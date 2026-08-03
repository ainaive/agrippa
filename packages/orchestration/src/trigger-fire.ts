import {
  AppError,
  applyScheduleTokens,
  type RunQueue,
  type TriggerDisabledReason,
} from "@agrippa/core";
import { type Db, triggerDeliveries, triggerEndpoints } from "@agrippa/db";
import { and, eq, sql } from "drizzle-orm";
import { auditAs } from "./audit";
import { checkWorkAuthority } from "./authority";
import {
  enqueueProjectEventDeliveries,
  insertProjectEventDeliveries,
  notifyProjectEvent,
} from "./notifications";
import { enqueueAfterCommit } from "./queue";
import { submitTask } from "./submit";

export type TriggerFireOutcome =
  | { kind: "submitted"; taskId: string; runId: string }
  | { kind: "skipped"; reason: "already_handled" | "disabled" }
  | { kind: "failed"; error: string }
  | { kind: "disabled"; reason: TriggerDisabledReason };

/**
 * Submit the task an accepted inbound delivery asked for.
 *
 * This runs in the worker rather than in the request, which is the whole reason
 * the delivery row exists: the sender gets its acknowledgement as soon as the
 * request is recorded, so a slow submit — or a failing one — never becomes a
 * timeout the sender retries into a second run.
 *
 * The disable-vs-fail split is the same one schedules make, for the same
 * reason. An owner who left, an archived project, a withdrawn task type will
 * never resolve themselves, so the trigger stops and says so. A quota, a
 * revoked grant, a missing worker will, so the delivery is marked failed,
 * stays replayable, and the trigger keeps listening. Neither case is silent:
 * the sender's 202 already happened, so the delivery log and the notification
 * pipeline are the only places a human can learn about it.
 */
export async function fireTrigger(
  db: Db,
  queue: RunQueue | null,
  deliveryId: string,
): Promise<TriggerFireOutcome> {
  const [delivery] = await db
    .select()
    .from(triggerDeliveries)
    .where(eq(triggerDeliveries.id, deliveryId));
  if (!delivery) return { kind: "skipped", reason: "already_handled" };
  // a succeeded delivery is never re-submitted: at-least-once job delivery and
  // an operator hitting replay both land here, and neither should double-spend
  if (delivery.status === "succeeded") return { kind: "skipped", reason: "already_handled" };

  const [endpoint] = await db
    .select()
    .from(triggerEndpoints)
    .where(eq(triggerEndpoints.id, delivery.endpointId));
  if (!endpoint) return { kind: "skipped", reason: "already_handled" };

  const markAttempt = async (patch: Record<string, unknown>): Promise<void> => {
    await db
      .update(triggerDeliveries)
      .set({ lastAttemptAt: new Date(), ...patch })
      .where(eq(triggerDeliveries.id, deliveryId));
  };

  // Claim the attempt by CAS before doing anything observable — the attempts
  // counter is the version. A plain read-then-submit lets two concurrent
  // invocations (a redelivered job racing a sweeper re-enqueue, or an operator
  // double-clicking Retry) both see `pending` and both submit, which is two
  // runs and two charges for one webhook. The 20s window mirrors the
  // notification executor's and is chosen against the queue's retry delay: it
  // must outlast an in-flight submit but stay under the 30s first retry and
  // the 60s sweeper threshold, or a legitimate retry would be turned away as
  // if it were a duplicate. Losing the race is a quiet no-op — whoever holds
  // the claim records the outcome.
  const [claimed] = await db
    .update(triggerDeliveries)
    .set({ attempts: delivery.attempts + 1, lastAttemptAt: new Date() })
    .where(
      and(
        eq(triggerDeliveries.id, deliveryId),
        eq(triggerDeliveries.status, "pending"),
        eq(triggerDeliveries.attempts, delivery.attempts),
        sql`(${triggerDeliveries.lastAttemptAt} IS NULL OR ${triggerDeliveries.lastAttemptAt} < now() - interval '20 seconds')`,
      ),
    )
    .returning({ id: triggerDeliveries.id });
  if (!claimed) return { kind: "skipped", reason: "already_handled" };

  if (!endpoint.enabled) {
    await markAttempt({ status: "failed", lastError: "trigger is disabled" });
    return { kind: "skipped", reason: "disabled" };
  }

  const denied = await checkWorkAuthority(db, {
    projectId: endpoint.projectId,
    taskTypeId: endpoint.taskTypeId,
    ownerId: endpoint.createdBy,
  });
  if (denied) {
    // one transaction, for the reason schedule-fire spells out: the flag that
    // stops the trigger is also the flag that makes the retry skip, so the
    // announcement has to be committed with it or it is lost for good
    const deliveryIds = await db.transaction(async (tx) => {
      await tx
        .update(triggerEndpoints)
        .set({ enabled: false, disabledReason: denied, updatedAt: new Date() })
        .where(eq(triggerEndpoints.id, endpoint.id));
      await tx
        .update(triggerDeliveries)
        .set({ status: "failed", lastError: `trigger disabled: ${denied}` })
        .where(eq(triggerDeliveries.id, deliveryId));
      await auditAs(
        tx,
        { orgId: endpoint.orgId, userId: endpoint.createdBy },
        {
          action: "trigger.disabled",
          resourceType: "trigger_endpoint",
          resourceId: endpoint.id,
          projectId: endpoint.projectId,
          payload: { reason: denied, name: endpoint.name },
        },
      );
      return insertProjectEventDeliveries(tx, {
        projectId: endpoint.projectId,
        eventType: "trigger.disabled",
        payload: { triggerId: endpoint.id, triggerName: endpoint.name, reason: denied },
      });
    });
    await enqueueProjectEventDeliveries(queue, deliveryIds);
    return { kind: "disabled", reason: denied };
  }

  try {
    const { taskId, runId } = await submitTask(db, queue, {
      projectId: endpoint.projectId,
      actorUserId: endpoint.createdBy,
      actor: { orgId: endpoint.orgId, userId: endpoint.createdBy },
      input: {
        taskTypeId: endpoint.taskTypeId,
        title: endpoint.name,
        // resolved against this firing, exactly as a schedule resolves them:
        // creation validated the resolved form, so firing must resolve too or
        // the token reaches the agent's prompt literally
        params: applyScheduleTokens(endpoint.params, new Date(), endpoint.timezone),
        agents: endpoint.agentOverrides,
      },
    });
    await markAttempt({ status: "succeeded", taskId, runId, lastError: null });
    await db
      .update(triggerEndpoints)
      .set({ lastFiredAt: new Date(), updatedAt: new Date() })
      .where(eq(triggerEndpoints.id, endpoint.id));
    return { kind: "submitted", taskId, runId };
  } catch (err) {
    const message =
      err instanceof AppError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    await markAttempt({ status: "failed", lastError: message });
    await notifyProjectEvent(db, queue, {
      projectId: endpoint.projectId,
      eventType: "trigger.failed",
      payload: { triggerId: endpoint.id, triggerName: endpoint.name, error: message, deliveryId },
    });
    return { kind: "failed", error: message };
  }
}

