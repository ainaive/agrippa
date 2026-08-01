import { index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAtCol, idCol, tstz } from "./_helpers";
import { users } from "./auth";
import { orgs } from "./orgs";
import type { WorkerExecutorAd } from "./registry";

/**
 * Remote runtime daemons (ADR-0017): a daemon on a user/team machine
 * authenticates with its token, registers what it can execute, and claims
 * dispatches over `/api/daemon/*`. One row per issued daemon token — the
 * row IS the runtime's durable identity (revoking the token retires the
 * runtime; a machine re-registering under the same token updates in place).
 *
 * The token is stored hash-only (sha256), `token_prefix` (the first chars of
 * the issued `agrd_…` value) is the indexed lookup key and the only part the
 * UI ever shows again. This deliberately mirrors `api_keys` so a future
 * shared bearer middleware serves both.
 */
export const runtimes = pgTable(
  "runtimes",
  {
    id: idCol(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    status: text("status", { enum: ["active", "revoked"] })
      .notNull()
      .default("active"),
    hostname: text("hostname"),
    version: text("version"),
    /** Same advertisement shape central workers write to worker_heartbeats. */
    executors: jsonb("executors").$type<WorkerExecutorAd[]>().notNull().default([]),
    /** Bumped by register and heartbeat — the routing liveness watermark. */
    lastSeenAt: tstz("last_seen_at"),
    /** Set on first successful register (null = token issued, daemon never connected). */
    registeredAt: tstz("registered_at"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAtCol(),
    revokedAt: tstz("revoked_at"),
  },
  (t) => [
    uniqueIndex("runtimes_token_prefix_uq").on(t.tokenPrefix),
    index("runtimes_org_status_idx").on(t.orgId, t.status),
  ],
);
