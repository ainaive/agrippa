import {
  AppError,
  type CheckpointRespondInput,
  type CheckpointStoredResponse,
  checkpointRespondSchema,
  commentCreateSchema,
  EXECUTOR_CATALOG,
  isExecutorId,
  isTerminalRunStatus,
  type Question,
  type ReviewFinding,
  taskSubmitSchema,
} from "@agrippa/core";
import {
  artifacts,
  checkpoints,
  fabri,
  orchestrationTemplates,
  projectMembers,
  projects,
  runComments,
  runEvents,
  runSteps,
  runs,
  tasks,
  taskTypes,
  templateVersions,
  tokenUsage,
  users,
} from "@agrippa/db";
import {
  appendRunEvent as allocateRunEvent,
  assertProjectAcceptsWork,
  assertQuotaHeadroom,
  decideCheckpoint,
  enqueueAfterCommit,
  finalizeRun,
  flattenPhases,
  resolveRunPlan,
  SubmitError,
  submitTask,
  syncRunNotifications,
  upgradeCompiledTemplate,
  verifyRepoRefs,
} from "@agrippa/orchestration";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../context";
import { audit, requestActor } from "../lib/audit";
import { validate } from "../lib/validate";
import { assertProjectRole, requireProjectRole } from "../middleware/rbac";

async function loadRunScoped(
  c: { var: AppEnv["Variables"] },
  runId: string,
  min: "viewer" | "member",
) {
  const [run] = await c.var.db.select().from(runs).where(eq(runs.id, runId));
  if (!run) throw AppError.notFound("Run");
  await assertProjectRole(c.var.db, c.var.principal, run.projectId, min);
  return run;
}

async function listPendingCheckpoints(c: Context<AppEnv>) {
  const rows = await c.var.db
    .select({
      id: checkpoints.id,
      checkpointId: checkpoints.checkpointId,
      kind: checkpoints.kind,
      iteration: checkpoints.iteration,
      payload: checkpoints.payload,
      requestedAt: checkpoints.requestedAt,
      runId: runs.id,
      runNumber: runs.number,
      taskId: tasks.id,
      taskTitle: tasks.title,
      projectId: projects.id,
      projectName: projects.name,
      projectRole: projectMembers.role,
    })
    .from(checkpoints)
    .innerJoin(runs, eq(checkpoints.runId, runs.id))
    .innerJoin(tasks, eq(runs.taskId, tasks.id))
    .innerJoin(projects, eq(runs.projectId, projects.id))
    .innerJoin(
      projectMembers,
      and(eq(projectMembers.projectId, runs.projectId), eq(projectMembers.userId, c.var.user.id)),
    )
    .where(eq(checkpoints.status, "pending"))
    .orderBy(desc(checkpoints.requestedAt));
  return c.json(rows);
}

type RunRowForRespond = typeof runs.$inferSelect;

/**
 * The one respond path for every checkpoint kind. Validates the payload
 * against the pending row's kind and snapshot, builds the stored response
 * (full finding objects, not ids — templates interpolate them directly),
 * then commits the CAS decision + checkpoint.decided event + audit row in
 * one transaction before re-enqueueing the run.
 */
