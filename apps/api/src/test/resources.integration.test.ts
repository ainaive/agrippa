import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { secrets } from "@agrippa/db";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { App } from "../app";
import { createApp } from "../app";
import { freshTestDb, jsonOf, postgresAvailable, signUp, type TestClient } from "./helpers";

const dbUp = await postgresAvailable();

const TEMPLATES_DIR = path.resolve(import.meta.dirname, "../../../../templates");
const bugFixYaml = readFileSync(path.join(TEMPLATES_DIR, "swdev/bug-localize-fix.yaml"), "utf8");

/** The builtin template re-slugged (with prompts inlined so no file resolver is needed). */
function customTemplateYaml(slug: string): string {
  // biome-ignore lint/suspicious/noExplicitAny: test fixture mutation
  const doc = parseYaml(bugFixYaml) as any;
  doc.metadata.slug = slug;
  for (const subagent of doc.spec.resources.subagents) {
    const content = readFileSync(path.join(TEMPLATES_DIR, subagent.promptFile), "utf8");
    subagent.prompt = content;
    subagent.promptFile = undefined;
  }
  return stringifyYaml(doc);
}

describe.skipIf(!dbUp)("resource layer (registries, templates, grants)", () => {
  let app: App;
  let db: Awaited<ReturnType<typeof freshTestDb>>;
  let admin: TestClient; // first user → org_admin
  let member: TestClient; // org_member
  let projectId: string;

  beforeAll(async () => {
    db = await freshTestDb();
    app = createApp({ db });
    admin = await signUp(app, "Root", "root@example.com");
    member = await signUp(app, "Marge", "marge@example.com");
    const res = await admin.request("/api/v1/projects", {
      method: "POST",
      json: { slug: "hermes", name: "Hermes" },
    });
    projectId = (await jsonOf<{ id: string }>(res)).id;
  });

  it("builtin seeding published bug-localize-fix with a usable input schema", async () => {
    const list = await jsonOf<Array<{ id: string; slug: string }>>(
      await admin.request("/api/v1/scenarios/software-development/task-types"),
    );
    const bugFix = list.find((t) => t.slug === "bug-localize-fix");
    expect(bugFix).toBeDefined();

    const detail = await jsonOf<{
      inputs: Array<{ key: string; type: string }>;
      templateVersion: { version: number } | null;
      budgets: { maxCostUsd: number };
    }>(await admin.request(`/api/v1/task-types/${bugFix?.id}`));
    expect(detail.templateVersion?.version).toBe(1);
    expect(detail.inputs.map((i) => i.key)).toContain("bugReport");
    expect(detail.budgets.maxCostUsd).toBe(8);
  });

  it("registry writes require org_admin", async () => {
    const denied = await member.request("/api/v1/fabri", {
      method: "POST",
      json: {
        slug: "intruder",
        nameI18n: { en: "X", "zh-CN": "某" },
        personaI18n: { en: "X", "zh-CN": "某" },
        systemPrompt: "x",
      },
    });
    expect(denied.status).toBe(403);

    const created = await admin.request("/api/v1/fabri", {
      method: "POST",
      json: {
        slug: "scribe",
        nameI18n: { en: "Scribe", "zh-CN": "书记官" },
        personaI18n: { en: "Writes things down.", "zh-CN": "记录一切。" },
        systemPrompt: "You are Scribe.",
      },
    });
    expect(created.status).toBe(201);

    const listed = await jsonOf<Array<{ slug: string }>>(await member.request("/api/v1/fabri"));
    expect(listed.map((f) => f.slug)).toContain("scribe");
  });

  it("mcp servers store auth write-only and bump configRevision on config change", async () => {
    const created = await admin.request("/api/v1/mcp-servers", {
      method: "POST",
      json: {
        slug: "github",
        nameI18n: { en: "GitHub", "zh-CN": "GitHub" },
        transport: "http",
        config: { url: "https://api.githubcopilot.com/mcp/" },
        authToken: "ghp_super_secret",
      },
    });
    expect(created.status).toBe(201);
    const body = await jsonOf<{
      id: string;
      hasAuth: boolean;
      configRevision: number;
      authSecretRef?: unknown;
    }>(created);
    expect(body.hasAuth).toBe(true);
    expect(body.authSecretRef).toBeUndefined();
    expect(body.configRevision).toBe(1);

    // the token never appears in the response, and the stored secret is encrypted
    const rows = await db.select().from(secrets);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ciphertext).not.toContain("ghp_super_secret");

    const updated = await admin.request(`/api/v1/mcp-servers/${body.id}`, {
      method: "PATCH",
      json: { config: { url: "https://api.githubcopilot.com/mcp/", timeout: 30 } },
    });
    expect((await jsonOf<{ configRevision: number }>(updated)).configRevision).toBe(2);
  });

  it("template versions: draft → publish is immutable and republish 409s", async () => {
    const head = await jsonOf<{ id: string }>(
      await admin.request("/api/v1/templates", {
        method: "POST",
        json: {
          slug: "swdev.custom-fix",
          scenarioSlug: "software-development",
          nameI18n: { en: "Custom Fix", "zh-CN": "自定义修复" },
        },
      }),
    );

    // invalid YAML is rejected with issues
    const invalid = await admin.request(`/api/v1/templates/${head.id}/versions`, {
      method: "POST",
      json: { sourceYaml: "apiVersion: nope" },
    });
    expect(invalid.status).toBe(400);
    expect((await jsonOf<{ code: string }>(invalid)).code).toBe("template_invalid");

    // slug mismatch is rejected
    const mismatched = await admin.request(`/api/v1/templates/${head.id}/versions`, {
      method: "POST",
      json: { sourceYaml: customTemplateYaml("swdev.wrong-slug") },
    });
    expect((await jsonOf<{ code: string }>(mismatched)).code).toBe("slug_mismatch");

    // valid draft
    const draft = await jsonOf<{ version: number; status: string }>(
      await admin.request(`/api/v1/templates/${head.id}/versions`, {
        method: "POST",
        json: { sourceYaml: customTemplateYaml("swdev.custom-fix") },
      }),
    );
    expect(draft.status).toBe("draft");
    expect(draft.version).toBe(1);

    // publish
    const published = await admin.request(`/api/v1/templates/${head.id}/versions/1/publish`, {
      method: "POST",
    });
    expect(published.status).toBe(200);
    expect((await jsonOf<{ status: string }>(published)).status).toBe("published");

    // publishing again → 409 (immutability: only drafts can transition)
    const again = await admin.request(`/api/v1/templates/${head.id}/versions/1/publish`, {
      method: "POST",
    });
    expect(again.status).toBe(409);
    expect((await jsonOf<{ code: string }>(again)).code).toBe("not_draft");

    // head now points at the published version
    const headAfter = await jsonOf<{ latestPublishedVersionId: string | null }>(
      await admin.request(`/api/v1/templates/${head.id}`),
    );
    expect(headAfter.latestPublishedVersionId).not.toBeNull();
  });

  it("validate endpoint dry-runs the compiler", async () => {
    const ok = await admin.request("/api/v1/templates/validate", {
      method: "POST",
      json: { sourceYaml: customTemplateYaml("swdev.dry-run") },
    });
    expect(ok.status).toBe(200);
    expect((await jsonOf<{ valid: boolean }>(ok)).valid).toBe(true);

    const bad = await admin.request("/api/v1/templates/validate", {
      method: "POST",
      json: { sourceYaml: "apiVersion: agrippa/v1\nkind: Nope" },
    });
    expect(bad.status).toBe(400);
    const body = await jsonOf<{ valid: boolean; issues: string[] }>(bad);
    expect(body.valid).toBe(false);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("grants: admin replaces the set; unknown resource ids rejected; member cannot write", async () => {
    const modelList = await jsonOf<Array<{ id: string }>>(await admin.request("/api/v1/models"));
    expect(modelList.length).toBeGreaterThan(0);
    const modelId = modelList[0]?.id as string;

    const put = await admin.request(`/api/v1/projects/${projectId}/grants`, {
      method: "PUT",
      json: [{ resourceType: "model", resourceId: modelId }],
    });
    expect(put.status).toBe(200);
    expect(await jsonOf<unknown[]>(put)).toHaveLength(1);

    const unknown = await admin.request(`/api/v1/projects/${projectId}/grants`, {
      method: "PUT",
      json: [{ resourceType: "model", resourceId: Bun.randomUUIDv7() }],
    });
    expect(unknown.status).toBe(400);
    expect((await jsonOf<{ code: string }>(unknown)).code).toBe("unknown_resource");

    const asMember = await member.request(`/api/v1/projects/${projectId}/grants`, {
      method: "PUT",
      json: [],
    });
    expect(asMember.status).toBe(403); // not a member at all → forbidden

    const read = await jsonOf<Array<{ resourceId: string }>>(
      await admin.request(`/api/v1/projects/${projectId}/grants`),
    );
    expect(read[0]?.resourceId).toBe(modelId);
  });

  it("builtin re-seed is idempotent (checksum guard)", async () => {
    const { seedBuiltinTemplates } = await import("@agrippa/orchestration");
    const result = await seedBuiltinTemplates(db, TEMPLATES_DIR);
    expect(result.published).toHaveLength(0);
    expect(result.unchanged).toContain("swdev.bug-localize-fix");
  });
});
