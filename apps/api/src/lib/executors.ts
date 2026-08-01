import { type Db, executorRegistrations, workerHeartbeats } from "@agrippa/db";
import { gte, sql } from "drizzle-orm";

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
 * The deployment's live executor capability, from per-worker heartbeats. The
 * deployment-wide `executor_registrations` rows are unioned in as a fallback
 * until the table is dropped post-merge — during deploy skew an old worker
 * heartbeats without an advertisement, and its executors must not read as
 * vanished.
 */
export async function liveWorkerExecutors(db: Db): Promise<LiveWorkerExecutors> {
  const workers = await db
    .select({ executors: workerHeartbeats.executors })
    .from(workerHeartbeats)
    .where(gte(workerHeartbeats.heartbeatAt, liveWindow));
  const legacy = await db
    .select({ executorId: executorRegistrations.executorId })
    .from(executorRegistrations)
    .where(gte(executorRegistrations.registeredAt, liveWindow));
  const sets = workers.map((w) => (w.executors ?? []).map((e) => e.id));
  return {
    union: new Set([...sets.flat(), ...legacy.map((r) => r.executorId)]),
    sets,
  };
}

/**
 * The deployment's live executor set (union). Empty means no worker has
 * advertised recently — callers skip availability checks then, rather than
 * blocking every submission on a fresh deployment.
 */
export async function liveExecutorIds(db: Db): Promise<Set<string>> {
  return (await liveWorkerExecutors(db)).union;
}
