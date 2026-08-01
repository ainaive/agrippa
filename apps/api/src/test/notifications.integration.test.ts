import { beforeAll, describe, expect, it } from "bun:test";
import type { RunQueue } from "@agrippa/core";
import {
  auditLogs,
  notificationDeliveries,
  notificationEndpoints,
  repoConnections,
  secrets,
} from "@agrippa/db";
import {
  appendRunEvent,
  InProcessEventBus,
  sweepNotificationDeliveries,
  syncRunNotifications,
} from "@agrippa/orchestration";
import { eq, sql } from "drizzle-orm";
import type { App } from "../app";
import { createApp } from "../app";
import { freshTestDb, jsonOf, postgresAvailable, signUp, type TestClient } from "./helpers";

const dbUp = await postgresAvailable();

describe.skipIf(!dbUp)("notification delivery bookkeeping (sync + sweep)", () => {
  let app: App;
  let db: Awaited<ReturnType<typeof freshTestDb>>;
  let admin: TestClient;
  let viewer: TestClient;
  let projectId: string;
  let runId: string;
  let allEventsEndpointId: string;
  let filteredEndpointId: string;
  const enqueued: string[] = [];

  const fakeQueue: RunQueue = {
    enqueueRun: async () => {},
    enqueueApprovalExpiry: async () => {},
    enqueueNotificationDelivery: async (id) => {
      enqueued.push(id);
    },
  };

  beforeAll(async () => {
    db = await freshTestDb();
    app = createApp({ db, queue: fakeQueue, bus: new InProcessEventBus() });
    admin = await signUp(app, "Root", "root@example.com");
    viewer = await signUp(app, "Vera", "vera@example.com");

    projectId = (
      await jsonOf<{ id: string }>(
        await admin.request("/api/v1/projects", {
          method: "POST",
          json: { slug: "notif", name: "Notifications" },
        }),
      )
    ).id;

    const [conn] = await db
      .insert(repoConnections)
      .values({ projectId, provider: "github", url: "https://github.com/acme/widget.git" })
      .returning();

    const types = await jsonOf<Array<{ id: string; slug: string }>>(
      await admin.request("/api/v1/scenarios/software-development/task-types"),
    );
    const taskTypeId = types.find((t) => t.slug === "bug-localize-fix")?.id as string;

    const submitted = await jsonOf<{ runId: string }>(
      await admin.request(`/api/v1/projects/${projectId}/tasks`, {
        method: "POST",
        json: {
          taskTypeId,
          title: "Fix the widget",
          params: { bugReport: "It crashes", repo: { repoConnectionId: conn?.id } },
        },
      }),
    );
    runId = submitted.runId;

    await admin.request(`/api/v1/projects/${projectId}/members`, {
      method: "POST",
      json: { email: "vera@example.com", role: "viewer" },
    });
  });

  it("creates nothing when no endpoints are configured", async () => {
    await appendRunEvent(db, {
      runId,
      type: "checkpoint.required",
      payload: { checkpointId: "c1" },
    });
    expect(await syncRunNotifications(db, fakeQueue, runId)).toEqual([]);
  });

  it("creates one delivery per matching enabled endpoint, exactly once", async () => {
    const [all] = await db
      .insert(notificationEndpoints)
      .values({
        projectId,
        kind: "generic",
        name: "all events",
        url: "https://hooks.example.com/all",
        locale: "en",
      })
      .returning();
    const [filtered] = await db
      .insert(notificationEndpoints)
      .values({
        projectId,
        kind: "feishu",
        name: "terminal only",
        url: "https://open.feishu.cn/open-apis/bot/v2/hook/abc",
        events: ["run.succeeded"],
        locale: "zh-CN",
      })
      .returning();
    await db.insert(notificationEndpoints).values({
      projectId,
      kind: "generic",
      name: "disabled",
      url: "https://hooks.example.com/disabled",
      enabled: false,
      locale: "en",
    });
    allEventsEndpointId = all?.id as string;
    filteredEndpointId = filtered?.id as string;

    // the checkpoint.required event above predates these endpoints; backdate
    // their activation watermark so this suite's pre-existing flow still
    // exercises delivery (the watermark itself is tested below)
    await db
      .update(notificationEndpoints)
      .set({ activatedAt: sql`now() - interval '1 hour'` })
      .where(eq(notificationEndpoints.projectId, projectId));

    enqueued.length = 0;
    const created = await syncRunNotifications(db, fakeQueue, runId);
    // checkpoint.required matches only the unfiltered endpoint; the disabled
    // endpoint and the run.succeeded-filtered one get nothing.
    expect(created.length).toBe(1);
    expect(enqueued).toEqual(created);
    const [row] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, created[0] as string));
    expect(row?.endpointId).toBe(allEventsEndpointId);
    expect(row?.eventType).toBe("checkpoint.required");
    expect(row?.status).toBe("pending");

    // idempotent: nothing new on re-sync
    expect(await syncRunNotifications(db, fakeQueue, runId)).toEqual([]);
  });

  it("fans a terminal event out to filter-matching endpoints", async () => {
    await appendRunEvent(db, { runId, type: "run.succeeded", payload: {} });
    enqueued.length = 0;
    const created = await syncRunNotifications(db, fakeQueue, runId);
    expect(created.length).toBe(2);
    const rows = await db
      .select({ endpointId: notificationDeliveries.endpointId })
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.eventType, "run.succeeded"));
    expect(new Set(rows.map((r) => r.endpointId))).toEqual(
      new Set([allEventsEndpointId, filteredEndpointId]),
    );
  });

  it("ignores non-notifiable event types", async () => {
    await appendRunEvent(db, { runId, type: "step.started", payload: {} });
    expect(await syncRunNotifications(db, fakeQueue, runId)).toEqual([]);
  });

  it("sweep backfills events that never got delivery rows", async () => {
    await appendRunEvent(db, { runId, type: "run.failed", payload: { code: "internal" } });
    enqueued.length = 0;
    await sweepNotificationDeliveries(db, fakeQueue);
    const rows = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.eventType, "run.failed"));
    expect(rows.length).toBe(1); // unfiltered endpoint only
    expect(rows[0]?.endpointId).toBe(allEventsEndpointId);
    expect(enqueued).toContain(rows[0]?.id as string);

    // idempotent: a second sweep adds nothing
    await sweepNotificationDeliveries(db, fakeQueue);
    const again = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.eventType, "run.failed"));
    expect(again.length).toBe(1);
  });

  it("sweep re-enqueues stale pending rows and finalizes exhausted ones", async () => {
    const pending = await db.select().from(notificationDeliveries);
    const staleId = pending[0]?.id as string;
    const exhaustedId = pending[1]?.id as string;
    await db
      .update(notificationDeliveries)
      .set({ createdAt: sql`now() - interval '5 minutes'` })
      .where(eq(notificationDeliveries.id, staleId));
    await db
      .update(notificationDeliveries)
      .set({ createdAt: sql`now() - interval '5 minutes'`, attempts: 8 })
      .where(eq(notificationDeliveries.id, exhaustedId));

    enqueued.length = 0;
    await sweepNotificationDeliveries(db, fakeQueue);

    expect(enqueued).toContain(staleId);
    expect(enqueued).not.toContain(exhaustedId);
    const [exhausted] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, exhaustedId));
    expect(exhausted?.status).toBe("failed");
    expect(exhausted?.lastError).toBe("delivery attempts exhausted");
  });

  it("watermark: an endpoint added later never replays pre-activation events", async () => {
    const [late] = await db
      .insert(notificationEndpoints)
      .values({
        projectId,
        kind: "generic",
        name: "late",
        url: "https://hooks.example.com/late",
        locale: "en",
      })
      .returning();
    const lateId = late?.id as string;

    // neither sync nor sweep backfills history for the new endpoint
    expect(await syncRunNotifications(db, fakeQueue, runId)).toEqual([]);
    await sweepNotificationDeliveries(db, fakeQueue);
    expect(
      await db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.endpointId, lateId)),
    ).toEqual([]);

    // an event after activation delivers to it (and the all-events endpoint)
    await appendRunEvent(db, { runId, type: "run.timed_out", payload: {} });
    const created = await syncRunNotifications(db, fakeQueue, runId);
    expect(created.length).toBe(2);
    const lateRows = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.endpointId, lateId));
    expect(lateRows.length).toBe(1);
  });

  // ── Routes ──────────────────────────────────────────────────────────────────

  const base = () => `/api/v1/projects/${projectId}/notifications`;

  it("endpoint routes are admin-only", async () => {
    expect((await viewer.request(`${base()}/endpoints`)).status).toBe(403);
    expect(
      (
        await viewer.request(`${base()}/endpoints`, {
          method: "POST",
          json: {
            kind: "generic",
            name: "x",
            url: "https://hooks.example.com/x",
            secret: "12345678",
          },
        })
      ).status,
    ).toBe(403);
  });

  it("rejects a generic endpoint without a secret and a bad URL", async () => {
    const noSecret = await admin.request(`${base()}/endpoints`, {
      method: "POST",
      json: { kind: "generic", name: "unsigned", url: "https://hooks.example.com/x" },
    });
    expect(noSecret.status).toBe(400);

    const badUrl = await admin.request(`${base()}/endpoints`, {
      method: "POST",
      json: { kind: "feishu", name: "wrong host", url: "https://hooks.example.com/x" },
    });
    expect(badUrl.status).toBe(400);
    expect((await jsonOf<{ code: string }>(badUrl)).code).toBe("webhook_url_invalid");
  });

  it("creates a signed endpoint, masks the URL, and never echoes the secret", async () => {
    const res = await admin.request(`${base()}/endpoints`, {
      method: "POST",
      json: {
        kind: "generic",
        name: "ci relay",
        url: "https://hooks.example.com/agrippa/relay/0123456789abcdef",
        secret: "super-secret-value",
        events: ["checkpoint.required"],
      },
    });
    expect(res.status).toBe(201);
    const body = await jsonOf<Record<string, unknown>>(res);
    expect(body.hasSecret).toBe(true);
    expect(body.url).not.toContain("0123456789abcdef");
    expect(JSON.stringify(body)).not.toContain("super-secret-value");

    const [auditRow] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "project.webhook.add"));
    expect(auditRow).toBeDefined();
  });

  it("requires the secret again when the URL changes on a signed endpoint", async () => {
    const list = await jsonOf<Array<{ id: string; name: string; hasSecret: boolean }>>(
      await admin.request(`${base()}/endpoints`),
    );
    const signed = list.find((e) => e.name === "ci relay") as { id: string };
    const urlOnly = await admin.request(`${base()}/endpoints/${signed.id}`, {
      method: "PATCH",
      json: { url: "https://evil.example.com/collector" },
    });
    expect(urlOnly.status).toBe(400);
    expect((await jsonOf<{ code: string }>(urlOnly)).code).toBe("webhook_secret_required");

    const withSecret = await admin.request(`${base()}/endpoints/${signed.id}`, {
      method: "PATCH",
      json: { url: "https://hooks.example.com/agrippa/relay/v2", secret: "rotated-secret-1" },
    });
    expect(withSecret.status).toBe(200);
  });

  it("PATCH resets the activation watermark on re-enable", async () => {
    const list = await jsonOf<Array<{ id: string; name: string }>>(
      await admin.request(`${base()}/endpoints`),
    );
    const target = list.find((e) => e.name === "ci relay") as { id: string };
    const [before] = await db
      .select({ activatedAt: notificationEndpoints.activatedAt })
      .from(notificationEndpoints)
      .where(eq(notificationEndpoints.id, target.id));

    await admin.request(`${base()}/endpoints/${target.id}`, {
      method: "PATCH",
      json: { enabled: false },
    });
    await Bun.sleep(20);
    await admin.request(`${base()}/endpoints/${target.id}`, {
      method: "PATCH",
      json: { enabled: true },
    });

    const [after] = await db
      .select({ activatedAt: notificationEndpoints.activatedAt })
      .from(notificationEndpoints)
      .where(eq(notificationEndpoints.id, target.id));
    expect((after?.activatedAt as Date | undefined)?.getTime() ?? 0).toBeGreaterThan(
      (before?.activatedAt as Date | undefined)?.getTime() ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("PATCH reconfiguration fails still-pending deliveries in the same transaction", async () => {
    const created = await jsonOf<{ id: string }>(
      await admin.request(`${base()}/endpoints`, {
        method: "POST",
        json: {
          kind: "feishu",
          name: "reconfig",
          url: "https://open.feishu.cn/open-apis/bot/v2/hook/original",
        },
      }),
    );
    const { deliveryId } = await jsonOf<{ deliveryId: string }>(
      await admin.request(`${base()}/endpoints/${created.id}/test`, { method: "POST" }),
    );

    // no worker runs in this suite, so the row is still pending when the
    // endpoint's URL changes — it must not survive to fire at the new URL
    const patched = await admin.request(`${base()}/endpoints/${created.id}`, {
      method: "PATCH",
      json: { url: "https://open.feishu.cn/open-apis/bot/v2/hook/replaced" },
    });
    expect(patched.status).toBe(200);

    const [row] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveryId));
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toBe("superseded by endpoint reconfiguration");
  });

  it("test-send creates and enqueues a delivery with no run", async () => {
    const list = await jsonOf<Array<{ id: string; name: string }>>(
      await admin.request(`${base()}/endpoints`),
    );
    const target = list.find((e) => e.name === "ci relay") as { id: string };
    enqueued.length = 0;
    const res = await admin.request(`${base()}/endpoints/${target.id}/test`, { method: "POST" });
    expect(res.status).toBe(202);
    const { deliveryId } = await jsonOf<{ deliveryId: string }>(res);
    expect(enqueued).toContain(deliveryId);
    const [row] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveryId));
    expect(row?.eventType).toBe("notification.test");
    expect(row?.runId).toBeNull();
    expect(row?.eventId).toBeNull();
  });

  it("lists deliveries with endpoint context and filters by status", async () => {
    const rows = await jsonOf<Array<{ eventType: string; endpointName: string | null }>>(
      await admin.request(`${base()}/deliveries?limit=100`),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.eventType === "notification.test")).toBe(true);
    const failed = await jsonOf<Array<{ status: string }>>(
      await admin.request(`${base()}/deliveries?status=failed`),
    );
    expect(failed.every((r) => r.status === "failed")).toBe(true);

    // hostile limits clamp instead of reaching Postgres as LIMIT -5
    expect((await admin.request(`${base()}/deliveries?limit=-5`)).status).toBe(200);
    expect((await admin.request(`${base()}/deliveries?limit=abc`)).status).toBe(200);
  });

  it("retry is CAS: failed retries once, non-failed conflicts", async () => {
    const [row] = await db
      .select({ id: notificationDeliveries.id })
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.status, "failed"));
    const failedId = row?.id as string;
    enqueued.length = 0;
    const ok = await admin.request(`${base()}/deliveries/${failedId}/retry`, { method: "POST" });
    expect(ok.status).toBe(202);
    expect(enqueued).toContain(failedId);
    const [after] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, failedId));
    expect(after?.status).toBe("pending");
    expect(after?.attempts).toBe(0);
    // an immediate retry must not be no-oped by the worker's claim-recency window
    expect(after?.lastAttemptAt).toBeNull();

    const again = await admin.request(`${base()}/deliveries/${failedId}/retry`, { method: "POST" });
    expect(again.status).toBe(409);
    expect((await jsonOf<{ code: string }>(again)).code).toBe("not_retryable");
  });

  it("deleting an endpoint removes its secret in the same transaction", async () => {
    const list = await jsonOf<Array<{ id: string; name: string }>>(
      await admin.request(`${base()}/endpoints`),
    );
    const target = list.find((e) => e.name === "ci relay") as { id: string };
    const [before] = await db
      .select({ secretRef: notificationEndpoints.secretRef })
      .from(notificationEndpoints)
      .where(eq(notificationEndpoints.id, target.id));
    const secretRef = before?.secretRef as string;

    const res = await admin.request(`${base()}/endpoints/${target.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await db.select().from(secrets).where(eq(secrets.id, secretRef))).toEqual([]);
    expect(
      await db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.endpointId, target.id)),
    ).toEqual([]); // deliveries cascade
  });
});
