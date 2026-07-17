import { auditLogs, type DbOrTx } from "@agrippa/db";
import type { Context } from "hono";
import type { AppEnv } from "../context";

type AuditEntry = {
  action: string; // e.g. "project.member.add"
  resourceType: string;
  resourceId?: string | null;
  projectId?: string | null;
  payload?: Record<string, unknown>;
};

/**
 * Every mutating handler records an audit row (docs/design/05-api-and-auth.md).
 * Accepts an explicit tx so creations can be atomic with their mutation.
 */
export async function audit(c: Context<AppEnv>, entry: AuditEntry, tx?: DbOrTx): Promise<void> {
  const db = tx ?? c.var.db;
  await db.insert(auditLogs).values({
    orgId: c.var.user.orgId,
    projectId: entry.projectId ?? null,
    actorUserId: c.var.user.id,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? null,
    payload: entry.payload ?? {},
    ip: c.req.header("x-forwarded-for") ?? null,
  });
}
