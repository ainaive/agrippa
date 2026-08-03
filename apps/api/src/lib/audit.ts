import { auditLogs, type DbOrTx } from "@agrippa/db";
import type { Context } from "hono";
import type { AppEnv } from "../context";

export type AuditEntry = {
  action: string; // e.g. "project.member.add"
  resourceType: string;
  resourceId?: string | null;
  projectId?: string | null;
  payload?: Record<string, unknown>;
};

/**
 * Who performed the mutation. `audit_logs` carries one column per actor kind —
 * a session user, an API key, or a daemon runtime (ADR-0017) — and exactly one
 * is set. Naming the actor explicitly is what lets callers with no Hono context
 * (cron schedules, webhook triggers) audit through this same helper instead of
 * growing a private copy, the way the daemon surface had to.
 */
export type AuditActor = {
  orgId: string;
  userId?: string | null;
  apiKeyId?: string | null;
  runtimeId?: string | null;
  ip?: string | null;
};

/**
 * Every mutating handler records an audit row (docs/design/05-api-and-auth.md).
 * Accepts an explicit tx/db so creations can be atomic with their mutation.
 */
export async function auditAs(db: DbOrTx, actor: AuditActor, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    orgId: actor.orgId,
    projectId: entry.projectId ?? null,
    actorUserId: actor.userId ?? null,
    actorApiKeyId: actor.apiKeyId ?? null,
    actorRuntimeId: actor.runtimeId ?? null,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? null,
    payload: entry.payload ?? {},
    ip: actor.ip ?? null,
  });
}

/** The session principal behind a v1 request. */
export function sessionActor(c: Context<AppEnv>): AuditActor {
  return {
    orgId: c.var.user.orgId,
    userId: c.var.user.id,
    ip: c.req.header("x-forwarded-for") ?? null,
  };
}

/** Session-principal convenience wrapper — the shape every v1 handler uses. */
export async function audit(c: Context<AppEnv>, entry: AuditEntry, tx?: DbOrTx): Promise<void> {
  await auditAs(tx ?? c.var.db, sessionActor(c), entry);
}
