import {
  type ApprovalExpirePayload,
  QUEUE_APPROVAL_EXPIRE,
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
  };
}
