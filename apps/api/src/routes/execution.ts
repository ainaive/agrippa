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
  mcpServers,
  orchestrationTemplates,
  projectMembers,
  projects,
  runComments,
  runEvents,
  runSteps,
  runs,
  skills,
  tasks,
  taskTypes,
  templateVersions,
  tokenUsage,
  users,
} from "@agrippa/db";
import {
  appendRunEvent as allocateRunEvent,
  authorizeResources,
  buildParamsValidator,
  decideCheckpoint,
  flattenPhases,
  resolveAgentBindings,
  SubmitError,
  upgradeCompiledTemplate,
  verifyRepoRefs,
} from "@agrippa/orchestration";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../context";
import { audit } from "../lib/audit";
import { assertQuotaHeadroom } from "../lib/usage";
import { validate } from "../lib/validate";
import { assertProjectRole, requireProjectRole } from "../middleware/rbac";

const DEFAULT_EXECUTOR = process.env.AGRIPPA_EXECUTOR ?? "claude-agent-sdk";

async function loadRunScoped(
  c: { var: AppEnv["Variables"] },
  runId: string,
  min: "viewer" | "member",
) {
  const [run] = await c.var.db.select().from(runs).where(eq(runs.id, runId));
  if (!run) throw AppError.notFound("Run");
  await assertProjectRole(c.var.db, c.var.user.id, run.projectId, min);
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
    await c.var.queue?.enqueueRun(run.id);
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
  await c.var.queue?.enqueueRun(run.id); // resume at the gated step
  return c.json(result.updated);
}

