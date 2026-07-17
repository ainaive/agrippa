import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema";

export function createDb(url: string | undefined = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = new SQL({ url, max: 10 });
  return drizzle({ client, schema });
}

export type Db = ReturnType<typeof createDb>;

/** The transaction handle drizzle passes to a `db.transaction(async (tx) => …)` callback. */
export type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Either a pooled connection or an open transaction — the query-capable surface
 * shared by both. Helpers that must be able to run inside a caller's transaction
 * accept this rather than `Db` (which additionally exposes `$client`).
 */
export type DbOrTx = Db | Transaction;
