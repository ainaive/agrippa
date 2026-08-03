import {
  AppError,
  TRIGGER_TOKEN_PREFIX,
  triggerCreateSchema,
  triggerUpdateSchema,
} from "@agrippa/core";
import {
  encryptSecret,
  loadSecretKey,
  secrets,
  triggerDeliveries,
  triggerEndpoints,
} from "@agrippa/db";
import { enqueueAfterCommit } from "@agrippa/orchestration";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { audit } from "../lib/audit";
import { issueToken } from "../lib/bearer-tokens";
import { assertSchedulableParams } from "../lib/task-params";
import { validate } from "../lib/validate";
import { requireProjectRole } from "../middleware/rbac";

/** Never selects the token hash or the secret — neither leaves the server. */
const triggerView = {
  id: triggerEndpoints.id,
  name: triggerEndpoints.name,
  taskTypeId: triggerEndpoints.taskTypeId,
  params: triggerEndpoints.params,
  timezone: triggerEndpoints.timezone,
  agentOverrides: triggerEndpoints.agentOverrides,
  tokenPrefix: triggerEndpoints.tokenPrefix,
  enabled: triggerEndpoints.enabled,
  disabledReason: triggerEndpoints.disabledReason,
  lastFiredAt: triggerEndpoints.lastFiredAt,
  createdBy: triggerEndpoints.createdBy,
  createdAt: triggerEndpoints.createdAt,
};

/**
 * Webhook triggers, managed by project admins. The public surface a sender
 * actually POSTs to lives in ./trigger-inbound.ts, mounted outside the session
 * gate; this is only the management side.
 */
