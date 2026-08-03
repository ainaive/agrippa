import {
  AppError,
  applyScheduleTokens,
  isTerminalRunStatus,
  type RunQueue,
  type RunStatus,
  type ScheduleDisabledReason,
} from "@agrippa/core";
import { type Db, runs, taskSchedules } from "@agrippa/db";
import { eq } from "drizzle-orm";
import { auditAs } from "./audit";
import { checkWorkAuthority } from "./authority";
import { requestRunCancellation } from "./engine/run-lifecycle";
import { enqueueProjectEventDeliveries, insertProjectEventDeliveries } from "./notifications";
import { enqueueAfterCommit } from "./queue";
import { DuplicateFiringError, submitTaskIn } from "./submit";

/** Calendar keys are schedule ids; anything else cannot have a row. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ScheduleFireOutcome =
  | { kind: "submitted"; taskId: string; runId: string }
  | { kind: "skipped"; reason: "disabled" | "previous_run_active" | "already_fired" }
  | { kind: "failed"; error: string }
  | { kind: "disabled"; reason: ScheduleDisabledReason };

/**
 * One firing of a schedule.
 *
 * The whole design turns on one distinction: **conditions that will never heal
 * on their own disable the schedule and announce it; everything else leaves it
 * enabled and records the error.** An owner who left the project, an archived
 * project, and a deleted task type are permanent — retrying weekly forever
 * would be noise. An exhausted quota, a missing grant, or no capable worker are
 * all fixable, and next week's firing should just work.
 *
 * Disabling is deliberately loud. The tempting alternative — skip the firing
 * and try again next time — is silent, and a silent schedule is
 * indistinguishable from one that was never created. That is the worst failure
 * mode available to the one feature whose entire job is to run while nobody is
 * watching, so a schedule that stops always says so through the notification
 * pipeline as well as on its own row.
 *
 * Authority is checked here, at fire time, rather than being revoked eagerly
 * when someone loses access. Eager revocation means hooking every path that can
 * remove authority — membership removal, role downgrade, project archive, org
 * role change — and missing one leaves a schedule firing with authority its
 * owner no longer has. One check at the point of use cannot be forgotten, and
 * it is the same `member` gate the manual submit path applies, so a schedule
 * can do exactly what its owner could do right now and never more.
 *
 * `fireKey` identifies THIS firing and must be stable across a redelivery of
 * the same job — the caller passes its pg-boss job id, which pg-boss preserves
 * when it re-inserts a retried job and mints afresh for each cron tick. Without
 * it a redelivery is indistinguishable from a new occurrence: `queue` submits
 * unconditionally, `replace` cancels the run this very firing created and then
 * submits another, and `skip` only holds while the previous run is still
 * running — which, at a ~15 minute redelivery latency, it usually is not.
 */
