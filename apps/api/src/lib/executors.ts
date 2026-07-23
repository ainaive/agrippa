import { type Db, executorRegistrations } from "@agrippa/db";
import { gte, sql } from "drizzle-orm";

/** Registrations older than this are a worker that no longer runs that config. */
const LIVE_WINDOW_MINUTES = 15;

/**
 * The deployment's live executor set, from worker heartbeats. Empty means no
 * worker has advertised recently — callers skip availability checks then,
 * rather than blocking every submission on a fresh deployment.
 */
export async function liveExecutorIds(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ executorId: executorRegistrations.executorId })
    .from(executorRegistrations)
    .where(
      gte(
        executorRegistrations.registeredAt,
        sql`now() - interval '${sql.raw(String(LIVE_WINDOW_MINUTES))} minutes'`,
      ),
    );
  return new Set(rows.map((r) => r.executorId));
}
