import { canTransitionRun, type RunStatus } from "@agrippa/core";
import { approvals, type Db, type DbOrTx, runEvents, runs } from "@agrippa/db";
import { and, eq, sql } from "drizzle-orm";

/**
 * Run-lifecycle module (docs/design/04, ADR-0007): the one place that mutates
 * run status and appends events, always atomically.
 *
 * Every status change is a compare-and-swap on the expected `from` status, so a
 * late worker completion can never overwrite a concurrent cancellation, and two
 * resumed jobs for the same run cannot both "win". Every event seq is allocated
 * by the database inside the INSERT, so the per-run monotonic seq can't be
 * seeded stale in memory and lost to a concurrent writer.
 */

export type RunEventInput = {
  runId: string;
  stepId?: string | null;
  type: string;
  payload?: Record<string, unknown>;
};

export type AppendedRunEvent = { seq: number; createdAt: Date };

/**
 * Move a run from `from` to `to` iff it is still in `from` (compare-and-swap).
 * Returns true when this caller made the change, false when the row had already
 * moved on (e.g. a cancel landed first). Rejects illegal transitions up front.
 */
export async function transitionRun(
  db: DbOrTx,
  runId: string,
  from: RunStatus,
  to: RunStatus,
): Promise<boolean> {
  if (from === to) {
    // a self-transition is an assertion "the run is still in `from`" — verify
    // against the database rather than trusting a possibly-stale caller value
    const [row] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
    return row?.status === to;
  }
  if (!canTransitionRun(from, to)) {
    throw new Error(`illegal run transition ${from} → ${to}`);
  }
  const updated = await db
    .update(runs)
    .set({ status: to })
    .where(and(eq(runs.id, runId), eq(runs.status, from)))
    .returning({ id: runs.id });
  return updated.length > 0;
}

/**
 * Append a run event with a database-allocated per-run seq. The seq comes from an
 * atomic `UPDATE runs SET next_event_seq = next_event_seq + 1 … RETURNING`: the
 * row lock serializes concurrent allocations, so this is collision-free and — key
 * for the approval flow — works inside a caller's transaction (the old
 * max(seq)+1-with-retry aborted on the first unique violation inside a tx).
 */
export async function appendRunEvent(db: DbOrTx, event: RunEventInput): Promise<AppendedRunEvent> {
  const [seqRow] = await db
    .update(runs)
    .set({ nextEventSeq: sql`${runs.nextEventSeq} + 1` })
    .where(eq(runs.id, event.runId))
    .returning({ seq: runs.nextEventSeq });
  if (!seqRow) throw new Error(`appendRunEvent: run ${event.runId} not found`);
  const [row] = await db
    .insert(runEvents)
    .values({
      runId: event.runId,
      stepId: event.stepId ?? null,
      seq: seqRow.seq,
      type: event.type,
      payload: event.payload ?? {},
    })
    .returning({ seq: runEvents.seq, createdAt: runEvents.createdAt });
  if (!row) throw new Error("run_events insert returned no row");
  return row;
}

/**
 * Runs paused in `waiting_approval` whose approvals are **all** decided — i.e. a
 * decision landed but its resume enqueue was lost. The sweeper re-enqueues these.
 * The `not exists (… pending)` guard is essential: a multi-checkpoint run with an
 * earlier decided approval and a current pending one must NOT be selected, or the
 * sweeper would re-enqueue it every tick while it legitimately waits.
 */
export async function findStrandedApprovalRuns(db: DbOrTx): Promise<string[]> {
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.status, "waiting_approval"),
        sql`not exists (select 1 from ${approvals} where ${approvals.runId} = ${runs.id} and ${approvals.status} = 'pending')`,
      ),
    );
  return rows.map((r) => r.id);
}

export type FinalizeRunInput = {
  runId: string;
  from: RunStatus;
  to: RunStatus;
  /** For a success: the CAS also requires cancel_requested=false, so a cancel that
   *  landed after the last interrupt check wins atomically instead of racing. */
  requireNotCancelled?: boolean;
  error: { code: string; message: string } | null;
  usageTotals: Record<string, unknown>;
  /** Terminal-event payload (caller redacts). */
  eventPayload: Record<string, unknown>;
};

export type FinalizeResult =
  | { outcome: "finalized"; seq: number; createdAt: Date }
  | { outcome: "cancelled_instead" } // requireNotCancelled lost to a pending cancel
  | { outcome: "lost" }; // another path already finalized the run

/**
 * The single terminal-transition implementation used by both the engine and the
 * worker's retry-exhaustion path. In one transaction it CAS-updates the status
 * (optionally requiring no pending cancel), writes finishedAt/error/usageTotals,
 * and appends the terminal event — so a run can never be left half-finalized and
 * both callers always emit the terminal event.
 */
export async function finalizeRun(db: Db, input: FinalizeRunInput): Promise<FinalizeResult> {
  const { runId, from, to, requireNotCancelled = false, error, usageTotals, eventPayload } = input;
  if (!canTransitionRun(from, to)) throw new Error(`illegal run transition ${from} → ${to}`);
  return db.transaction(async (tx): Promise<FinalizeResult> => {
    const conds = [eq(runs.id, runId), eq(runs.status, from)];
    if (requireNotCancelled) conds.push(eq(runs.cancelRequested, false));
    const updated = await tx
      .update(runs)
      .set({ status: to, finishedAt: new Date(), error: error ?? null, usageTotals })
      .where(and(...conds))
      .returning({ id: runs.id });
    if (updated.length === 0) {
      const [row] = await tx
        .select({ status: runs.status, cancelRequested: runs.cancelRequested })
        .from(runs)
        .where(eq(runs.id, runId));
      if (requireNotCancelled && row?.status === from && row.cancelRequested) {
        return { outcome: "cancelled_instead" };
      }
      return { outcome: "lost" };
    }
    const evt = await appendRunEvent(tx, { runId, type: `run.${to}`, payload: eventPayload });
    return { outcome: "finalized", seq: evt.seq, createdAt: evt.createdAt };
  });
}

/**
 * Decide a pending approval atomically. The `status = 'pending'` predicate makes
 * this a compare-and-swap: a user decision and the expiry worker can't overwrite
 * each other. Returns the updated row, or null if it was no longer pending.
 */
export async function decideApproval(
  db: DbOrTx,
  approvalId: string,
  patch: { status: "approved" | "rejected" | "expired"; decidedBy?: string; comment?: string },
): Promise<typeof approvals.$inferSelect | null> {
  const [updated] = await db
    .update(approvals)
    .set({ ...patch, decidedAt: new Date() })
    .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
    .returning();
  return updated ?? null;
}