export async function fireSchedule(
  db: Db,
  queue: RunQueue | null,
  scheduleId: string,
  fireKey: string,
): Promise<ScheduleFireOutcome> {
  const [schedule] = await db.select().from(taskSchedules).where(eq(taskSchedules.id, scheduleId));
  if (!schedule?.enabled) return { kind: "skipped", reason: "disabled" };

  const disable = async (reason: ScheduleDisabledReason): Promise<ScheduleFireOutcome> => {
    // Stopping and saying so commit together. Flipping `enabled` first and
    // announcing afterwards looks equivalent but is not: the flag is exactly
    // what makes this function skip on its next invocation, so a failure in
    // between is never retried, and a run-less notification that was never
    // written cannot be reconstructed by any sweeper. The schedule would go
    // quiet without a word — the one outcome this whole design exists to
    // prevent.
    const deliveryIds = await db.transaction(async (tx) => {
      await tx
        .update(taskSchedules)
        .set({ enabled: false, disabledReason: reason, updatedAt: new Date() })
        .where(eq(taskSchedules.id, scheduleId));
      await auditAs(
        tx,
        { orgId: schedule.orgId, userId: schedule.createdBy },
        {
          action: "schedule.disabled",
          resourceType: "task_schedule",
          resourceId: scheduleId,
          projectId: schedule.projectId,
          payload: { reason, name: schedule.name },
        },
      );
      return insertProjectEventDeliveries(tx, {
        projectId: schedule.projectId,
        eventType: "schedule.disabled",
        payload: { scheduleId, scheduleName: schedule.name, reason },
      });
    });
    // post-commit, both best-effort: the notification sweeper re-enqueues a
    // stranded delivery row, and boot reconciliation drops a stale cron entry
    await enqueueProjectEventDeliveries(queue, deliveryIds);
    await enqueueAfterCommit(
      () => queue?.unregisterSchedule(scheduleId) ?? Promise.resolve(),
      `unregister schedule ${scheduleId}`,
    );
    return { kind: "disabled", reason };
  };

  const fail = async (error: string): Promise<ScheduleFireOutcome> => {
    // recorded and announced together, the same rule the disable path follows.
    // Less acute here — a recurring schedule announces again next firing — but
    // a run-less notification still cannot be reconstructed if it is lost, and
    // a weekly schedule means a week of silence.
    const deliveryIds = await db.transaction(async (tx) => {
      await tx
        .update(taskSchedules)
        .set({ lastError: error, lastErrorAt: new Date(), updatedAt: new Date() })
        .where(eq(taskSchedules.id, scheduleId));
      return insertProjectEventDeliveries(tx, {
        projectId: schedule.projectId,
        eventType: "schedule.failed",
        payload: { scheduleId, scheduleName: schedule.name, error },
      });
    });
    await enqueueProjectEventDeliveries(queue, deliveryIds);
    return { kind: "failed", error };
  };

  // ── permanent conditions ───────────────────────────────────────────────────

  const denied = await checkWorkAuthority(db, {
    projectId: schedule.projectId,
    taskTypeId: schedule.taskTypeId,
    ownerId: schedule.createdBy,
  });
  if (denied) return disable(denied);

  // ── overlap with the previous firing ───────────────────────────────────────

  if (schedule.lastRunId) {
    const [previous] = await db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(eq(runs.id, schedule.lastRunId));
    const active = previous && !isTerminalRunStatus(previous.status as RunStatus);
    if (active && schedule.concurrencyPolicy === "skip") {
      return { kind: "skipped", reason: "previous_run_active" };
    }
    if (active && schedule.concurrencyPolicy === "replace") {
      // Cooperative for a running run — the engine sees the flag at its next
      // step boundary. Best-effort by design: if it finishes on its own in the
      // meantime, that is the outcome `replace` wanted anyway.
      await requestRunCancellation(
        db,
        { id: previous.id, status: previous.status as RunStatus },
        {
          code: "superseded_by_schedule",
          message: "replaced by a newer scheduled run",
        },
      );
    }
  }

  // ── submit ─────────────────────────────────────────────────────────────────

  // one clock reading for the firing: token values and lastFiredAt must agree,
  // or a report could be stamped with a different day than it claims to cover
  const firedAt = new Date();

  let submitted: { taskId: string; runId: string };
  try {
    // Run and bookkeeping commit together. Losing `lastRunId` is worse here
    // than for a trigger: it is the ONLY thing the concurrency check above
    // reads, and this queue retries immediately with no claim to stop it — so
    // the stale pointer makes `skip` fail to skip and `replace` cancel a run
    // that already finished while the live one keeps going.
    submitted = await db.transaction(async (tx) => {
      const result = await submitTaskIn(tx, {
        projectId: schedule.projectId,
        actorUserId: schedule.createdBy,
        actor: { orgId: schedule.orgId, userId: schedule.createdBy },
        input: {
          taskTypeId: schedule.taskTypeId,
          title: schedule.name,
          // resolved against THIS firing, in the schedule's own timezone: stored
          // parameters are frozen, but the interesting ones are about when the
          // schedule fired — a weekly report with a fixed dateRange reports on
          // the same week forever
          params: applyScheduleTokens(schedule.params, firedAt, schedule.timezone),
          agents: schedule.agentOverrides,
        },
        originKey: `schedule:${fireKey}`,
      });
      await tx
        .update(taskSchedules)
        .set({
          lastFiredAt: firedAt,
          lastRunId: result.runId,
          lastError: null,
          lastErrorAt: null,
          updatedAt: new Date(),
        })
        .where(eq(taskSchedules.id, scheduleId));
      return result;
    });
  } catch (err) {
    // A redelivered job, not a failure: this firing already has its run, and
    // the whole point is to leave that run — and the schedule — untouched.
    // Checked before `fail()`, which would otherwise page the project about
    // the system working exactly as intended.
    if (err instanceof DuplicateFiringError) {
      return { kind: "skipped", reason: "already_fired" };
    }
    // Everything else reaching here is fixable configuration or a transient
    // shortage — quota exhausted, a revoked grant, no live worker for the
    // executor set. The schedule stays on so next week's firing can succeed;
    // the error is recorded and announced so the fix happens before then.
    const message =
      err instanceof AppError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return fail(message);
  }

  // outside the try: a send failure must not be recorded as a firing failure
  // for a run that is alive and billing
  await enqueueAfterCommit(
    () => queue?.enqueueRun(submitted.runId) ?? Promise.resolve(),
    `run ${submitted.runId}`,
  );
  return { kind: "submitted", taskId: submitted.taskId, runId: submitted.runId };
}

