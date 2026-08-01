import {
  type ApprovalExpirePayload,
  QUEUE_APPROVAL_EXPIRE,
  QUEUE_NOTIFICATION_DELIVER,
  QUEUE_RUN_EXECUTE,
  type RunQueue,
} from "@agrippa/core";
import { PgBoss } from "pg-boss";

export type BossQueue = RunQueue & { boss: PgBoss; stop(): Promise<void> };

/**
 * pg-boss handle shared by the api (producer) and worker (consumer).
 * Sends are singleton-keyed by run id: at most one queued/active job per run,
 * so the post-commit send plus the worker's reconciliation sweeper give
 * effectively-exactly-once handoff (docs/design/04, ADR-0003).
 */
export async function createRunQueue(connectionString: string): Promise<BossQueue> {
  const boss = new PgBoss({ connectionString });
  boss.on("error", (err: Error) => console.error("[pg-boss]", err));
  await boss.start();
  await boss.createQueue(QUEUE_RUN_EXECUTE);
  await boss.createQueue(QUEUE_APPROVAL_EXPIRE);
  // stately = a real unique index on the singleton key across created/retry/
  // active. On the default 'standard' policy singletonKey enforces NOTHING
  // (pg-boss's singleton indexes are partial on policy), so the sweeper's
  // re-enqueues would mint duplicate concurrent deliveries. createQueue is
  // ON CONFLICT DO NOTHING and updateQueue cannot change policy, so a queue
  // left behind by an earlier revision converges by recreate — any dropped
  // jobs are re-enqueued by the sweeper from the durable delivery rows.
  const existing = await boss.getQueue(QUEUE_NOTIFICATION_DELIVER);
  if (existing && existing.policy !== "stately") {
    await boss.deleteQueue(QUEUE_NOTIFICATION_DELIVER);
  }
  await boss.createQueue(QUEUE_NOTIFICATION_DELIVER, { policy: "stately" });

  return {
    boss,
    stop: () => boss.stop({ graceful: true }),
    async enqueueRun(runId: string): Promise<void> {
      await boss.send(
        QUEUE_RUN_EXECUTE,
        { runId },
        { singletonKey: runId, retryLimit: 2, retryDelay: 5 },
      );
    },
    async enqueueApprovalExpiry(payload: ApprovalExpirePayload, atMs: number): Promise<void> {
      await boss.sendAfter(
        QUEUE_APPROVAL_EXPIRE,
        payload,
        { singletonKey: payload.approvalId },
        new Date(atMs),
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
