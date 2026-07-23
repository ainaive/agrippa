import { beforeAll, describe, expect, it } from "bun:test";
import { auditLogs, providerCredentials, repoConnections, runs, secrets } from "@agrippa/db";
import { eq } from "drizzle-orm";
import type { App } from "../app";
import { createApp } from "../app";
import { freshTestDb, jsonOf, postgresAvailable, signUp, type TestClient } from "./helpers";

const dbUp = await postgresAvailable();

type CredentialRow = {
  id: string;
  provider: string;
  baseUrl: string | null;
  hasCredential: boolean;
  rotatedAt: string | null;
};

describe.skipIf(!dbUp)("provider credentials (project settings → submit gate)", () => {
  let app: App;
  let db: Awaited<ReturnType<typeof freshTestDb>>;
  let admin: TestClient;
  let viewer: TestClient;
  let projectId: string;

  beforeAll(async () => {
    db = await freshTestDb();
    app = createApp({ db });
    admin = await signUp(app, "Root", "root@example.com");
    viewer = await signUp(app, "Vera", "vera@example.com");
    projectId = (
      await jsonOf<{ id: string }>(
        await admin.request("/api/v1/projects", {
          method: "POST",
          json: { slug: "bailian", name: "Bailian" },
        }),
      )
    ).id;
    await admin.request(`/api/v1/projects/${projectId}/members`, {
      method: "POST",
      json: { email: "vera@example.com", role: "viewer" },
    });
  });

  it("stores the key write-only, encrypted, and masks it everywhere", async () => {
    const created = await admin.request(`/api/v1/projects/${projectId}/providers`, {
      method: "POST",
      json: { provider: "dashscope", apiKey: "sk-bailian-super-secret" },
    });
    expect(created.status).toBe(201);
    const body = await jsonOf<Record<string, unknown>>(created);
    expect(body.hasCredential).toBe(true);
    expect(body.secretRef).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("sk-bailian-super-secret");

    const [row] = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.projectId, projectId));
    expect(row?.provider).toBe("dashscope");
    const [secret] = await db
      .select()
      .from(secrets)
      .where(eq(secrets.id, row?.secretRef ?? ""));
    expect(secret?.kind).toBe("provider_api_key");
    expect(secret?.ciphertext).not.toContain("sk-bailian-super-secret");

    // list is viewer-readable but only ever exposes hasCredential
    const listed = await jsonOf<CredentialRow[]>(
      await viewer.request(`/api/v1/projects/${projectId}/providers`),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.hasCredential).toBe(true);
    expect(JSON.stringify(listed)).not.toContain("sk-bailian");
  });

  it("writes are admin-only; duplicates conflict", async () => {
    const denied = await viewer.request(`/api/v1/projects/${projectId}/providers`, {
      method: "POST",
      json: { provider: "anthropic", apiKey: "sk-nope" },
    });
    expect(denied.status).toBe(403);

    const dup = await admin.request(`/api/v1/projects/${projectId}/providers`, {
      method: "POST",
      json: { provider: "dashscope", apiKey: "sk-again" },
    });
    expect(dup.status).toBe(409);
    expect((await jsonOf<{ code: string }>(dup)).code).toBe("provider_exists");
  });

  it("rotates the key in place and updates the base URL three-state", async () => {
    const [before] = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.projectId, projectId));
    const [secretBefore] = await db
      .select()
      .from(secrets)
      .where(eq(secrets.id, before?.secretRef ?? ""));

    const rotated = await admin.request(`/api/v1/projects/${projectId}/providers/dashscope`, {
      method: "PATCH",
      json: { apiKey: "sk-bailian-rotated", baseUrl: "https://dashscope-intl.aliyuncs.com/x" },
    });
    expect(rotated.status).toBe(200);

    const [after] = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.projectId, projectId));
    expect(after?.secretRef).toBe(before?.secretRef as string); // ref stays stable
    expect(after?.baseUrl).toBe("https://dashscope-intl.aliyuncs.com/x");
    const [secretAfter] = await db
      .select()
      .from(secrets)
      .where(eq(secrets.id, before?.secretRef ?? ""));
    expect(secretAfter?.ciphertext).not.toBe(secretBefore?.ciphertext as string);
    expect(secretAfter?.rotatedAt).not.toBeNull();

    // baseUrl: null clears the override back to the catalog default
    await admin.request(`/api/v1/projects/${projectId}/providers/dashscope`, {
      method: "PATCH",
      json: { baseUrl: null },
    });
    const listed = await jsonOf<CredentialRow[]>(
      await admin.request(`/api/v1/projects/${projectId}/providers`),
    );
    expect(listed[0]?.baseUrl).toBeNull();
    expect(listed[0]?.rotatedAt).not.toBeNull();
  });

  it("gates submission: dashscope-only grants fail actionably until a credential exists", async () => {
    // fresh project so the credential created above doesn't leak in
    const gatedProject = (
      await jsonOf<{ id: string }>(
        await admin.request("/api/v1/projects", {
          method: "POST",
          json: { slug: "gated", name: "Gated" },
        }),
      )
    ).id;
    const [conn] = await db
      .insert(repoConnections)
      .values({
        projectId: gatedProject,
        provider: "github",
        url: "https://github.com/acme/widget.git",
      })
      .returning();

    // grant every skill but ONLY dashscope models
    const modelRows = await jsonOf<Array<{ id: string; provider: string }>>(
      await admin.request("/api/v1/models"),
    );
    const skillRows = await jsonOf<Array<{ id: string }>>(await admin.request("/api/v1/skills"));
    await admin.request(`/api/v1/projects/${gatedProject}/grants`, {
      method: "PUT",
      json: [
        ...modelRows
          .filter((m) => m.provider === "dashscope")
          .map((m) => ({ resourceType: "model", resourceId: m.id })),
        ...skillRows.map((s) => ({ resourceType: "skill", resourceId: s.id })),
      ],
    });

    const types = await jsonOf<Array<{ id: string; slug: string }>>(
      await admin.request("/api/v1/scenarios/software-development/task-types"),
    );
    const submitBody = {
      taskTypeId: types.find((t) => t.slug === "bug-localize-fix")?.id,
      title: "Fix via Qwen",
      params: { bugReport: "It crashes", repo: { repoConnectionId: conn?.id } },
    };

    const blocked = await admin.request(`/api/v1/projects/${gatedProject}/tasks`, {
      method: "POST",
      json: submitBody,
    });
    expect(blocked.status).toBe(400);
    expect((await jsonOf<{ code: string }>(blocked)).code).toBe("provider_credential_required");

    await admin.request(`/api/v1/projects/${gatedProject}/providers`, {
      method: "POST",
      json: { provider: "dashscope", apiKey: "sk-bailian-gated-project" },
    });
    const accepted = await admin.request(`/api/v1/projects/${gatedProject}/tasks`, {
      method: "POST",
      json: submitBody,
    });
    expect(accepted.status).toBe(202);

    // the frozen resolution is single-provider dashscope for every slot role
    const { runId } = await jsonOf<{ runId: string }>(accepted);
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    const entries = Object.values(run?.modelResolution ?? {}).flatMap((slot) =>
      Object.values(slot as Record<string, { provider: string }>),
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.provider).toBe("dashscope");
  });

  it("delete removes the credential AND its secret, with audit rows throughout", async () => {
    const [row] = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.projectId, projectId));
    const secretRef = row?.secretRef as string;

    const denied = await viewer.request(`/api/v1/projects/${projectId}/providers/dashscope`, {
      method: "DELETE",
    });
    expect(denied.status).toBe(403);

    const removed = await admin.request(`/api/v1/projects/${projectId}/providers/dashscope`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(
      await db
        .select()
        .from(providerCredentials)
        .where(eq(providerCredentials.projectId, projectId)),
    ).toHaveLength(0);
    // no orphaned key material
    expect(await db.select().from(secrets).where(eq(secrets.id, secretRef))).toHaveLength(0);

    const actions = (await db.select().from(auditLogs)).map((a) => a.action);
    expect(actions).toContain("project.provider.add");
    expect(actions).toContain("project.provider.update");
    expect(actions).toContain("project.provider.remove");
  });
});
