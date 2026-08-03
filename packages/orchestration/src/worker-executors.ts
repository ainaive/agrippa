import { type Db, type DbOrTx, runtimes, workerHeartbeats } from "@agrippa/db";
import { and, eq, gte, sql } from "drizzle-orm";

/** Advertisements older than this are a worker that no longer runs that config. */
const LIVE_WINDOW_MINUTES = 15;

const liveWindow = sql`now() - interval '${sql.raw(String(LIVE_WINDOW_MINUTES))} minutes'`;

export type LiveWorkerExecutors = {
  /** Union across live workers — drives the per-slot availability check. */
  union: Set<string>;
  /**
   * One executor-id set per live worker — drives the coverage check (jobs are
   * routed by executor-set queue, so a run's whole set must fit ONE worker).
   * Empty array = no live workers (fresh deployment): callers skip checks.
   * A worker advertising an empty list (pre-advertisement build, deploy skew)
   * makes the fleet unknowable — callers must skip the coverage check then,
   * which `hasCoveringWorker` handles.
   */
  sets: string[][];
};

/**
 * The deployment's live executor capability, from per-worker heartbeats
 * alone (the deployment-wide `executor_registrations` fallback is gone —
 * every deployed worker advertises per-heartbeat now). With `orgId`, the
 * org's live remote runtimes join both the union and the coverage sets — a
 * daemon-only executor is submittable (ADR-0017).
 */
export async function liveWorkerExecutors(
  db: DbOrTx,
  opts?: { orgId?: string },
): Promise<LiveWorkerExecutors> {
  const workers = await db
    .select({ executors: workerHeartbeats.executors })
    .from(workerHeartbeats)
    .where(gte(workerHeartbeats.heartbeatAt, liveWindow));
  const sets = workers.map((w) => (w.executors ?? []).map((e) => e.id));
  if (opts?.orgId) {
    const liveRuntimes = await db
      .select({ executors: runtimes.executors })
      .from(runtimes)
      .where(
        and(
          eq(runtimes.orgId, opts.orgId),
          eq(runtimes.status, "active"),
          gte(runtimes.lastSeenAt, sql`now() - interval '60 seconds'`),
        ),
      );
    sets.push(...liveRuntimes.map((r) => (r.executors ?? []).map((e) => e.id)));
  }
  return {
    union: new Set(sets.flat()),
    sets,
  };
}

/**
 * The deployment's live executor set (union). Empty means no worker has
 * advertised recently — callers skip availability checks then, rather than
 * blocking every submission on a fresh deployment.
 */
export async function liveExecutorIds(db: DbOrTx): Promise<Set<string>> {
  return (await liveWorkerExecutors(db)).union;
}
