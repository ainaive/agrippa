import { beforeAll, describe, expect, it } from "bun:test";
import type { RunQueue } from "@agrippa/core";
import { auditLogs, runtimes } from "@agrippa/db";
import { InProcessEventBus } from "@agrippa/orchestration";
import { eq } from "drizzle-orm";
import type { App } from "../app";
import { createApp } from "../app";
import { freshTestDb, jsonOf, postgresAvailable, signUp, type TestClient } from "./helpers";

const dbUp = await postgresAvailable();

type RuntimeRow = {
  id: string;
  name: string;
  tokenPrefix: string;
  status: string;
  hostname: string | null;
  executors: Array<{ id: string; envAuthProviders?: string[] }>;
  lastSeenAt: string | null;
  registeredAt: string | null;
  token?: string;
};

describe.skipIf(!dbUp)("runtime daemons: tokens, register, heartbeat", () => {
  let app: App;
  let db: Awaited<ReturnType<typeof freshTestDb>>;
  let admin: TestClient;
  let member: TestClient;
  let runtimeId: string;
  let token: string;

  const fakeQueue: RunQueue = {
    enqueueRun: async () => {},
    enqueueApprovalExpiry: async () => {},
    enqueueNotificationDelivery: async () => {},
  };

  const daemonRequest = (path: string, body: unknown, auth = token) =>
    app.request(`/api/daemon${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    db = await freshTestDb();
    app = createApp({ db, queue: fakeQueue, bus: new InProcessEventBus() });
    admin = await signUp(app, "Root", "root@example.com");
    member = await signUp(app, "Mia", "mia@example.com");
  });

  it("issues a token exactly once, hash-only at rest, admin-gated", async () => {
    expect(
      (await member.request("/api/v1/runtimes", { method: "POST", json: { name: "laptop" } }))
        .status,
    ).toBe(403);

    const created = await jsonOf<RuntimeRow>(
      await admin.request("/api/v1/runtimes", { method: "POST", json: { name: "dev-laptop" } }),
    );
    runtimeId = created.id;
    token = created.token as string;
    expect(token.startsWith("agrd_")).toBe(true);
    expect(created.tokenPrefix).toBe(token.slice(0, 12));

    // hash-only at rest; the list never returns the token again
    const [row] = await db.select().from(runtimes).where(eq(runtimes.id, runtimeId));
    expect(row?.tokenHash).not.toContain(token.slice(5));
    const listed = await jsonOf<RuntimeRow[]>(await admin.request("/api/v1/runtimes"));
    expect(listed[0]?.token).toBeUndefined();
    expect(listed[0]?.registeredAt).toBeNull();

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "runtime.create"));
    expect(audits).toHaveLength(1);
  });

  it("register authenticates by token, records the advertisement, audits with the runtime actor", async () => {
    expect(
      (await daemonRequest("/register", { hostname: "x", executors: [] }, "agrd_wrong")).status,
    ).toBe(401);
    expect(
      (await daemonRequest("/register", { hostname: "x", executors: [] }, "not-a-token")).status,
    ).toBe(401);

    const res = await daemonRequest("/register", {
      hostname: "mba.local",
      version: "0.1.0",
      executors: [{ id: "claude-agent-sdk", envAuthProviders: ["anthropic"] }],
    });
    expect(res.status).toBe(200);
    const body = await jsonOf<{ runtimeId: string; hints: { keepaliveSec: number } }>(res);
    expect(body.runtimeId).toBe(runtimeId);
    expect(body.hints.keepaliveSec).toBeGreaterThan(0);

    const [row] = await db.select().from(runtimes).where(eq(runtimes.id, runtimeId));
    expect(row?.hostname).toBe("mba.local");
    expect(row?.registeredAt).not.toBeNull();
    expect(row?.lastSeenAt).not.toBeNull();
    expect(row?.executors.map((e) => e.id)).toEqual(["claude-agent-sdk"]);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "runtime.register"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorRuntimeId).toBe(runtimeId);
    expect(audits[0]?.actorUserId).toBeNull();
  });

  it("heartbeat bumps lastSeenAt and is not audited", async () => {
    const [before] = await db.select().from(runtimes).where(eq(runtimes.id, runtimeId));
    await Bun.sleep(10);
    expect((await daemonRequest("/heartbeat", {})).status).toBe(200);
    const [after] = await db.select().from(runtimes).where(eq(runtimes.id, runtimeId));
    expect(after?.lastSeenAt?.getTime()).toBeGreaterThan(before?.lastSeenAt?.getTime() ?? 0);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.resourceType, "runtime"));
    expect(audits.map((a) => a.action).sort()).toEqual(["runtime.create", "runtime.register"]);
  });

  it("revoke kills the token immediately", async () => {
    const revoked = await jsonOf<RuntimeRow>(
      await admin.request(`/api/v1/runtimes/${runtimeId}/revoke`, { method: "POST" }),
    );
    expect(revoked.status).toBe("revoked");
    expect((await daemonRequest("/heartbeat", {})).status).toBe(401);
    // revoking again 404s (CAS on active)
    expect(
      (await admin.request(`/api/v1/runtimes/${runtimeId}/revoke`, { method: "POST" })).status,
    ).toBe(404);
  });
});
