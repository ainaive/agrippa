import { ARTIFACT_KINDS, type RunStatus, type StepStatus } from "@agrippa/core";
import {
  type AnyPgColumn,
  bigserial,
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
import { fabri, taskTypes, templateVersions } from "./registry";

export const tasks = pgTable("tasks", {
  id: idCol(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  taskTypeId: uuid("task_type_id")
    .notNull()
    .references(() => taskTypes.id),
  title: text("title").notNull(),
  params: jsonb("params").$type<Record<string, unknown>>().notNull(),
  latestRunId: uuid("latest_run_id").references((): AnyPgColumn => runs.id),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: createdAtCol(),
});

export const runs = pgTable(
  "runs",
  {
    id: idCol(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    projectId: uuid("project_id") // denormalized for quota/usage queries
      .notNull()
      .references(() => projects.id),
    number: integer("number").notNull(),
    status: text("status").$type<RunStatus>().notNull().default("queued"),
    templateVersionId: uuid("template_version_id") // pinned at submit
      .notNull()
      .references(() => templateVersions.id),
    faberId: uuid("faber_id")
      .notNull()
      .references(() => fabri.id),
    executorId: text("executor_id").notNull(),
    paramsSnapshot: jsonb("params_snapshot").$type<Record<string, unknown>>().notNull(),
    modelResolution: jsonb("model_resolution").$type<Record<string, unknown>>().notNull(),
    budget: jsonb("budget").$type<Record<string, unknown>>().notNull().default({}),
    usageTotals: jsonb("usage_totals").$type<Record<string, unknown>>().notNull().default({}),
    workspaceRef: text("workspace_ref"),
    error: jsonb("error").$type<Record<string, unknown>>(),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    queuedAt: tstz("queued_at").notNull().defaultNow(),
    startedAt: tstz("started_at"),
    finishedAt: tstz("finished_at"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    uniqueIndex("runs_task_number_uq").on(t.taskId, t.number),
    index("runs_project_idx").on(t.projectId, t.status),
  ],
);

export const runSteps = pgTable(
  "run_steps",
  {
    id: idCol(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    phaseId: text("phase_id").notNull(),
    stepId: text("step_id").notNull(),
    attempt: integer("attempt").notNull().default(1),
    seq: integer("seq").notNull(),
    status: text("status").$type<StepStatus>().notNull().default("pending"),
    agentRef: text("agent_ref"),
    modelId: uuid("model_id"),
    executorSessionId: text("executor_session_id"), // engine resume handle
    output: text("output"), // step.completed output — feeds steps.<id>.outputs.result + priorContext
    usage: jsonb("usage").$type<Record<string, unknown>>().notNull().default({}),
    error: jsonb("error").$type<Record<string, unknown>>(),
    startedAt: tstz("started_at"),
    finishedAt: tstz("finished_at"),
  },
  (t) => [uniqueIndex("run_steps_uq").on(t.runId, t.phaseId, t.stepId, t.attempt)],
);

/** Append-only; the source of truth for the timeline and SSE replay. */
export const runEvents = pgTable(
  "run_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepId: uuid("step_id").references(() => runSteps.id),
    seq: integer("seq").notNull(), // per-run monotonic; SSE Last-Event-ID
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAtCol(),
  },
  (t) => [uniqueIndex("run_events_run_seq_uq").on(t.runId, t.seq)],
);

export const approvals = pgTable("approvals", {
  id: idCol(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  stepId: uuid("step_id").references(() => runSteps.id),
  checkpointId: text("checkpoint_id").notNull(),
  status: text("status", { enum: ["pending", "approved", "rejected", "expired"] })
    .notNull()
    .default("pending"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  requestedAt: tstz("requested_at").notNull().defaultNow(),
  decidedBy: uuid("decided_by").references(() => users.id),
  decidedAt: tstz("decided_at"),
  comment: text("comment"),
});

export const artifacts = pgTable("artifacts", {
  id: idCol(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  stepId: uuid("step_id").references(() => runSteps.id),
  artifactKey: text("artifact_key").notNull(), // from the template output contract
  kind: text("kind", { enum: ARTIFACT_KINDS }).notNull(),
  name: text("name").notNull(),
  mime: text("mime"),
  size: integer("size"),
  storageRef: text("storage_ref"), // large artifacts on disk
  inline: jsonb("inline"), // small artifacts (≤64 KB) inline
  createdAt: createdAtCol(),
});
