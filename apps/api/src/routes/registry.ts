import {
  AppError,
  faberCreateSchema,
  faberUpdateSchema,
  mcpServerCreateSchema,
  mcpServerUpdateSchema,
  modelCreateSchema,
  modelUpdateSchema,
  skillCreateSchema,
  skillVersionCreateSchema,
} from "@agrippa/core";
import {
  encryptSecret,
  fabri,
  loadSecretKey,
  mcpServers,
  models,
  secrets,
  skills,
  skillVersions,
} from "@agrippa/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { audit } from "../lib/audit";
import { validate } from "../lib/validate";
import { requireOrgAdmin } from "../middleware/rbac";

function maskMcpServer<T extends { authSecretRef: string | null }>(row: T) {
  const { authSecretRef, ...rest } = row;
  return { ...rest, hasAuth: authSecretRef !== null };
}

export const registryRoutes = new Hono<AppEnv>()
  // ── Fabri ───────────────────────────────────────────────────────────────────
  .get("/fabri", async (c) => c.json(await c.var.db.select().from(fabri).orderBy(asc(fabri.slug))))
  .post("/fabri", requireOrgAdmin, validate("json", faberCreateSchema), async (c) => {
    const input = c.req.valid("json");
    const [existing] = await c.var.db.select().from(fabri).where(eq(fabri.slug, input.slug));
    if (existing) throw AppError.conflict("slug_taken", "Faber slug already exists");
    const [created] = await c.var.db
      .insert(fabri)
      .values({ ...input, orgId: c.var.user.orgId })
      .returning();
    await audit(c, { action: "faber.create", resourceType: "faber", resourceId: created?.id });
    return c.json(created, 201);
  })
  .patch("/fabri/:id", requireOrgAdmin, validate("json", faberUpdateSchema), async (c) => {
    const [updated] = await c.var.db
      .update(fabri)
      .set(c.req.valid("json"))
      .where(eq(fabri.id, c.req.param("id")))
      .returning();
    if (!updated) throw AppError.notFound("Faber");
    await audit(c, { action: "faber.update", resourceType: "faber", resourceId: updated.id });
    return c.json(updated);
  })

  // ── Models ──────────────────────────────────────────────────────────────────
  .get("/models", async (c) =>
    c.json(await c.var.db.select().from(models).orderBy(asc(models.providerModelId))),
  )
  .post("/models", requireOrgAdmin, validate("json", modelCreateSchema), async (c) => {
    const input = c.req.valid("json");
    const [existing] = await c.var.db
      .select()
      .from(models)
      .where(eq(models.providerModelId, input.providerModelId));
    if (existing) throw AppError.conflict("model_exists", "Model already registered");
    const [created] = await c.var.db
      .insert(models)
      .values({
        ...input,
        orgId: c.var.user.orgId,
        inputCostPerMtok: input.inputCostPerMtok?.toString(),
        outputCostPerMtok: input.outputCostPerMtok?.toString(),
      })
      .returning();
    await audit(c, { action: "model.create", resourceType: "model", resourceId: created?.id });
    return c.json(created, 201);
  })
  .patch("/models/:id", requireOrgAdmin, validate("json", modelUpdateSchema), async (c) => {
    const input = c.req.valid("json");
    const [updated] = await c.var.db
      .update(models)
      .set({
        ...input,
        inputCostPerMtok:
          input.inputCostPerMtok === undefined ? undefined : String(input.inputCostPerMtok),
        outputCostPerMtok:
          input.outputCostPerMtok === undefined ? undefined : String(input.outputCostPerMtok),
      })
      .where(eq(models.id, c.req.param("id")))
      .returning();
    if (!updated) throw AppError.notFound("Model");
    await audit(c, { action: "model.update", resourceType: "model", resourceId: updated.id });
    return c.json(updated);
  })

  // ── MCP servers (secrets write-only) ────────────────────────────────────────
  .get("/mcp-servers", async (c) => {
    const rows = await c.var.db.select().from(mcpServers).orderBy(asc(mcpServers.slug));
    return c.json(rows.map(maskMcpServer));
  })
  .post("/mcp-servers", requireOrgAdmin, validate("json", mcpServerCreateSchema), async (c) => {
    const { authToken, ...input } = c.req.valid("json");
    const db = c.var.db;
    const [existing] = await db.select().from(mcpServers).where(eq(mcpServers.slug, input.slug));
    if (existing) throw AppError.conflict("slug_taken", "MCP server slug already exists");

    let authSecretRef: string | null = null;
    if (authToken) {
      const [secret] = await db
        .insert(secrets)
        .values({
          orgId: c.var.user.orgId,
          kind: "mcp_auth",
          ciphertext: encryptSecret(authToken, loadSecretKey()),
          createdBy: c.var.user.id,
        })
        .returning();
      authSecretRef = secret?.id ?? null;
    }

    const [created] = await db
      .insert(mcpServers)
      .values({ ...input, orgId: c.var.user.orgId, authSecretRef })
      .returning();
    await audit(c, {
      action: "mcp_server.create",
      resourceType: "mcp_server",
      resourceId: created?.id,
    });
    return c.json(created ? maskMcpServer(created) : null, 201);
  })
  .patch(
    "/mcp-servers/:id",
    requireOrgAdmin,
    validate("json", mcpServerUpdateSchema),
    async (c) => {
      const { authToken, ...input } = c.req.valid("json");
      const db = c.var.db;
      const [current] = await db
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.id, c.req.param("id")));
      if (!current) throw AppError.notFound("MCP server");

      let authSecretRef = current.authSecretRef;
      if (authToken === null) {
        authSecretRef = null;
      } else if (authToken !== undefined) {
        const [secret] = await db
          .insert(secrets)
          .values({
            orgId: c.var.user.orgId,
            kind: "mcp_auth",
            ciphertext: encryptSecret(authToken, loadSecretKey()),
            createdBy: c.var.user.id,
          })
          .returning();
        authSecretRef = secret?.id ?? null;
      }

      const [updated] = await db
        .update(mcpServers)
        .set({
          ...input,
          authSecretRef,
          // config changes bump the revision so runs can record what they resolved
          configRevision: input.config ? sql`${mcpServers.configRevision} + 1` : undefined,
        })
        .where(eq(mcpServers.id, current.id))
        .returning();
      await audit(c, {
        action: "mcp_server.update",
        resourceType: "mcp_server",
        resourceId: current.id,
      });
      return c.json(updated ? maskMcpServer(updated) : null);
    },
  )

  // ── Skills (head + immutable versions) ──────────────────────────────────────
  .get("/skills", async (c) => {
    const heads = await c.var.db.select().from(skills).orderBy(asc(skills.slug));
    const versions = await c.var.db.select().from(skillVersions);
    return c.json(
      heads.map((head) => ({
        ...head,
        versions: versions
          .filter((v) => v.skillId === head.id)
          .map(({ id, version, status, createdAt }) => ({ id, version, status, createdAt })),
      })),
    );
  })
  .post("/skills", requireOrgAdmin, validate("json", skillCreateSchema), async (c) => {
    const input = c.req.valid("json");
    const [existing] = await c.var.db.select().from(skills).where(eq(skills.slug, input.slug));
    if (existing) throw AppError.conflict("slug_taken", "Skill slug already exists");
    const [created] = await c.var.db
      .insert(skills)
      .values({ ...input, orgId: c.var.user.orgId })
      .returning();
    await audit(c, { action: "skill.create", resourceType: "skill", resourceId: created?.id });
    return c.json(created, 201);
  })
  .post(
    "/skills/:id/versions",
    requireOrgAdmin,
    validate("json", skillVersionCreateSchema),
    async (c) => {
      const input = c.req.valid("json");
      const db = c.var.db;
      const [head] = await db
        .select()
        .from(skills)
        .where(eq(skills.id, c.req.param("id")));
      if (!head) throw AppError.notFound("Skill");
      const [existing] = await db
        .select()
        .from(skillVersions)
        .where(and(eq(skillVersions.skillId, head.id), eq(skillVersions.version, input.version)));
      if (existing) {
        throw AppError.conflict("version_exists", "Skill version already exists");
      }
      const [created] = await db
        .insert(skillVersions)
        .values({ skillId: head.id, ...input, manifest: input.manifest ?? {} })
        .returning();
      await db.update(skills).set({ latestVersionId: created?.id }).where(eq(skills.id, head.id));
      await audit(c, {
        action: "skill.version.create",
        resourceType: "skill_version",
        resourceId: created?.id,
      });
      return c.json(created, 201);
    },
  );
