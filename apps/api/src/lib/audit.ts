import type { DbOrTx } from "@agrippa/db";
import { type AuditActor, type AuditEntry, auditAs } from "@agrippa/orchestration";
import type { Context } from "hono";
import type { AppEnv } from "../context";

export type { AuditActor, AuditEntry };

/**
 * The principal behind a v1 request. An API-key request names both the owning
 * user and the key: the user is who is accountable, the key is which credential
 * was used — dropping either would make a leaked key indistinguishable from its
 * owner working in the browser. This is what satisfies "audit on use" without
 * an audit row per read: mutations already write one, and now they say how.
 */
export function requestActor(c: Context<AppEnv>): AuditActor {
  return {
    orgId: c.var.principal.orgId,
    userId: c.var.principal.userId,
    apiKeyId: c.var.principal.apiKeyId,
    ip: c.req.header("x-forwarded-for") ?? null,
  };
}

/** Request-principal convenience wrapper — the shape every v1 handler uses. */
export async function audit(c: Context<AppEnv>, entry: AuditEntry, tx?: DbOrTx): Promise<void> {
  await auditAs(tx ?? c.var.db, requestActor(c), entry);
}
