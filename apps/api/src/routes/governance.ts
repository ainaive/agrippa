import { auditLogs, users } from "@agrippa/db";
import { and, desc, eq, getTableColumns, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { requireOrgAdmin } from "../middleware/rbac";

export const governanceRoutes = new Hono<AppEnv>().get(
  "/audit-logs",
  requireOrgAdmin,
  async (c) => {
    const filters: SQL[] = [eq(auditLogs.orgId, c.var.user.orgId)];
    const projectId = c.req.query("projectId");
    if (projectId) filters.push(eq(auditLogs.projectId, projectId));
    const action = c.req.query("action");
    if (action) filters.push(eq(auditLogs.action, action));
    const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);

    const rows = await c.var.db
      .select({
        ...getTableColumns(auditLogs),
        actorEmail: users.email,
        actorName: users.name,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.actorUserId, users.id))
      .where(and(...filters))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
    return c.json(rows);
  },
);
