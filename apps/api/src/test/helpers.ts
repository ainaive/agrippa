import { randomBytes } from "node:crypto";
import path from "node:path";
import { createDb, type Db, migrateDb, seed } from "@agrippa/db";
import { seedBuiltinTemplates } from "@agrippa/orchestration";
import { sql } from "drizzle-orm";
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

/** Signs up a user via the real better-auth endpoint and returns a cookie-bound client. */
export async function signUp(app: App, name: string, email: string): Promise<TestClient> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email, password: "correct-horse-battery" }),
  });
  if (res.status !== 200) {
    throw new Error(`sign-up failed (${res.status}): ${await res.text()}`);
  }
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-up returned no session cookie");
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
