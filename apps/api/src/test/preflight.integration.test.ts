import { beforeAll, describe, expect, it } from "bun:test";
import { repoConnections } from "@agrippa/db";
import type { App } from "../app";
import { createApp } from "../app";
import { freshTestDb, jsonOf, postgresAvailable, signUp, type TestClient } from "./helpers";

const dbUp = await postgresAvailable();

type PreflightCheck = {
  key: string;
  ok: boolean;
  detail: string;
  fixPath: string | null;
};
type Preflight = { ready: boolean; checks: PreflightCheck[] };

describe.skipIf(!dbUp)("preflight (submit-readiness)", () => {
  let app: App;
  let db: Awaited<ReturnType<typeof freshTestDb>>;
  let admin: TestClient;
  let taskTypeId: string;

  beforeAll(async () => {
    db = await freshTestDb();
    app = createApp({ db });
    admin = await signUp(app, "Root", "root@example.com");
    const types = await jsonOf<Array<{ id: string; slug: string }>>(
      await admin.request("/api/v1/scenarios/software-development/task-types"),
    );
    taskTypeId = types.find((t) => t.slug === "bug-localize-fix")?.id as string;
  });

  const createProject = async (slug: string) => {
    const res = await admin.request("/api/v1/projects", {
      method: "POST",
      json: { slug, name: slug },
    });
    return (await jsonOf<{ id: string }>(res)).id;
  };

  const preflight = async (projectId: string): Promise<Preflight> =>
    jsonOf(await admin.request(`/api/v1/projects/${projectId}/task-types/${taskTypeId}/preflight`));

  it("reports ready=true for a fully-configured project (auto-grants + credential)", async () => {
    const projectId = await createProject("ready");
    // a repoRef input means the project needs a repo connection
    await db
      .insert(repoConnections)
      .values({ projectId, provider: "github", url: "https://github.com/acme/widget.git" })
      .returning();
    // bug-localize-fix resolves to a claude executor whose catalog providers
    // include dashscope (project auth) — give it a credential so the slot
    // resolves single-provider without env fallback surprises
    await admin.request(`/api/v1/projects/${projectId}/providers`, {
      method: "POST",
      json: { provider: "dashscope", apiKey: "sk-preflight-ready" },
    });

    const result = await preflight(projectId);
    expect(result.ready).toBe(true);
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    // no failing check offers a fix path
    expect(result.checks.filter((c) => c.fixPath !== null)).toHaveLength(0);
  });

  it("flags a missing repo connection with fixPath=repos", async () => {
    const projectId = await createProject("norepo");
    await admin.request(`/api/v1/projects/${projectId}/providers`, {
      method: "POST",
      json: { provider: "dashscope", apiKey: "sk-preflight-norepo" },
    });
    const result = await preflight(projectId);
    const repo = result.checks.find((c) => c.key === "repo");
    expect(repo).toBeDefined();
    expect(repo?.ok).toBe(false);
    expect(repo?.fixPath).toBe("repos");
  });

  it("flags an ungranted required skill with fixPath=grants", async () => {
    const projectId = await createProject("noskill");
    await db
      .insert(repoConnections)
      .values({ projectId, provider: "github", url: "https://github.com/acme/x.git" })
      .returning();
    await admin.request(`/api/v1/projects/${projectId}/providers`, {
      method: "POST",
      json: { provider: "dashscope", apiKey: "sk-preflight-noskill" },
    });
    // revoke one required skill (built-ins are auto-granted on create)
    const grants = await jsonOf<Array<{ resourceType: string; resourceId: string }>>(
      await admin.request(`/api/v1/projects/${projectId}/grants`),
    );
    const skills = await jsonOf<Array<{ id: string; slug: string }>>(
      await admin.request("/api/v1/skills"),
    );
    const testRunner = skills.find((s) => s.slug === "builtin/test-runner") as {
      id: string;
      slug: string;
    };
    // send clean {resourceType, resourceId} — the GET returns configOverride:
    // null, which the PUT schema rejects on round-trip (the frontend rebuilds
    // the same minimal shape)
    const body = grants
      .filter((g) => g.resourceId !== testRunner.id)
      .map((g) => ({ resourceType: g.resourceType, resourceId: g.resourceId }));
    const putRes = await admin.request(`/api/v1/projects/${projectId}/grants`, {
      method: "PUT",
      json: body,
    });
    expect(putRes.status).toBe(200);

    const result = await preflight(projectId);
    expect(result.ready).toBe(false);
    const skill = result.checks.find((c) => c.key === "skills");
    expect(skill?.ok).toBe(false);
    expect(skill?.fixPath).toBe("grants");
  });

  it("flags a missing provider credential with fixPath=providers", async () => {
    const projectId = await createProject("nocred");
    await db
      .insert(repoConnections)
      .values({ projectId, provider: "github", url: "https://github.com/acme/y.git" })
      .returning();
    // revoke all dashscope models so resolution can only fall back to an
    // env-policy provider (anthropic/openai) — but to expose the credential
    // path, instead grant ONLY dashscope models and hold no credential
    const models = await jsonOf<Array<{ id: string; provider: string }>>(
      await admin.request("/api/v1/models"),
    );
    const skills = await jsonOf<Array<{ id: string }>>(await admin.request("/api/v1/skills"));
    await admin.request(`/api/v1/projects/${projectId}/grants`, {
      method: "PUT",
      json: [
        ...models
          .filter((m) => m.provider === "dashscope")
          .map((m) => ({ resourceType: "model", resourceId: m.id })),
        ...skills.map((s) => ({ resourceType: "skill", resourceId: s.id })),
      ],
    });

    const result = await preflight(projectId);
    expect(result.ready).toBe(false);
    const cred = result.checks.find((c) => c.key === "provider_credential");
    expect(cred?.ok).toBe(false);
    expect(cred?.fixPath).toBe("providers");
  });
});
