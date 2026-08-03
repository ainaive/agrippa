import {
  AppError,
  applyScheduleTokens,
  type RunQueue,
  type TriggerDisabledReason,
} from "@agrippa/core";
import { type Db, triggerDeliveries, triggerEndpoints } from "@agrippa/db";
import { eq, sql } from "drizzle-orm";
import { auditAs } from "./audit";
import { checkWorkAuthority } from "./authority";
import { notifyProjectEvent } from "./notifications";
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
      .set({
        attempts: sql`${triggerDeliveries.attempts} + 1`,
        lastAttemptAt: new Date(),
        ...patch,
      })
      .where(eq(triggerDeliveries.id, deliveryId));
  };

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
    await db
      .update(triggerEndpoints)
      .set({ enabled: false, disabledReason: denied, updatedAt: new Date() })
      .where(eq(triggerEndpoints.id, endpoint.id));
    await markAttempt({ status: "failed", lastError: `trigger disabled: ${denied}` });
    await auditAs(
      db,
      { orgId: endpoint.orgId, userId: endpoint.createdBy },
      {
        action: "trigger.disabled",
        resourceType: "trigger_endpoint",
        resourceId: endpoint.id,
        projectId: endpoint.projectId,
        payload: { reason: denied, name: endpoint.name },
      },
    );
    await notifyProjectEvent(db, queue, {
      projectId: endpoint.projectId,
      eventType: "trigger.disabled",
      payload: { triggerId: endpoint.id, triggerName: endpoint.name, reason: denied },
    });
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
