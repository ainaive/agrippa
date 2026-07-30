import { type Db, workerHeartbeats } from "@agrippa/db";
import { lt, sql } from "drizzle-orm";

/**
 * Per-container liveness rows (issue #15). Registrations are global per
 * executor, so they cannot prove each replica came up; deploy verification
 * (infra/deploy.sh worker_ok) counts fresh consumers_ready_at rows instead —
 * one per expected replica.
 */

/**
 * Call only after boss.work() has returned for every consumer. Writing it any
 * earlier reopens the register-then-wedge gap this row exists to close: a
 * worker that hangs in consumer setup must never look ready.
 */
export async function markConsumersReady(db: Db, containerId: string): Promise<void> {
  const now = new Date();
  await db
    .insert(workerHeartbeats)
    .values({ containerId, startedAt: now, consumersReadyAt: now, heartbeatAt: now })
    .onConflictDoUpdate({
      target: workerHeartbeats.containerId,
      set: { consumersReadyAt: now, heartbeatAt: now },
    });
  // containers are recreated on every deploy, so rows accumulate one per
  // container forever; a week of silence is far past any freshness window
  await db
    .delete(workerHeartbeats)
    .where(lt(workerHeartbeats.heartbeatAt, sql`now() - interval '7 days'`));
}

/** Sweeper-interval liveness bump; never touches consumersReadyAt. */
export async function touchWorkerHeartbeat(db: Db, containerId: string): Promise<void> {
  const now = new Date();
  await db
    .insert(workerHeartbeats)
    .values({ containerId, startedAt: now, heartbeatAt: now })
    .onConflictDoUpdate({
      target: workerHeartbeats.containerId,
      set: { heartbeatAt: now },
    });
}
