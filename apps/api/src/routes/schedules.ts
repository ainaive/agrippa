import {
  AppError,
  applyScheduleTokens,
  findUnknownScheduleTokens,
  SCHEDULE_TOKENS,
  scheduleCreateSchema,
  scheduleUpdateSchema,
} from "@agrippa/core";
import { orchestrationTemplates, taskSchedules, taskTypes, templateVersions } from "@agrippa/db";
import { buildParamsValidator, upgradeCompiledTemplate } from "@agrippa/orchestration";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { audit } from "../lib/audit";
import { validate } from "../lib/validate";
import { requireProjectRole } from "../middleware/rbac";

/**
 * Reject a schedule that could never produce a run.
 *
 * Without this the mistake surfaces at the first firing — which for a weekly
 * schedule is a week away, and for a monthly one a month. "Loud but late" is
 * barely better than silent when the whole point is unattended operation, so
 * parameters are validated against the same compiled schema the submit form
 * renders from, at the moment someone can still fix them.
 *
 * Tokens are resolved first: what gets validated is what will actually be
 * submitted, which also catches a token placed in a field that is not a string.
 * Unknown tokens are rejected outright — left alone, `{{lastWeek}}` would reach
 * the agent's prompt verbatim and read as a broken report rather than a broken
 * schedule.
 */
async function assertSchedulableParams(
  db: AppEnv["Variables"]["db"],
  taskTypeId: string,
  params: Record<string, unknown>,
  timezone: string,
): Promise<void> {
  const unknown = findUnknownScheduleTokens(params);
  if (unknown.length > 0) {
    throw AppError.validation([
      {
        path: ["params"],
        message: `unknown schedule tokens: ${unknown.join(", ")}. Known: ${SCHEDULE_TOKENS.join(", ")}`,
      },
    ]);
  }

  const [taskType] = await db.select().from(taskTypes).where(eq(taskTypes.id, taskTypeId));
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
  const resolved = applyScheduleTokens(params, new Date(), timezone);
  const parsed = buildParamsValidator(compiled.spec.inputs).safeParse(resolved);
  if (!parsed.success) throw AppError.validation(parsed.error.issues);
}

const scheduleView = {
  id: taskSchedules.id,
  name: taskSchedules.name,
  taskTypeId: taskSchedules.taskTypeId,
  params: taskSchedules.params,
  agentOverrides: taskSchedules.agentOverrides,
  cron: taskSchedules.cron,
  timezone: taskSchedules.timezone,
  concurrencyPolicy: taskSchedules.concurrencyPolicy,
  enabled: taskSchedules.enabled,
  disabledReason: taskSchedules.disabledReason,
  lastError: taskSchedules.lastError,
  lastErrorAt: taskSchedules.lastErrorAt,
  lastFiredAt: taskSchedules.lastFiredAt,
  lastRunId: taskSchedules.lastRunId,
  createdBy: taskSchedules.createdBy,
  createdAt: taskSchedules.createdAt,
};

/**
 * Scheduled task submission, managed by project admins.
 *
 * The cron calendar lives in pg-boss and the schedule row lives here; the two
 * are kept in step by writing the row first and registering second, plus a boot
 * reconciliation in the worker. Registration is best-effort at request time on
 * purpose — a schedule that exists but has not yet been registered is visible
 * and repairable, whereas failing the request would leave the user unsure which
 * of the two happened.
 */
export const scheduleRoutes = new Hono<AppEnv>()
  .get("/:projectId/schedules", requireProjectRole("member"), async (c) => {
    const rows = await c.var.db
      .select(scheduleView)
      .from(taskSchedules)
      .where(eq(taskSchedules.projectId, c.req.param("projectId")))
      .orderBy(desc(taskSchedules.createdAt));
    return c.json(rows);
  })

  .post(
    "/:projectId/schedules",
    requireProjectRole("admin"),
    validate("json", scheduleCreateSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const body = c.req.valid("json");

      await assertSchedulableParams(c.var.db, body.taskTypeId, body.params, body.timezone);

      const [row] = await c.var.db
        .insert(taskSchedules)
        .values({
          orgId: c.var.user.orgId,
          projectId,
          taskTypeId: body.taskTypeId,
          name: body.name,
          params: body.params,
          agentOverrides: body.agents,
          cron: body.cron,
          timezone: body.timezone,
          concurrencyPolicy: body.concurrencyPolicy,
          createdBy: c.var.user.id,
        })
        .returning(scheduleView);
      if (!row) throw new Error("schedule insert failed");

      await audit(c, {
        action: "schedule.create",
        resourceType: "task_schedule",
        resourceId: row.id,
        projectId,
        payload: { name: row.name, cron: row.cron, timezone: row.timezone },
      });
      await c.var.queue?.registerSchedule(row.id, row.cron, row.timezone);
      return c.json(row, 201);
    },
  )

  .patch(
    "/:projectId/schedules/:id",
    requireProjectRole("admin"),
    validate("json", scheduleUpdateSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const id = c.req.param("id");
      const body = c.req.valid("json");

      // an edit can break a working schedule just as easily as creation can
      if (body.params !== undefined || body.timezone !== undefined) {
        const [current] = await c.var.db
          .select()
          .from(taskSchedules)
          .where(and(eq(taskSchedules.id, id), eq(taskSchedules.projectId, projectId)));
        if (!current) throw AppError.notFound("Schedule");
        await assertSchedulableParams(
          c.var.db,
          current.taskTypeId,
          body.params ?? current.params,
          body.timezone ?? current.timezone,
        );
      }

      const [row] = await c.var.db
        .update(taskSchedules)
        .set({
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.params === undefined ? {} : { params: body.params }),
          ...(body.agents === undefined ? {} : { agentOverrides: body.agents }),
          ...(body.cron === undefined ? {} : { cron: body.cron }),
          ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
          ...(body.concurrencyPolicy === undefined
            ? {}
            : { concurrencyPolicy: body.concurrencyPolicy }),
          // re-enabling clears the platform's reason for stopping it; whether
          // the underlying condition is actually fixed is re-checked at the
          // next firing rather than trusted here
          ...(body.enabled === undefined
            ? {}
            : { enabled: body.enabled, disabledReason: null, lastError: null, lastErrorAt: null }),
          updatedAt: new Date(),
        })
        .where(and(eq(taskSchedules.id, id), eq(taskSchedules.projectId, projectId)))
        .returning(scheduleView);
      if (!row) throw AppError.notFound("Schedule");

      await audit(c, {
        action: "schedule.update",
        resourceType: "task_schedule",
        resourceId: id,
        projectId,
        payload: body,
      });
      // the calendar follows the row: a disabled schedule has none at all, so
      // pausing cannot leave a firing in flight
      if (row.enabled) await c.var.queue?.registerSchedule(row.id, row.cron, row.timezone);
      else await c.var.queue?.unregisterSchedule(row.id);
      return c.json(row);
    },
  )

  .delete("/:projectId/schedules/:id", requireProjectRole("admin"), async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    const [row] = await c.var.db
      .delete(taskSchedules)
      .where(and(eq(taskSchedules.id, id), eq(taskSchedules.projectId, projectId)))
      .returning({ id: taskSchedules.id, name: taskSchedules.name });
    if (!row) throw AppError.notFound("Schedule");
    await audit(c, {
      action: "schedule.delete",
      resourceType: "task_schedule",
      resourceId: id,
      projectId,
      payload: { name: row.name },
    });
    await c.var.queue?.unregisterSchedule(id);
    return c.json({ ok: true });
  });
