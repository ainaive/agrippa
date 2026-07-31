import path from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "./client";

/**
 * Wait until the database schema is at least as new as the one this build
 * expects. The api migrates on boot; the worker only reads and writes, so a
 * worker that starts first would crash on a table (or column) its own code
 * knows about but the database has not been given yet — and a crash-looping
 * worker fails deploy verification, rolling back a perfectly good deploy.
 *
 * Doing this in-process rather than via a compose `depends_on` healthcheck is
 * deliberate: restart policies ignore `depends_on`, so it never covered host
 * reboots, `docker start`, or the VM/systemd topology — and api health proves
 * nothing about the schema when AGRIPPA_MIGRATE_ON_BOOT=0. It also avoids
 * making `compose up -d` block on another service's health, which is what
 * turns a crash-looping api into an unbounded deploy hang.
 */

type JournalEntry = { idx: number; when: number; tag: string };

const JOURNAL_PATH = path.resolve(import.meta.dirname, "../drizzle/meta/_journal.json");

/**
 * The newest migration in THIS build's migrations folder. Derived from the
 * journal rather than a hardcoded table name so it stays correct for every
 * future migration, including column-only ones that a table-existence probe
 * would sail straight past.
 */
export async function expectedSchema(): Promise<{ when: number; tag: string } | null> {
  const journal = (await Bun.file(JOURNAL_PATH).json()) as { entries?: JournalEntry[] };
  const latest = journal.entries?.at(-1);
  return latest ? { when: latest.when, tag: latest.tag } : null;
}

/** What the database has applied; null when the journal table is not there yet. */
async function appliedMillis(db: Db): Promise<number | null> {
  try {
    const rows = (await db.execute(
      sql`select coalesce(max(created_at), 0)::bigint as at from drizzle.__drizzle_migrations`,
    )) as Array<{ at: string | number }>;
    return Number(rows[0]?.at ?? 0);
  } catch {
    // missing schema/table (first boot) and transient connection errors are
    // both just "not ready yet" — a single statement cannot branch on it
    return null;
  }
}

export type AwaitSchemaOptions = {
  /**
   * Must exceed deploy.sh's HEALTH_TIMEOUT: if the schema never arrives, the
   * fallback crash then lands AFTER deploy verification has already given up,
   * so the deploy fails as "worker never became ready" (true, and legible)
   * rather than as a RestartCount mismatch (which reads like a crash loop).
   */
  timeoutMs?: number;
  pollMs?: number;
  logEveryMs?: number;
  log?: (message: string) => void;
};

/**
 * Poll until the applied schema reaches this build's expectation. Returns true
 * when it does, false on timeout — the caller proceeds either way, so a
 * genuinely misconfigured deployment (migrations disabled and never applied
 * out of band) crash-loops visibly instead of idling as a healthy-looking
 * container that consumes nothing.
 */
export async function awaitSchema(db: Db, opts: AwaitSchemaOptions = {}): Promise<boolean> {
  const { timeoutMs = 300_000, pollMs = 2_000, logEveryMs = 30_000, log = () => {} } = opts;
  const expected = await expectedSchema();
  if (!expected) return true; // no migrations in this build — nothing to wait for

  const deadline = Date.now() + timeoutMs;
  let lastLog = 0;
  for (;;) {
    const applied = await appliedMillis(db);
    if (applied !== null && applied >= expected.when) return true;
    if (Date.now() >= deadline) {
      log(
        `schema never reached ${expected.tag} after ${Math.round(timeoutMs / 1000)}s — continuing; writes may fail until migrations run`,
      );
      return false;
    }
    if (Date.now() - lastLog >= logEveryMs) {
      lastLog = Date.now();
      // both sides named: this one line is the whole diagnosis at 3am
      log(
        `waiting for schema ${expected.tag} (database at ${applied === null ? "no migrations applied" : applied})`,
      );
    }
    await Bun.sleep(pollMs);
  }
}
