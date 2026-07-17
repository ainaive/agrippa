import path from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import type { Db } from "./client";

const MIGRATIONS_FOLDER = path.resolve(import.meta.dirname, "../drizzle");

/**
 * Runs pending migrations under a Postgres advisory lock so concurrent
 * boots (api + N workers) never race each other.
 */
export async function migrateDb(db: Db): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_lock(727270001)`);
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(727270001)`);
  }
}
