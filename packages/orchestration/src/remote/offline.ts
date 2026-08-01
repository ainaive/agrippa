import { type Db, runs, runtimes } from "@agrippa/db";
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