async function respondToCheckpoint(
  c: Context<AppEnv>,
  run: RunRowForRespond,
  rowId: string,
  input: CheckpointRespondInput,
) {
  const db = c.var.db;
  const [row] = await db
    .select()
    .from(checkpoints)
    .where(and(eq(checkpoints.id, rowId), eq(checkpoints.runId, run.id)));
  if (!row) throw AppError.notFound("Checkpoint");
  if (row.kind !== input.kind) {
    throw AppError.conflict("checkpoint_kind_mismatch", `Checkpoint is of kind '${row.kind}'`);
  }
  const payload = row.payload as {
    questions?: Question[];
    findings?: ReviewFinding[];
    loopId?: string | null;
  };

  let status: "approved" | "rejected" = "approved";
  let comment: string | undefined;
  let response: CheckpointStoredResponse;

  if (input.kind === "approval") {
    if (input.decision === "request_changes" && !payload.loopId) {
      // outside a loop there is nothing to send the agent back to — the
      // outcome would silently read as a pass
      throw AppError.conflict(
        "request_changes_unsupported",
        "This checkpoint cannot request changes",
      );
    }
    status = input.decision === "rejected" ? "rejected" : "approved";
    response = { kind: "approval", outcome: input.decision, comment: input.comment };
    comment = input.comment;
  } else if (input.kind === "input") {
    const questions = payload.questions ?? [];
    const known = new Set(questions.map((q) => q.id));
    const unknown = Object.keys(input.answers).filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw AppError.validation([{ message: `unknown questions: ${unknown.join(", ")}` }]);
    }
    const missing = questions
      .filter((q) => q.required !== false)
      .filter((q) => input.answers[q.id] === undefined || input.answers[q.id] === "")
      .map((q) => q.id);
    if (missing.length > 0) {
      throw AppError.validation([{ message: `answers required for: ${missing.join(", ")}` }]);
    }
    // each answer must match its snapshotted question's kind — the answer re-
    // enters agent prompts, so a select value outside the options (or a string
    // where a boolean was asked) must be rejected here, not interpolated later
    for (const question of questions) {
      const answer = input.answers[question.id];
      if (answer === undefined) continue;
      const kind = question.kind ?? "text"; // pre-fix snapshots may lack kind
      if (kind === "boolean" && typeof answer !== "boolean") {
        throw AppError.validation([
          { message: `question '${question.id}' expects a boolean answer` },
        ]);
      }
      if (kind !== "boolean" && typeof answer !== "string") {
        throw AppError.validation([{ message: `question '${question.id}' expects a text answer` }]);
      }
      if (kind === "select" && !(question.options ?? []).includes(answer as string)) {
        throw AppError.validation([
          { message: `question '${question.id}' answer must be one of its options` },
        ]);
      }
    }
    response = { kind: "input", outcome: "answered", answers: input.answers };
  } else {
    const findings = payload.findings ?? [];
    const byId = new Map(findings.map((f) => [f.id, f]));
    if (input.outcome === "fix") {
      if (input.selectedFindingIds.length === 0) {
        throw AppError.validation([{ message: "select at least one finding to fix" }]);
      }
      const unknown = input.selectedFindingIds.filter((id) => !byId.has(id));
      if (unknown.length > 0) {
        throw AppError.validation([{ message: `unknown findings: ${unknown.join(", ")}` }]);
      }
      const selectedIds = new Set(input.selectedFindingIds);
      const selected = findings.filter((f) => selectedIds.has(f.id));
      const accepted = findings.filter((f) => !selectedIds.has(f.id));
      response = {
        kind: "review-gate",
        outcome: "fix",
        selectedFindings: selected,
        acceptedFindings: accepted,
        acceptedFindingIds: accepted.map((f) => f.id),
      };
    } else {
      response = {
        kind: "review-gate",
        outcome: "pass",
        selectedFindings: [],
        acceptedFindings: findings,
        acceptedFindingIds: findings.map((f) => f.id),
      };
    }
  }

  const eventPayload = {
    checkpointRowId: row.id,
    checkpointId: row.checkpointId,
    kind: row.kind,
    iteration: row.iteration,
    outcome: response.outcome,
    decidedBy: { id: c.var.user.id, name: c.var.user.name },
  };
  // decision (CAS on status='pending'), the checkpoint.decided event, and the
  // audit row commit together — a partial write can't leave the timeline or
  // audit log missing the decision that a later retry would then skip
  const result = await db.transaction(async (tx) => {
    const updated = await decideCheckpoint(tx, row.id, {
      status,
      decidedBy: c.var.user.id,
      comment,
      response,
    });
    if (!updated) return { updated: null as null };
    const event = await allocateRunEvent(tx, {
      runId: run.id,
      type: "checkpoint.decided",
      payload: eventPayload,
    });
    await audit(
      c,
      {
        action: "run.checkpoint.respond",
        resourceType: "checkpoint",
        resourceId: row.id,
        projectId: run.projectId,
        payload: { kind: row.kind, outcome: response.outcome },
      },
      tx,
    );
    return { updated, event };
  });
  if (!result.updated) {
    // already decided, OR a prior attempt decided then failed to enqueue: in
    // both cases the durable state is correct, so re-enqueue to unstick the
    // run (the sweeper also backstops this) and report the conflict
    await enqueueAfterCommit(
      () => c.var.queue?.enqueueRun(run.id) ?? Promise.resolve(),
      `resume run ${run.id}`,
    );
    throw AppError.conflict("already_decided", "Checkpoint is already decided");
  }
  // publish + enqueue only after the decision durably committed
  await c.var.bus?.publish({
    runId: run.id,
    seq: result.event.seq,
    type: "checkpoint.decided",
    payload: eventPayload,
    createdAt: result.event.createdAt.toISOString(),
  });
  // best-effort: the decision is committed, and findStrandedCheckpointRuns
  // re-enqueues a decided-but-unresumed run, so a send failure must not 500 a
  // checkpoint the user has in fact answered
  await enqueueAfterCommit(
    () => c.var.queue?.enqueueRun(run.id) ?? Promise.resolve(),
    `resume run ${run.id}`,
  );
  return c.json(result.updated);
}

