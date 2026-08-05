import { AppError, type RunQueue, type TaskSubmitInput } from "@agrippa/core";
import {
  type Db,
  type DbOrTx,
  newRunIdentity,
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
export async function assertProjectAcceptsWork(db: DbOrTx, projectId: string): Promise<void> {
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
  /**
   * Idempotency key identifying **one firing** of an unattended source — a
   * schedule's pg-boss job id, a webhook's delivery id. Omitted by the human
   * paths, where the HTTP request is the firing and a second click is a second
   * intent. See {@link DuplicateFiringError}.
   */
  originKey?: string;
};

export type SubmittedTask = { taskId: string; runId: string };

/** The partial unique index that enforces one run per unattended firing. */
const ORIGIN_KEY_CONSTRAINT = "runs_origin_key_uq";

/**
 * Did this error come from two firings racing into the same key?
 *
 * The pre-check below catches every *sequential* redelivery, which is all of
 * them in practice. This covers the one case it cannot: two invocations of the
 * same firing genuinely concurrent — pg-boss expires a job still held by a
 * live worker and re-delivers it, so both transactions pre-check, both miss,
 * and one loses at the index. Without this the loser's raw
 * `duplicate key value violates …` reaches `fireSchedule`'s catch, which pages
 * the project with `schedule.failed`, or `fireTrigger`'s, which flips a
 * delivery to `failed` **behind a run that succeeded** — and the `run_id IS
 * NULL` guard on Retry then refuses to let an operator clear it.
 *
 * Matches on the constraint name so an unrelated 23505 is never swallowed;
 * bun-sql reports SQLSTATE in `errno` (`code` is its own tag), and drizzle
 * wraps, so both are checked down the cause chain.
 */
function isOriginKeyConflict(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e != null && depth < 4; depth += 1) {
    const pg = e as { errno?: unknown; code?: unknown; constraint?: unknown; cause?: unknown };
    const sqlstate = String(pg.errno ?? pg.code ?? "");
    if (sqlstate === "23505" && String(pg.constraint ?? "").includes(ORIGIN_KEY_CONSTRAINT)) {
      return true;
    }
    e = pg.cause;
  }
  return false;
}

/** Insert the run, translating the index's verdict into the caller's vocabulary. */
async function insertRunOrRaiseDuplicate(
  db: DbOrTx,
  originKey: string | undefined,
  values: typeof runs.$inferInsert,
): Promise<Array<typeof runs.$inferSelect>> {
  try {
    return await db.insert(runs).values(values).returning();
  } catch (err) {
    if (originKey && isOriginKeyConflict(err)) throw new DuplicateFiringError(originKey, null);
    throw err;
  }
}

/**
 * This firing already produced a run; the caller should report success without
 * submitting again.
 *
 * Its own class because the alternative — letting the unique index raise —
 * cannot be told apart from a real failure by the callers' catch blocks, and
 * `fireSchedule` routes anything it catches into a `schedule.failed`
 * notification. Paging a human because the system correctly refused to charge
 * twice is its own kind of broken.
 */
export class DuplicateFiringError extends Error {
  constructor(
    readonly originKey: string,
    /** Null when the index caught it — the aborted transaction cannot read it. */
    readonly runId: string | null,
  ) {
    super(`firing ${originKey} already produced run ${runId ?? "(concurrently)"}`);
    this.name = "DuplicateFiringError";
  }
}

/**
 * Create a task and its first run **on the caller's transaction**, without
 * enqueueing.
 *
 * Taking a tx is what lets an unattended caller commit the submission together
 * with the bookkeeping that records it happened. Written separately, the two
 * are a dual write, and the gap is not theoretical: a crash between them leaves
 * a delivery `pending` or a schedule's `lastRunId` stale, and the retry — whose
 * claim window is deliberately tuned to let retries through — submits a second
 * charged run. Inside one transaction there is no such gap: either the run and
 * the record of it both exist, or neither does.
 *
 * The reads above the inserts stay on the same handle. They are all reads, so
 * they are safe in a caller's transaction; the only cost is holding it open a
 * little longer.
 *
 * Throws `SubmitError` (from resolution) and `AppError`; callers own the
 * mapping to a response.
 */
export async function submitTaskIn(db: DbOrTx, args: SubmitTaskArgs): Promise<SubmittedTask> {
  const { projectId, actorUserId, actor, input, originKey } = args;

  // First, before any resolution work: a redelivered job re-runs this function
  // from the top, and everything below it costs reads the answer does not need.
  // The `runs_origin_key_uq` index is the real guarantee — this read only turns
  // the common case (a sequential redelivery, whose predecessor has long since
  // committed) into a clean outcome instead of a constraint violation that
  // would abort the caller's whole transaction.
  if (originKey) {
    const [existing] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.originKey, originKey));
    if (existing) throw new DuplicateFiringError(originKey, existing.id);
  }

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

  const [task] = await db
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
  const [run] = await insertRunOrRaiseDuplicate(db, originKey, {
    ...newRunIdentity(), // id + the workspace key that starts out equal to it
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
    originKey,
    createdBy: actorUserId,
  });
  if (!run) throw new Error("run insert failed");
  await db.update(tasks).set({ latestRunId: run.id }).where(eq(tasks.id, task.id));
  // with the mutation: a committed mutation without its audit row would break
  // the every-mutation-is-audited invariant (ADR-0013 amendment 1)
  await auditAs(db, actor, {
    action: "task.submit",
    resourceType: "task",
    resourceId: task.id,
    projectId,
    payload: { taskTypeId: taskType.id, runId: run.id },
  });
  return { taskId: task.id, runId: run.id };
}

/**
 * Submit and enqueue, for callers with nothing to be atomic with — the browser
 * and API-key paths, where the HTTP response is the only bookkeeping.
 */
export async function submitTask(
  db: Db,
  queue: RunQueue | null,
  args: SubmitTaskArgs,
): Promise<SubmittedTask> {
  const submitted = await db.transaction((tx) => submitTaskIn(tx, args));
  // Post-commit, and deliberately NOT awaited. The worker's straggler sweep is
  // the delivery guarantee, so a send failure must not surface as a submission
  // failure — the run exists and will execute either way, and telling the
  // caller otherwise invites a retry that creates a second one.
  //
  // Awaiting invites the same retry by a slower route: `enqueueAfterCommit`
  // bounds failure but never latency, pg-boss's pool waits indefinitely for a
  // connection, and this function is reached by `POST /projects/:id/tasks` —
  // the first entry on the API-key allow-list. A stalled database would hold
  // the response until Bun's idleTimeout killed the socket, and a machine
  // client answers a connection reset with a retry. That retry has nothing to
  // dedupe against: `originKey` is null for the human and API-key paths by
  // design, so it would be a second task, a second run, and a second charge.
  // Safe to leave un-awaited because `enqueueAfterCommit` cannot reject.
  void enqueueAfterCommit(
    () => queue?.enqueueRun(submitted.runId) ?? Promise.resolve(),
    `run ${submitted.runId}`,
  );
  return submitted;
}
