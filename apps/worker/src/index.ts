import { hostname } from "node:os";
import {
  type ApprovalExpirePayload,
  catalogCapabilityShortfall,
  EXECUTOR_CATALOG,
  isExecutorId,
  type NotificationDeliverPayload,
  QUEUE_APPROVAL_EXPIRE,
  QUEUE_NOTIFICATION_DELIVER,
  QUEUE_SCHEDULE_FIRE,
  QUEUE_TRIGGER_FIRE,
  type ScheduleFirePayload,
  type TriggerFirePayload,
} from "@agrippa/core";
import { awaitSchema, createDb, notificationDeliveries, runs, runtimes } from "@agrippa/db";
import { createClaudeExecutor } from "@agrippa/executor-claude";
import { createCodexExecutor, probeCodexCli } from "@agrippa/executor-codex";
import type { Executor } from "@agrippa/executor-core";
import {
  appendRunEvent,
  collectExpiredWorkspaces,
  createRunQueue,
  DiskArtifactStore,
  dbRunExecutorResolver,
  decideCheckpoint,
  type EngineDeps,
  enqueueAfterCommit,
  FakeScmService,
  findStrandedCheckpointRuns,
  fireSchedule,
  fireTrigger,
  InProcessEventBus,
  liveCentralWorkerSets,
  RedisEventBus,
  reconcileScheduleCalendar,
  type ScheduleFireOutcome,
  sweepNotificationDeliveries,
  sweepOfflineRuntimes,
  sweepRunLeases,
  sweepTriggerDeliveries,
  type TriggerFireOutcome,
} from "@agrippa/orchestration";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Job, JobWithMetadata } from "pg-boss";
import { createRunConsumer, startRunFetchLoop } from "./consumer";
import { DemoExecutor } from "./deps/demo-executor";
import { deliverNotification } from "./deps/notify";
import {
  markBootStarted,
  markConsumersReady,
  touchWorkerHeartbeat,
  WORKER_SCHEMA_WAIT_MS,
} from "./deps/readiness";
import { DbResourceMaterializer } from "./deps/resources";
import { GitScmService } from "./deps/scm";
import { GitWorkspaceManager, removeWorkspace } from "./deps/workspace";
import { selectRunQueues } from "./run-queues";

/**
 * Workspace keys this process has already collected, so a key named on every
 * tick for the rest of its window costs one `has` rather than an `rm -rf`.
 * Bounded by that window; a restart simply re-collects, which is a no-op.
 */
const collectedWorkspaces = new Set<string>();

const db = createDb();
// inside a compose container the hostname IS the container id — the identity
// deploy verification counts readiness rows by. Boot-start clears any prior
// boot's readiness FIRST, so a boot that wedges below never looks ready.
const containerId = hostname();

// The api migrates on boot; this worker only reads and writes, so it waits for
// the schema its own build expects rather than crashing on a table the
// database has not been given yet (a crash-looping worker fails deploy
// verification and rolls back a good deploy). createDb() is lazy, so nothing
// has touched the database before this point.
//
// The bound MUST exceed deploy.sh's HEALTH_TIMEOUT (180s) — see
// WORKER_SCHEMA_WAIT_MS below.
await awaitSchema(db, {
  timeoutMs: WORKER_SCHEMA_WAIT_MS,
  log: (msg) => console.log(`[worker] ${msg}`),
});

// Executor construction is DB-free (the codex probe runs a CLI, nothing
// else), so it happens before the first heartbeat write: boot-start carries
// the capability advertisement the API's submit gating and fleet page read.
const executors: Record<string, Executor> = {
  "claude-agent-sdk": createClaudeExecutor(),
  fake: new DemoExecutor(),
};
// codex registers only when the CLI is actually usable on this host — which
// includes supporting the config-isolation flags every step passes. Env auth
// is no longer required at boot: a project provider credential can arrive
// per-step, so a keyless worker is still a valid codex host.
const codexProbe = probeCodexCli();
if (codexProbe.ok) {
  executors["codex-cli"] = createCodexExecutor();
  const authMode =
    process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.CODEX_HOME
      ? "env auth"
      : "project credentials only";
  console.log(`[worker] codex executor registered (${codexProbe.version}, ${authMode})`);
} else {
  console.log(`[worker] codex executor not registered (${codexProbe.reason})`);
}
// the static catalog in @agrippa/core is what the API/SPA trust — a drifting
// capability set here would let templates pass validation and fail at runtime
for (const [id, executor] of Object.entries(executors)) {
  if (!isExecutorId(id)) throw new Error(`executor '${id}' is not in EXECUTOR_CATALOG`);
  // the catalog may promise less than the executor delivers, never more
  const short = catalogCapabilityShortfall(
    EXECUTOR_CATALOG[id].capabilities,
    executor.capabilities,
  );
  if (short) throw new Error(`executor '${id}' lacks catalog capability '${short}'`);
}

