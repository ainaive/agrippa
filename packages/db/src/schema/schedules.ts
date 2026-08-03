import { boolean, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAtCol, idCol, tstz } from "./_helpers";
import { users } from "./auth";
import { orgs } from "./orgs";
import { projects } from "./projects";
import { taskTypes } from "./registry";
import { runs } from "./runs";

/**
 * A standing order: submit this task type, with these parameters, on this cron.
 *
 * `createdBy` is load-bearing rather than decorative. `tasks.created_by` and
 * `runs.created_by` are NOT NULL, so an unattended submission still has to name
 * a human — and naming the schedule's owner means the fire handler can check,
 * at every firing, that this person may still submit here. A schedule therefore
 * carries exactly the authority its owner has right now, never more, and never
 * authority frozen at the moment it was created.
 *
 * When that check fails the schedule is disabled rather than skipped: a skipped
 * firing is silent, and silence is indistinguishable from "no schedule exists"
 * — the worst possible failure mode for the one feature whose job is to run
 * while nobody is watching. `disabledReason` says which of the ways it was.
 */
export const taskSchedules = pgTable(
  "task_schedules",
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
    /** Submission parameters, validated against the template at fire time. */
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    agentOverrides: jsonb("agent_overrides")
      .$type<Record<string, { executorId?: string; faberId?: string }>>()
      .notNull()
      .default({}),
    /** 5-field cron, interpreted in `timezone`. */
    cron: text("cron").notNull(),
    /** IANA zone — pg-boss applies it, so DST is handled for us. */
    timezone: text("timezone").notNull().default("UTC"),
    /** What a firing does when the previous run is still going. */
    concurrencyPolicy: text("concurrency_policy", { enum: ["skip", "queue", "replace"] })
      .notNull()
      .default("skip"),
    enabled: boolean("enabled").notNull().default(true),
    /** Why the platform disabled it; null when a human did, or when enabled. */
    disabledReason: text("disabled_reason"),
    /** Last firing that produced no run, kept visible instead of swallowed. */
    lastError: text("last_error"),
    lastErrorAt: tstz("last_error_at"),
    lastFiredAt: tstz("last_fired_at"),
    /** The run the previous firing produced — the concurrency check reads it. */
    lastRunId: uuid("last_run_id").references(() => runs.id, { onDelete: "set null" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAtCol(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("task_schedules_project_idx").on(t.projectId)],
);
