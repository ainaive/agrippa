import { canTransitionRun, type RunStatus } from "@agrippa/core";
import { approvals, type Db, runEvents, runs } from "@agrippa/db";
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

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "23505" || /duplicate key|run_events_run_seq_uq/i.test(e?.message ?? "");
}

/**
 * Move a run from `from` to `to` iff it is still in `from` (compare-and-swap).
 * Returns true when this caller made the change, false when the row had already
 * moved on (e.g. a cancel landed first). Rejects illegal transitions up front.
 */
export async function transitionRun(
  db: Db,
  runId: string,
  from: RunStatus,
  to: RunStatus,
): Promise<boolean> {
  if (from === to) return true;
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
 * Append a run event with a database-allocated per-run seq. The seq is computed
 * inside the INSERT (max+1 over the run's events), so serial writers are always
 * correct; the unique (run_id, seq) index backstops the rare concurrent race,
 * on which we retry rather than fail the job.
 */
export async function appendRunEvent(db: Db, event: RunEventInput): Promise<AppendedRunEvent> {
  const nextSeq = sql<number>`(select coalesce(max(${runEvents.seq}), 0) + 1 from ${runEvents} where ${runEvents.runId} = ${event.runId})`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [row] = await db
        .insert(runEvents)
        .values({
          runId: event.runId,
          stepId: event.stepId ?? null,
          seq: nextSeq,
          type: event.type,
          payload: event.payload ?? {},
        })
        .returning({ seq: runEvents.seq, createdAt: runEvents.createdAt });
      if (!row) throw new Error("run_events insert returned no row");
      return row;
    } catch (err) {
      if (isUniqueViolation(err) && attempt < 4) continue;
      throw err;
    }
  }
  throw new Error("run_events seq allocation exhausted retries");
}

/**
 * Decide a pending approval atomically. The `status = 'pending'` predicate makes
 * this a compare-and-swap: a user decision and the expiry worker can't overwrite
 * each other. Returns the updated row, or null if it was no longer pending.
 */
export async function decideApproval(
  db: Db,
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
