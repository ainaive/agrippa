import {
  AppError,
  DAEMON_PROTOCOL_HINTS,
  daemonHeartbeatSchema,
  daemonRegisterSchema,
} from "@agrippa/core";
import { auditLogs, type Db, runtimes } from "@agrippa/db";
import type { RunEventBus } from "@agrippa/orchestration";
import { eq, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  RUNTIME_TOKEN_PREFIX,
  runtimeTokenMatches,
  runtimeTokenPrefix,
} from "../lib/runtime-tokens";
import { validate } from "../lib/validate";

type RuntimeRow = typeof runtimes.$inferSelect;

/**
 * The daemon-facing surface is its own Hono environment: requests carry a
 * runtime principal, never a session user, and the router mounts OUTSIDE the
 * v1 session gate (the accept-invite precedent in app.ts). The upstream
 * global middleware still provides db/bus/locale.
 */
export type DaemonEnv = {
  Variables: {
    db: Db;
    bus: RunEventBus | null;
    locale: string;
    runtime: RuntimeRow;
  };
};

/**
 * Bearer auth with the runtime token: prefix-indexed lookup, constant-time
 * hash compare, active-status check. Every failure is the same 401 code so
 * a probe can't distinguish unknown, revoked, and malformed tokens.
 */
const daemonAuth: MiddlewareHandler<DaemonEnv> = async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token.startsWith(RUNTIME_TOKEN_PREFIX)) {
    throw new AppError("daemon_token_invalid", 401, "Invalid daemon token");
  }
  const [row] = await c.var.db
    .select()
    .from(runtimes)
    .where(eq(runtimes.tokenPrefix, runtimeTokenPrefix(token)));
  if (!row || row.status !== "active" || !runtimeTokenMatches(token, row.tokenHash)) {
    throw new AppError("daemon_token_invalid", 401, "Invalid daemon token");
  }
  c.set("runtime", row);
  await next();
};

/** Audit rows for daemon-authenticated requests carry the runtime actor. */
async function daemonAudit(
  c: { var: DaemonEnv["Variables"]; req: { header(name: string): string | undefined } },
  entry: { action: string; payload?: Record<string, unknown> },
): Promise<void> {
  await c.var.db.insert(auditLogs).values({
    orgId: c.var.runtime.orgId,
    actorRuntimeId: c.var.runtime.id,
    action: entry.action,
    resourceType: "runtime",
    resourceId: c.var.runtime.id,
    payload: entry.payload ?? {},
    ip: c.req.header("x-forwarded-for") ?? null,
  });
}

export const daemonRoutes = new Hono<DaemonEnv>()
  .use("*", daemonAuth)
  .post("/register", validate("json", daemonRegisterSchema), async (c) => {
    const body = c.req.valid("json");
    await c.var.db
      .update(runtimes)
      .set({
        hostname: body.hostname,
        version: body.version ?? null,
        executors: body.executors,
        lastSeenAt: sql`now()`,
        registeredAt: sql`coalesce(${runtimes.registeredAt}, now())`,
      })
      .where(eq(runtimes.id, c.var.runtime.id));
    // once per daemon boot — heartbeats are deliberately not audited
    await daemonAudit(c, {
      action: "runtime.register",
      payload: { hostname: body.hostname, executors: body.executors.map((e) => e.id) },
    });
    return c.json({ runtimeId: c.var.runtime.id, hints: DAEMON_PROTOCOL_HINTS });
  })
  .post("/heartbeat", validate("json", daemonHeartbeatSchema), async (c) => {
    await c.var.db
      .update(runtimes)
      .set({ lastSeenAt: sql`now()` })
      .where(eq(runtimes.id, c.var.runtime.id));
    // dispatch contact-deadline bumps land here with the dispatch tables (B3)
    return c.json({ ok: true });
  });