const workerAd = {
  executors: Object.entries(executors).map(([id, executor]) => ({
    id,
    envAuthProviders: executor.envAuthProviders ? [...executor.envAuthProviders] : undefined,
  })),
  version: process.env.AGRIPPA_VERSION ?? null,
};

await markBootStarted(db, containerId, workerAd);
const bus = process.env.REDIS_URL
  ? new RedisEventBus(process.env.REDIS_URL)
  : new InProcessEventBus();
const queue = await createRunQueue(process.env.DATABASE_URL as string, {
  resolveRunExecutors: dbRunExecutorResolver(db),
});

const deps: EngineDeps = {
  db,
  executors,
  bus,
  workspace: new GitWorkspaceManager(db),
  resources: new DbResourceMaterializer(db),
  artifacts: new DiskArtifactStore(),
  scm: process.env.AGRIPPA_SCM === "fake" ? new FakeScmService() : new GitScmService(db),
  logger: {
    info: (msg, extra) => console.log(`[worker] ${msg}`, extra ?? ""),
    warn: (msg, extra) => console.warn(`[worker] ${msg}`, extra ?? ""),
    error: (msg, extra) => console.error(`[worker] ${msg}`, extra ?? ""),
  },
  // execution-lease identity: claims, renewals, and releases all key on it
  lease: { owner: containerId },
};

const SLOTS = Number(process.env.WORKER_SLOTS ?? 2);

const consumer = createRunConsumer(db, deps, queue);

/**
 * The queues this worker polls (see selectRunQueues for the selection rules):
 * its own executor-set subsets, runtime-covered sets no live central worker
 * can serve (the engine runs centrally even when the executor is remote, so
 * daemon-only sets need SOME worker fetching their jobs — but sets a capable
 * central worker covers are left to that worker, or an incapable fetcher
 * would route central and decline in a steal loop).
 * Recomputed on the sweeper tick because runtimes and workers come and go.
 */
const knownQueues = new Set<string>();
async function computeRunQueues(): Promise<string[]> {
  const liveRuntimes = await db
    .select({ name: runtimes.name, executors: runtimes.executors })
    .from(runtimes)
    .where(
      and(
        eq(runtimes.status, "active"),
        gte(runtimes.lastSeenAt, sql`now() - interval '15 minutes'`),
      ),
    );
  // the SAME live-and-ready predicate routing's central-coverage check uses
  // (150s + consumers ready) — a dead or boot-wedged sole-capable worker must
  // not suppress a live daemon's queues for the old 15-minute window
  const liveWorkers = await liveCentralWorkerSets(db);
  const list = selectRunQueues({
    localExecutorIds: Object.keys(executors),
    centralWorkerSets: liveWorkers.map((ads) => ads.map((e) => e.id)),
    runtimeAds: liveRuntimes.map((r) => ({
      name: r.name,
      ids: (r.executors ?? []).map((e) => e.id),
    })),
    logger: { warn: (msg) => deps.logger.warn(msg) },
  });
  // queues must exist before the first fetch (createQueue is idempotent)
  for (const name of list) {
    if (knownQueues.has(name)) continue;
    await queue.boss.createQueue(name);
    knownQueues.add(name);
  }
  return list;
}

const fetchLoop = startRunFetchLoop({
  boss: queue.boss,
  queues: await computeRunQueues(),
  slots: SLOTS,
  handler: consumer.handleRunJob,
  logger: deps.logger,
});

// Lease renewal on its own cadence (TTL/3): the 60s sweeper is too coarse for
// a 90s TTL — one delayed tick would expire every lease this worker holds.
const leaseRenewal = setInterval(() => {
  consumer.renewLeases().catch((err) => {
    deps.logger.warn("lease renewal failed", { err: String(err) });
  });
}, 30_000);

