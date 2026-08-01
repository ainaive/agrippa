import {
  AppError,
  LOCALES,
  type Locale,
  maskWebhookUrl,
  type NotificationEndpointKind,
  notificationEndpointCreateSchema,
  notificationEndpointUpdateSchema,
  validateWebhookUrl,
} from "@agrippa/core";
import {
  encryptSecret,
  loadSecretKey,
  notificationDeliveries,
  notificationEndpoints,
  runs,
  secrets,
} from "@agrippa/db";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { audit } from "../lib/audit";
import { validate } from "../lib/validate";
import { requireProjectRole } from "../middleware/rbac";

/**
 * Outbound notification config + delivery log (Track N, docs/design/04).
 * Everything is project-admin-only: IM bot webhook URLs are capability URLs,
 * so even reads are privileged and responses carry only a masked URL. The
 * signing secret is write-only via the secrets table, like provider keys.
 */

function serializeEndpoint(r: typeof notificationEndpoints.$inferSelect) {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    url: maskWebhookUrl(r.url),
    events: r.events,
    locale: r.locale,
    enabled: r.enabled,
    hasSecret: r.secretRef !== null,
    createdAt: r.createdAt,
  };
}

async function loadEndpointScoped(
  c: { var: { db: AppEnv["Variables"]["db"] } },
  projectId: string,
  endpointId: string,
) {
  const [row] = await c.var.db
    .select()
    .from(notificationEndpoints)
    .where(
      and(eq(notificationEndpoints.id, endpointId), eq(notificationEndpoints.projectId, projectId)),
    );
  if (!row) throw AppError.notFound("Notification endpoint");
  return row;
}

