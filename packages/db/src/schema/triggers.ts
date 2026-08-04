import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAtCol, idCol, tstz } from "./_helpers";
import { users } from "./auth";
import { orgs } from "./orgs";
import { projects } from "./projects";
import { taskTypes } from "./registry";
import { runs, tasks } from "./runs";
import { secrets } from "./secrets";

/**
 * An inbound webhook that submits a task: the mirror image of a notification
 * endpoint, and shaped like one on purpose — a token plus a signing secret, a
 * durable delivery log, replay. The difference is which way the bytes travel,
 * so the HMAC is verified here rather than generated.
 *
 * `createdBy` is load-bearing exactly as it is on `task_schedules`: the run has
 * to name a human, so the trigger names its author, and the author's current
 * project access is re-checked on every firing. A trigger therefore carries
 * exactly the authority its owner has right now.
 */
export const triggerEndpoints = pgTable(
  "trigger_endpoints",
  {
    id: idCol(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskTypeId: uuid("task_type_id")
      .notNull()
      .references(() => taskTypes.id),
    name: text("name").notNull(),
    /** Submission parameters, validated against the template at creation. */
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    agentOverrides: jsonb("agent_overrides")
      .$type<Record<string, { executorId?: string; faberId?: string }>>()
      .notNull()
      .default({}),
    /** Routes the request; the signature is what authenticates it. */
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    /**
     * Required, unlike an outbound endpoint's optional secret. An unsigned
     * inbound trigger is an open "spend this project's tokens" endpoint for
     * anyone who ever sees the URL — in a proxy log, a CI transcript, a
     * screenshot — so there is no unsigned mode to fall back to.
     */
    secretRef: uuid("secret_ref")
      .notNull()
      .references(() => secrets.id),
    /**
     * Resolves the same fire-time date tokens schedules use. A trigger has no
     * calendar of its own, but it still fires at a moment, and the same
     * `{{today}}` typed into the same form field must mean the same thing in
     * both places — otherwise creation validates a token that firing then
     * passes to the agent verbatim.
     */
    timezone: text("timezone").notNull().default("UTC"),
    enabled: boolean("enabled").notNull().default(true),
    disabledReason: text("disabled_reason"),
    lastFiredAt: tstz("last_fired_at"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAtCol(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("trigger_endpoints_token_prefix_uq").on(t.tokenPrefix),
    index("trigger_endpoints_project_idx").on(t.projectId),
  ],
);

/**
 * One row per accepted inbound request. Written before the request is
 * acknowledged, so a submission that fails later is still visible and
 * replayable rather than lost with the sender's connection.
 */
export const triggerDeliveries = pgTable(
  "trigger_deliveries",
  {
    id: idCol(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => triggerEndpoints.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Sender-supplied id, when it offered one — the idempotency key. */
    externalId: text("external_id"),
    status: text("status", { enum: ["pending", "succeeded", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    /** The received body, for inspection and replay. Size-capped at receipt. */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    lastError: text("last_error"),
    lastAttemptAt: tstz("last_attempt_at"),
    createdAt: createdAtCol(),
  },
  (t) => [
    // a sender that retries after a lost response must not submit twice
    uniqueIndex("trigger_deliveries_dedupe_uq")
      .on(t.endpointId, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    index("trigger_deliveries_project_idx").on(t.projectId, t.createdAt),
    index("trigger_deliveries_pending_idx").on(t.createdAt).where(sql`${t.status} = 'pending'`),
  ],
);