await queue.boss.work(QUEUE_APPROVAL_EXPIRE, async (jobs: Job<ApprovalExpirePayload>[]) => {
  for (const job of jobs) {
    // CAS pending → expired and its timeline event commit TOGETHER: the CAS
    // makes this job's retry a no-op, so a crash between the two would leave
    // an expired checkpoint that event-derived notifications can never see.
    // null means a user already decided it (or a prior run of this job did).
    const expired = await db.transaction(async (tx) => {
      const row = await decideCheckpoint(tx, job.data.approvalId, { status: "expired" });
      if (!row) return null;
      // the expiry previously left no trace until the engine resumed — one
      // timeline event so the timeline (and notifications) can show it
      await appendRunEvent(tx, {
        runId: job.data.runId,
        type: "checkpoint.expired",
        payload: {
          checkpointRowId: row.id,
          checkpointId: row.checkpointId,
          kind: row.kind,
          iteration: row.iteration,
          title: (row.payload as { title?: unknown }).title,
        },
      });
      return row;
    });
    if (!expired) continue;
    deps.logger.warn(`approval ${expired.id} expired — resuming run for onTimeout handling`);
    // the onTimeout resume must never wait on delivery bookkeeping
    await queue.enqueueRun(job.data.runId); // engine applies the template's onTimeout
    await consumer.syncNotificationsBestEffort(job.data.runId);
  }
});

await queue.boss.work(
  QUEUE_NOTIFICATION_DELIVER,
  { includeMetadata: true, pollingIntervalSeconds: 1 } as const,
  async (jobs: JobWithMetadata<NotificationDeliverPayload>[]) => {
    for (const job of jobs) {
      const meta = job as unknown as { retryCount?: number; retryLimit?: number };
      try {
        await deliverNotification(db, job.data.deliveryId);
      } catch (err) {
        deps.logger.warn(`notification ${job.data.deliveryId} attempt failed`, {
          err: String(err),
        });
        if ((meta.retryCount ?? 0) >= (meta.retryLimit ?? 0)) {
          // terminal bookkeeping mirrors markRunFailed: the attempt itself was
          // already recorded by deliverNotification; only the status flips here
          await db
            .update(notificationDeliveries)
            .set({ status: "failed" })
            .where(
              and(
                eq(notificationDeliveries.id, job.data.deliveryId),
                eq(notificationDeliveries.status, "pending"),
              ),
            );
          continue; // retries exhausted — completing the job ends the churn
        }
        throw err; // pg-boss retries with backoff
      }
    }
  },
);

/**
 * The whole outcome, not just its discriminant.
 *
 * Logging `outcome.kind` alone printed `"failed"` with no cause — leaving the
 * operator's only signal for a lost firing to say that something went wrong
 * and nothing about what. The union carries `error`, `reason` or the ids on
 * exactly the branches where each matters.
 *
 * Typed as the two unions and switched on the discriminant rather than taking
 * a structural bag: a future member with a new informative field then fails to
 * compile instead of being silently dropped, which is how the run id went
 * missing from the success line in the first place.
 */
function outcomeDetail(outcome: ScheduleFireOutcome | TriggerFireOutcome): Record<string, string> {
  switch (outcome.kind) {
    case "submitted":
      // the run id is the whole point of the success line: without it a firing
      // cannot be correlated to the run it produced from the log alone
      return { outcome: outcome.kind, runId: outcome.runId, taskId: outcome.taskId };
    case "failed":
      return { outcome: outcome.kind, error: outcome.error };
    default:
      return { outcome: outcome.kind, reason: outcome.reason };
  }
}

/**
 * Is this the queue's last go at the job?
 *
 * A firing rethrows an unexpected error so pg-boss retries it — but only while
 * retries remain. pg-boss does not emit on handler failure and no dead-letter
 * queue is configured, so the last throw is a silent one: the job rests in
 * `failed` and nothing on the row, in the notification pipeline, or in this log
 * ever says so. Past the limit the firing records instead, the same shape the
 * notification handler above uses.
 */
function isFinalAttempt(job: { retryCount?: number; retryLimit?: number }): boolean {
  return (job.retryCount ?? 0) >= (job.retryLimit ?? 0);
}

await queue.boss.work(
  QUEUE_SCHEDULE_FIRE,
  { includeMetadata: true } as const,
  async (jobs: JobWithMetadata<ScheduleFirePayload>[]) => {
    for (const job of jobs) {
      // job.id, not the schedule id: it is this FIRING's identity. pg-boss keeps
      // it when it re-inserts a retried job and mints a new one per cron tick, so
      // it is exactly the key that tells a redelivery apart from an occurrence —
      // and it is stable across the retries this handler now allows.
      const outcome = await fireSchedule(
        db,
        queue,
        job.data.scheduleId,
        job.id,
        isFinalAttempt(job),
      );
      deps.logger.info(`schedule ${job.data.scheduleId} fired`, outcomeDetail(outcome));
    }
  },
);

