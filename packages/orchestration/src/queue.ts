import {
  type ApprovalExpirePayload,
  QUEUE_APPROVAL_EXPIRE,
  QUEUE_NOTIFICATION_DELIVER,
  QUEUE_SCHEDULE_FIRE,
  QUEUE_TRIGGER_FIRE,
  type RunQueue,
  requiredExecutorIds,
  runExecuteQueueName,
} from "@agrippa/core";
import { type Db, runs } from "@agrippa/db";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";

export type BossQueue = RunQueue & { boss: PgBoss; stop(): Promise<void> };

/**
 * Resolves the executor ids a run requires, so enqueueRun can derive its
 * executor-set queue name. Returning [] (unknown run) falls back to the
 * legacy queue — the job then fails visibly instead of being silently lost.
 */
export type RunExecutorResolver = (runId: string) => Promise<readonly string[]>;

/** The standard resolver: one indexed select on the run row. */
export function dbRunExecutorResolver(db: Db): RunExecutorResolver {
  return async (runId) => {
    const [run] = await db
      .select({ executorId: runs.executorId, agentBindings: runs.agentBindings })
      .from(runs)
      .where(eq(runs.id, runId));
    return run ? requiredExecutorIds(run) : [];
  };
}

/**
 * pg-boss handle shared by the api (producer) and worker (consumer).
 * Sends are singleton-keyed by run id: at most one queued/active job per run,
 * so the post-commit send plus the worker's reconciliation sweeper give
 * effectively-exactly-once handoff (docs/design/04, ADR-0003).
 *
 * Run sends route to the executor-set queue derived from the run row
 * (`run.execute.<sorted ids>`); the resolver is injected so this module owns
 * the name derivation in exactly one place. Set queues are created lazily on
 * first send — createQueue is ON CONFLICT DO NOTHING, so producer/consumer
 * races are harmless.
 */
export async function createRunQueue(
  connectionString: string,
  opts: { resolveRunExecutors: RunExecutorResolver },
): Promise<BossQueue> {
  const boss = new PgBoss({ connectionString });
  boss.on("error", (err: Error) => console.error("[pg-boss]", err));
  await boss.start();
  await boss.createQueue(QUEUE_APPROVAL_EXPIRE);
  const createdQueues = new Set<string>([QUEUE_APPROVAL_EXPIRE]);
  const ensureQueue = async (name: string): Promise<void> => {
    if (createdQueues.has(name)) return;
    await boss.createQueue(name);
    createdQueues.add(name);
  };
  // exclusive = ONE unique index on (name, singleton_key) across the whole
  // created/retry/active range, so a sweeper re-enqueue cannot mint a fresh
  // job while the original waits out its retry backoff. Neither of the
  // tempting alternatives does this: 'standard' has no singleton index at
  // all, and 'stately' keys its index BY STATE (one created + one retry can
  // coexist). createQueue is ON CONFLICT DO NOTHING and updateQueue cannot
  // change policy, so a queue left behind by an earlier revision converges
  // by recreate — any dropped jobs are re-enqueued by the sweeper from the
  // durable delivery rows.
  const existing = await boss.getQueue(QUEUE_NOTIFICATION_DELIVER);
  if (existing && existing.policy !== "exclusive") {
    await boss.deleteQueue(QUEUE_NOTIFICATION_DELIVER);
  }
  await boss.createQueue(QUEUE_NOTIFICATION_DELIVER, { policy: "exclusive" });
  await boss.createQueue(QUEUE_SCHEDULE_FIRE);
  await boss.createQueue(QUEUE_TRIGGER_FIRE);

  return {
    boss,
    stop: () => boss.stop({ graceful: true }),
    async enqueueRun(runId: string): Promise<void> {
      const executorIds = await opts.resolveRunExecutors(runId);
      // Post-M2-flush there is no legacy fallback queue: a run whose executor
      // set cannot be derived has no consumer, so failing the enqueue loudly
      // beats parking the job on a queue nobody polls.
      if (executorIds.length === 0) {
        throw new Error(`enqueueRun: cannot derive an executor set for run ${runId}`);
      }
      const name = runExecuteQueueName(executorIds);
      await ensureQueue(name);
      await boss.send(name, { runId }, { singletonKey: runId, retryLimit: 2, retryDelay: 5 });
    },
    async enqueueApprovalExpiry(payload: ApprovalExpirePayload, atMs: number): Promise<void> {
      await boss.sendAfter(
        QUEUE_APPROVAL_EXPIRE,
        payload,
        { singletonKey: payload.approvalId },
        new Date(atMs),
      );
    },
    async registerSchedule(scheduleId: string, cron: string, timezone: string): Promise<void> {
      // `key` scopes the entry to this schedule, so re-registering after an
      // edit replaces its calendar rather than adding a second one; pg-boss
      // owns the timezone, and with it the DST edges we would otherwise have
      // to reason about ourselves.
      await boss.schedule(
        QUEUE_SCHEDULE_FIRE,
        cron,
        { scheduleId },
        { tz: timezone, key: scheduleId },
      );
    },
    async unregisterSchedule(scheduleId: string): Promise<void> {
      await boss.unschedule(QUEUE_SCHEDULE_FIRE, scheduleId);
    },
    async enqueueTriggerDelivery(deliveryId: string): Promise<void> {
      // the inbound request already committed the delivery row, so a lost job
      // is recoverable from it; the singleton key keeps a sender's retry and
      // an operator's replay from racing into two runs
      await boss.send(
        QUEUE_TRIGGER_FIRE,
        { deliveryId },
        { singletonKey: deliveryId, retryLimit: 3, retryDelay: 10 },
      );
    },
    async enqueueNotificationDelivery(deliveryId: string): Promise<void> {
      await boss.send(
        QUEUE_NOTIFICATION_DELIVER,
        { deliveryId },
        // backoff because the receiver is an external service: hammering a
        // down endpoint every 30s converts an outage into five fast failures.
        { singletonKey: deliveryId, retryLimit: 5, retryDelay: 30, retryBackoff: true },
      );
    },
  };
}
