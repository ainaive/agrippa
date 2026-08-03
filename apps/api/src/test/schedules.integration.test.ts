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
import { fireSchedule, reconcileScheduleCalendar } from "@agrippa/orchestration";
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

/**
 * A distinct key per firing, which is what the worker passes: pg-boss mints a
 * new job id per cron tick and preserves it across a retry. Tests that assert
 * a *policy* want distinct keys; the redelivery test below deliberately reuses
 * one, because reusing it is exactly what a redelivery does.
 */
let fireKeySeq = 0;
const fireKey = () => `test-fire-${++fireKeySeq}`;

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

  // ── parameters ─────────────────────────────────────────────────────────────

  it("rejects params that could never produce a run, at creation rather than at the first firing", async () => {
    // weekly-report requires dateRange and rawNotes; a weekly schedule created
    // with neither would otherwise fail its first firing a WEEK later
    const res = await admin.request(`/api/v1/projects/${projectId}/schedules`, {
      method: "POST",
      json: { name: "empty", taskTypeId, params: {}, cron: "0 9 * * 1" },
    });
    expect(res.status).toBe(400);

    const partial = await admin.request(`/api/v1/projects/${projectId}/schedules`, {
      method: "POST",
      json: { name: "partial", taskTypeId, params: { dateRange: "x" }, cron: "0 9 * * 1" },
    });
    expect(partial.status).toBe(400);
  });

  it("rejects an unknown token instead of letting it reach the agent verbatim", async () => {
    const res = await admin.request(`/api/v1/projects/${projectId}/schedules`, {
      method: "POST",
      json: {
        name: "typo",
        taskTypeId,
        params: { ...params, dateRange: "{{lastWeek}}" },
        cron: "0 9 * * 1",
      },
    });
    expect(res.status).toBe(400);
    const body = await jsonOf<{ details?: Array<{ message: string }> }>(res);
    expect(JSON.stringify(body)).toContain("lastWeek");
  });

  it("re-validates on edit, so an edit cannot break a working schedule silently", async () => {
    const row = await createSchedule();
    const res = await admin.request(`/api/v1/projects/${projectId}/schedules/${row.id}`, {
      method: "PATCH",
      json: { params: { dateRange: "only-this" } },
    });
    expect(res.status).toBe(400);
    // unchanged on disk
    expect((await rowOf(row.id))?.params).toEqual(params);
  });

  it("resolves date tokens against the firing, so a weekly report moves with the weeks", async () => {
    const row = await createSchedule({
      params: { ...params, dateRange: "{{lastWeekStart}}..{{lastWeekEnd}}" },
      timezone: "Asia/Shanghai",
    });
    expect(await fireSchedule(db, queue, row.id, fireKey())).toMatchObject({ kind: "submitted" });

    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, (await rowOf(row.id))?.lastRunId as string));
    const snapshot = run?.paramsSnapshot as { dateRange: string };
    // the stored parameter is still the token; only the run carries dates
    expect((await rowOf(row.id))?.params).toMatchObject({
      dateRange: "{{lastWeekStart}}..{{lastWeekEnd}}",
    });
    expect(snapshot.dateRange).toMatch(/^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/);

    // and it is genuinely last week: the range ends the day before this Monday
    const [start, end] = snapshot.dateRange.split("..") as [string, string];
    expect(new Date(`${end}T00:00:00Z`).getTime()).toBeGreaterThan(
      new Date(`${start}T00:00:00Z`).getTime(),
    );
    expect(new Date(`${end}T00:00:00Z`).getTime()).toBeLessThan(Date.now());
  });

  // ── firing ─────────────────────────────────────────────────────────────────

  it("submits a run attributed to its owner", async () => {
    const row = await createSchedule();
    const outcome = await fireSchedule(db, queue, row.id, fireKey());
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
    await fireSchedule(db, queue, skip.id, fireKey());
    const firstRunId = (await rowOf(skip.id))?.lastRunId as string;
    expect((await fireSchedule(db, queue, skip.id, fireKey())).kind).toBe("skipped");
    expect((await rowOf(skip.id))?.lastRunId).toBe(firstRunId);

    // queue: submits regardless, and the schedule now points at the new run
    const queued = await createSchedule({ concurrencyPolicy: "queue" });
    await fireSchedule(db, queue, queued.id, fireKey());
    const queuedFirst = (await rowOf(queued.id))?.lastRunId as string;
    expect((await fireSchedule(db, queue, queued.id, fireKey())).kind).toBe("submitted");
    expect((await rowOf(queued.id))?.lastRunId).not.toBe(queuedFirst);

    // replace: the previous run is cancelled before the new one is submitted
    const replace = await createSchedule({ concurrencyPolicy: "replace" });
    await fireSchedule(db, queue, replace.id, fireKey());
    const replaced = (await rowOf(replace.id))?.lastRunId as string;
    expect((await fireSchedule(db, queue, replace.id, fireKey())).kind).toBe("submitted");
    const [old] = await db.select().from(runs).where(eq(runs.id, replaced));
    expect(old?.status).toBe("cancelled");
  });

  // ── review round 2 regressions ─────────────────────────────────────────────

  it("repairs calendar drift without waiting for a restart", async () => {
    // registration is best-effort at request time, so a dropped one used to
    // mean a schedule that silently never fired until someone restarted a
    // worker — and an edit whose re-registration was lost kept the OLD cron
    // while the UI showed the new one
    const calendar = new Map<string, { key: string; cron: string; timezone: string }>();
    const view = {
      list: async () => [...calendar.values()],
      register: async (id: string, cron: string, timezone: string) => {
        calendar.set(id, { key: id, cron, timezone });
      },
      unregister: async (id: string) => {
        calendar.delete(id);
      },
    };

    const row = await createSchedule({ cron: "0 9 * * 1" });
    // sync everything the suite has created, then drop just this one's entry
    // — the shape a failed registerSchedule leaves behind
    await reconcileScheduleCalendar(db, view);
    calendar.delete(row.id);

    expect(await reconcileScheduleCalendar(db, view)).toMatchObject({
      registered: 1,
      unregistered: 0,
      failed: [],
    });
    expect(calendar.get(row.id)?.cron).toBe("0 9 * * 1");

    // an edit whose re-registration was lost converges too
    await db.update(taskSchedules).set({ cron: "0 17 * * 5" }).where(eq(taskSchedules.id, row.id));
    expect(await reconcileScheduleCalendar(db, view)).toMatchObject({
      registered: 1,
      unregistered: 0,
      failed: [],
    });
    expect(calendar.get(row.id)?.cron).toBe("0 17 * * 5");

    // steady state writes nothing
    expect(await reconcileScheduleCalendar(db, view)).toMatchObject({
      registered: 0,
      unregistered: 0,
      failed: [],
    });

    // and an orphaned entry whose row is gone is removed — nothing else could
    calendar.set("ghost", { key: "ghost", cron: "* * * * *", timezone: "UTC" });
    expect(await reconcileScheduleCalendar(db, view)).toMatchObject({ unregistered: 1 });
    expect(calendar.has("ghost")).toBe(false);
  });

  // ── review round 3 regressions ─────────────────────────────────────────────

  it("treats a redelivered job as one firing, not two", async () => {
    // A worker that dies after the transaction commits but before pg-boss's
    // completion write leaves the job `active`; the supervisor re-delivers it
    // ~15 minutes later with the SAME job id. `queue` used to submit again
    // unconditionally, and `skip` only held while the previous run was still
    // running — which after 15 minutes it usually is not.
    const row = await createSchedule({ concurrencyPolicy: "queue" });
    const key = fireKey();

    expect(await fireSchedule(db, queue, row.id, key)).toMatchObject({ kind: "submitted" });
    const firstRunId = (await rowOf(row.id))?.lastRunId as string;
    // the run reaches a terminal status, exactly as it would have by the time
    // the redelivery lands — this is what used to defeat `skip`
    await db.update(runs).set({ status: "succeeded" }).where(eq(runs.id, firstRunId));

    expect(await fireSchedule(db, queue, row.id, key)).toEqual({
      kind: "skipped",
      reason: "already_fired",
    });
    const after = await rowOf(row.id);
    expect(after?.lastRunId).toBe(firstRunId);
    // not a failure: announcing one would page the project about the system
    // refusing to charge twice
    expect(after?.lastError).toBeNull();
    const [failure] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.eventType, "schedule.failed"));
    expect(failure).toBeUndefined();

    // a genuinely new occurrence still fires
    expect(await fireSchedule(db, queue, row.id, fireKey())).toMatchObject({ kind: "submitted" });
    expect((await rowOf(row.id))?.lastRunId).not.toBe(firstRunId);
  });

  it("does not undo a schedule created or edited while it is reconciling", async () => {
    // The rows and the calendar live in different stores with no transaction
    // spanning them, so there is always a window between the two reads. Every
    // writer commits its row first, so reading the CALENDAR first makes the
    // rows snapshot the fresher of the two and every interleaving benign.
    const calendar = new Map<string, { key: string; cron: string; timezone: string }>();
    let onList: (() => Promise<void>) | null = null;
    const view = {
      list: async () => {
        const entries = [...calendar.values()];
        // commit an API mutation in the window between the two reads
        const hook = onList;
        onList = null;
        await hook?.();
        return entries;
      },
      register: async (id: string, cron: string, timezone: string) => {
        calendar.set(id, { key: id, cron, timezone });
      },
      unregister: async (id: string) => {
        calendar.delete(id);
      },
    };
    await reconcileScheduleCalendar(db, view);

    // a schedule created in the window keeps the entry its creation registered
    let created: ScheduleRow | undefined;
    onList = async () => {
      created = await createSchedule({ cron: "0 8 * * 2" });
      calendar.set(created.id, { key: created.id, cron: "0 8 * * 2", timezone: "Asia/Shanghai" });
    };
    await reconcileScheduleCalendar(db, view);
    expect(calendar.get(created?.id as string)?.cron).toBe("0 8 * * 2");

    // an edit committed in the window converges onto the NEW cron; read the
    // other way round the reconciler restores the old one and the schedule
    // fires at a time the UI says it does not
    const edited = await createSchedule({ cron: "0 9 * * 1" });
    calendar.set(edited.id, { key: edited.id, cron: "0 9 * * 1", timezone: "Asia/Shanghai" });
    onList = async () => {
      await admin.request(`/api/v1/projects/${projectId}/schedules/${edited.id}`, {
        method: "PATCH",
        json: { cron: "30 6 * * 3" },
      });
      calendar.set(edited.id, { key: edited.id, cron: "30 6 * * 3", timezone: "Asia/Shanghai" });
    };
    await reconcileScheduleCalendar(db, view);
    expect(calendar.get(edited.id)?.cron).toBe("30 6 * * 3");
  });

  it("names the schedule it could not repair instead of swallowing it", async () => {
    // one unrepairable schedule must not stop the others being repaired — but
    // tolerance that reports nothing is indistinguishable from success, and
    // the schedule stays unregistered while the drift line reads "+0/-0"
    const broken = await createSchedule({ cron: "0 7 * * 4" });
    const healthy = await createSchedule({ cron: "0 8 * * 4" });
    const calendar = new Map<string, { key: string; cron: string; timezone: string }>();
    const view = {
      list: async () => [...calendar.values()],
      register: async (id: string, cron: string, timezone: string) => {
        if (id === broken.id) throw new Error("calendar unavailable");
        calendar.set(id, { key: id, cron, timezone });
      },
      unregister: async (id: string) => {
        calendar.delete(id);
      },
    };

    const result = await reconcileScheduleCalendar(db, view);
    expect(result.failed).toContainEqual({ id: broken.id, error: "calendar unavailable" });
    expect(calendar.has(healthy.id)).toBe(true);
    // and it reaches the amber line the admin already reads on the row
    expect((await rowOf(broken.id))?.lastError).toContain("calendar unavailable");
  });

  it("rolls the mutation back when its audit row cannot be written", async () => {
    await db.execute(
      `alter table audit_logs add constraint tmp_block_schedule_create
       check (action <> 'schedule.create') not valid`,
    );
    try {
      const before = (await db.select().from(taskSchedules)).length;
      const res = await admin.request(`/api/v1/projects/${projectId}/schedules`, {
        method: "POST",
        json: { name: "unaudited", taskTypeId, params, cron: "0 9 * * 1" },
      });
      expect(res.status).toBe(500);
      // no orphan schedule for the user's retry to duplicate
      expect((await db.select().from(taskSchedules)).length).toBe(before);
    } finally {
      await db.execute(`alter table audit_logs drop constraint tmp_block_schedule_create`);
    }
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

    const outcome = await fireSchedule(db, queue, row.id, fireKey());
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

    expect(await fireSchedule(db, queue, row.id, fireKey())).toEqual({
      kind: "disabled",
      reason: "project_archived",
    });
    expect((await rowOf(row.id))?.enabled).toBe(false);
  });

  it("disables when its task type is gone", async () => {
    const row = await createSchedule();
    await db.update(taskTypes).set({ enabled: false }).where(eq(taskTypes.id, taskTypeId));
    expect(await fireSchedule(db, queue, row.id, fireKey())).toEqual({
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

    const outcome = await fireSchedule(db, queue, row.id, fireKey());
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

  it("keeps the schedule enabled when disabling cannot be announced", async () => {
    // The flag that stops a schedule is the flag that makes the retry skip, so
    // if the announcement is not committed with it the schedule goes quiet
    // with nobody told — and a run-less notification cannot be reconstructed.
    // One transaction means the retry still has work to do.
    // its own owner: revoking admin's membership would 403 every later test
    const owner = await signUp(app, "Tess", "tess@example.com");
    await admin.request(`/api/v1/projects/${projectId}/members`, {
      method: "POST",
      json: { email: owner.email, role: "admin" },
    });
    const row = await jsonOf<ScheduleRow>(
      await owner.request(`/api/v1/projects/${projectId}/schedules`, {
        method: "POST",
        json: { name: "tess-sched", taskTypeId, params, cron: "0 9 * * 1" },
      }),
    );
    const [before] = await db.select().from(taskSchedules).where(eq(taskSchedules.id, row.id));
    await db
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, before?.createdBy as string),
        ),
      );
    await db.insert(notificationEndpoints).values({
      projectId,
      kind: "generic",
      name: "blocker",
      url: "https://example.com/blocked",
      events: [],
      createdBy: before?.createdBy as string,
    });

    // NOT VALID: applies to new rows only, so the suite's existing deliveries
    // do not block adding it
    await db.execute(
      `alter table notification_deliveries add constraint tmp_block_schedule_disabled
       check (event_type <> 'schedule.disabled') not valid`,
    );
    try {
      await expect(fireSchedule(db, queue, row.id, fireKey())).rejects.toThrow();
      const [during] = await db.select().from(taskSchedules).where(eq(taskSchedules.id, row.id));
      expect(during?.enabled).toBe(true); // rolled back with the notification
    } finally {
      await db.execute(
        `alter table notification_deliveries drop constraint tmp_block_schedule_disabled`,
      );
    }

    // the retry now completes both halves together
    expect(await fireSchedule(db, queue, row.id, fireKey())).toEqual({
      kind: "disabled",
      reason: "owner_lost_access",
    });
    const [after] = await db.select().from(taskSchedules).where(eq(taskSchedules.id, row.id));
    expect(after?.enabled).toBe(false);
    const deliveries = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.eventType, "schedule.disabled"));
    expect(deliveries.length).toBeGreaterThan(0);
  });

  it("does not fire while disabled, and clears its reason when re-enabled", async () => {
    const row = await createSchedule();
    await admin.request(`/api/v1/projects/${projectId}/schedules/${row.id}`, {
      method: "PATCH",
      json: { enabled: false },
    });
    expect(await fireSchedule(db, queue, row.id, fireKey())).toEqual({
      kind: "skipped",
      reason: "disabled",
    });

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