await queue.boss.work(
  QUEUE_TRIGGER_FIRE,
  { includeMetadata: true } as const,
  async (jobs: JobWithMetadata<TriggerFirePayload>[]) => {
    for (const job of jobs) {
      const outcome = await fireTrigger(db, queue, job.data.deliveryId, isFinalAttempt(job));
      deps.logger.info(`trigger delivery ${job.data.deliveryId}`, outcomeDetail(outcome));
    }
  },
);

/**
 * The calendar view the reconciler drives. Kept here rather than on `RunQueue`
 * because listing is a worker-side repair concern, not something a producer
 * needs; the boss handle is already in reach for `boss.work` above.
 */
const scheduleCalendar = {
  list: async () => {
    const entries = await queue.boss.getSchedules(QUEUE_SCHEDULE_FIRE);
    return entries.map((e) => ({ key: e.key, cron: e.cron, timezone: e.timezone }));
  },
  register: (id: string, cron: string, timezone: string) =>
    queue.registerSchedule(id, cron, timezone),
  unregister: (id: string) => queue.unregisterSchedule(id),
};

/**
 * A schedule the reconciler could not repair is named, every time.
 *
 * The reconciler is deliberately per-row tolerant so one broken schedule
 * cannot stop the rest being fixed — but tolerance that reports nothing is
 * indistinguishable from success, and the schedule stays unregistered forever
 * while the drift line reads "+0/-0". The package takes no logger, so it hands
 * the list back and this is where it becomes visible.
 */
function logReconcileFailures(failed: Array<{ id: string; error: string }>): void {
  for (const { id, error } of failed) {
    deps.logger.warn(`schedule ${id}: calendar reconciliation failed`, { err: error });
  }
}

// Converge once at boot so a restart repairs drift immediately; the sweeper
// stage below then keeps converging, which is what makes a dropped
// registration recoverable without waiting for the next restart.
try {
  const { considered, registered, unregistered, failed } = await reconcileScheduleCalendar(
    db,
    scheduleCalendar,
  );
  // the denominator matters: "+0/-0" is what a converged fleet prints AND what
  // a fleet whose every repair threw would print without it
  deps.logger.info(
    `schedule calendar reconciled (+${registered}/-${unregistered} of ${considered})`,
  );
  logReconcileFailures(failed);
} catch (err) {
  deps.logger.warn("schedule reconciliation failed", { err: String(err) });
}

// every consumer above is live — the boss.work() calls returned and the
// run fetch loop is ticking — which is the signal deploy verification counts
// (issue #15)
await markConsumersReady(db, containerId);

/**
 * Reconciliation sweeper: re-enqueues queued runs whose job got lost (e.g.
 * the API crashed between commit and send). Singleton keys make this safe.
 */
/**
 * Bounded, because an unbounded one is worse than the overlap it prevents.
 *
 * `setInterval` does not await the callback, so a slow sweep overlaps itself
 * and wastes work. But nothing on this path has a timeout — no statement
 * timeout, no pool acquisition deadline — so a stage wedged on a lock never
 * returns, and a plain boolean would then disable *every* recovery mechanism
 * (stragglers, leases, offline runtimes, checkpoints, both delivery sweeps,
 * calendar drift) until someone restarts the worker. That is the same argument
 * the per-stage isolation below makes, one level up: a recovery mechanism one
 * hung call can switch off is not a recovery mechanism. Past the deadline a
 * new tick takes over and says so at error level.
 */