export const notificationRoutes = new Hono<AppEnv>()
  .get("/:projectId/notifications/endpoints", requireProjectRole("admin"), async (c) => {
    const rows = await c.var.db
      .select()
      .from(notificationEndpoints)
      .where(eq(notificationEndpoints.projectId, c.req.param("projectId")))
      .orderBy(notificationEndpoints.createdAt);
    return c.json(rows.map(serializeEndpoint));
  })
  .post(
    "/:projectId/notifications/endpoints",
    requireProjectRole("admin"),
    validate("json", notificationEndpointCreateSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const body = c.req.valid("json");
      const reason = validateWebhookUrl(body.kind, body.url);
      if (reason) throw new AppError("webhook_url_invalid", 400, `Webhook URL ${reason}`);
      const locale = (body.locale ??
        (LOCALES.includes(c.var.locale as Locale) ? c.var.locale : "zh-CN")) as string;
      const db = c.var.db;
      const created = await db.transaction(async (tx) => {
        let secretRef: string | null = null;
        if (body.secret !== undefined) {
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
          secretRef = secret.id;
        }
        const [row] = await tx
          .insert(notificationEndpoints)
          .values({
            projectId,
            kind: body.kind,
            name: body.name,
            url: body.url,
            secretRef,
            events: body.events,
            locale,
            enabled: body.enabled,
            createdBy: c.var.user.id,
          })
          .returning();
        await audit(
          c,
          {
            action: "project.webhook.add",
            resourceType: "notification_endpoint",
            resourceId: row?.id,
            projectId,
            payload: { kind: body.kind, name: body.name, url: maskWebhookUrl(body.url) },
          },
          tx,
        );
        return row;
      });
      if (!created) throw new Error("endpoint insert failed");
      return c.json(serializeEndpoint(created), 201);
    },
  )
  .patch(
    "/:projectId/notifications/endpoints/:endpointId",
    requireProjectRole("admin"),
    validate("json", notificationEndpointUpdateSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const patch = c.req.valid("json");
      const current = await loadEndpointScoped(c, projectId, c.req.param("endpointId"));
      if (patch.url !== undefined) {
        const reason = validateWebhookUrl(current.kind as NotificationEndpointKind, patch.url);
        if (reason) throw new AppError("webhook_url_invalid", 400, `Webhook URL ${reason}`);
        // URL and secret travel together (provider-credential rule): a
        // url-only change would point signed payloads at a new host without
        // proof the caller holds the secret. Unsigned endpoints are exempt.
        if (current.secretRef !== null && patch.secret === undefined) {
          throw new AppError(
            "webhook_secret_required",
            400,
            "Changing the URL requires re-entering the signing secret",
          );
        }
      }
      const db = c.var.db;
      await db.transaction(async (tx) => {
        let secretRef = current.secretRef;
        if (patch.secret !== undefined) {
          if (secretRef === null) {
            const [secret] = await tx
              .insert(secrets)
              .values({
                orgId: c.var.user.orgId,
                kind: "webhook_secret",
                ciphertext: encryptSecret(patch.secret, loadSecretKey()),
                createdBy: c.var.user.id,
              })
              .returning();
            if (!secret) throw new Error("secret insert failed");
            secretRef = secret.id;
          } else {
            await tx
              .update(secrets)
              .set({
                ciphertext: encryptSecret(patch.secret, loadSecretKey()),
                rotatedAt: new Date(),
              })
              .where(eq(secrets.id, secretRef));
          }
        }
        await tx
          .update(notificationEndpoints)
          .set({
            name: patch.name ?? current.name,
            url: patch.url ?? current.url,
            events: patch.events ?? current.events,
            locale: patch.locale ?? current.locale,
            enabled: patch.enabled ?? current.enabled,
            secretRef,
          })
          .where(eq(notificationEndpoints.id, current.id));
        await audit(
          c,
          {
            action: "project.webhook.update",
            resourceType: "notification_endpoint",
            resourceId: current.id,
            projectId,
            payload: {
              rotated: patch.secret !== undefined,
              urlChanged: patch.url !== undefined,
              enabled: patch.enabled,
            },
          },
          tx,
        );
      });
      return c.json({ updated: true });
    },
  )
  .delete(
    "/:projectId/notifications/endpoints/:endpointId",
    requireProjectRole("admin"),
    async (c) => {
      const projectId = c.req.param("projectId");
      const current = await loadEndpointScoped(c, projectId, c.req.param("endpointId"));
      await c.var.db.transaction(async (tx) => {
        // deliveries cascade with the endpoint row
        await tx.delete(notificationEndpoints).where(eq(notificationEndpoints.id, current.id));
        if (current.secretRef !== null) {
          // the secret dies with the endpoint — no orphaned key material
          await tx.delete(secrets).where(eq(secrets.id, current.secretRef));
        }
        await audit(
          c,
          {
            action: "project.webhook.remove",
            resourceType: "notification_endpoint",
            resourceId: current.id,
            projectId,
            payload: { name: current.name },
          },
          tx,
        );
      });
      return c.json({ removed: true });
    },
  )
  .post(
    "/:projectId/notifications/endpoints/:endpointId/test",
    requireProjectRole("admin"),
    async (c) => {
      const projectId = c.req.param("projectId");
      const current = await loadEndpointScoped(c, projectId, c.req.param("endpointId"));
      const [delivery] = await c.var.db
        .insert(notificationDeliveries)
        .values({
          endpointId: current.id,
          projectId,
          eventType: "notification.test",
        })
        .returning({ id: notificationDeliveries.id });
      if (!delivery) throw new Error("delivery insert failed");
      await c.var.queue?.enqueueNotificationDelivery(delivery.id);
      await audit(c, {
        action: "project.webhook.test",
        resourceType: "notification_endpoint",
        resourceId: current.id,
        projectId,
      });
      return c.json({ deliveryId: delivery.id }, 202);
    },
  )
  .get("/:projectId/notifications/deliveries", requireProjectRole("admin"), async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
    const status = c.req.query("status");
    const conditions = [eq(notificationDeliveries.projectId, c.req.param("projectId"))];
    if (status === "pending" || status === "succeeded" || status === "failed") {
      conditions.push(eq(notificationDeliveries.status, status));
    }
    const rows = await c.var.db
      .select({
        id: notificationDeliveries.id,
        endpointId: notificationDeliveries.endpointId,
        endpointName: notificationEndpoints.name,
        endpointKind: notificationEndpoints.kind,
        runId: notificationDeliveries.runId,
        runNumber: runs.number,
        eventType: notificationDeliveries.eventType,
        status: notificationDeliveries.status,
        attempts: notificationDeliveries.attempts,
        payload: notificationDeliveries.payload,
        lastAttemptAt: notificationDeliveries.lastAttemptAt,
        responseStatus: notificationDeliveries.responseStatus,
        responseSnippet: notificationDeliveries.responseSnippet,
        lastError: notificationDeliveries.lastError,
        createdAt: notificationDeliveries.createdAt,
      })
      .from(notificationDeliveries)
      .leftJoin(
        notificationEndpoints,
        eq(notificationEndpoints.id, notificationDeliveries.endpointId),
      )
      .leftJoin(runs, eq(runs.id, notificationDeliveries.runId))
      .where(and(...conditions))
      .orderBy(desc(notificationDeliveries.createdAt))
      .limit(limit);
    return c.json(rows);
  })
  .post(
    "/:projectId/notifications/deliveries/:deliveryId/retry",
    requireProjectRole("admin"),
    async (c) => {
      const projectId = c.req.param("projectId");
      const deliveryId = c.req.param("deliveryId");
      // CAS failed → pending: only a finished failure is retryable, and two
      // concurrent retries produce one enqueue. Attempts reset so the manual
      // retry gets the full budget instead of the sweeper's exhaustion cap.
      const updated = await c.var.db
        .update(notificationDeliveries)
        .set({ status: "pending", attempts: 0, lastError: null })
        .where(
          and(
            eq(notificationDeliveries.id, deliveryId),
            eq(notificationDeliveries.projectId, projectId),
            eq(notificationDeliveries.status, "failed"),
          ),
        )
        .returning({ id: notificationDeliveries.id });
      if (updated.length === 0) {
        const [exists] = await c.var.db
          .select({ id: notificationDeliveries.id })
          .from(notificationDeliveries)
          .where(
            and(
              eq(notificationDeliveries.id, deliveryId),
              eq(notificationDeliveries.projectId, projectId),
            ),
          );
        if (!exists) throw AppError.notFound("Notification delivery");
        throw AppError.conflict("not_retryable", "Only failed deliveries can be retried");
      }
      await c.var.queue?.enqueueNotificationDelivery(deliveryId);
      await audit(c, {
        action: "project.webhook.retry",
        resourceType: "notification_delivery",
        resourceId: deliveryId,
        projectId,
      });
      return c.json({ retried: true }, 202);
    },
  );
