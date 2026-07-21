import { randomBytes } from "node:crypto";
import path from "node:path";
import { accounts, createDb, type Db, migrateDb, orgs, seed, users, uuidv7 } from "@agrippa/db";
import { seedBuiltinTemplates } from "@agrippa/orchestration";
import { hashPassword } from "better-auth/crypto";
import { count, eq, sql } from "drizzle-orm";
import type { App } from "../app";

process.env.AGRIPPA_SECRET_KEY ??= randomBytes(32).toString("base64");

const TEMPLATES_DIR = path.resolve(import.meta.dirname, "../../../../templates");

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/agrippa_test";

// one pool for all API suites — a pool per call exhausts max_connections
let sharedDb: Db | null = null;
function testDb(): Db {
  sharedDb ??= createDb(TEST_DATABASE_URL);
  return sharedDb;
}

/** True when the test database is reachable; suites skip themselves otherwise. */
export async function postgresAvailable(): Promise<boolean> {
  try {
    await testDb().execute(sql`select 1`);
    return true;
  } catch {
    console.warn(
      `[test] postgres not reachable at ${TEST_DATABASE_URL} — skipping integration suite`,
    );
    return false;
  }
}

/** Fresh schema per test run: drop everything, migrate, seed builtins. */
export async function freshTestDb(): Promise<Db> {
  const db = testDb();
  await db.execute(sql`drop schema public cascade`);
  await db.execute(sql`create schema public`);
  // the migrator journals into its own "drizzle" schema — reset it too,
  // or migrations silently no-op on the second run
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await migrateDb(db);
  await seed(db);
  await seedBuiltinTemplates(db, TEMPLATES_DIR);
  return db;
}

export type TestClient = {
  /** Fetch with this user's session cookie and JSON body handling. */
  request: (path: string, init?: RequestInit & { json?: unknown }) => Promise<Response>;
  email: string;
};

/**
 * Creates a test user and returns a cookie-bound client. Self-sign-up is
 * closed in app.ts, so users are created directly (mirroring the
 * bootstrap-admin / accept-invite path) and then signed in via the real
 * /api/auth/sign-in/email endpoint to get a genuine session cookie. The first
 * user becomes org_admin, the rest org_member — matching the bootstrap
 * convention.
 */
export async function signUp(app: App, name: string, email: string): Promise<TestClient> {
  const db = testDb();
  const [row] = await db.select({ n: count() }).from(users);
  const orgRole = (row?.n ?? 0) === 0 ? "org_admin" : "org_member";
  const [org] = await db.select().from(orgs).where(eq(orgs.slug, "default"));
  if (!org) throw new Error("test db: default org missing — did freshTestDb() run?");

  const userId = uuidv7();
  const password = "correct-horse-battery";
  const hash = await hashPassword(password);
  await db.insert(users).values({
    id: userId,
    name,
    email,
    orgId: org.id,
    orgRole,
    locale: "en",
  } as typeof users.$inferInsert);
  await db.insert(accounts).values({
    id: uuidv7(),
    userId,
    providerId: "credential",
    accountId: userId,
    password: hash,
  } as typeof accounts.$inferInsert);

  const res = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) {
    throw new Error(`sign-in failed (${res.status}): ${await res.text()}`);
  }
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-in returned no session cookie");
  const cookie = setCookie
    .split(",")
    .map((part) => part.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");

  return {
    email,
    request: async (path, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cookie", cookie);
      let body = init.body;
      if (init.json !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(init.json);
      }
      return await app.request(path, { ...init, headers, body });
    },
  };
}

/** Typed JSON body accessor — Bun types Response.json() as unknown. */
export async function jsonOf<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