/**
 * Converge pg-boss's cron calendar with the schedule rows.
 *
 * Registration at request time is best-effort, and the boot pass only runs at
 * boot — so without this a dropped `registerSchedule` meant the schedule
 * silently never fired until someone restarted a worker, and a dropped
 * re-registration after an edit meant it kept firing on the OLD cron while the
 * UI displayed the new one. Silence and a lie, from the feature whose whole
 * premise is running unattended.
 *
 * Diffs rather than re-registers: `getSchedules` returns the live calendar
 * keyed by schedule id with its cron and timezone, which is exactly the drift
 * surface, so a converged deployment does no writes at all. It also catches
 * the one class nothing else can — a calendar entry whose row was deleted
 * while its unregister failed, which would otherwise wake a worker forever.
 *
 * **The calendar is read before the rows, and the order is load-bearing.** The
 * two live in different stores — rows in Postgres, entries in pg-boss's own
 * tables — mutated by a different process with no transaction spanning them,
 * so there is always a window between the two reads. Every writer commits its
 * row first and touches the calendar after, so reading the calendar first
 * makes the rows snapshot the fresher of the two, and that turns every
 * interleaving benign: a schedule created in the window is absent from the
 * calendar snapshot and present in rows, so it is registered rather than
 * mistaken for an orphan and torn out; an edit diffs the old entry against the
 * new row and converges onto the NEW cron instead of restoring the old one.
 * Read the other way round, both of those corrupt a schedule that was correct
 * when the request returned.
 *
 * What this buys is convergence within a tick, not mutual exclusion — no read
 * order can give the latter across two stores. The remaining window is between
 * the rows read and the repair itself, which is why each unregister
 * re-validates against the row immediately before tearing an entry out: that
 * is the only repair that can silence a live schedule, and it is rare enough
 * that one extra statement costs nothing.
 */
export async function reconcileScheduleCalendar(
  db: Db,
  calendar: {
    list(): Promise<Array<{ key: string; cron: string; timezone: string }>>;
    register(scheduleId: string, cron: string, timezone: string): Promise<void>;
    unregister(scheduleId: string): Promise<void>;
  },
): Promise<{
  considered: number;
  registered: number;
  unregistered: number;
  failed: Array<{ id: string; error: string }>;
}> {
  // calendar first — see the note above; swapping these two statements
  // reintroduces a race that unregisters schedules created seconds ago
  const live = new Map((await calendar.list()).map((e) => [e.key, e]));
  const rows = await db
    .select({
      id: taskSchedules.id,
      cron: taskSchedules.cron,
      timezone: taskSchedules.timezone,
      enabled: taskSchedules.enabled,
    })
    .from(taskSchedules);

  /**
   * Re-read immediately before an unregister. An entry whose row was created
   * or re-enabled after the rows snapshot would otherwise be torn out on the
   * strength of a stale read, leaving an enabled schedule that never fires and
   * says nothing about it.
   */
  const safeToUnregister = async (id: string): Promise<boolean> => {
    // A key that cannot be a row id has no row to protect, and asking Postgres
    // for it would raise rather than return empty — which would strand the
    // junk entry in the calendar forever, waking a worker on every tick with
    // nothing to run. Shape-check instead of catching, so a database that is
    // merely *down* still aborts the unregister rather than reaping the fleet.
    if (!UUID_RE.test(id)) return true;
    const [row] = await db
      .select({ enabled: taskSchedules.enabled })
      .from(taskSchedules)
      .where(eq(taskSchedules.id, id));
    return !row?.enabled;
  };

  let registered = 0;
  let unregistered = 0;
  const failed: Array<{ id: string; error: string }> = [];
  for (const row of rows) {
    // isolated per row: this is a repair loop, and one unrepairable schedule
    // must not stop the others being repaired
    try {
      const entry = live.get(row.id);
      if (row.enabled) {
        if (!entry || entry.cron !== row.cron || entry.timezone !== row.timezone) {
          await calendar.register(row.id, row.cron, row.timezone);
          registered += 1;
        }
      } else if (entry && (await safeToUnregister(row.id))) {
        await calendar.unregister(row.id);
        unregistered += 1;
      }
      live.delete(row.id);
    } catch (err) {
      live.delete(row.id); // not an orphan; it has a row, just an unhappy one
      failed.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // whatever is left in the calendar has no row in the snapshot — but the
  // snapshot is older than this loop, so confirm before tearing it out
  for (const key of live.keys()) {
    try {
      if (await safeToUnregister(key)) {
        await calendar.unregister(key);
        unregistered += 1;
      }
    } catch (err) {
      failed.push({ id: key, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // A failure that only ever became a dropped counter is how a schedule stops
  // firing while every log line says the fleet converged. Record it where an
  // admin already looks — the same amber `lastError` a failed firing writes,
  // prefixed so the two stay distinguishable — and hand the list back so the
  // caller can log it with its own logger.
  for (const { id, error } of failed) {
    await db
      .update(taskSchedules)
      .set({ lastError: `calendar registration failed: ${error}`, lastErrorAt: new Date() })
      .where(eq(taskSchedules.id, id))
      .catch(() => {}); // the reporting path must not itself break the sweep
  }
  return { considered: rows.length, registered, unregistered, failed };
}
