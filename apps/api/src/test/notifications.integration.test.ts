import { beforeAll, describe, expect, it } from "bun:test";
import type { RunQueue } from "@agrippa/core";
import { notificationDeliveries, notificationEndpoints, repoConnections } from "@agrippa/db";
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
});
