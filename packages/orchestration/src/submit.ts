import { AppError, type RunQueue, type TaskSubmitInput } from "@agrippa/core";
import {
  type Db,
  orchestrationTemplates,
  projects,
  runs,
  tasks,
  taskTypes,
  templateVersions,
} from "@agrippa/db";
import { eq } from "drizzle-orm";
import { type AuditActor, auditAs } from "./audit";
import { upgradeCompiledTemplate } from "./compile";
import { enqueueAfterCommit } from "./queue";
import { buildParamsValidator, verifyRepoRefs } from "./resolve";
import { resolveRunPlan } from "./run-plan";
import { assertQuotaHeadroom } from "./usage";

/**
 * An archived project accepts no new work — not a submission, not a retry.
 *
 * Archiving has always written `projects.status` and, until now, nothing read
 * it: the project merely vanished from the switcher, which was enough while a
 * human had to click Submit. It stops being enough the moment work can arrive
 * without a human (API keys, schedules), because an archived project is exactly
 * the one nobody is looking at — runs would accumulate and burn quota unseen.
 * Both manuals already promise this behavior; this is where it becomes true.
 */
export async function assertProjectAcceptsWork(db: Db, projectId: string): Promise<void> {
  const [project] = await db
    .select({ status: projects.status })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) throw AppError.notFound("Project");
  if (project.status !== "active") {
    throw AppError.conflict("project_archived", "This project is archived and accepts no new work");
  }
}

export type SubmitTaskArgs = {
  projectId: string;
  /**
   * Attribution for the created rows. `tasks.created_by` and `runs.created_by`
   * are NOT NULL → users.id, so every submission — including one fired by a
   * cron schedule or an inbound webhook — resolves to a real user: the trigger's
   * owner stands in for automated callers.
   */
  actorUserId: string;
  /** Audit principal; may name an API key or runtime rather than the user. */
  actor: AuditActor;
  input: TaskSubmitInput;
};

/**
 * Create a task + its first run and enqueue it. Deliberately free of any Hono
 * context so non-HTTP callers (cron schedules, webhook triggers, API-key
 * requests) submit through exactly the same path the browser does — quota,
 * repo-ref verification, resource authorization, and audit included.
 *
 * Throws `SubmitError` (from resolution) and `AppError`; callers own the
 * mapping to a response.
 */
export async function submitTask(
  db: Db,
  queue: RunQueue | null,
  args: SubmitTaskArgs,
): Promise<{ taskId: string; runId: string }> {
  const { projectId, actorUserId, actor, input } = args;

  await assertProjectAcceptsWork(db, projectId);

  const [taskType] = await db.select().from(taskTypes).where(eq(taskTypes.id, input.taskTypeId));
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

  // every repoRef must reference a connection owned by this project
  await verifyRepoRefs(db, projectId, compiled.spec.inputs, parsed.data);

  const { resourceManifest, agentResolution } = await resolveRunPlan(
    db,
    projectId,
    taskType,
    compiled,
    input.agents ?? {},
  );

  const { task, run } = await db.transaction(async (tx) => {
    const [task] = await tx
      .insert(tasks)
      .values({
        orgId: actor.orgId,
        projectId,
        taskTypeId: taskType.id,
        title: input.title,
        params: parsed.data,
        agentOverrides: input.agents ?? {},
        createdBy: actorUserId,
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
        createdBy: actorUserId,
      })
      .returning();
    if (!run) throw new Error("run insert failed");
    await tx.update(tasks).set({ latestRunId: run.id }).where(eq(tasks.id, task.id));
    // in the tx: a committed mutation without its audit row would break
    // the every-mutation-is-audited invariant (ADR-0013 amendment 1)
    await auditAs(tx, actor, {
      action: "task.submit",
      resourceType: "task",
      resourceId: task.id,
      projectId,
      payload: { taskTypeId: taskType.id, runId: run.id },
    });
    return { task, run };
  });

  // Post-commit: the worker's straggler sweep is the delivery guarantee, so a
  // send failure must not surface as a submission failure — the run exists and
  // will execute either way, and telling the caller otherwise invites a retry
  // that creates a second one.
  await enqueueAfterCommit(() => queue?.enqueueRun(run.id) ?? Promise.resolve(), `run ${run.id}`);
  return { taskId: task.id, runId: run.id };
}
