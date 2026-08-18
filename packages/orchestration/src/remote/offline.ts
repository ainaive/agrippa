import { type Db, dispatches, runs, runtimes } from "@agrippa/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { appendRunEvent } from "../engine/run-lifecycle";

/** A runtime is presumed dead after this much silence (20× its heartbeat). */
const OFFLINE_AFTER_SECONDS = 300;

/**
 * Runtime-offline notifications (the Track N deferral, ADR-0017): flag active
 * runtimes silent past the threshold and append a `runtime.offline` event to
 * every RUNNING run pinned to them — the event-derived notification pipeline
 * does the rest (delivery rows dedupe on (endpoint, event)). The watermark
 * UPDATE is the CAS: `notified_offline_at` is set in the same statement that
 * selects the stale rows, so concurrent sweeper replicas notify once, and a
 * later lastSeenAt re-arms it — one notification per outage, not per sweep.
 * Returns the run ids that got an event so the caller can sync deliveries.
 */
export async function sweepOfflineRuntimes(db: Db): Promise<string[]> {
  const wentOffline = await db
    .update(runtimes)
    .set({ notifiedOfflineAt: sql`now()` })
    .where(
      and(
        eq(runtimes.status, "active"),
        isNotNull(runtimes.lastSeenAt),
        sql`${runtimes.lastSeenAt} < now() - interval '${sql.raw(String(OFFLINE_AFTER_SECONDS))} seconds'`,
        sql`(${runtimes.notifiedOfflineAt} is null or ${runtimes.notifiedOfflineAt} < ${runtimes.lastSeenAt})`,
      ),
    )
    .returning({ id: runtimes.id, name: runtimes.name });

  const affected: string[] = [];
  for (const runtime of wentOffline) {
    const pinned = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.runtimeId, runtime.id), eq(runs.status, "running")));
    for (const run of pinned) {
      await appendRunEvent(db, {
        runId: run.id,
        type: "runtime.offline",
        payload: { runtimeId: runtime.id, runtimeName: runtime.name },
      });
      affected.push(run.id);
    }
  }
  return affected;
}

/** Grace for a claimed-but-orphaned dispatch to observe its abort flag. */
export const ORPHANED_DISPATCH_GRACE_MS = 5 * 60_000;

/**
 * Dispatches whose run or step no longer wants them (ADR-0020 Decision 6):
 * the engine died between insert and consumption, a cancelled run left a live
 * dispatch behind, or a settled step's dispatch never learned. The engine's
 * own dispatch path handles its stale predecessors (`abortStalePredecessors`)
 * — this stage is the backstop for dispatches with no live engine to notice.
 *
 * Never-claimed orphans just die (`superseded`, the same code the engine
 * uses). Claimed orphans get the abort flag first — the daemon observes it on
 * its next contact and winds down — and fail after a grace of silence, so a
 * daemon mid-report is not cut off. LIVE dispatches (non-terminal run, step
 * row still running) are untouchable here by construction of the predicate.
 */
export async function sweepOrphanedDispatches(
  db: Db,
  graceMs: number = ORPHANED_DISPATCH_GRACE_MS,
): Promise<{ superseded: number; flagged: number; failed: number }> {
  const grace = sql`${Math.round(graceMs / 1000)} * interval '1 second'`;
  const orphaned = sql`(
    exists (select 1 from runs r where r.id = ${dispatches.runId}
              and r.status in ('succeeded', 'failed', 'cancelled', 'timed_out'))
    or exists (select 1 from run_steps s where s.id = ${dispatches.stepRowId}
                 and s.status in ('succeeded', 'failed', 'cancelled', 'skipped'))
  )`;
  const superseded = await db
    .update(dispatches)
    .set({
      status: "failed",
      result: { code: "superseded", message: "orphaned before any runtime claimed it" },
      finishedAt: sql`now()`,
    })
    .where(and(eq(dispatches.status, "pending"), orphaned))
    .returning({ id: dispatches.id });
  const flagged = await db
    .update(dispatches)
    .set({ abortRequested: true })
    .where(and(eq(dispatches.status, "claimed"), eq(dispatches.abortRequested, false), orphaned))
    .returning({ id: dispatches.id });
  const failed = await db
    .update(dispatches)
    .set({
      status: "failed",
      result: { code: "superseded", message: "orphaned; the runtime never wound it down" },
      finishedAt: sql`now()`,
    })
    .where(
      and(
        eq(dispatches.status, "claimed"),
        eq(dispatches.abortRequested, true),
        orphaned,
        sql`coalesce(${dispatches.lastContactAt}, ${dispatches.createdAt}) < now() - ${grace}`,
      ),
    )
    .returning({ id: dispatches.id });
  return { superseded: superseded.length, flagged: flagged.length, failed: failed.length };
}
