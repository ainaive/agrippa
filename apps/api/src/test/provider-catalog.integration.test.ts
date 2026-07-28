import { beforeAll, describe, expect, it } from "bun:test";
import type { App } from "../app";
import { createApp } from "../app";
import { freshTestDb, jsonOf, postgresAvailable, signUp, type TestClient } from "./helpers";

const dbUp = await postgresAvailable();

type CatalogRow = {
  providerId: string;
  label: string;
  baseUrls: Record<string, string>;
  auth: string;
  baseUrlHosts: string[] | null;
  status: string;
  orgId: string | null;
};

describe.skipIf(!dbUp)("provider catalog CRUD + ref validation", () => {
  let app: App;
  let admin: TestClient;
  let member: TestClient;

  beforeAll(async () => {
    app = createApp({ db: await freshTestDb() });
    admin = await signUp(app, "Root", "root@example.com");
    member = await signUp(app, "Marge", "marge@example.com");
  });

  it("lists the 3 seeded builtins", async () => {
    const rows = await jsonOf<CatalogRow[]>(await admin.request("/api/v1/provider-catalog"));
    const ids = rows.map((r) => r.providerId).sort();
    expect(ids).toEqual(["anthropic", "dashscope", "openai"]);
    for (const r of rows) expect(r.orgId).toBeNull();
  });

  it("org_admin can register a custom Anthropic-compatible provider", async () => {
    const created = await admin.request("/api/v1/provider-catalog", {
      method: "POST",
      json: {
        providerId: "deepseek",
        label: "DeepSeek",
        baseUrls: { anthropic: "https://api.deepseek.com/anthropic" },
        auth: "project",
        baseUrlHosts: ["api.deepseek.com"],
      },
    });
    expect(created.status).toBe(201);
    const body = await jsonOf<CatalogRow>(created);
    expect(body.providerId).toBe("deepseek");
    expect(body.auth).toBe("project");
    expect(body.orgId).not.toBeNull();

    // duplicate id → 409
    const dup = await admin.request("/api/v1/provider-catalog", {
      method: "POST",
      json: { providerId: "deepseek", label: "DeepSeek", baseUrls: {}, auth: "env" },
    });
    expect(dup.status).toBe(409);

    // member (org_member) cannot create
    const denied = await member.request("/api/v1/provider-catalog", {
      method: "POST",
      json: { providerId: "moonshot", label: "Moonshot", baseUrls: {}, auth: "env" },
    });
    expect(denied.status).toBe(403);
  });

  it("builtins are immutable; customs are editable and deletable", async () => {
    // patch a builtin → 404 (immutable)
    const builtinPatch = await admin.request("/api/v1/provider-catalog/anthropic", {
      method: "PATCH",
      json: { label: "Anthropic Renamed" },
    });
    expect(builtinPatch.status).toBe(404);

    // patch the custom deepseek
    const patched = await admin.request("/api/v1/provider-catalog/deepseek", {
      method: "PATCH",
      json: { status: "disabled" },
    });
    expect(patched.status).toBe(200);
    expect((await jsonOf<CatalogRow>(patched)).status).toBe("disabled");

    // delete a builtin → 404
    const builtinDelete = await admin.request("/api/v1/provider-catalog/openai", {
      method: "DELETE",
    });
    expect(builtinDelete.status).toBe(404);

    // delete the custom
    const removed = await admin.request("/api/v1/provider-catalog/deepseek", {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
  });

  it("POST /models and POST /projects/:id/providers reject unknown providers", async () => {
    // register a project first so the providers endpoint is reachable
    const project = (
      await jsonOf<{ id: string }>(
        await admin.request("/api/v1/projects", {
          method: "POST",
          json: { slug: "refcheck", name: "Ref Check" },
        }),
      )
    ).id;

    const badModel = await admin.request("/api/v1/models", {
      method: "POST",
      json: {
        provider: "typo-provider",
        providerModelId: "some-model",
        displayName: "Some Model",
        tier: "balanced",
      },
    });
    expect(badModel.status).toBe(400);
    expect((await jsonOf<{ code: string }>(badModel)).code).toBe("provider_not_in_catalog");

    const badCred = await admin.request(`/api/v1/projects/${project}/providers`, {
      method: "POST",
      json: { provider: "typo-provider", apiKey: "sk-x" },
    });
    expect(badCred.status).toBe(400);
    expect((await jsonOf<{ code: string }>(badCred)).code).toBe("provider_not_in_catalog");
  });

  it("rejects a model rank the rank column cannot hold", async () => {
    // models.rank is a 32-bit integer; without the schema bound this reached
    // Postgres and surfaced as a 500 instead of a validation error
    const tooLarge = await admin.request("/api/v1/models", {
      method: "POST",
      json: {
        provider: "anthropic",
        providerModelId: "rank-overflow",
        displayName: "Rank Overflow",
        tier: "balanced",
        rank: 2_147_483_648,
      },
    });
    expect(tooLarge.status).toBe(400);
    expect((await jsonOf<{ code: string }>(tooLarge)).code).toBe("validation_failed");

    // the boundary value itself is storable, so it must be accepted
    const atLimit = await admin.request("/api/v1/models", {
      method: "POST",
      json: {
        provider: "anthropic",
        providerModelId: "rank-at-limit",
        displayName: "Rank At Limit",
        tier: "balanced",
        rank: 2_147_483_647,
      },
    });
    expect(atLimit.status).toBe(201);
    expect((await jsonOf<{ rank: number }>(atLimit)).rank).toBe(2_147_483_647);
  });
});
