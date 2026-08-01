import { workerHeartbeats } from "@agrippa/db";
import { desc, gte, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { requireOrgAdmin } from "../middleware/rbac";

/**
 * 2.5× the worker's 60s heartbeat interval: one missed beat plus jitter is
 * not a stale worker, two missed beats is. Computed against the database
 * clock — heartbeats are written with now(), so comparing to anything else
 * would let API-host clock skew flip statuses.
 */
const STALE_AFTER_SECONDS = 150;

/** Fleet visibility for operators: every worker row the prune hasn't aged out. */
export const fleetRoutes = new Hono<AppEnv>().get("/fleet/workers", requireOrgAdmin, async (c) => {
  const rows = await c.var.db
    .select({
      containerId: workerHeartbeats.containerId,
      startedAt: workerHeartbeats.startedAt,
      consumersReadyAt: workerHeartbeats.consumersReadyAt,
      heartbeatAt: workerHeartbeats.heartbeatAt,
      executors: workerHeartbeats.executors,
      version: workerHeartbeats.version,
      live: sql<boolean>`${workerHeartbeats.heartbeatAt} > now() - interval '${sql.raw(
        String(STALE_AFTER_SECONDS),
      )} seconds'`,
    })
    .from(workerHeartbeats)
    // the readiness module prunes rows silent for 7 days; filter anyway so a
    // quiet deployment (no beats, no prune) doesn't resurrect ancient rows
    .where(gte(workerHeartbeats.heartbeatAt, sql`now() - interval '7 days'`))
    .orderBy(desc(workerHeartbeats.heartbeatAt));
  return c.json({
    workers: rows.map(({ live, ...row }) => ({ ...row, status: live ? "live" : "stale" })),
  });
});