/** A delivery untouched this long lost its job and needs re-enqueueing. */
const STALE_AFTER = sql`now() - interval '60 seconds'`;
/** Give up after this many attempts rather than retrying a doomed row forever. */
const MAX_SWEPT_ATTEMPTS = 8;
/** Bound one tick's work; the next tick takes the rest. */
const STALE_BATCH = 100;

/**
 * Backstop for accepted deliveries whose job never arrived.
 *
 * The inbound request writes the row and then enqueues, so a crash, a queue
 * outage, or a deduplicated retry whose original never got a job all leave a
 * `pending` row with nothing scheduled. Nothing else can rescue it: the retry
 * endpoint only moves `failed → pending`, and the UI offers Retry only on
 * `failed`, so without this sweep a stranded delivery is reachable only by
 * hand-written SQL — an acknowledged webhook that silently never ran.
 *
 * Mirrors `sweepNotificationDeliveries` minus its backfill half; there is
 * nothing to backfill here, because the request itself creates the row.
 */
export async function sweepTriggerDeliveries(db: Db, queue: RunQueue): Promise<void> {
  // Both statements measure the age of the last ATTEMPT, not of the row.
  // Row age is the wrong clock: a delivery created hours ago and re-attempted
  // a second ago is not stale, and treating it as such re-enqueues it on every
  // tick and — worse, below — lets the exhaustion update stamp `failed` on a
  // row whose submit is still running, which the success path then overwrites.
  // `coalesce` covers the never-claimed row, whose creation IS its clock.
  const untouched = sql`coalesce(${triggerDeliveries.lastAttemptAt}, ${triggerDeliveries.createdAt}) < ${STALE_AFTER}`;

  // a row that has burned its attempts is failed, not pending — that both
  // stops the churn and puts Retry in front of the operator in the UI
  await db
    .update(triggerDeliveries)
    .set({
      status: "failed",
      lastError: sql`coalesce(${triggerDeliveries.lastError}, 'delivery attempts exhausted')`,
    })
    .where(
      and(
        eq(triggerDeliveries.status, "pending"),
        sql`${triggerDeliveries.attempts} >= ${MAX_SWEPT_ATTEMPTS}`,
        untouched,
      ),
    );

  const stale = await db
    .select({ id: triggerDeliveries.id })
    .from(triggerDeliveries)
    .where(and(eq(triggerDeliveries.status, "pending"), untouched))
    .orderBy(triggerDeliveries.createdAt)
    .limit(STALE_BATCH);
  for (const row of stale) {
    await enqueueAfterCommit(
      () => queue.enqueueTriggerDelivery(row.id),
      `trigger delivery ${row.id}`,
    );
  }
}
