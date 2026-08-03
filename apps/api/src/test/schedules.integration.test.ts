import { beforeAll, describe, expect, it } from "bun:test";
import type { RunQueue } from "@agrippa/core";
import {
  auditLogs,
  notificationDeliveries,
  notificationEndpoints,
  projectMembers,
  projects,
  runs,
  taskSchedules,
  taskTypes,
  tokenUsage,
} from "@agrippa/db";
import { fireSchedule } from "@agrippa/orchestration";
import { and, eq } from "drizzle-orm";
import type { App } from "../app";
import { createApp } from "../app";
import {
  freshTestDb,
  jsonOf,
  makeFakeQueue,
  postgresAvailable,
  signUp,
  type TestClient,
} from "./helpers";

const dbUp = await postgresAvailable();

type ScheduleRow = {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  concurrencyPolicy: "skip" | "queue" | "replace";
  enabled: boolean;
  disabledReason: string | null;
  lastError: string | null;
  lastRunId: string | null;
};

describe.skipIf(!dbUp)("task schedules (cron submission)", () => {
  let app: App;
  let db: Awaited<ReturnType<typeof freshTestDb>>;
  let admin: TestClient;
  let member: TestClient;
  let projectId: string;
  let taskTypeId: string;

  const registered: Array<{ id: string; cron: string; tz: string }> = [];
  const unregistered: string[] = [];
  const queue: RunQueue = makeFakeQueue({
    registerSchedule: async (id, cron, tz) => {
      registered.push({ id, cron, tz });
    },
    unregisterSchedule: async (id) => {
      unregistered.push(id);
    },
  });

  const params = { dateRange: "2026.07.27-2026.08.02", rawNotes: "notes" };

  const createSchedule = async (over: Record<string, unknown> = {}) =>
    jsonOf<ScheduleRow>(
      await admin.request(`/api/v1/projects/${projectId}/schedules`, {
        method: "POST",
        json: {
          name: `weekly-${Math.random()}`,
          taskTypeId,
          params,
          cron: "0 9 * * 1",
          timezone: "Asia/Shanghai",
          ...over,
        },
      }),
    );

  const rowOf = async (id: string) => {
    const [row] = await db.select().from(taskSchedules).where(eq(taskSchedules.id, id));
    return row;
  };

  beforeAll(async () => {
    db = await freshTestDb();
    app = createApp({ db, queue });
    admin = await signUp(app, "Root", "root@example.com");
    member = await signUp(app, "Mia", "mia@example.com");
    projectId = (
      await jsonOf<{ id: string }>(
        await admin.request("/api/v1/projects", {
          method: "POST",
          json: { slug: "sched", name: "sched" },
        }),
      )
    ).id;
    const types = await jsonOf<Array<{ id: string; slug: string }>>(
      await admin.request("/api/v1/scenarios/project-management/task-types"),
    );
    taskTypeId = types.find((t) => t.slug === "weekly-report")?.id as string;
  });

  // ── CRUD ───────────────────────────────────────────────────────────────────

  it("creates a schedule and registers its cron calendar", async () => {
    const row = await createSchedule();
    expect(row.enabled).toBe(true);
    expect(registered.at(-1)).toEqual({ id: row.id, cron: "0 9 * * 1", tz: "Asia/Shanghai" });

    const [logged] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "schedule.create"), eq(auditLogs.resourceId, row.id)));
    expect(logged).toBeDefined();
  });

  it("rejects a malformed cron and an unknown timezone before anything is stored", async () => {
    for (const bad of [{ cron: "0 9 * *" }, { cron: "99 9 * * *" }, { timezone: "Mars/Olympus" }]) {
      const res = await admin.request(`/api/v1/projects/${projectId}/schedules`, {
        method: "POST",
        json: { name: "bad", taskTypeId, params, cron: "0 9 * * 1", ...bad },
      });
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
    }
  });

  it("is project-admin gated for writes and member-readable", async () => {
    await admin.request(`/api/v1/projects/${projectId}/members`, {
      method: "POST",
      json: { email: member.email, role: "member" },
    });
    expect((await member.request(`/api/v1/projects/${projectId}/schedules`)).status).toBe(200);
    expect(
      (
        await member.request(`/api/v1/projects/${projectId}/schedules`, {
          method: "POST",
          json: { name: "nope", taskTypeId, params, cron: "0 9 * * 1" },
        })
      ).status,
    ).toBe(403);
  });

  it("unregisters the calendar when paused or deleted", async () => {
    const row = await createSchedule();
    await admin.request(`/api/v1/projects/${projectId}/schedules/${row.id}`, {
      method: "PATCH",
      json: { enabled: false },
    });
    expect(unregistered).toContain(row.id);

    const deleted = await createSchedule();
    await admin.request(`/api/v1/projects/${projectId}/schedules/${deleted.id}`, {
      method: "DELETE",
    });
    expect(unregistered).toContain(deleted.id);
    expect(await rowOf(deleted.id)).toBeUndefined();
  });

  // ── firing ─────────────────────────────────────────────────────────────────

  it("submits a run attributed to its owner", async () => {
    const row = await createSchedule();
    const outcome = await fireSchedule(db, queue, row.id);
    expect(outcome.kind).toBe("submitted");

    const after = await rowOf(row.id);
    expect(after?.lastRunId).toBeTruthy();
    expect(after?.lastFiredAt).not.toBeNull();

    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, after?.lastRunId as string));
    // runs.created_by is NOT NULL — an unattended submission still names a human
    expect(run?.createdBy).toBeTruthy();
  });

  it("honors each concurrency policy against an unfinished previous run", async () => {
    // skip: the in-flight run is left alone and nothing new is submitted
    const skip = await createSchedule({ concurrencyPolicy: "skip" });
    await fireSchedule(db, queue, skip.id);
    const firstRunId = (await rowOf(skip.id))?.lastRunId as string;
    expect((await fireSchedule(db, queue, skip.id)).kind).toBe("skipped");
    expect((await rowOf(skip.id))?.lastRunId).toBe(firstRunId);

    // queue: submits regardless, and the schedule now points at the new run
    const queued = await createSchedule({ concurrencyPolicy: "queue" });
    await fireSchedule(db, queue, queued.id);
    const queuedFirst = (await rowOf(queued.id))?.lastRunId as string;
    expect((await fireSchedule(db, queue, queued.id)).kind).toBe("submitted");
    expect((await rowOf(queued.id))?.lastRunId).not.toBe(queuedFirst);

    // replace: the previous run is cancelled before the new one is submitted
    const replace = await createSchedule({ concurrencyPolicy: "replace" });
    await fireSchedule(db, queue, replace.id);
    const replaced = (await rowOf(replace.id))?.lastRunId as string;
    expect((await fireSchedule(db, queue, replace.id)).kind).toBe("submitted");
    const [old] = await db.select().from(runs).where(eq(runs.id, replaced));
    expect(old?.status).toBe("cancelled");
  });

  // ── the loud-failure design ────────────────────────────────────────────────

  it("disables and announces when the owner loses project access", async () => {
    // an endpoint so the notification has somewhere to go
    await db.insert(notificationEndpoints).values({
      projectId,
      kind: "generic",
      name: "hook",
      url: "https://example.com/hook",
      events: [],
      createdBy: (await rowOf((await createSchedule()).id))?.createdBy as string,
    });

    const owner = await signUp(app, "Sam", "sam@example.com");
    await admin.request(`/api/v1/projects/${projectId}/members`, {
      method: "POST",
      json: { email: owner.email, role: "admin" },
    });
    const row = await jsonOf<ScheduleRow>(
      await owner.request(`/api/v1/projects/${projectId}/schedules`, {
        method: "POST",
        json: { name: "sams", taskTypeId, params, cron: "0 9 * * 1" },
      }),
    );

    const [ownerRow] = await db.select().from(taskSchedules).where(eq(taskSchedules.id, row.id));
    await db
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, ownerRow?.createdBy as string),
        ),
      );

    const outcome = await fireSchedule(db, queue, row.id);
    expect(outcome).toEqual({ kind: "disabled", reason: "owner_lost_access" });

    const after = await rowOf(row.id);
    expect(after?.enabled).toBe(false);
    expect(after?.disabledReason).toBe("owner_lost_access");
    expect(unregistered).toContain(row.id);

    // loud, not silent: an audit row AND an outbound notification
    const [logged] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "schedule.disabled"), eq(auditLogs.resourceId, row.id)));
    expect(logged).toBeDefined();
    const deliveries = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.eventType, "schedule.disabled"));
    expect(deliveries.length).toBeGreaterThan(0);
    // a schedule event has no run behind it — the run-less delivery shape
    expect(deliveries[0]?.runId).toBeNull();
  });

  it("disables when its project is archived", async () => {
    const other = (
      await jsonOf<{ id: string }>(
        await admin.request("/api/v1/projects", {
          method: "POST",
          json: { slug: "arch", name: "arch" },
        }),
      )
    ).id;
    const row = await jsonOf<ScheduleRow>(
      await admin.request(`/api/v1/projects/${other}/schedules`, {
        method: "POST",
        json: { name: "doomed", taskTypeId, params, cron: "0 9 * * 1" },
      }),
    );
    await db.update(projects).set({ status: "archived" }).where(eq(projects.id, other));

    expect(await fireSchedule(db, queue, row.id)).toEqual({
      kind: "disabled",
      reason: "project_archived",
    });
    expect((await rowOf(row.id))?.enabled).toBe(false);
  });

  it("disables when its task type is gone", async () => {
    const row = await createSchedule();
    await db.update(taskTypes).set({ enabled: false }).where(eq(taskTypes.id, taskTypeId));
    expect(await fireSchedule(db, queue, row.id)).toEqual({
      kind: "disabled",
      reason: "task_type_gone",
    });
    await db.update(taskTypes).set({ enabled: true }).where(eq(taskTypes.id, taskTypeId));
  });

  it("records a transient failure WITHOUT disabling, so next week can succeed", async () => {
    const row = await createSchedule();
    // an exhausted quota is fixable and heals on its own next month — exactly
    // the case that must not disable the schedule
    await admin.request(`/api/v1/projects/${projectId}/quota`, {
      method: "PUT",
      json: { tokenLimit: 1, hardStop: true },
    });
    const [anyRun] = await db
      .select({ id: runs.id, orgId: runs.projectId })
      .from(runs)
      .where(eq(runs.projectId, projectId))
      .limit(1);
    const [org] = await db
      .select({ orgId: projects.orgId })
      .from(projects)
      .where(eq(projects.id, projectId));
    await db.insert(tokenUsage).values({
      orgId: org?.orgId as string,
      projectId,
      runId: anyRun?.id as string,
      inputTokens: 100,
      outputTokens: 100,
    });

    const outcome = await fireSchedule(db, queue, row.id);
    expect(outcome.kind).toBe("failed");

    const after = await rowOf(row.id);
    expect(after?.enabled).toBe(true); // still on
    expect(after?.disabledReason).toBeNull();
    expect(after?.lastError).toContain("quota_exhausted");

    const deliveries = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.eventType, "schedule.failed"));
    expect(deliveries.length).toBeGreaterThan(0);

    await admin.request(`/api/v1/projects/${projectId}/quota`, {
      method: "PUT",
      json: { tokenLimit: null, hardStop: false },
    });
  });

  it("does not fire while disabled, and clears its reason when re-enabled", async () => {
    const row = await createSchedule();
    await admin.request(`/api/v1/projects/${projectId}/schedules/${row.id}`, {
      method: "PATCH",
      json: { enabled: false },
    });
    expect(await fireSchedule(db, queue, row.id)).toEqual({ kind: "skipped", reason: "disabled" });

    await admin.request(`/api/v1/projects/${projectId}/schedules/${row.id}`, {
      method: "PATCH",
      json: { enabled: true },
    });
    const after = await rowOf(row.id);
    expect(after?.enabled).toBe(true);
    expect(after?.disabledReason).toBeNull();
    expect(after?.lastError).toBeNull();
  });
});
