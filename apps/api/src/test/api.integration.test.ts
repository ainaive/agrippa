import { beforeAll, describe, expect, it } from "bun:test";
import { auditLogs } from "@agrippa/db";
import { desc } from "drizzle-orm";
import type { App } from "../app";
import { createApp } from "../app";
import { freshTestDb, jsonOf, postgresAvailable, signUp, type TestClient } from "./helpers";

const dbUp = await postgresAvailable();

describe.skipIf(!dbUp)("api integration (auth, projects, RBAC)", () => {
  let app: App;
  let db: Awaited<ReturnType<typeof freshTestDb>>;
  let alice: TestClient; // first user → org_admin, project admin
  let bob: TestClient; // second user → org_member
  let carol: TestClient; // third user, never a member
  let projectId: string;

  beforeAll(async () => {
    db = await freshTestDb();
    app = createApp({ db });
    alice = await signUp(app, "Alice", "alice@example.com");
    bob = await signUp(app, "Bob", "bob@example.com");
    carol = await signUp(app, "Carol", "carol@example.com");
  });

  const userId = async (client: TestClient) =>
    (await jsonOf<{ id: string }>(await client.request("/api/v1/me"))).id;

  it("rejects unauthenticated requests", async () => {
    const res = await app.request("/api/v1/me");
    expect(res.status).toBe(401);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("unauthorized");
  });

  it("first signup becomes org_admin, later ones org_member", async () => {
    const aliceMe = await jsonOf<{ orgRole: string; locale: string }>(
      await alice.request("/api/v1/me"),
    );
    const bobMe = await jsonOf<{ orgRole: string }>(await bob.request("/api/v1/me"));
    expect(aliceMe.orgRole).toBe("org_admin");
    expect(bobMe.orgRole).toBe("org_member");
    expect(aliceMe.locale).toBe("en");
  });

  it("PATCH /me updates locale", async () => {
    const res = await alice.request("/api/v1/me", { method: "PATCH", json: { locale: "zh-CN" } });
    expect(res.status).toBe(200);
    expect((await jsonOf<{ locale: string }>(res)).locale).toBe("zh-CN");
  });

  it("creates a project; creator becomes project admin; audit row written", async () => {
    const res = await alice.request("/api/v1/projects", {
      method: "POST",
      json: { slug: "apollo", name: "Apollo", description: "First project" },
    });
    expect(res.status).toBe(201);
    projectId = (await jsonOf<{ id: string }>(res)).id;

    const me = await jsonOf<{ projects: unknown[] }>(await alice.request("/api/v1/me"));
    expect(me.projects).toEqual([
      expect.objectContaining({ projectId, slug: "apollo", role: "admin" }),
    ]);

    const [lastAudit] = await db
      .select()
      .from(auditLogs)
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(lastAudit?.action).toBe("project.create");
    expect(lastAudit?.projectId).toBe(projectId);
  });

  it("rejects duplicate slug with 409", async () => {
    const res = await alice.request("/api/v1/projects", {
      method: "POST",
      json: { slug: "apollo", name: "Apollo again" },
    });
    expect(res.status).toBe(409);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("slug_taken");
  });

  it("validates input (400 validation_failed)", async () => {
    const res = await alice.request("/api/v1/projects", {
      method: "POST",
      json: { slug: "Bad Slug!", name: "" },
    });
    expect(res.status).toBe(400);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("validation_failed");
  });

  it("non-members get 403; unknown project 404", async () => {
    const forbidden = await bob.request(`/api/v1/projects/${projectId}`);
    expect(forbidden.status).toBe(403);
    const missing = await alice.request(`/api/v1/projects/${Bun.randomUUIDv7()}`);
    expect(missing.status).toBe(404);
  });

  it("admin adds a member by email; unknown email 404; duplicate 409", async () => {
    const add = await alice.request(`/api/v1/projects/${projectId}/members`, {
      method: "POST",
      json: { email: "bob@example.com", role: "viewer" },
    });
    expect(add.status).toBe(201);

    const unknown = await alice.request(`/api/v1/projects/${projectId}/members`, {
      method: "POST",
      json: { email: "nobody@example.com", role: "viewer" },
    });
    expect(unknown.status).toBe(404);

    const dup = await alice.request(`/api/v1/projects/${projectId}/members`, {
      method: "POST",
      json: { email: "bob@example.com", role: "member" },
    });
    expect(dup.status).toBe(409);
  });

  it("RBAC: viewer can read but not mutate; member cannot manage members", async () => {
    const read = await bob.request(`/api/v1/projects/${projectId}`);
    expect(read.status).toBe(200);
    expect((await jsonOf<{ role: string }>(read)).role).toBe("viewer");

    const patchAsViewer = await bob.request(`/api/v1/projects/${projectId}`, {
      method: "PATCH",
      json: { name: "Hacked" },
    });
    expect(patchAsViewer.status).toBe(403);

    const bobId = await userId(bob);
    const toMember = await alice.request(`/api/v1/projects/${projectId}/members/${bobId}`, {
      method: "PATCH",
      json: { role: "member" },
    });
    expect(toMember.status).toBe(200);

    const addAsMember = await bob.request(`/api/v1/projects/${projectId}/members`, {
      method: "POST",
      json: { email: "carol@example.com", role: "viewer" },
    });
    expect(addAsMember.status).toBe(403);

    const outsider = await carol.request(`/api/v1/projects/${projectId}/members`);
    expect(outsider.status).toBe(403);
  });

  it("cannot demote or remove the last admin", async () => {
    const aliceId = await userId(alice);
    const demote = await alice.request(`/api/v1/projects/${projectId}/members/${aliceId}`, {
      method: "PATCH",
      json: { role: "member" },
    });
    expect(demote.status).toBe(409);
    expect((await jsonOf<{ code: string }>(demote)).code).toBe("last_admin");

    const remove = await alice.request(`/api/v1/projects/${projectId}/members/${aliceId}`, {
      method: "DELETE",
    });
    expect(remove.status).toBe(409);
  });

  it("quota: admin sets, viewer reads, member cannot write", async () => {
    const put = await alice.request(`/api/v1/projects/${projectId}/quota`, {
      method: "PUT",
      json: { tokenLimit: 1_000_000, costLimitUsd: 50, hardStop: true },
    });
    expect(put.status).toBe(200);
    expect((await jsonOf<{ tokenLimit: number }>(put)).tokenLimit).toBe(1_000_000);

    const get = await bob.request(`/api/v1/projects/${projectId}/quota`);
    expect(get.status).toBe(200);

    const putAsMember = await bob.request(`/api/v1/projects/${projectId}/quota`, {
      method: "PUT",
      json: { hardStop: false },
    });
    expect(putAsMember.status).toBe(403);
  });

  it("archives a project", async () => {
    const res = await alice.request(`/api/v1/projects/${projectId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const project = await jsonOf<{ status: string }>(
      await alice.request(`/api/v1/projects/${projectId}`),
    );
    expect(project.status).toBe("archived");
  });
});
