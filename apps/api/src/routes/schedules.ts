import { AppError, scheduleCreateSchema, scheduleUpdateSchema } from "@agrippa/core";
import { taskSchedules } from "@agrippa/db";
import { enqueueAfterCommit } from "@agrippa/orchestration";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { audit } from "../lib/audit";
import { assertSchedulableParams } from "../lib/task-params";
import { validate } from "../lib/validate";
import { requireProjectRole } from "../middleware/rbac";

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
      // best-effort, as the module comment promises: the row and its audit are
      // committed, so a 500 here would tell the user creation failed while the
      // schedule sits enabled and starts firing at the next worker boot — and
      // their retry would leave two. Boot reconciliation repairs the calendar.
      await enqueueAfterCommit(
        () => c.var.queue?.registerSchedule(row.id, row.cron, row.timezone) ?? Promise.resolve(),
        `register schedule ${row.id}`,
      );
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
      await enqueueAfterCommit(
        () =>
          (row.enabled
            ? c.var.queue?.registerSchedule(row.id, row.cron, row.timezone)
            : c.var.queue?.unregisterSchedule(row.id)) ?? Promise.resolve(),
        `sync schedule calendar ${row.id}`,
      );
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
    await enqueueAfterCommit(
      () => c.var.queue?.unregisterSchedule(id) ?? Promise.resolve(),
      `unregister schedule ${id}`,
    );
    return c.json({ ok: true });
  });
