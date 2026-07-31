import { type Db, workerHeartbeats } from "@agrippa/db";
import { lt, sql } from "drizzle-orm";

/**
 * Per-container liveness rows (issue #15). Registrations are global per
 * executor, so they cannot prove each replica came up; deploy verification
 * (infra/deploy.sh worker_ok) counts fresh consumers_ready_at rows instead —
 * one per expected replica.
 *
 * All timestamps are written with the DATABASE clock (`now()`): the deploy
 * freshness window and the prune predicate compare against Postgres `now()`,
 * and a skewed worker clock must not shift rows in or out of either.
 */
const DB_NOW = sql`now()`;

/**
 * How long boot waits for the api to finish migrating (see awaitSchema).
 *
 * MUST stay above deploy.sh's HEALTH_TIMEOUT default (180s): the point is that
 * if the schema never arrives, the worker is still *waiting* — running,
 * restart-steady, simply not ready — for the whole of deploy verification, so
 * the deploy fails as "worker never became ready" instead of as a RestartCount
 * mismatch that reads like a crash loop. A cross-file test guards the ordering.
 */
export const WORKER_SCHEMA_WAIT_MS = 300_000;

/**
 * First write of every boot, before anything else touches the DB: a restarted
 * container surrenders the previous boot's readiness, so a boot that wedges
 * anywhere in consumer setup cannot coast on a stale consumers_ready_at.
 */
export async function markBootStarted(db: Db, containerId: string): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({ containerId, startedAt: DB_NOW, heartbeatAt: DB_NOW })
    .onConflictDoUpdate({
      target: workerHeartbeats.containerId,
      set: { startedAt: DB_NOW, consumersReadyAt: null, heartbeatAt: DB_NOW },
    });
}

/**
 * Call only after boss.work() has returned for every consumer. Writing it any
 * earlier reopens the register-then-wedge gap this row exists to close: a
 * worker that hangs in consumer setup must never look ready.
 */
export async function markConsumersReady(db: Db, containerId: string): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({ containerId, startedAt: DB_NOW, consumersReadyAt: DB_NOW, heartbeatAt: DB_NOW })
    .onConflictDoUpdate({
      target: workerHeartbeats.containerId,
      set: { consumersReadyAt: DB_NOW, heartbeatAt: DB_NOW },
    });
  // containers are recreated on every deploy, so rows accumulate one per
  // container forever; a week of silence is far past any freshness window
  await db
    .delete(workerHeartbeats)
    .where(lt(workerHeartbeats.heartbeatAt, sql`now() - interval '7 days'`));
}

/** Sweeper-interval liveness bump; never touches consumersReadyAt. */
export async function touchWorkerHeartbeat(db: Db, containerId: string): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({ containerId, startedAt: DB_NOW, heartbeatAt: DB_NOW })
    .onConflictDoUpdate({
      target: workerHeartbeats.containerId,
      set: { heartbeatAt: DB_NOW },
    });
}
