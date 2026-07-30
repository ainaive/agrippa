import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema";

export function createDb(url: string | undefined = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  // Parse before handing it to Bun, purely for the error message. A password
  // containing `/` terminates the URL's authority component, so the whole URL
  // becomes unparseable and the failure surfaces at api boot as a generic parse
  // error naming neither the password nor DATABASE_URL. That is not theoretical:
  // this file's own .env.example recommended `openssl rand -base64 24` for a
  // while, whose alphabet includes `/` — about a 40% chance per password.
  try {
    new URL(url);
  } catch {
    throw new Error(
      "DATABASE_URL is not a valid URL. If the password contains any of / ? # @ : " +
        "they must be percent-encoded (%2F %3F %23 %40 %3A) — generate one with " +
        "`openssl rand -hex 24` to avoid the problem entirely.",
    );
  }
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
