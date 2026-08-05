import {
  ARTIFACT_KINDS,
  CHECKPOINT_KINDS,
  type CheckpointStoredResponse,
  type RunKind,
  type RunStatus,
  type StepStatus,
} from "@agrippa/core";
import { sql } from "drizzle-orm";
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
import { createdAtCol, idCol, tstz, uuidv7 } from "./_helpers";
import { users } from "./auth";
import { orgs } from "./orgs";
import { projects } from "./projects";
import { fabri, taskTypes, templateVersions } from "./registry";
import { runtimes } from "./runtimes";

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
  // raw submit-time per-slot agent overrides, kept so a retry can re-resolve
  // without losing the user's deliberate slot choices (ADR-0014); {} = none
  agentOverrides: jsonb("agent_overrides")
    .$type<Record<string, { faberId?: string; executorId?: string }>>()
    .notNull()
    .default({}),
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
    // What this run is: `initial` is a first submission or a retry of one;
    // `followup` continues its parent's workspace and session (ADR-0018).
    kind: text("kind").$type<RunKind>().notNull().default("initial"),
    // The run this one continues. NULL for everything but a follow-up; a chain
    // of follow-ups points each at its immediate predecessor, not at the head.
    parentRunId: uuid("parent_run_id").references((): AnyPgColumn => runs.id),
    /**
     * Which directory on some host holds this run's work (ADR-0018 Decision 3).
     * Written at submit as the run's own id and INHERITED by a follow-up, so a
     * steering chain shares one workspace — which is the whole point: the
     * agent's branch, its uncommitted edits, and its session all live there.
     *
     * Writer-assigned rather than defaulted, because Postgres cannot default a
     * column to another column of the same row. The identity that follows —
     * for every run that is not a follow-up, the key IS the run id — is what
     * keeps older daemons correct when the wire starts carrying keys.
     */
    workspaceKey: uuid("workspace_key").notNull(),
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
    // Execution lease (ADR-0017 Decision 4, resolving ADR-0009's future work):
    // claiming a run takes the lease by CAS, the owning worker renews it, the
    // sweeper expires dead leases and re-enqueues. A second at-least-once
    // delivery of a `running` run can no longer re-enter it while the lease
    // is live. Owner is the worker's container id; NULL = unheld.
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: tstz("lease_expires_at"),
    // Remote-runtime affinity pin (ADR-0017 Decision 3): set when routing
    // sends the run's execution to a daemon; every subsequent step dispatches
    // to the same runtime, which owns the workspace. NULL = central workers.
    runtimeId: uuid("runtime_id").references(() => runtimes.id),
    // Idempotency key for an unattended firing, NULL for anything a human
    // submitted. A schedule writes its pg-boss job id, a webhook its delivery
    // id — both stable across a retry of the same firing and distinct between
    // firings — so "this run exists" and "this firing already happened" become
    // one committed fact instead of two writes with a crash-window between.
    originKey: text("origin_key"),
    queuedAt: tstz("queued_at").notNull().defaultNow(),
    startedAt: tstz("started_at"),
    finishedAt: tstz("finished_at"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    uniqueIndex("runs_task_number_uq").on(t.taskId, t.number),
    // a re-delivered schedule/trigger job must not be able to charge twice
    uniqueIndex("runs_origin_key_uq").on(t.originKey).where(sql`${t.originKey} IS NOT NULL`),
    index("runs_project_idx").on(t.projectId, t.status),
    // every workspace question is asked by key, not by run: who else shares
    // this directory, and is any of them still alive (ADR-0018 Decisions 3–4)
    index("runs_workspace_key_idx").on(t.workspaceKey),
    // the expiry sweep scans only running runs
    index("runs_lease_sweep_idx").on(t.leaseExpiresAt).where(sql`${t.status} = 'running'`),
    // the daemon claim poll asks "which of my pinned runs are finished?" on
    // every long-poll, so it must not be a seq scan over every run ever
    index("runs_runtime_reap_idx")
      .on(t.runtimeId, t.finishedAt)
      .where(sql`${t.runtimeId} is not null`),
  ],
);

/**
 * A fresh run identity. The workspace key is writer-assigned (see the column),
 * and for anything that is not a follow-up it is the run's own id — so the two
 * are minted together rather than the caller remembering to pair them.
 *
 * A follow-up does NOT use this: it keeps a new id and inherits its parent's
 * key, which is what makes the pair worth naming.
 */
export function newRunIdentity(): { id: string; workspaceKey: string } {
  const id = uuidv7();
  return { id, workspaceKey: id };
}

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
  (t) => [
    uniqueIndex("run_events_run_seq_uq").on(t.runId, t.seq),
    // notification sweeper backstop: scan recent notifiable events by type
    index("run_events_type_created_idx").on(t.type, t.createdAt),
  ],
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
  inline: jsonb("inline"), // small artifacts inline (≤64 KB; checkpoint-driving ones ≤2 MiB)
  // store-time content digest (hex). Integrity anchor for patch evidence at
  // git.push: the disk store is agent-writable, this row is not.
  sha256: text("sha256"),
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
