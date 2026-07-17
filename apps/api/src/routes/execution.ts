import {
  AppError,
  approvalDecisionSchema,
  isTerminalRunStatus,
  taskSubmitSchema,
} from "@agrippa/core";
import {
  approvals,
  artifacts,
  mcpServers,
  orchestrationTemplates,
  runEvents,
  runSteps,
  runs,
  skills,
  tasks,
  taskTypes,
  templateVersions,
} from "@agrippa/db";
import {
  authorizeResources,
  buildParamsValidator,
  resolveModelRoles,
  SubmitError,
  type TemplateDoc,
  verifyRepoRefs,
} from "@agrippa/orchestration";
import { and, asc, desc, eq, gt, max } from "drizzle-orm";
import { Hono } from "hono";
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

/** Appends an API-originated event to the run log (seq = max + 1) and the bus. */
async function appendRunEvent(
  c: { var: AppEnv["Variables"] },
  runId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const [maxSeq] = await c.var.db
    .select({ v: max(runEvents.seq) })
    .from(runEvents)
    .where(eq(runEvents.runId, runId));
  const seq = (maxSeq?.v ?? 0) + 1;
  await c.var.db.insert(runEvents).values({ runId, seq, type, payload });
  await c.var.bus?.publish({
    runId,
    seq,
    type,
    payload,
    createdAt: new Date().toISOString(),
  });
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
      const compiled = version.compiled as unknown as TemplateDoc;

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
        const modelResolution = await resolveModelRoles(db, projectId, compiled.spec.models);

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
              faberId: taskType.defaultFaberId,
              executorId: DEFAULT_EXECUTOR,
              paramsSnapshot: parsed.data,
              modelResolution,
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
    return c.json(run);
  })
  .get("/runs/:id/steps", async (c) => {
    const run = await loadRunScoped(c, c.req.param("id"), "viewer");
    const rows = await c.var.db
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, run.id))
      .orderBy(asc(runSteps.seq), asc(runSteps.attempt));
    return c.json(rows);
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

  // ── Approvals ───────────────────────────────────────────────────────────────
  .get("/runs/:id/approvals", async (c) => {
    const run = await loadRunScoped(c, c.req.param("id"), "viewer");
    const rows = await c.var.db.select().from(approvals).where(eq(approvals.runId, run.id));
    return c.json(rows);
  })
  .post("/runs/:id/approvals/:approvalId", validate("json", approvalDecisionSchema), async (c) => {
    const run = await loadRunScoped(c, c.req.param("id"), "member");
    const input = c.req.valid("json");
    const [approval] = await c.var.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, c.req.param("approvalId")), eq(approvals.runId, run.id)));
    if (!approval) throw AppError.notFound("Approval");
    if (approval.status !== "pending") {
      throw AppError.conflict("already_decided", `Approval is ${approval.status}`);
    }
    const [updated] = await c.var.db
      .update(approvals)
      .set({
        status: input.decision,
        decidedBy: c.var.user.id,
        decidedAt: new Date(),
        comment: input.comment,
      })
      .where(eq(approvals.id, approval.id))
      .returning();
    await appendRunEvent(c, run.id, "approval.decided", {
      approvalId: approval.id,
      checkpointId: approval.checkpointId,
      decision: input.decision,
    });
    await audit(c, {
      action: "run.approval.decide",
      resourceType: "approval",
      resourceId: approval.id,
      projectId: run.projectId,
      payload: { decision: input.decision },
    });
    await c.var.queue?.enqueueRun(run.id); // resume at the gated phase
    return c.json(updated);
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

      // 1) replay history (gap-free by construction)
      await replay();

      const isTerminal = async (): Promise<boolean> => {
        const [row] = await db
          .select({ status: runs.status })
          .from(runs)
          .where(eq(runs.id, run.id));
        return row ? isTerminalRunStatus(row.status) : true;
      };

      if (await isTerminal()) return;

      // 2) live: bridge the bus when present, else poll the DB
      if (bus) {
        const queue: Array<() => Promise<void>> = [];
        let notify: (() => void) | null = null;
        const unsubscribe = bus.subscribe(run.id, (event) => {
          queue.push(async () => {
            if (event.seq > cursor) {
              await sendRow({ ...event, createdAt: event.createdAt });
            }
          });
          notify?.();
        });
        try {
          while (!closed) {
            while (queue.length > 0) {
              const job = queue.shift();
              if (job) await job();
            }
            if (await isTerminal()) {
              await replay(); // drain anything raced between bus and DB
              break;
            }
            await new Promise<void>((resolve) => {
              notify = resolve;
              setTimeout(resolve, 2000);
            });
            notify = null;
          }
        } finally {
          unsubscribe();
        }
      } else {
        while (!closed) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          await replay();
          if (await isTerminal()) break;
        }
      }
    });
  });
