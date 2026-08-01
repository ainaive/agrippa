import type { NotifiableEventType } from "@agrippa/core";
import { sql } from "drizzle-orm";
import {
  bigint,
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
import { projects } from "./projects";
import { runEvents, runs } from "./runs";
import { secrets } from "./secrets";

/**
 * Outbound notification channels, one row per configured receiver.
 * `url` is stored plain like repo_connections.url — for IM bots it is a
 * capability URL, so routes are admin-only and responses mask it.
 */
export const notificationEndpoints = pgTable(
  "notification_endpoints",
  {
    id: idCol(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // NotificationEndpointKind; TS-only enum like models.provider
    name: text("name").notNull(),
    url: text("url").notNull(),
    /** Signing secret; required for kind "generic" (API-enforced), optional for IM bots. */
    secretRef: uuid("secret_ref").references(() => secrets.id),
    /** NotifiableEventType[]; empty = every notifiable event. */
    events: jsonb("events").$type<NotifiableEventType[]>().notNull().default([]),
    /** Rendering locale for this channel's audience (design/07: channels carry their own locale). */
    locale: text("locale").notNull().default("zh-CN"),
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Watermark: only events created at/after this instant are delivered.
     * Reset by PATCH on re-enable and on url/events changes, so a new or
     * materially changed endpoint never replays history.
     */
    activatedAt: tstz("activated_at").notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAtCol(),
  },
  (t) => [index("notification_endpoints_project_idx").on(t.projectId)],
);

/**
 * One delivery attempt-record per (endpoint, notifiable run event) — the
 * unique index is what makes syncRunNotifications idempotent. Test sends
 * carry no event/run. `payload` is a redacted snapshot for inspection;
 * retries re-render from the durable event because signatures embed
 * timestamps receivers reject when stale.
 */
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: idCol(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => notificationEndpoints.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
    eventId: bigint("event_id", { mode: "number" }).references(() => runEvents.id, {
      onDelete: "cascade",
    }),
    eventType: text("event_type").notNull(), // denormalized for the list UI; "notification.test" for tests
    status: text("status", { enum: ["pending", "succeeded", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    lastAttemptAt: tstz("last_attempt_at"),
    responseStatus: integer("response_status"),
    responseSnippet: text("response_snippet"), // ≤500 chars, secret-free
    lastError: text("last_error"),
    createdAt: createdAtCol(),
  },
  (t) => [
    uniqueIndex("notification_deliveries_dedupe_uq")
      .on(t.endpointId, t.eventId)
      .where(sql`${t.eventId} IS NOT NULL`),
    index("notification_deliveries_project_idx").on(t.projectId, t.createdAt),
    index("notification_deliveries_pending_idx")
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);
