/** Queue names and payloads shared by the API (producer) and worker (consumer). */

/**
 * Legacy single run queue. New sends route to an executor-set queue (below);
 * this name stays in every worker's fetch rotation as the deploy-skew
 * fallback — an old api mid-deploy still sends here, and jobs already queued
 * under this name must drain. Removal is a post-merge cleanup once a deploy
 * has flushed it.
 */
export const QUEUE_RUN_EXECUTE = "run.execute";
export const QUEUE_APPROVAL_EXPIRE = "approval.expire";
export const QUEUE_NOTIFICATION_DELIVER = "notification.deliver";
export const QUEUE_SCHEDULE_FIRE = "schedule.fire";

export const RUN_EXECUTE_QUEUE_PREFIX = "run.execute.";

/**
 * Queue name for a run's required executor set: `run.execute.` plus the
 * sorted, deduplicated ids joined by `.` (pg-boss queue names only allow
 * `[\w.\-/]`, so `+` and `,` are out; ids come from EXECUTOR_CATALOG and
 * contain no dots, and names are only ever generated, never parsed back).
 * Workers consume exactly the queues whose set is a subset of their own
 * registered executors, so a run only ever lands on a worker that can execute
 * every one of its slots — the bounce-until-capable-worker decline loop
 * becomes a skew fallback only.
 */
export function runExecuteQueueName(ids: Iterable<string>): string {
  const sorted = [...new Set(ids)].sort();
  if (sorted.length === 0) throw new Error("runExecuteQueueName: empty executor set");
  return RUN_EXECUTE_QUEUE_PREFIX + sorted.join(".");
}

/**
 * Every executor-set queue a worker owning `ownIds` must consume: one per
 * non-empty subset of its executor set (required-set ⊆ own-set is exactly
 * membership in this enumeration). Bounded by the catalog — 2^n − 1 with
 * n ≤ 4 in practice.
 */
export function runExecuteSubsetQueues(ownIds: readonly string[]): string[] {
  return executorSubsets(ownIds).map((subset) => runExecuteQueueName(subset));
}

/** Every non-empty subset of an executor set, deduplicated and sorted. */
export function executorSubsets(ownIds: readonly string[]): string[][] {
  const ids = [...new Set(ownIds)].sort();
  const subsets: string[][] = [];
  for (let mask = 1; mask < 1 << ids.length; mask++) {
    subsets.push(ids.filter((_, i) => mask & (1 << i)));
  }
  return subsets;
}

/**
 * The executor set a run needs: its primary executor plus every per-slot
 * binding (agrippa/v2 slots may bind different executors in one run).
 */
export function requiredExecutorIds(run: {
  executorId: string;
  agentBindings?: Record<string, { executorId: string }> | null;
}): string[] {
  const ids = new Set([run.executorId]);
  for (const binding of Object.values(run.agentBindings ?? {})) ids.add(binding.executorId);
  return [...ids].sort();
}

export type RunExecutePayload = { runId: string };
export type ApprovalExpirePayload = { approvalId: string; runId: string };
export type NotificationDeliverPayload = { deliveryId: string };
export type ScheduleFirePayload = { scheduleId: string };

/**
 * The API's handle on the queue. Sends are deduplicated by singleton key
 * (the run id), and a worker-side sweeper re-enqueues stragglers — together
 * these give the no-stranded-runs invariant of docs/design/04 without
 * depending on cross-driver transaction plumbing.
 */
export type RunQueue = {
  enqueueRun(runId: string): Promise<void>;
  enqueueApprovalExpiry(payload: ApprovalExpirePayload, atMs: number): Promise<void>;
  enqueueNotificationDelivery(deliveryId: string): Promise<void>;
  /**
   * Register (or replace) a schedule's cron entry. pg-boss owns the calendar,
   * including the timezone and its DST edges — the platform stores the same
   * cron on `task_schedules` for display and for the boot reconciliation that
   * repairs drift between the two.
   */
  registerSchedule(scheduleId: string, cron: string, timezone: string): Promise<void>;
  unregisterSchedule(scheduleId: string): Promise<void>;
};