export const executionRoutes = new Hono<AppEnv>()
  // ── Submit ──────────────────────────────────────────────────────────────────
  .post(
    "/projects/:projectId/tasks",
    requireProjectRole("member"),
    validate("json", taskSubmitSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const input = c.req.valid("json");
      const db = c.var.db;
      const user = c.var.user;

      const [taskType] = await db
        .select()
        .from(taskTypes)
        .where(eq(taskTypes.id, input.taskTypeId));
      if (!taskType?.enabled) throw AppError.notFound("Task type");

      const [template] = await db
        .select()
        .from(orchestrationTemplates)
        .where(eq(orchestrationTemplates.id, taskType.templateId));
      if (!template?.latestPublishedVersionId) {
        throw new AppError("template_unpublished", 409, "Task type has no published template");
      }
      const [version] = await db
        .select()
        .from(templateVersions)
        .where(eq(templateVersions.id, template.latestPublishedVersionId));
      if (!version) throw AppError.notFound("Template version");
      const compiled = upgradeCompiledTemplate(version.compiled);

      // params validated against the same compiled schema the SPA renders from
      const parsed = buildParamsValidator(compiled.spec.inputs).safeParse(input.params);
      if (!parsed.success) throw AppError.validation(parsed.error.issues);

      // hard-stop quotas reject new work before anything persists
      await assertQuotaHeadroom(db, projectId);

      try {
        // every repoRef must reference a connection owned by this project
        await verifyRepoRefs(db, projectId, compiled.spec.inputs, parsed.data);

        const skillRows = await db.select({ id: skills.id, slug: skills.slug }).from(skills);
        const mcpRows = await db
          .select({ id: mcpServers.id, slug: mcpServers.slug })
          .from(mcpServers);
        // required grants enforced; optional resources pinned only when granted
        const resourceManifest = await authorizeResources(db, projectId, compiled, {
          skillIdBySlug: new Map(skillRows.map((s) => [s.slug, s.id])),
          mcpIdBySlug: new Map(mcpRows.map((m) => [m.slug, m.id])),
        });
        // every agent slot resolves to a concrete faber + executor here (with
        // per-slot provider-filtered models) and freezes onto the run
        const agentResolution = await resolveAgentBindings(
          db,
          projectId,
          compiled,
          { faberId: taskType.defaultFaberId, executorId: DEFAULT_EXECUTOR },
          input.agents ?? {},
        );

        const { task, run } = await db.transaction(async (tx) => {
          const [task] = await tx
            .insert(tasks)
            .values({
              orgId: user.orgId,
              projectId,
              taskTypeId: taskType.id,
              title: input.title,
              params: parsed.data,
              createdBy: user.id,
            })
            .returning();
          if (!task) throw new Error("task insert failed");
          const [run] = await tx
            .insert(runs)
            .values({
              taskId: task.id,
              projectId,
              number: 1,
              templateVersionId: version.id,
              faberId: agentResolution.primary.faberId,
              executorId: agentResolution.primary.executorId,
              agentBindings: agentResolution.bindings,
              paramsSnapshot: parsed.data,
              modelResolution: agentResolution.modelResolution,
              resourceManifest,
              budget: compiled.spec.budgets as unknown as Record<string, unknown>,
              createdBy: user.id,
            })
            .returning();
          if (!run) throw new Error("run insert failed");
          await tx.update(tasks).set({ latestRunId: run.id }).where(eq(tasks.id, task.id));
          return { task, run };
        });

        await audit(c, {
          action: "task.submit",
          resourceType: "task",
          resourceId: task.id,
          projectId,
          payload: { taskTypeId: taskType.id, runId: run.id },
        });
        // post-commit send; singleton key + worker sweeper make this loss-proof
        await c.var.queue?.enqueueRun(run.id);
        return c.json({ taskId: task.id, runId: run.id }, 202);
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
    await assertProjectRole(c.var.db, c.var.user.id, task.projectId, "viewer");
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
    await assertProjectRole(db, c.var.user.id, task.projectId, "member");

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

    const [run] = await db
      .insert(runs)
      .values({
        taskId: task.id,
        projectId: task.projectId,
        number: latest.number + 1,
        templateVersionId: latest.templateVersionId, // pinned — retries never re-resolve
        faberId: latest.faberId,
        executorId: latest.executorId,
        agentBindings: latest.agentBindings,
        paramsSnapshot: latest.paramsSnapshot,
        modelResolution: latest.modelResolution,
        resourceManifest: latest.resourceManifest,
        budget: latest.budget,
        createdBy: c.var.user.id,
      })
      .returning();
    if (!run) throw new Error("run insert failed");
    await db.update(tasks).set({ latestRunId: run.id }).where(eq(tasks.id, task.id));
    await audit(c, {
      action: "task.retry",
      resourceType: "run",
      resourceId: run.id,
      projectId: task.projectId,
    });
    await c.var.queue?.enqueueRun(run.id);
    return c.json({ runId: run.id, number: run.number }, 202);
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
          budgets: spec.budgets,
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
    // per-step spend lives in token_usage (per attempt); aggregate it into the
    // response so the timeline can show cost without an N+1 from the SPA
    const usageRows = await c.var.db
      .select({
        stepId: tokenUsage.stepId,
        costUsd: sql<string>`coalesce(sum(${tokenUsage.costUsd}), 0)`,
        tokens: sql<string>`coalesce(sum(${tokenUsage.inputTokens} + ${tokenUsage.outputTokens}), 0)`,
      })
      .from(tokenUsage)
      .where(eq(tokenUsage.runId, run.id))
      .groupBy(tokenUsage.stepId);
    const usageByStep = new Map(
      usageRows.map((u) => [u.stepId, { costUsd: Number(u.costUsd), tokens: Number(u.tokens) }]),
    );
    return c.json(rows.map((row) => ({ ...row, usage: usageByStep.get(row.id) ?? row.usage })));
  })
  .post("/runs/:id/cancel", async (c) => {
    const run = await loadRunScoped(c, c.req.param("id"), "member");
    if (isTerminalRunStatus(run.status)) {
      throw AppError.conflict("already_terminal", "Run already finished");
    }
    await c.var.db.update(runs).set({ cancelRequested: true }).where(eq(runs.id, run.id));
    await c.var.bus?.publishControl(run.id, "cancel");
    // no worker holds queued/waiting runs — enqueue so the engine observes the flag
    if (run.status === "queued" || run.status === "waiting_approval") {
      await c.var.queue?.enqueueRun(run.id);
    }
    await audit(c, {
      action: "run.cancel",
      resourceType: "run",
      resourceId: run.id,
      projectId: run.projectId,
    });
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
    const rows = await c.var.db
      .select({
        id: artifacts.id,
        artifactKey: artifacts.artifactKey,
        kind: artifacts.kind,
        name: artifacts.name,
        mime: artifacts.mime,
        size: artifacts.size,
        createdAt: artifacts.createdAt,
      })
      .from(artifacts)
      .where(eq(artifacts.runId, run.id));
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
        }
      }
    });
  });
