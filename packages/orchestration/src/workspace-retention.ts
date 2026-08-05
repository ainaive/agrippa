import { type Db, runs } from "@agrippa/db";
import { type SQL, sql } from "drizzle-orm";

/**
 * Workspace retention (ADR-0018 Decision 4).
 *
 * Deleting a workspace used to be a side effect of finalizing a run, which
 * only works while a directory belongs to exactly one run. A follow-up
 * continues its ancestor's workspace, so the directory has to outlive the run
 * that made it: finalize now *releases* — stamping an expiry — and collection
 * is a policy the server owns while each host owns its own filesystem, the
 * same split ADR-0017 made for credentials.
 *
 * The grouping is what makes it safe. A workspace is collectable only when
 * EVERY run sharing its key has released it (a live run's expiry is NULL) and
 * the LATEST of those expiries has passed — so a follow-up extends its
 * ancestor's workspace merely by existing, and no writer has to reason about
 * who else is using the directory.
 */

/**
 * How long a finished run's workspace survives, and therefore how long its
 * result can be steered — the two are the same number (ADR-0018 Decision 7):
 * a follow-up attaches to the ancestor's directory, so once it is collected
 * the only honest answer is `workspace_lost`.
 *
 * ADR-0018 Decision 4 proposed defaulting to zero to preserve today's
 * behaviour until the collector was proven. Building Decision 7 showed the
 * two cannot both hold: at zero the ancestor's workspace is collected on the
 * next sweeper tick, so the follow-up a human types a minute later always
 * fails. One hour is the smallest default that makes the feature real —
 * enough to read a result and reply, short enough that a busy instance is not
 * holding shallow clones all day. Raise it to inspect finished trees, set it
 * to 0 to restore the old immediate collection (and give up steering).
 *
 * A live run in the chain holds its workspace regardless: eligibility is a
 * property of the GROUP, so retention never races an unfinished follow-up.
 */
const DEFAULT_RETENTION_MINUTES = 60;

/** Env is read per call: the daemon sets its root/config after import time. */
function retentionMinutes(): number {
  const raw = process.env.AGRIPPA_WORKSPACE_RETENTION_MINUTES;
  if (raw === undefined || raw === "") return DEFAULT_RETENTION_MINUTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RETENTION_MINUTES;
}

/**
 * When a run finalizing right now stops holding its workspace.
 *
 * An expression rather than a statement, because the write belongs INSIDE
 * `finalizeRun`'s CAS: releasing is part of finalizing, and every path that
 * finalizes — the engine, the API's cancel of a queued or paused run, the
 * worker's retry-exhaustion — must release. Doing it as a follow-up statement
 * gave retention only to the engine's path and made a lost write possible;
 * inside the transaction it happens exactly once, or not at all.
 */
export function workspaceExpiryAt(): SQL {
  return sql`now() + ${sql.raw(String(retentionMinutes()))} * interval '1 minute'`;
}

/**
 * Workspace keys nothing needs any more: every run sharing the key has
 * released it and the group's latest expiry has passed.
 *
 * A run reads as released when it has an expiry OR simply a `finished_at`,
 * and that fallback covers two cases that would otherwise leak a directory
 * forever. Runs that finalized before retention existed have no expiry (the
 * engine deleted their workspace on the spot), and a release write lost to a
 * database blip leaves the same shape. Falling back to `finished_at` means
 * such a workspace is collectable immediately rather than never — it gives up
 * that run's steering window, which is the right way round: the window is a
 * convenience, an unreclaimable directory is not.
 *
 * `scope` picks whose filesystem is being asked about — the central hosts
 * (runs with no runtime pin) or one daemon's. Bounded by a window rather than
 * an acknowledgement, exactly like the daemon's abort piggyback: deletion is
 * idempotent, so repeating a key costs a syscall, while anything that falls
 * out of the window is collected by the host's own age-based sweep.
 */
export async function expiredWorkspaceKeys(
  db: Db,
  scope: { runtimeId: string | null; windowHours?: number; limit?: number },
): Promise<string[]> {
  const windowHours = scope.windowHours ?? 24;
  const limit = scope.limit ?? 200;
  const rows = (await db.execute(sql`
    select r.workspace_key as "workspaceKey"
    from ${runs} r
    where ${
      scope.runtimeId === null ? sql`r.runtime_id is null` : sql`r.runtime_id = ${scope.runtimeId}`
    }
    group by r.workspace_key
    having bool_and(coalesce(r.workspace_expires_at, r.finished_at) is not null)
       and max(coalesce(r.workspace_expires_at, r.finished_at)) < now()
       and max(coalesce(r.workspace_expires_at, r.finished_at)) >
           now() - ${sql.raw(String(windowHours))} * interval '1 hour'
    limit ${sql.raw(String(limit))}
  `)) as unknown as Array<{ workspaceKey: string }>;
  return rows.map((row) => row.workspaceKey);
}

/**
 * Whether this workspace is past the point where the platform still promises
 * it exists — every run sharing the key released it and the latest expiry has
 * passed, i.e. the collector is entitled to have taken it.
 *
 * The follow-up endpoint asks this before creating anything: the alternative
 * is a run that reaches a worker, finds an empty directory, and fails
 * `workspace_lost` — a charge, a timeline entry, and a notification for
 * something the server could have answered as a 409.
 */
export async function workspaceCollectable(db: Db, workspaceKey: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    select bool_and(coalesce(r.workspace_expires_at, r.finished_at) is not null)
       and max(coalesce(r.workspace_expires_at, r.finished_at)) < now() as "collectable"
    from ${runs} r
    where r.workspace_key = ${workspaceKey}
  `)) as unknown as Array<{ collectable: boolean | null }>;
  return rows[0]?.collectable === true;
}

/**
 * Delete the central workspaces that have expired. Runs as one sweeper stage
 * on every worker: the deletes are idempotent and a worker that does not hold
 * a directory simply removes nothing, so a fleet sharing the workspaces volume
 * collects exactly once and a fleet that does not still collects on whichever
 * host actually has the files.
 */
export async function collectExpiredWorkspaces(opts: {
  db: Db;
  remove: (workspaceKey: string) => Promise<void>;
  logger: { info(message: string): void; warn(message: string): void };
  /**
   * Keys already collected by this process, with when — so a key named on
   * every tick for the rest of its window costs a lookup rather than an
   * `rm -rf`, and the memory is bounded by that window rather than by uptime.
   * A plain Set never evicted, which on a long-lived worker is a slow leak of
   * exactly the kind this module exists to stop on disk.
   */
  collected: Map<string, number>;
  windowHours?: number;
}): Promise<number> {
  // the debugging escape hatch keeps its meaning: nothing is deleted, so a
  // finished run's tree stays on disk for as long as the operator wants
  if (process.env.AGRIPPA_KEEP_WORKSPACES === "1") return 0;

  const windowHours = opts.windowHours ?? 24;
  const cutoff = Date.now() - windowHours * 60 * 60 * 1000;
  for (const [key, at] of opts.collected) {
    // past the window the query stops naming it, so remembering it is pointless
    if (at < cutoff) opts.collected.delete(key);
  }

  const keys = await expiredWorkspaceKeys(opts.db, { runtimeId: null, windowHours });
  let removed = 0;
  for (const key of keys) {
    if (opts.collected.has(key)) continue;
    try {
      await opts.remove(key);
      opts.collected.set(key, Date.now());
      removed += 1;
    } catch (err) {
      opts.logger.warn(`workspace collection failed for ${key}: ${String(err)}`);
    }
  }
  if (removed > 0) opts.logger.info(`collected ${removed} expired workspace(s)`);
  return removed;
}