export const triggerRoutes = new Hono<AppEnv>()
  .get("/:projectId/triggers", requireProjectRole("admin"), async (c) => {
    const rows = await c.var.db
      .select(triggerView)
      .from(triggerEndpoints)
      .where(eq(triggerEndpoints.projectId, c.req.param("projectId")))
      .orderBy(desc(triggerEndpoints.createdAt));
    return c.json(rows);
  })

  .post(
    "/:projectId/triggers",
    requireProjectRole("admin"),
    validate("json", triggerCreateSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const body = c.req.valid("json");
      // the same gate schedules get: a trigger whose parameters could never
      // produce a run would fail on a request nobody is watching
      await assertSchedulableParams(c.var.db, body.taskTypeId, body.params, body.timezone);

      const issued = issueToken(TRIGGER_TOKEN_PREFIX);
      const created = await c.var.db.transaction(async (tx) => {
        const [secret] = await tx
          .insert(secrets)
          .values({
            orgId: c.var.user.orgId,
            kind: "webhook_secret",
            ciphertext: encryptSecret(body.secret, loadSecretKey()),
            createdBy: c.var.user.id,
          })
          .returning();
        if (!secret) throw new Error("secret insert failed");
        const [row] = await tx
          .insert(triggerEndpoints)
          .values({
            orgId: c.var.user.orgId,
            projectId,
            taskTypeId: body.taskTypeId,
            name: body.name,
            params: body.params,
            timezone: body.timezone,
            agentOverrides: body.agents,
            tokenHash: issued.tokenHash,
            tokenPrefix: issued.tokenPrefix,
            secretRef: secret.id,
            createdBy: c.var.user.id,
          })
          .returning(triggerView);
        if (!row) throw new Error("trigger insert failed");
        return row;
      });

      await audit(c, {
        action: "trigger.create",
        resourceType: "trigger_endpoint",
        resourceId: created.id,
        projectId,
        payload: { name: created.name, taskTypeId: created.taskTypeId },
      });
      // the token is shown exactly once, as part of the URL the sender needs
      return c.json({ ...created, token: issued.token }, 201);
    },
  )

  .patch(
    "/:projectId/triggers/:id",
    requireProjectRole("admin"),
    validate("json", triggerUpdateSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const id = c.req.param("id");
      const body = c.req.valid("json");

      if (body.params !== undefined || body.timezone !== undefined) {
        const [current] = await c.var.db
          .select()
          .from(triggerEndpoints)
          .where(and(eq(triggerEndpoints.id, id), eq(triggerEndpoints.projectId, projectId)));
        if (!current) throw AppError.notFound("Trigger");
        await assertSchedulableParams(
          c.var.db,
          current.taskTypeId,
          body.params ?? current.params,
          body.timezone ?? current.timezone,
        );
      }

      const [row] = await c.var.db
        .update(triggerEndpoints)
        .set({
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.params === undefined ? {} : { params: body.params }),
          ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
          ...(body.agents === undefined ? {} : { agentOverrides: body.agents }),
          ...(body.enabled === undefined ? {} : { enabled: body.enabled, disabledReason: null }),
          updatedAt: new Date(),
        })
        .where(and(eq(triggerEndpoints.id, id), eq(triggerEndpoints.projectId, projectId)))
        .returning(triggerView);
      if (!row) throw AppError.notFound("Trigger");

      await audit(c, {
        action: "trigger.update",
        resourceType: "trigger_endpoint",
        resourceId: id,
        projectId,
        payload: body,
      });
      return c.json(row);
    },
  )

  .delete("/:projectId/triggers/:id", requireProjectRole("admin"), async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    const row = await c.var.db.transaction(async (tx) => {
      const [deleted] = await tx
        .delete(triggerEndpoints)
        .where(and(eq(triggerEndpoints.id, id), eq(triggerEndpoints.projectId, projectId)))
        // deliveries cascade with the endpoint row
        .returning({
          id: triggerEndpoints.id,
          name: triggerEndpoints.name,
          secretRef: triggerEndpoints.secretRef,
        });
      if (!deleted) return null;
      // the secret dies with the endpoint — no orphaned key material. The FK
      // has no reverse cascade, so nothing else would ever reap it, and the
      // row that pointed at it is the only thing that could have found it.
      await tx.delete(secrets).where(eq(secrets.id, deleted.secretRef));
      return deleted;
    });
    if (!row) throw AppError.notFound("Trigger");
    await audit(c, {
      action: "trigger.delete",
      resourceType: "trigger_endpoint",
      resourceId: id,
      projectId,
      payload: { name: row.name },
    });
    return c.json({ ok: true });
  })

  // ── delivery log: payload inspection + replay ───────────────────────────────

  .get("/:projectId/triggers/deliveries", requireProjectRole("admin"), async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 30), 100);
    const rows = await c.var.db
      .select({
        id: triggerDeliveries.id,
        endpointId: triggerDeliveries.endpointId,
        endpointName: triggerEndpoints.name,
        externalId: triggerDeliveries.externalId,
        status: triggerDeliveries.status,
        attempts: triggerDeliveries.attempts,
        payload: triggerDeliveries.payload,
        runId: triggerDeliveries.runId,
        lastError: triggerDeliveries.lastError,
        lastAttemptAt: triggerDeliveries.lastAttemptAt,
        createdAt: triggerDeliveries.createdAt,
      })
      .from(triggerDeliveries)
      .leftJoin(triggerEndpoints, eq(triggerDeliveries.endpointId, triggerEndpoints.id))
      .where(eq(triggerDeliveries.projectId, c.req.param("projectId")))
      .orderBy(desc(triggerDeliveries.createdAt))
      .limit(limit);
    return c.json(rows);
  })

  .post(
    "/:projectId/triggers/deliveries/:deliveryId/retry",
    requireProjectRole("admin"),
    async (c) => {
      const projectId = c.req.param("projectId");
      const deliveryId = c.req.param("deliveryId");
      // failed → pending only: replaying a succeeded delivery would spend the
      // project's tokens on a run it already got, and fireTrigger refuses it
      // anyway — better to say so here than to enqueue a job that no-ops
      const [row] = await c.var.db
        .update(triggerDeliveries)
        .set({ status: "pending", lastError: null })
        .where(
          and(
            eq(triggerDeliveries.id, deliveryId),
            eq(triggerDeliveries.projectId, projectId),
            eq(triggerDeliveries.status, "failed"),
          ),
        )
        .returning({ id: triggerDeliveries.id });
      if (!row)
        throw AppError.conflict("delivery_not_retryable", "Delivery is not in a failed state");

      await audit(c, {
        action: "trigger.delivery.retry",
        resourceType: "trigger_delivery",
        resourceId: deliveryId,
        projectId,
      });
      // the CAS and its audit are committed; the delivery sweeper re-enqueues
      // a stale pending row, so a send failure must not 500 a replay that did
      // in fact take effect
      await enqueueAfterCommit(
        () => c.var.queue?.enqueueTriggerDelivery(deliveryId) ?? Promise.resolve(),
        `replay delivery ${deliveryId}`,
      );
      return c.json({ ok: true });
    },
  );
