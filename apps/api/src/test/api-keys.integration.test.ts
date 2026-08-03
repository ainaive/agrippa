import { beforeAll, describe, expect, it } from "bun:test";
import type { RunQueue } from "@agrippa/core";
import { apiKeys, auditLogs, projectMembers } from "@agrippa/db";
import { and, eq } from "drizzle-orm";
import type { App } from "../app";
import { createApp } from "../app";
import {
  freshTestDb,
  jsonOf,
  makeFakeQueue,
  postgresAvailable,
  signUp,
  type TestClient,
} from "./helpers";

const dbUp = await postgresAvailable();

type KeyRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  projectId: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  key?: string;
};

describe.skipIf(!dbUp)("project API keys (Bearer agr_…)", () => {
  let app: App;
  let db: Awaited<ReturnType<typeof freshTestDb>>;
  let admin: TestClient;
  let outsider: TestClient;
  let projectId: string;
  let otherProjectId: string;
  let taskTypeId: string;

  const fakeQueue: RunQueue = makeFakeQueue();

  /** A request authenticated by an API key rather than a session cookie. */
  const withKey = (key: string, path: string, init: RequestInit & { json?: unknown } = {}) => {
    const { json, ...rest } = init;
    return app.request(`/api/v1${path}`, {
      ...rest,
      headers: {
        ...(json ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${key}`,
      },
      ...(json ? { body: JSON.stringify(json) } : {}),
    });
  };

  const issueKey = async (scopes: string[], onProject = projectId, expiresDays?: number) =>
    jsonOf<KeyRow>(
      await admin.request(`/api/v1/projects/${onProject}/api-keys`, {
        method: "POST",
        json: { name: `k-${scopes.join("-")}-${Math.random()}`, scopes, expiresDays },
      }),
    );

  beforeAll(async () => {
    db = await freshTestDb();
    app = createApp({ db, queue: fakeQueue });
    admin = await signUp(app, "Root", "root@example.com");
    outsider = await signUp(app, "Otto", "otto@example.com");

    const mk = async (slug: string) =>
      (
        await jsonOf<{ id: string }>(
          await admin.request("/api/v1/projects", { method: "POST", json: { slug, name: slug } }),
        )
      ).id;
    projectId = await mk("keys-main");
    otherProjectId = await mk("keys-other");

    const types = await jsonOf<Array<{ id: string; slug: string }>>(
      await admin.request("/api/v1/scenarios/project-management/task-types"),
    );
    taskTypeId = types.find((t) => t.slug === "weekly-report")?.id as string;
  });

  // ── issuance ───────────────────────────────────────────────────────────────

  it("shows the plaintext exactly once and stores only its hash", async () => {
    const created = await issueKey(["runs:read"]);
    expect(created.key).toBeDefined();
    expect(created.key?.startsWith("agr_")).toBe(true);
    expect(created.prefix).toBe(created.key?.slice(0, 12) as string);

    const [stored] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id));
    expect(stored?.keyHash).toBeDefined();
    expect(stored?.keyHash).not.toContain(created.key as string);

    // the list view never returns the hash or the plaintext again
    const listed = await jsonOf<KeyRow[]>(
      await admin.request(`/api/v1/projects/${projectId}/api-keys`),
    );
    const row = listed.find((k) => k.id === created.id) as KeyRow & { keyHash?: string };
    expect(row.key).toBeUndefined();
    expect(row.keyHash).toBeUndefined();
  });

  it("is project-admin gated and audited", async () => {
    expect(
      (
        await outsider.request(`/api/v1/projects/${projectId}/api-keys`, {
          method: "POST",
          json: { name: "sneaky", scopes: ["runs:read"] },
        })
      ).status,
    ).toBe(403);

    const created = await issueKey(["runs:read"]);
    const [row] = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, "project.apikey.create"), eq(auditLogs.resourceId, created.id)),
      );
    expect(row).toBeDefined();
    expect(row?.projectId).toBe(projectId);
  });

  it("rejects a key that grants nothing", async () => {
    const res = await admin.request(`/api/v1/projects/${projectId}/api-keys`, {
      method: "POST",
      json: { name: "empty", scopes: [] },
    });
    expect(res.status).toBe(400);
  });

  // ── authentication ─────────────────────────────────────────────────────────

  it("authenticates a valid key and rejects unknown, revoked, and expired ones alike", async () => {
    const live = await issueKey(["runs:read"]);
    expect((await withKey(live.key as string, `/projects/${projectId}/tasks`)).status).toBe(200);

    // unknown
    const unknown = await withKey("agr_deadbeefdeadbeef", `/projects/${projectId}/tasks`);
    expect(unknown.status).toBe(401);
    expect((await jsonOf<{ code: string }>(unknown)).code).toBe("api_key_invalid");

    // revoked — same code, so a probe learns nothing from the difference
    const revoked = await issueKey(["runs:read"]);
    await admin.request(`/api/v1/projects/${projectId}/api-keys/${revoked.id}/revoke`, {
      method: "POST",
    });
    const afterRevoke = await withKey(revoked.key as string, `/projects/${projectId}/tasks`);
    expect(afterRevoke.status).toBe(401);
    expect((await jsonOf<{ code: string }>(afterRevoke)).code).toBe("api_key_invalid");

    // expired
    const expiring = await issueKey(["runs:read"], projectId, 1);
    await db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeys.id, expiring.id));
    const afterExpiry = await withKey(expiring.key as string, `/projects/${projectId}/tasks`);
    expect(afterExpiry.status).toBe(401);
    expect((await jsonOf<{ code: string }>(afterExpiry)).code).toBe("api_key_invalid");
  });

  it("records last_used_at on use", async () => {
    const key = await issueKey(["runs:read"]);
    expect(key.lastUsedAt).toBeNull();
    await withKey(key.key as string, `/projects/${projectId}/tasks`);
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
    expect(row?.lastUsedAt).not.toBeNull();
  });

  // ── scopes ─────────────────────────────────────────────────────────────────

  it("enforces scopes per route", async () => {
    const readOnly = await issueKey(["runs:read"]);
    const writeOnly = await issueKey(["tasks:write"]);

    // read key cannot submit
    const denied = await withKey(readOnly.key as string, `/projects/${projectId}/tasks`, {
      method: "POST",
      json: { taskTypeId, title: "nope", params: {} },
    });
    expect(denied.status).toBe(403);

    // write key cannot read the catalog it wasn't scoped for
    expect((await withKey(writeOnly.key as string, "/scenarios")).status).toBe(403);

    // and the scope it does have works
    expect((await withKey(readOnly.key as string, `/projects/${projectId}/tasks`)).status).toBe(
      200,
    );
  });

  it("refuses every route outside the allow-list, including admin surfaces", async () => {
    // an org_admin issued this key; it must still not administer anything
    const key = await issueKey(["tasks:write", "runs:read", "resources:read"]);
    for (const path of [
      "/me",
      "/models",
      "/skills",
      "/runtimes",
      "/audit-logs",
      "/fleet/workers",
      "/checkpoints/pending",
      `/projects/${projectId}`,
      `/projects/${projectId}/api-keys`,
      `/projects/${projectId}/quota`,
      `/projects/${projectId}/members`,
    ]) {
      expect({ path, status: (await withKey(key.key as string, path)).status }).toEqual({
        path,
        status: 403,
      });
    }
  });

  // ── project binding ────────────────────────────────────────────────────────

  it("cannot reach a project it is not bound to", async () => {
    const key = await issueKey(["runs:read", "tasks:write"], projectId);
    const res = await withKey(key.key as string, `/projects/${otherProjectId}/tasks`);
    expect(res.status).toBe(403);

    const submit = await withKey(key.key as string, `/projects/${otherProjectId}/tasks`, {
      method: "POST",
      json: { taskTypeId, title: "cross-project", params: {} },
    });
    expect(submit.status).toBe(403);
  });

  // ── submission, attribution, revocation of the owner ───────────────────────

  it("submits a task and audits the key as the actor alongside its owner", async () => {
    const key = await issueKey(["tasks:write"]);
    const res = await withKey(key.key as string, `/projects/${projectId}/tasks`, {
      method: "POST",
      json: {
        taskTypeId,
        title: "from a script",
        params: { dateRange: "2026.07.27-2026.08.02", rawNotes: "shipped Track T1" },
      },
    });
    expect(res.status).toBe(202);
    const { taskId } = await jsonOf<{ taskId: string; runId: string }>(res);

    const [row] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "task.submit"), eq(auditLogs.resourceId, taskId)));
    // the key is named, and so is the human accountable for it
    expect(row?.actorApiKeyId).toBe(key.id);
    expect(row?.actorUserId).toBeTruthy();
  });

  it("stops working when its owner loses project membership", async () => {
    const key = await issueKey(["runs:read"]);
    expect((await withKey(key.key as string, `/projects/${projectId}/tasks`)).status).toBe(200);

    const [owner] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
    await db
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, owner?.createdBy as string),
        ),
      );

    expect((await withKey(key.key as string, `/projects/${projectId}/tasks`)).status).toBe(403);
  });
});
