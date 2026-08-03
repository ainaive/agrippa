import { beforeAll, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import type { RunQueue } from "@agrippa/core";
import {
  TRIGGER_DELIVERY_ID_HEADER,
  TRIGGER_SIGNATURE_HEADER,
  TRIGGER_TIMESTAMP_HEADER,
} from "@agrippa/core";
import {
  auditLogs,
  projectMembers,
  projects,
  runs,
  triggerDeliveries,
  triggerEndpoints,
} from "@agrippa/db";
import { fireTrigger } from "@agrippa/orchestration";
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

type TriggerRow = {
  id: string;
  name: string;
  tokenPrefix: string;
  enabled: boolean;
  disabledReason: string | null;
  token?: string;
};

const SECRET = "a-signing-secret-long-enough";

describe.skipIf(!dbUp)("inbound webhook triggers", () => {
  let app: App;
  let db: Awaited<ReturnType<typeof freshTestDb>>;
  let admin: TestClient;
  let member: TestClient;
  let projectId: string;
  let taskTypeId: string;

  const enqueued: string[] = [];
  const queue: RunQueue = makeFakeQueue({
    enqueueTriggerDelivery: async (id) => {
      enqueued.push(id);
    },
  });

  const params = { dateRange: "2026.07.27-2026.08.02", rawNotes: "notes" };

  /** POST to the public surface, signed the way a real sender would. */
  const send = (
    token: string,
    body: unknown,
    opts: { secret?: string; timestamp?: number; deliveryId?: string; signature?: string } = {},
  ) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
    const sig =
      opts.signature ??
      `v1=${createHmac("sha256", opts.secret ?? SECRET)
        .update(`${ts}.${raw}`)
        .digest("hex")}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [TRIGGER_TIMESTAMP_HEADER]: ts,
      [TRIGGER_SIGNATURE_HEADER]: sig,
    };
    if (opts.deliveryId) headers[TRIGGER_DELIVERY_ID_HEADER] = opts.deliveryId;
    return app.request(`/api/triggers/${token}`, { method: "POST", headers, body: raw });
  };

  const createTrigger = async (over: Record<string, unknown> = {}) =>
    jsonOf<TriggerRow>(
      await admin.request(`/api/v1/projects/${projectId}/triggers`, {
        method: "POST",
        json: { name: `hook-${Math.random()}`, taskTypeId, params, secret: SECRET, ...over },
      }),
    );

  beforeAll(async () => {
    db = await freshTestDb();
    app = createApp({ db, queue });
    admin = await signUp(app, "Root", "root@example.com");
    member = await signUp(app, "Mia", "mia@example.com");
    projectId = (
      await jsonOf<{ id: string }>(
        await admin.request("/api/v1/projects", {
          method: "POST",
          json: { slug: "trig", name: "trig" },
        }),
      )
    ).id;
    const types = await jsonOf<Array<{ id: string; slug: string }>>(
      await admin.request("/api/v1/scenarios/project-management/task-types"),
    );
    taskTypeId = types.find((t) => t.slug === "weekly-report")?.id as string;
  });

  // ── management ─────────────────────────────────────────────────────────────

  it("issues a token once, stores neither it nor the secret in readable form", async () => {
    const created = await createTrigger();
    expect(created.token?.startsWith("agrt_")).toBe(true);
    expect(created.tokenPrefix).toBe(created.token?.slice(0, 12) as string);

    const [stored] = await db
      .select()
      .from(triggerEndpoints)
      .where(eq(triggerEndpoints.id, created.id));
    expect(stored?.tokenHash).not.toContain(created.token as string);
    expect(stored?.secretRef).toBeTruthy();

    const listed = await jsonOf<Array<TriggerRow & { tokenHash?: string; secretRef?: string }>>(
      await admin.request(`/api/v1/projects/${projectId}/triggers`),
    );
    const row = listed.find((r) => r.id === created.id);
    expect(row?.token).toBeUndefined();
    expect(row?.tokenHash).toBeUndefined();
    expect(row?.secretRef).toBeUndefined();
  });

  it("is project-admin gated and rejects params that could never run", async () => {
    expect(
      (
        await member.request(`/api/v1/projects/${projectId}/triggers`, {
          method: "POST",
          json: { name: "nope", taskTypeId, params, secret: SECRET },
        })
      ).status,
    ).toBe(403);

    expect(
      (
        await admin.request(`/api/v1/projects/${projectId}/triggers`, {
          method: "POST",
          json: { name: "empty", taskTypeId, params: {}, secret: SECRET },
        })
      ).status,
    ).toBe(400);

    // an unsigned trigger would be an open "spend tokens" endpoint
    expect(
      (
        await admin.request(`/api/v1/projects/${projectId}/triggers`, {
          method: "POST",
          json: { name: "unsigned", taskTypeId, params },
        })
      ).status,
    ).toBe(400);
  });

  // ── the inbound surface ────────────────────────────────────────────────────

  it("accepts a correctly signed request and records it before acknowledging", async () => {
    const t = await createTrigger();
    const res = await send(t.token as string, { event: "ci.passed" });
    expect(res.status).toBe(202);
    const { deliveryId } = await jsonOf<{ deliveryId: string }>(res);

    const [row] = await db
      .select()
      .from(triggerDeliveries)
      .where(eq(triggerDeliveries.id, deliveryId));
    expect(row?.status).toBe("pending"); // no run yet — that is the worker's job
    expect(row?.payload).toEqual({ event: "ci.passed" });
    expect(enqueued).toContain(deliveryId);
  });

  it("refuses every bad request the same way, so probing learns nothing", async () => {
    const t = await createTrigger();
    const body = { event: "x" };
    const cases: Array<[string, Response | Promise<Response>]> = [
      ["unknown token", send("agrt_deadbeefdead", body)],
      ["wrong secret", send(t.token as string, body, { secret: "a-different-secret-entirely" })],
      ["malformed signature", send(t.token as string, body, { signature: "garbage" })],
      [
        "stale timestamp",
        send(t.token as string, body, { timestamp: Math.floor(Date.now() / 1000) - 3600 }),
      ],
      [
        "future timestamp",
        send(t.token as string, body, { timestamp: Math.floor(Date.now() / 1000) + 3600 }),
      ],
    ];
    for (const [label, p] of cases) {
      const res = await p;
      const json = await jsonOf<{ code: string }>(res);
      expect({ label, status: res.status, code: json.code }).toEqual({
        label,
        status: 401,
        code: "trigger_request_invalid",
      });
    }
  });

  it("signs over the exact bytes sent, not a re-serialization", async () => {
    const t = await createTrigger();
    // same JSON, different byte order — a signature over re-serialized JSON
    // would wrongly accept this
    const raw = '{"b":2,"a":1}';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v1=${createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex")}`;
    const res = await app.request(`/api/triggers/${t.token}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TRIGGER_TIMESTAMP_HEADER]: ts,
        [TRIGGER_SIGNATURE_HEADER]: sig,
      },
      body: raw,
    });
    expect(res.status).toBe(202);
  });

  it("rejects a disabled trigger indistinguishably from a wrong token", async () => {
    const t = await createTrigger();
    await admin.request(`/api/v1/projects/${projectId}/triggers/${t.id}`, {
      method: "PATCH",
      json: { enabled: false },
    });
    const res = await send(t.token as string, { event: "x" });
    expect(res.status).toBe(401);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("trigger_request_invalid");
  });

  it("deduplicates on the sender's delivery id, so a retry cannot double-submit", async () => {
    const t = await createTrigger();
    const first = await send(t.token as string, { event: "x" }, { deliveryId: "evt-42" });
    expect(first.status).toBe(202);
    const second = await send(t.token as string, { event: "x" }, { deliveryId: "evt-42" });
    expect(second.status).toBe(200);
    expect((await jsonOf<{ deduplicated: boolean }>(second)).deduplicated).toBe(true);

    const rows = await db
      .select()
      .from(triggerDeliveries)
      .where(eq(triggerDeliveries.externalId, "evt-42"));
    expect(rows).toHaveLength(1);
  });

  it("caps the payload size", async () => {
    const t = await createTrigger();
    const res = await send(t.token as string, { blob: "x".repeat(70_000) });
    expect(res.status).toBe(413);
  });

  // ── firing ─────────────────────────────────────────────────────────────────

  it("submits the run, attributed to the trigger's owner", async () => {
    const t = await createTrigger();
    const { deliveryId } = await jsonOf<{ deliveryId: string }>(
      await send(t.token as string, { event: "ci.passed" }),
    );
    const outcome = await fireTrigger(db, queue, deliveryId);
    expect(outcome.kind).toBe("submitted");

    const [row] = await db
      .select()
      .from(triggerDeliveries)
      .where(eq(triggerDeliveries.id, deliveryId));
    expect(row?.status).toBe("succeeded");
    expect(row?.runId).toBeTruthy();
    expect(row?.attempts).toBe(1);
  });

  it("resolves date tokens at fire time, so a token never reaches the agent literally", async () => {
    // creation validates the RESOLVED parameters, so it accepts a token —
    // firing therefore has to resolve one too, or the prompt gets "{{...}}"
    const t = await createTrigger({
      params: { ...params, dateRange: "{{lastWeekStart}}..{{lastWeekEnd}}" },
      timezone: "Asia/Shanghai",
    });
    const { deliveryId } = await jsonOf<{ deliveryId: string }>(
      await send(t.token as string, { event: "x" }),
    );
    expect((await fireTrigger(db, queue, deliveryId)).kind).toBe("submitted");

    const [d] = await db
      .select()
      .from(triggerDeliveries)
      .where(eq(triggerDeliveries.id, deliveryId));
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, d?.runId as string));
    const snapshot = run?.paramsSnapshot as { dateRange: string };
    expect(snapshot.dateRange).toMatch(/^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/);
    // the stored parameter keeps the token; only the run carries dates
    const [stored] = await db.select().from(triggerEndpoints).where(eq(triggerEndpoints.id, t.id));
    expect(stored?.params).toMatchObject({ dateRange: "{{lastWeekStart}}..{{lastWeekEnd}}" });
  });

  it("never submits the same delivery twice, however often the job is redelivered", async () => {
    const t = await createTrigger();
    const { deliveryId } = await jsonOf<{ deliveryId: string }>(
      await send(t.token as string, { event: "x" }),
    );
    expect((await fireTrigger(db, queue, deliveryId)).kind).toBe("submitted");
    const [first] = await db
      .select()
      .from(triggerDeliveries)
      .where(eq(triggerDeliveries.id, deliveryId));

    expect(await fireTrigger(db, queue, deliveryId)).toEqual({
      kind: "skipped",
      reason: "already_handled",
    });
    const [second] = await db
      .select()
      .from(triggerDeliveries)
      .where(eq(triggerDeliveries.id, deliveryId));
    expect(second?.runId).toBe(first?.runId as string);
  });

  it("disables the trigger when its owner loses project access", async () => {
    const owner = await signUp(app, "Sam", "sam-trig@example.com");
    await admin.request(`/api/v1/projects/${projectId}/members`, {
      method: "POST",
      json: { email: owner.email, role: "admin" },
    });
    const t = await jsonOf<TriggerRow>(
      await owner.request(`/api/v1/projects/${projectId}/triggers`, {
        method: "POST",
        json: { name: "sams-hook", taskTypeId, params, secret: SECRET },
      }),
    );
    const { deliveryId } = await jsonOf<{ deliveryId: string }>(
      await send(t.token as string, { event: "x" }),
    );

    const [row] = await db.select().from(triggerEndpoints).where(eq(triggerEndpoints.id, t.id));
    await db
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, row?.createdBy as string),
        ),
      );

    expect(await fireTrigger(db, queue, deliveryId)).toEqual({
      kind: "disabled",
      reason: "owner_lost_access",
    });
    const [after] = await db.select().from(triggerEndpoints).where(eq(triggerEndpoints.id, t.id));
    expect(after?.enabled).toBe(false);
    expect(after?.disabledReason).toBe("owner_lost_access");

    const [logged] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "trigger.disabled"), eq(auditLogs.resourceId, t.id)));
    expect(logged).toBeDefined();
  });

  it("disables when the project is archived", async () => {
    const other = (
      await jsonOf<{ id: string }>(
        await admin.request("/api/v1/projects", {
          method: "POST",
          json: { slug: "trig-arch", name: "trig-arch" },
        }),
      )
    ).id;
    const t = await jsonOf<TriggerRow>(
      await admin.request(`/api/v1/projects/${other}/triggers`, {
        method: "POST",
        json: { name: "doomed", taskTypeId, params, secret: SECRET },
      }),
    );
    const { deliveryId } = await jsonOf<{ deliveryId: string }>(
      await send(t.token as string, { event: "x" }),
    );
    await db.update(projects).set({ status: "archived" }).where(eq(projects.id, other));

    expect(await fireTrigger(db, queue, deliveryId)).toEqual({
      kind: "disabled",
      reason: "project_archived",
    });
  });

  // ── delivery log ───────────────────────────────────────────────────────────

  it("exposes the delivery log and replays only failed deliveries", async () => {
    const t = await createTrigger();
    const { deliveryId } = await jsonOf<{ deliveryId: string }>(
      await send(t.token as string, { event: "inspect-me" }),
    );

    const log = await jsonOf<Array<{ id: string; payload: unknown; status: string }>>(
      await admin.request(`/api/v1/projects/${projectId}/triggers/deliveries`),
    );
    const entry = log.find((d) => d.id === deliveryId);
    expect(entry?.payload).toEqual({ event: "inspect-me" });

    // pending is not retryable — only a failed one is
    expect(
      (
        await admin.request(
          `/api/v1/projects/${projectId}/triggers/deliveries/${deliveryId}/retry`,
          { method: "POST" },
        )
      ).status,
    ).toBe(409);

    await db
      .update(triggerDeliveries)
      .set({ status: "failed", lastError: "quota_exhausted" })
      .where(eq(triggerDeliveries.id, deliveryId));
    const retried = await admin.request(
      `/api/v1/projects/${projectId}/triggers/deliveries/${deliveryId}/retry`,
      { method: "POST" },
    );
    expect(retried.status).toBe(200);
    expect(enqueued.filter((id) => id === deliveryId).length).toBeGreaterThan(1);
  });
});
