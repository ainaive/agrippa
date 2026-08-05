import { AppError, runtimeCreateSchema } from "@agrippa/core";
import { runtimes } from "@agrippa/db";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { audit } from "../lib/audit";
import { issueRuntimeToken } from "../lib/runtime-tokens";
import { validate } from "../lib/validate";
import { requireOrgAdmin } from "../middleware/rbac";

const runtimeView = {
  id: runtimes.id,
  name: runtimes.name,
  tokenPrefix: runtimes.tokenPrefix,
  status: runtimes.status,
  hostname: runtimes.hostname,
  version: runtimes.version,
  executors: runtimes.executors,
  features: runtimes.features,
  lastSeenAt: runtimes.lastSeenAt,
  registeredAt: runtimes.registeredAt,
  createdAt: runtimes.createdAt,
  revokedAt: runtimes.revokedAt,
};

/**
 * Admin management of remote runtime daemons (ADR-0017): issue a token
 * (plaintext shown exactly once), list the fleet's runtimes, revoke.
 * The daemon-facing surface lives in ./daemon.ts.
 */
export const runtimeRoutes = new Hono<AppEnv>()
  .get("/runtimes", requireOrgAdmin, async (c) => {
    const rows = await c.var.db
      .select(runtimeView)
      .from(runtimes)
      .where(eq(runtimes.orgId, c.var.user.orgId))
      .orderBy(desc(runtimes.createdAt));
    return c.json(rows);
  })
  .post("/runtimes", requireOrgAdmin, validate("json", runtimeCreateSchema), async (c) => {
    const body = c.req.valid("json");
    const issued = issueRuntimeToken();
    const [row] = await c.var.db
      .insert(runtimes)
      .values({
        orgId: c.var.user.orgId,
        name: body.name,
        tokenHash: issued.tokenHash,
        tokenPrefix: issued.tokenPrefix,
        createdBy: c.var.user.id,
      })
      .returning(runtimeView);
    await audit(c, {
      action: "runtime.create",
      resourceType: "runtime",
      resourceId: row?.id,
      payload: { name: body.name },
    });
    // the plaintext token is returned exactly once — only the hash is stored
    return c.json({ ...row, token: issued.token }, 201);
  })
  .post("/runtimes/:id/revoke", requireOrgAdmin, async (c) => {
    const id = c.req.param("id");
    const [row] = await c.var.db
      .update(runtimes)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(
        and(
          eq(runtimes.id, id),
          eq(runtimes.orgId, c.var.user.orgId),
          eq(runtimes.status, "active"),
        ),
      )
      .returning(runtimeView);
    if (!row) throw AppError.notFound("Runtime");
    await audit(c, { action: "runtime.revoke", resourceType: "runtime", resourceId: id });
    return c.json(row);
  });