export const executionRoutes = new Hono<AppEnv>()
  // ── Submit ──────────────────────────────────────────────────────────────────
  .post(
    "/projects/:projectId/tasks",
    requireProjectRole("member"),
    validate("json", taskSubmitSchema),
    async (c) => {
      try {
        const { taskId, runId } = await submitTask(c.var.db, c.var.queue, {
          projectId: c.req.param("projectId"),
          actorUserId: c.var.user.id,
          actor: requestActor(c),
          input: c.req.valid("json"),
        });
        return c.json({ taskId, runId }, 202);
      } catch (err) {
        if (err instanceof SubmitError) {
          throw new AppError(err.code, 400, err.message, err.details);
        }
        throw err;
      }
    },
  )
  .get("/projects/:projectId/tasks", requireProjectRole("viewer"), async (c) => {
    const rows = await c.var.db
      .select({
        id: tasks.id,
        title: tasks.title,
        taskTypeId: tasks.taskTypeId,
        createdAt: tasks.createdAt,
        createdBy: tasks.createdBy,
        latestRunId: tasks.latestRunId,
        runStatus: runs.status,
        runNumber: runs.number,
      })
      .from(tasks)
      .leftJoin(runs, eq(tasks.latestRunId, runs.id))
      .where(eq(tasks.projectId, c.req.param("projectId")))
      .orderBy(desc(tasks.createdAt));
    return c.json(rows);
  })
  .get("/tasks/:id", async (c) => {
    const [task] = await c.var.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, c.req.param("id")));
    if (!task) throw AppError.notFound("Task");
    await assertProjectRole(c.var.db, c.var.principal, task.projectId, "viewer");
    const taskRuns = await c.var.db
      .select({
        id: runs.id,
        number: runs.number,
        status: runs.status,
        queuedAt: runs.queuedAt,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
      })
      .from(runs)
      .where(eq(runs.taskId, task.id))
      .orderBy(desc(runs.number));
    return c.json({ ...task, runs: taskRuns });
  })
  .post("/tasks/:id/retry", async (c) => {
    const db = c.var.db;
    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, c.req.param("id")));
    if (!task) throw AppError.notFound("Task");
    await assertProjectRole(db, c.var.principal, task.projectId, "member");
    // a retry is new work and consumes tokens like any run — an archived
    // project refuses it for the same reason it refuses a submission
    await assertProjectAcceptsWork(db, task.projectId);

    const [latest] = await db
      .select()
      .from(runs)
      .where(eq(runs.taskId, task.id))
      .orderBy(desc(runs.number))
      .limit(1);
    if (!latest) throw AppError.notFound("Run");
    if (!isTerminalRunStatus(latest.status)) {
      throw AppError.conflict("run_active", "The latest run has not finished");
    }

    // deliberately no taskType.enabled check: disabling blocks new catalog
    // submissions, not retries of a task that already exists (ADR-0014)
    const [taskType] = await db.select().from(taskTypes).where(eq(taskTypes.id, task.taskTypeId));
    if (!taskType) throw AppError.notFound("Task type");
    const [version] = await db
      .select()
      .from(templateVersions)
      .where(eq(templateVersions.id, latest.templateVersionId));
    if (!version) throw AppError.notFound("Template version");
    const compiled = upgradeCompiledTemplate(version.compiled);

    // a retry consumes tokens like any run — same hard-stop as submit
    await assertQuotaHeadroom(db, task.projectId);

    try {
      // ADR-0014: the template version and params snapshot stay pinned;
      // everything derived from project configuration re-resolves, so a
      // config fix (grants, registry, credentials) heals the task here
      // instead of re-billing a full run into the same failure
      await verifyRepoRefs(db, task.projectId, compiled.spec.inputs, latest.paramsSnapshot);
      const { resourceManifest, agentResolution } = await resolveRunPlan(
        db,
        task.projectId,
        taskType,
        compiled,
        task.agentOverrides ?? {},
      );

      const run = await db.transaction(async (tx) => {
        // serialize concurrent retries on the task row: two racers would both
        // compute number N+1 and the loser would die on runs_task_number_uq
        // as a 500 — locked, the second sees the first's queued run instead
        // and gets the run_active conflict. The pre-tx read above only sourced
        // the pinned snapshot/version, identical across all runs of a task.
        await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, task.id)).for("update");
        const [head] = await tx
          .select({ id: runs.id, number: runs.number, status: runs.status })
          .from(runs)
          .where(eq(runs.taskId, task.id))
          .orderBy(desc(runs.number))
          .limit(1);
        if (!head) throw AppError.notFound("Run");
        if (!isTerminalRunStatus(head.status)) {
          throw AppError.conflict("run_active", "The latest run has not finished");
        }
        const [run] = await tx
          .insert(runs)
          .values({
            taskId: task.id,
            projectId: task.projectId,
            number: head.number + 1,
            templateVersionId: latest.templateVersionId,
            faberId: agentResolution.primary.faberId,
            executorId: agentResolution.primary.executorId,
            agentBindings: agentResolution.bindings,
            paramsSnapshot: latest.paramsSnapshot,
            modelResolution: agentResolution.modelResolution,
            resourceManifest,
            createdBy: c.var.user.id,
          })
          .returning();
        if (!run) throw new Error("run insert failed");
        await tx.update(tasks).set({ latestRunId: run.id }).where(eq(tasks.id, task.id));
        // in the tx: the every-mutation-is-audited invariant (ADR-0013 am. 1)
        await audit(
          c,
          {
            action: "task.retry",
            resourceType: "run",
            resourceId: run.id,
            projectId: task.projectId,
            payload: { fromRunId: head.id, taskId: task.id },
          },
          tx,
        );
        return run;
      });
      await enqueueAfterCommit(
        () => c.var.queue?.enqueueRun(run.id) ?? Promise.resolve(),
        `retry run ${run.id}`,
      );
      return c.json({ runId: run.id, number: run.number }, 202);
    } catch (err) {
      if (err instanceof SubmitError) throw new AppError(err.code, 400, err.message, err.details);
      throw err;
    }
  })

  // ── Runs ────────────────────────────────────────────────────────────────────
  .get("/runs/:id", async (c) => {
    const run = await loadRunScoped(c, c.req.param("id"), "viewer");
    // every checkpoint with who decided it — the timeline's interaction cards
    const checkpointRows = await c.var.db
      .select({ row: checkpoints, deciderName: users.name })
      .from(checkpoints)
      .leftJoin(users, eq(checkpoints.decidedBy, users.id))
      .where(eq(checkpoints.runId, run.id))
      .orderBy(asc(checkpoints.requestedAt));
    // slot → faber (name/avatar) + executor label, for the header chips
    const faberIds = [
      ...new Set([run.faberId, ...Object.values(run.agentBindings ?? {}).map((b) => b.faberId)]),
    ];
    const faberRows = await c.var.db.select().from(fabri).where(inArray(fabri.id, faberIds));
    const fabersById = new Map(faberRows.map((f) => [f.id, f]));
    const agents = Object.fromEntries(
      Object.entries(run.agentBindings ?? {}).map(([slot, binding]) => {
        const faber = fabersById.get(binding.faberId);
        return [
          slot,
          {
            faberId: binding.faberId,
            faberSlug: faber?.slug ?? null,
            faberName: faber?.nameI18n ?? null,
            faberAvatar: faber?.avatar ?? null,
            executorId: binding.executorId,
            executorLabel: isExecutorId(binding.executorId)
              ? EXECUTOR_CATALOG[binding.executorId].label
              : binding.executorId,
          },
        ];
      }),
    );
    // Embed the pinned template's plan so the UI can group steps by phase.
    // Viewer-scoped projection: structure + i18n names only — never
    // instructions, prompts, or resource references.
    let template: Record<string, unknown> | null = null;
    if (run.templateVersionId) {
      const [row] = await c.var.db
        .select({
          version: templateVersions.version,
          compiled: templateVersions.compiled,
          slug: orchestrationTemplates.slug,
        })
        .from(templateVersions)
        .innerJoin(
          orchestrationTemplates,
          eq(orchestrationTemplates.id, templateVersions.templateId),
        )
        .where(eq(templateVersions.id, run.templateVersionId));
      const spec = row ? upgradeCompiledTemplate(row.compiled).spec : null;
      if (row && spec) {
        template = {
          slug: row.slug,
          version: row.version,
          agents: Object.fromEntries(
            Object.entries(spec.agents).map(([slot, agent]) => [
              slot,
              { label: agent.label, overridable: agent.overridable },
            ]),
          ),
          phases: flattenPhases(spec.phases).map(({ phase, loop }) => {
            const checkpointSteps = phase.steps.filter((step) => step.kind === "checkpoint");
            const firstApproval = checkpointSteps.find(
              (step) => step.checkpoint.kind === "approval",
            );
            return {
              id: phase.id,
              name: phase.name,
              loop: loop
                ? { id: loop.id, name: loop.name, maxIterations: loop.maxIterations }
                : null,
              stepIds: phase.steps.map((step) => step.id),
              checkpoints: checkpointSteps.map((step) => ({
                id: step.id,
                kind: step.checkpoint.kind,
                title: step.checkpoint.title,
                present: step.checkpoint.present,
              })),
              // legacy projection retained for the current phase-timeline UI
              approval: firstApproval
                ? {
                    checkpoint: firstApproval.id,
                    title: firstApproval.checkpoint.title,
                    present: firstApproval.checkpoint.present,
                  }
                : null,
            };
          }),
          limits: spec.limits,
          modelRoles: spec.models.roles,
        };
      }
    }
    return c.json({
      ...run,
      template,
      agents,
      checkpoints: checkpointRows.map(({ row, deciderName }) => ({ ...row, deciderName })),
    });
  })
  .get("/runs/:id/steps", async (c) => {
    const run = await loadRunScoped(c, c.req.param("id"), "viewer");
    const rows = await c.var.db
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, run.id))
      .orderBy(asc(runSteps.seq), asc(runSteps.attempt));
    // per-step consumption lives in token_usage (per attempt); aggregate it into
    // the response so the timeline can show tokens without an N+1 from the SPA
    const usageRows = await c.var.db
      .select({
        stepId: tokenUsage.stepId,
        tokens: sql<string>`coalesce(sum(${tokenUsage.inputTokens} + ${tokenUsage.outputTokens}), 0)`,
      })
      .from(tokenUsage)
      .where(eq(tokenUsage.runId, run.id))
      .groupBy(tokenUsage.stepId);
    const usageByStep = new Map(usageRows.map((u) => [u.stepId, { tokens: Number(u.tokens) }]));
    return c.json(rows.map((row) => ({ ...row, usage: usageByStep.get(row.id) ?? row.usage })));
  })
  .post("/runs/:id/cancel", async (c) => {
    const run = await loadRunScoped(c, c.req.param("id"), "member");
    if (isTerminalRunStatus(run.status)) {
      throw AppError.conflict("already_terminal", "Run already finished");
    }
    await c.var.db.update(runs).set({ cancelRequested: true }).where(eq(runs.id, run.id));
    await c.var.bus?.publishControl(run.id, "cancel");
    // No worker holds a queued/waiting run: setting the flag + the control
    // message + enqueue all miss — the control channel has no subscriber yet,
    // and enqueueRun is singleton-deduped against the submit-time job. So the
    // user saw no change until the worker happened to pick the run up. Finalize
    // directly here; the CAS inside finalizeRun makes this concurrency-safe
    // against a worker that picks the run up in the same instant.
    if (run.status === "queued" || run.status === "waiting_approval") {
      const result = await finalizeRun(c.var.db, {
        runId: run.id,
        from: run.status,
        to: "cancelled",
        error: { code: "cancelled", message: "run cancelled" },
        usageTotals: {},
        eventPayload: { error: { code: "cancelled", message: "run cancelled" } },
      });
      if (result.outcome === "finalized") {
        // push the terminal event to connected SSE clients immediately
        await c.var.bus?.publish({
          runId: run.id,
          seq: result.seq,
          type: "run.cancelled",
          payload: { error: { code: "cancelled", message: "run cancelled" } },
          createdAt: result.createdAt.toISOString(),
        });
      } else {
        // lost: another path moved the run out of <queued|waiting_approval>
        // first (typically the worker just picked it up). The flag is set and
        // the control message fired above; enqueue as a belt-and-suspenders
        // nudge so the worker observes cancelRequested at its next boundary.
        await enqueueAfterCommit(
          () => c.var.queue?.enqueueRun(run.id) ?? Promise.resolve(),
          `cancel nudge run ${run.id}`,
        );
      }
    }
    await audit(c, {
      action: "run.cancel",
      resourceType: "run",
      resourceId: run.id,
      projectId: run.projectId,
    });
    // this finalize happens in the API process, so the worker's
    // post-executeRun sync never sees it — create the delivery rows here.
    // Best-effort, and only after the audit row: the cancel is already
    // committed, so bookkeeping must not 500 the response or displace the
    // audit write (the worker sweeper is the delivery guarantee).
    try {
      await syncRunNotifications(c.var.db, c.var.queue, run.id);
    } catch (err) {
      console.warn(`[api] notification sync failed for run ${run.id}:`, String(err));
    }
    return c.json({ cancelRequested: true });
  })

  // ── Checkpoints ─────────────────────────────────────────────────────────────
  // Cross-project inbox: every pending checkpoint in a project the caller
  // belongs to ("waiting on you"). Read-only; responding goes through
  // POST /runs/:id/checkpoints/:checkpointId/respond.
  .get("/checkpoints/pending", (c) => listPendingCheckpoints(c))
  .get("/runs/:id/checkpoints", async (c) => {
    const run = await loadRunScoped(c, c.req.param("id"), "viewer");
    const rows = await c.var.db
      .select({ row: checkpoints, deciderName: users.name })
      .from(checkpoints)
      .leftJoin(users, eq(checkpoints.decidedBy, users.id))
      .where(eq(checkpoints.runId, run.id))
      .orderBy(asc(checkpoints.requestedAt));
    return c.json(rows.map(({ row, deciderName }) => ({ ...row, deciderName })));
  })
  .post(
    "/runs/:id/checkpoints/:checkpointId/respond",
    validate("json", checkpointRespondSchema),
    async (c) => {
      const run = await loadRunScoped(c, c.req.param("id"), "member");
      return await respondToCheckpoint(c, run, c.req.param("checkpointId"), c.req.valid("json"));
    },
  )

  // ── Comments ────────────────────────────────────────────────────────────────
  .get("/runs/:id/comments", async (c) => {
    const run = await loadRunScoped(c, c.req.param("id"), "viewer");
    const rows = await c.var.db
      .select({
        id: runComments.id,
        body: runComments.body,
        createdAt: runComments.createdAt,
        userId: users.id,
        userName: users.name,
      })
      .from(runComments)
      .innerJoin(users, eq(runComments.userId, users.id))
      .where(eq(runComments.runId, run.id))
      .orderBy(asc(runComments.createdAt));
    return c.json(rows);
  })
  .post("/runs/:id/comments", validate("json", commentCreateSchema), async (c) => {
    const run = await loadRunScoped(c, c.req.param("id"), "member");
    const input = c.req.valid("json");
    // the comment row and its timeline event commit together, so the SSE
    // stream and the thread can never disagree
    const { comment, event, payload } = await c.var.db.transaction(async (tx) => {
      const [comment] = await tx
        .insert(runComments)
        .values({ runId: run.id, userId: c.var.user.id, body: input.body })
        .returning();
      if (!comment) throw new Error("comment insert failed");
      const payload = {
        commentId: comment.id,
        body: comment.body,
        user: { id: c.var.user.id, name: c.var.user.name },
      };
      const event = await allocateRunEvent(tx, {
        runId: run.id,
        type: "comment.added",
        payload,
      });
      await audit(
        c,
        {
          action: "run.comment.create",
          resourceType: "run",
          resourceId: run.id,
          projectId: run.projectId,
        },
        tx,
      );
      return { comment, event, payload };
    });
    await c.var.bus?.publish({
      runId: run.id,
      seq: event.seq,
      type: "comment.added",
      payload,
      createdAt: event.createdAt.toISOString(),
    });
    return c.json(comment, 201);
  })

  // ── Artifacts ───────────────────────────────────────────────────────────────
  .get("/runs/:id/artifacts", async (c) => {
    const run = await loadRunScoped(c, c.req.param("id"), "viewer");
    // creation order matters: loop rounds re-produce the same key, and the
    // checkpoint panels must present the LATEST row per key, not the first
    const rows = await c.var.db
      .select({
        id: artifacts.id,
        artifactKey: artifacts.artifactKey,
        iteration: artifacts.iteration,
        kind: artifacts.kind,
        name: artifacts.name,
        mime: artifacts.mime,
        size: artifacts.size,
        createdAt: artifacts.createdAt,
      })
      .from(artifacts)
      .where(eq(artifacts.runId, run.id))
      .orderBy(asc(artifacts.createdAt), asc(artifacts.id));
    return c.json(rows);
  })
  .get("/artifacts/:id/download", async (c) => {
    const [artifact] = await c.var.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, c.req.param("id")));
    if (!artifact) throw AppError.notFound("Artifact");
    await loadRunScoped(c, artifact.runId, "viewer");

    if (artifact.inline !== null) {
      const body =
        typeof artifact.inline === "string"
          ? artifact.inline
          : JSON.stringify(artifact.inline, null, 2);
      const mime =
        artifact.mime ??
        (artifact.kind === "json" ? "application/json" : "text/plain; charset=utf-8");
      return c.body(body, 200, {
        "content-type": mime,
        "content-disposition": `attachment; filename="${artifact.artifactKey}"`,
      });
    }
    if (artifact.storageRef) {
      const file = Bun.file(artifact.storageRef);
      if (!(await file.exists())) throw AppError.notFound("Artifact content");
      return c.body(file.stream(), 200, {
        "content-type": artifact.mime ?? "application/octet-stream",
        "content-disposition": `attachment; filename="${artifact.artifactKey}"`,
      });
    }
    throw AppError.notFound("Artifact content");
  })

  // ── Live events (SSE with Last-Event-ID replay) ─────────────────────────────
  .get("/runs/:id/events", async (c) => {
    const run = await loadRunScoped(c, c.req.param("id"), "viewer");
    const lastEventId = Number(c.req.header("last-event-id") ?? c.req.query("lastEventId") ?? 0);
    const db = c.var.db;
    const bus = c.var.bus;

    return streamSSE(c, async (stream) => {
      let cursor = Number.isFinite(lastEventId) ? lastEventId : 0;
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });

      // A run parked on a long agent turn or an approval emits no events for
      // minutes, and this stream writes nothing in between — so an idle
      // connection looks dead to every intermediary. nginx severs it at
      // proxy_read_timeout (60s by default) and Cloudflare at ~100s. A comment
      // frame is ignored by EventSource but resets those timers, which keeps
      // the reconnect churn (and the replay it triggers) out of normal
      // operation. The default sits well under the tightest common limit;
      // AGRIPPA_SSE_KEEPALIVE_MS exists for proxies more aggressive than that.
      const keepaliveMs = Number(process.env.AGRIPPA_SSE_KEEPALIVE_MS) || 15_000;
      let lastWriteAt = Date.now();

      const sendRow = async (row: {
        seq: number;
        type: string;
        payload: unknown;
        createdAt: Date | string;
      }) => {
        await stream.writeSSE({
          id: String(row.seq),
          event: row.type,
          data: JSON.stringify({ seq: row.seq, type: row.type, payload: row.payload }),
        });
        cursor = Math.max(cursor, row.seq);
        lastWriteAt = Date.now();
      };

      // Comment frame — carries no id, so it can't disturb the Last-Event-ID
      // cursor the client reconnects with.
      const keepaliveIfIdle = async () => {
        if (closed || Date.now() - lastWriteAt < keepaliveMs) return;
        await stream.write(": keepalive\n\n");
        lastWriteAt = Date.now();
      };

      const replay = async () => {
        const rows = await db
          .select()
          .from(runEvents)
          .where(and(eq(runEvents.runId, run.id), gt(runEvents.seq, cursor)))
          .orderBy(asc(runEvents.seq));
        for (const row of rows) await sendRow(row);
        return rows;
      };

      const isTerminal = async (): Promise<boolean> => {
        const [row] = await db
          .select({ status: runs.status })
          .from(runs)
          .where(eq(runs.id, run.id));
        return row ? isTerminalRunStatus(row.status) : true;
      };

      // Live: bridge the bus when present, else poll the DB. The bus is only a
      // WAKE-UP — every event is delivered by an ordered `replay()` from
      // Postgres, so the cursor advances contiguously. Sending bus events
      // directly would advance a high-water cursor past a dropped seq, and that
      // gap would then be skipped forever (even on Last-Event-ID reconnect).
      if (bus) {
        let notify: (() => void) | null = null;
        const subscription = bus.subscribe(run.id, () => notify?.());
        try {
          // wait until the subscription is actually live, THEN replay history,
          // so nothing published in between is dropped (ADR-0007)
          await subscription.ready;
          await replay();
          while (!closed) {
            if (await isTerminal()) {
              await replay(); // final ordered drain
              break;
            }
            // sleep until woken by the bus (or a 2 s safety tick), then replay
            await new Promise<void>((resolve) => {
              notify = resolve;
              setTimeout(resolve, 2000);
            });
            notify = null;
            await replay();
            await keepaliveIfIdle();
          }
        } finally {
          subscription.unsubscribe();
        }
      } else {
        await replay();
        if (await isTerminal()) return;
        while (!closed) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          await replay();
          if (await isTerminal()) break;
          await keepaliveIfIdle();
        }
      }
    });
  });
