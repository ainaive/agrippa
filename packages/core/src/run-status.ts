export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
];

export const STEP_STATUSES = [
  "pending",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/**
 * The run state machine (see docs/design/04-execution-runtime.md).
 * Pure data: the engine persists and audits every transition; anything
 * not listed here is illegal and must be rejected.
 */
const LEGAL_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "cancelled", "failed"],
  running: ["succeeded", "failed", "timed_out", "waiting_approval", "cancelled"],
  waiting_approval: ["running", "cancelled", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * Whether a run still holds its workspace — and therefore whether it can be
 * steered (ADR-0018 Decision 4).
 *
 * A run releases its workspace when it finalizes, stamping an expiry. Two
 * populations never carry one: runs that finalized before retention existed,
 * and runs whose release write was lost — so `finished_at` is the fallback,
 * and such a workspace reads as already released rather than held forever.
 *
 * The server asks this of a whole workspace GROUP in SQL (`expiredWorkspaceKeys`
 * — every run released, latest expiry passed) and cannot share this function;
 * it CAN share the rule, which is why the rule lives here. It first shipped as
 * two copies that disagreed, and the SPA offered a Continue button on every
 * run finished before the feature existed, every one of which the API refused.
 */
export function runHoldsWorkspace(run: {
  finishedAt: string | Date | null;
  workspaceExpiresAt: string | Date | null;
}): boolean {
  const effective = run.workspaceExpiresAt ?? run.finishedAt;
  if (effective === null) return true; // still running: nothing has released
  return new Date(effective).getTime() > Date.now();
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export class IllegalRunTransitionError extends Error {
  constructor(
    readonly from: RunStatus,
    readonly to: RunStatus,
  ) {
    super(`illegal run transition: ${from} → ${to}`);
    this.name = "IllegalRunTransitionError";
  }
}

/** Returns `to` if the transition is legal, otherwise throws. */
export function transitionRun(from: RunStatus, to: RunStatus): RunStatus {
  if (!canTransitionRun(from, to)) throw new IllegalRunTransitionError(from, to);
  return to;
}
