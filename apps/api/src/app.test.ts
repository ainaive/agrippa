import { describe, expect, it } from "bun:test";
import type { Db } from "@agrippa/db";
import { createApp } from "./app";
import type { Auth } from "./auth";

const stubAuth = {
  handler: async () => new Response("stub"),
  api: { getSession: async () => null },
} as unknown as Auth;

describe("api", () => {
  it("healthz reports degraded when the database is unreachable", async () => {
    const app = createApp({ db: null as unknown as Db, auth: stubAuth });
    const res = await app.request("/healthz");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { status: string }).status).toBe("degraded");
  });

  it("healthz reports ok when the database answers", async () => {
    const db = { execute: async () => [{ one: 1 }] } as unknown as Db;
    const app = createApp({ db, auth: stubAuth });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 401 with our error shape when unauthenticated", async () => {
    const app = createApp({ db: null as unknown as Db, auth: stubAuth });
    const res = await app.request("/api/v1/me");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("unauthorized");
  });
});
