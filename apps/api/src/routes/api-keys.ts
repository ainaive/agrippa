import { API_KEY_PREFIX, AppError, apiKeyCreateSchema } from "@agrippa/core";
import { apiKeys } from "@agrippa/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { audit } from "../lib/audit";
import { issueToken } from "../lib/bearer-tokens";
import { validate } from "../lib/validate";
import { requireProjectRole } from "../middleware/rbac";

/** Never selects `key_hash` — the plaintext left the server at creation. */
const apiKeyView = {
  id: apiKeys.id,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  scopes: apiKeys.scopes,
  projectId: apiKeys.projectId,
  createdBy: apiKeys.createdBy,
  createdAt: apiKeys.createdAt,
  expiresAt: apiKeys.expiresAt,
  revokedAt: apiKeys.revokedAt,
  lastUsedAt: apiKeys.lastUsedAt,
};

/**
 * Project API keys (`Bearer agr_…`) — issued and revoked by project admins in
 * project settings, because a key is project automation and its blast radius is
 * one project.
 *
 * Every key is bound to the project it was created in. The `api_keys.project_id`
 * column is nullable for a future org-wide key, but nothing issues one: an
 * unbound credential would skip the binding check in `assertProjectRole`, which
 * is the guarantee that makes the rest of this cheap to reason about.
 */
export const apiKeyRoutes = new Hono<AppEnv>()
  .get("/:projectId/api-keys", requireProjectRole("admin"), async (c) => {
    const rows = await c.var.db
      .select(apiKeyView)
      .from(apiKeys)
      .where(eq(apiKeys.projectId, c.req.param("projectId")))
      .orderBy(desc(apiKeys.createdAt));
    return c.json(rows);
  })

  .post(
    "/:projectId/api-keys",
    requireProjectRole("admin"),
    validate("json", apiKeyCreateSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const body = c.req.valid("json");
      const issued = issueToken(API_KEY_PREFIX);
      const expiresAt = body.expiresDays
        ? new Date(Date.now() + body.expiresDays * 24 * 60 * 60 * 1000)
        : null;

      const [row] = await c.var.db
        .insert(apiKeys)
        .values({
          orgId: c.var.user.orgId,
          projectId,
          name: body.name,
          keyHash: issued.tokenHash,
          prefix: issued.tokenPrefix,
          scopes: body.scopes,
          createdBy: c.var.user.id,
          expiresAt,
        })
        .returning(apiKeyView);
      await audit(c, {
        action: "project.apikey.create",
        resourceType: "api_key",
        resourceId: row?.id,
        projectId,
        payload: { name: body.name, scopes: body.scopes, expiresAt: expiresAt?.toISOString() },
      });
      // the plaintext key is returned exactly once — only its hash is stored
      return c.json({ ...row, key: issued.token }, 201);
    },
  )

  .post("/:projectId/api-keys/:id/revoke", requireProjectRole("admin"), async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    const [row] = await c.var.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.projectId, projectId), isNull(apiKeys.revokedAt)))
      .returning(apiKeyView);
    if (!row) throw AppError.notFound("API key");
    await audit(c, {
      action: "project.apikey.revoke",
      resourceType: "api_key",
      resourceId: id,
      projectId,
      payload: { name: row.name },
    });
    return c.json(row);
  });