const SWEEP_STALL_MS = 5 * 60_000;
let sweepStartedAt: number | null = null;
setInterval(async () => {
  const startedAt = sweepStartedAt;
  if (startedAt !== null) {
    const stalledFor = Date.now() - startedAt;
    if (stalledFor < SWEEP_STALL_MS) {
      deps.logger.warn("sweeper still running from the previous tick — skipping this one");
      return;
    }
    deps.logger.error("sweeper stalled — starting a new pass over the top", {
      stalledForMs: String(stalledFor),
    });
  }
  const startedAtOwned = Date.now();
  sweepStartedAt = startedAtOwned;
  try {
    // Each stage is isolated. The sweep used to be one try block, which meant a
    // single unenqueueable straggler took lease expiry, offline detection,
    // checkpoint recovery and the delivery sweeps down with it — every tick,
    // indefinitely, behind one "sweeper failed" line. A recovery mechanism that
    // one bad row can disable is not a recovery mechanism.
    const stage = async (what: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (err) {
        deps.logger.warn(`sweeper stage failed: ${what}`, { err: String(err) });
      }
    };

    // liveness beat FIRST: deploy verification reads it through a sliding
    // window, so a transient error in the sweep work below must not skip it
    await stage("heartbeat", () => touchWorkerHeartbeat(db, containerId, workerAd));

    await stage("stragglers", async () => {
      const stragglers = await db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(eq(runs.status, "queued"), lt(runs.queuedAt, sql`now() - interval '30 seconds'`)),
        );
      // per run, so one undeliverable job cannot strand the rest of the batch
      for (const run of stragglers) {
        await enqueueAfterCommit(() => queue.enqueueRun(run.id), `straggler ${run.id}`);
      }
    });

    // execution-lease sweep (ADR-0017 Decision 4): expire dead leases (each
    // gets one run.lease_expired event, CAS-safe across replicas) and
    // re-enqueue every leaseless running run — the recovery path crashed
    // `running` runs never had. Singleton keys dedupe repeat enqueues.
    await stage("leases", async () => {
      const { expired, orphaned } = await sweepRunLeases(db);
      for (const { id, previousOwner } of expired) {
        deps.logger.warn(`run ${id}: lease expired (owner ${previousOwner ?? "unknown"})`);
      }
      for (const runId of orphaned) {
        await enqueueAfterCommit(() => queue.enqueueRun(runId), `orphaned ${runId}`);
      }
    });

    // runtime-offline notifications (ADR-0017): a silent daemon flags its
    // pinned running runs with a runtime.offline event; deliveries derive
    // from the event, deduped per endpoint like every other notification
    await stage("offline-runtimes", async () => {
      for (const runId of await sweepOfflineRuntimes(db)) {
        await consumer.syncNotificationsBestEffort(runId);
      }
    });

    // queue coverage tracks the live fleet: a runtime registering a new
    // executor set needs a worker polling that set's queue within a tick
    await stage("queue-coverage", async () => {
      fetchLoop.updateQueues(await computeRunQueues());
    });

    // runs paused on an approval that has since been decided but whose resume
    // enqueue was lost (e.g. the API/worker died between the decision and the
    // send) — re-enqueue so the decision actually takes effect
    await stage("stranded-checkpoints", async () => {
      for (const runId of await findStrandedCheckpointRuns(db)) {
        await enqueueAfterCommit(() => queue.enqueueRun(runId), `stranded ${runId}`);
      }
    });

    // Workspace collection (ADR-0018 Decision 4). Deleting used to be a
    // finalize side effect, which cannot work once a directory outlives the
    // run that made it: a key is collected only when every run sharing it has
    // released it and the group's latest expiry has passed. Every worker runs
    // this — the deletes are idempotent, and a worker that does not hold a
    // directory removes nothing, so a fleet with a shared volume collects once
    // and a fleet without one still collects on whichever host has the files.
    await stage("workspaces", async () => {
      await collectExpiredWorkspaces({
        db,
        remove: removeWorkspace,
        collected: collectedWorkspaces,
        logger: {
          info: (msg: string) => deps.logger.info(msg),
          warn: (msg: string) => deps.logger.warn(msg),
        },
      });
    });

    // delivery backstops: backfill missed events, re-enqueue stale rows
    await stage("notification-deliveries", () => sweepNotificationDeliveries(db, queue));
    await stage("trigger-deliveries", () => sweepTriggerDeliveries(db, queue));

    // calendar drift: a registration dropped at request time, or an edit whose
    // re-registration was lost, would otherwise persist until the next restart —
    // a schedule that silently never fires, or one firing on its old cron while
    // the UI shows the new one. Steady state does no writes.
    await stage("schedule-calendar", async () => {
      const { registered, unregistered, failed } = await reconcileScheduleCalendar(
        db,
        scheduleCalendar,
      );
      if (registered || unregistered) {
        deps.logger.warn(`schedule calendar drift repaired (+${registered}/-${unregistered})`);
      }
      logReconcileFailures(failed);
    });
  } finally {
    // only if we still own it — a stalled predecessor finishing late must not
    // clear the flag out from under the pass that took over
    if (sweepStartedAt === startedAtOwned) sweepStartedAt = null;
  }
}, 60_000);

console.log(
  `[worker] up — container=${containerId} slots=${SLOTS} redis=${Boolean(process.env.REDIS_URL)}`,
);

process.on("SIGTERM", async () => {
  deps.logger.info("draining…");
  clearInterval(leaseRenewal);
  // 1. stop fetching (no new runs land mid-shutdown); 2. abort in-flight
  // engines — each exits `drained`, releases its lease, and re-enqueues so a
  // healthy worker resumes step-granularly without burning retries; 3. wait
  // for the jobs to settle, bounded so a wedged step cannot outlive the
  // compose stop_grace_period (60s).
  const settled = fetchLoop.stop();
  consumer.drainActive();
  await Promise.race([settled, Bun.sleep(15_000)]);
  await queue.stop();
  process.exit(0);
});
