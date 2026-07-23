import {
  ARTIFACT_KINDS,
  CHECKPOINT_KINDS,
  type CheckpointStoredResponse,
  type RunStatus,
  type StepStatus,
} from "@agrippa/core";
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
    // authorized skills/MCP slugs, pinned at submit from project grants; the
    // worker resolves resources only from this set (docs/design/04, ADR-0005)
    resourceManifest: jsonb("resource_manifest")
      .$type<{ mcpServers: string[]; skills: string[] }>()
      .notNull()
      .default({ mcpServers: [], skills: [] }),
    budget: jsonb("budget").$type<Record<string, unknown>>().notNull().default({}),
    usageTotals: jsonb("usage_totals").$type<Record<string, unknown>>().notNull().default({}),
    // atomic per-run event-seq allocator (UPDATE … RETURNING); avoids max(seq)+1 races
    nextEventSeq: integer("next_event_seq").notNull().default(0),
    workspaceRef: text("workspace_ref"),
    error: jsonb("error").$type<Record<string, unknown>>(),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    // per-slot agent bindings (agrippa/v2); faber_id/executor_id above stay as
    // primary-slot denormalization for list/usage queries
    agentBindings: jsonb("agent_bindings")
      .$type<Record<string, { faberId: string; executorId: string }>>()
      .notNull()
      .default({}),
    workBranch: text("work_branch"), // created by the git.branch system action
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
    iteration: integer("iteration").notNull().default(1), // loop round; 1 outside loops
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
  (t) => [uniqueIndex("run_steps_uq").on(t.runId, t.phaseId, t.stepId, t.iteration, t.attempt)],
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

/**
 * Human-in-the-loop pauses (formerly `approvals`). One row per
 * (run, checkpoint, iteration); the engine inserts it pending, the API
 * decides it (CAS), and `response` carries the structured decision back
 * into the run's expression context (`checkpoints.<id>`).
 */
export const checkpoints = pgTable(
  "checkpoints",
  {
    id: idCol(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepId: uuid("step_id").references(() => runSteps.id),
    checkpointId: text("checkpoint_id").notNull(),
    kind: text("kind", { enum: CHECKPOINT_KINDS }).notNull().default("approval"),
    iteration: integer("iteration").notNull().default(1),
    status: text("status", { enum: ["pending", "approved", "rejected", "expired"] })
      .notNull()
      .default("pending"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    response: jsonb("response").$type<CheckpointStoredResponse>(),
    requestedAt: tstz("requested_at").notNull().defaultNow(),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: tstz("decided_at"),
    comment: text("comment"),
  },
  (t) => [uniqueIndex("checkpoints_run_ckpt_iter_uq").on(t.runId, t.checkpointId, t.iteration)],
);

export const artifacts = pgTable("artifacts", {
  id: idCol(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  stepId: uuid("step_id").references(() => runSteps.id),
  artifactKey: text("artifact_key").notNull(), // from the template output contract
  iteration: integer("iteration").notNull().default(1), // loop round that produced it
  kind: text("kind", { enum: ARTIFACT_KINDS }).notNull(),
  name: text("name").notNull(),
  mime: text("mime"),
  size: integer("size"),
  storageRef: text("storage_ref"), // large artifacts on disk
  inline: jsonb("inline"), // small artifacts (≤64 KB) inline
  createdAt: createdAtCol(),
});

/** Team discussion on a run; each insert also appends a comment.added run event. */
export const runComments = pgTable(
  "run_comments",
  {
    id: idCol(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(), // ≤4000, enforced by commentCreateSchema
    createdAt: createdAtCol(),
  },
  (t) => [index("run_comments_run_idx").on(t.runId, t.createdAt)],
);
