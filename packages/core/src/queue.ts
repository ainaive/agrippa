/** Queue names and payloads shared by the API (producer) and worker (consumer). */

export const QUEUE_RUN_EXECUTE = "run.execute";
export const QUEUE_APPROVAL_EXPIRE = "approval.expire";

export type RunExecutePayload = { runId: string };
export type ApprovalExpirePayload = { approvalId: string; runId: string };

/**
 * The API's handle on the queue. Sends are deduplicated by singleton key
 * (the run id), and a worker-side sweeper re-enqueues stragglers — together
 * these give the no-stranded-runs invariant of docs/design/04 without
 * depending on cross-driver transaction plumbing.
 */
export type RunQueue = {
  enqueueRun(runId: string): Promise<void>;
  enqueueApprovalExpiry(payload: ApprovalExpirePayload, atMs: number): Promise<void>;
};
