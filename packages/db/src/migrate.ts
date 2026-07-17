import path from "node:path";
import type { SQL } from "bun";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import type { Db } from "./client";

const MIGRATIONS_FOLDER = path.resolve(import.meta.dirname, "../drizzle");
const MIGRATION_LOCK = 727270001;

/**
 * Runs pending migrations under a Postgres advisory lock so concurrent
 * boots (api + N workers) never race each other.
 *
 * The lock is session-scoped, so acquire and release MUST happen on the same
 * connection — a pooled `db.execute` pair can land on different connections,
 * leaving the lock held forever. We reserve one connection for the bracket.
 */
export async function migrateDb(db: Db): Promise<void> {
  const client = db.$client as SQL;
  const reserved = await client.reserve();
  try {
    await reserved`SELECT pg_advisory_lock(${MIGRATION_LOCK})`;
    try {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await reserved`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`;
    }
  } finally {
    reserved.release();
  }
}
