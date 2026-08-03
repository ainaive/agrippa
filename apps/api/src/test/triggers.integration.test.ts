import { beforeAll, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import type { RunQueue } from "@agrippa/core";
import {
  TRIGGER_DELIVERY_ID_HEADER,
  TRIGGER_DELIVERY_ID_MAX_LENGTH,
  TRIGGER_SIGNATURE_HEADER,
  TRIGGER_TIMESTAMP_HEADER,
} from "@agrippa/core";
import {
  auditLogs,
  notificationEndpoints,
  projectMembers,
  projects,
  runs,
  secrets,
  taskTypes,
  triggerDeliveries,
  triggerEndpoints,
} from "@agrippa/db";
import { fireTrigger, sweepTriggerDeliveries } from "@agrippa/orchestration";
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
    // `!== undefined`, not truthiness: an EMPTY delivery id is precisely the
    // case worth testing, and `if (opts.deliveryId)` silently dropped it —
    // which is why the bug it covers survived two review rounds
    if (opts.deliveryId !== undefined) headers[TRIGGER_DELIVERY_ID_HEADER] = opts.deliveryId;
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

  // ── review round 1 regressions ─────────────────────────────────────────────

  it("does not report failure when the post-commit enqueue fails (the run exists)", async () => {
    // the sweeper is the delivery guarantee, so a send failure must not look
    // like a submission failure — reporting one invites a retry that submits
    // a SECOND run while the first is still swept up and executed
    const t = await createTrigger();
    const { deliveryId } = await jsonOf<{ deliveryId: string }>(
      await send(t.token as string, { event: "x" }),
    );
    const brokenQueue = makeFakeQueue({
      enqueueRun: async () => {
        throw new Error("queue is down");
      },
    });
    const outcome = await fireTrigger(db, brokenQueue, deliveryId);
    expect(outcome.kind).toBe("submitted");

    const [row] = await db
      .select()
      .from(triggerDeliveries)
      .where(eq(triggerDeliveries.id, deliveryId));
    expect(row?.status).toBe("succeeded");
    expect(row?.runId).toBeTruthy();
  });

  it("submits once when two firings race the same delivery", async () => {
    const t = await createTrigger();
    const { deliveryId } = await jsonOf<{ deliveryId: string }>(
      await send(t.token as string, { event: "x" }),
    );
    // concurrent, not sequential: only an atomic claim survives this
    const outcomes = await Promise.all([
      fireTrigger(db, queue, deliveryId),
      fireTrigger(db, queue, deliveryId),
    ]);
    expect(outcomes.filter((o) => o.kind === "submitted")).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === "skipped")).toHaveLength(1);

    const rows = await db
      .select()
      .from(triggerDeliveries)
      .where(eq(triggerDeliveries.id, deliveryId));
    expect(rows[0]?.status).toBe("succeeded");
  });

  it("re-enqueues a stranded pending delivery instead of leaving it unreachable", async () => {
    const t = await createTrigger();
    const { deliveryId } = await jsonOf<{ deliveryId: string }>(
      await send(t.token as string, { event: "x" }),
    );
    // pretend the enqueue was lost and the row aged past the stale threshold
    await db
      .update(triggerDeliveries)
      .set({ createdAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(triggerDeliveries.id, deliveryId));
    enqueued.length = 0;

    await sweepTriggerDeliveries(db, queue);
    expect(enqueued).toContain(deliveryId);
  });

  it("measures attempt age, not row age, so an in-flight delivery is left alone", async () => {
    const t = await createTrigger();
    const { deliveryId } = await jsonOf<{ deliveryId: string }>(
      await send(t.token as string, { event: "x" }),
    );
    // an old row whose attempt is CURRENT: a submit in progress, or one that
    // just retried. Sweeping on row age would re-enqueue it every tick and
    // could stamp it failed underneath the attempt that is still running.
    await db
      .update(triggerDeliveries)
      .set({
        createdAt: new Date(Date.now() - 60 * 60_000),
        lastAttemptAt: new Date(),
        attempts: 8,
      })
      .where(eq(triggerDeliveries.id, deliveryId));
    enqueued.length = 0;

    await sweepTriggerDeliveries(db, queue);
    expect(enqueued).not.toContain(deliveryId);
    const [row] = await db
      .select()
      .from(triggerDeliveries)
      .where(eq(triggerDeliveries.id, deliveryId));
    expect(row?.status).toBe("pending"); // not stamped failed mid-flight
  });

  it("fails a delivery that has burned its attempts, so Retry becomes reachable", async () => {
    const t = await createTrigger();
    const { deliveryId } = await jsonOf<{ deliveryId: string }>(
      await send(t.token as string, { event: "x" }),
    );
    await db
      .update(triggerDeliveries)
      .set({
        attempts: 8,
        createdAt: new Date(Date.now() - 5 * 60_000),
        lastAttemptAt: new Date(Date.now() - 5 * 60_000),
      })
      .where(eq(triggerDeliveries.id, deliveryId));

    await sweepTriggerDeliveries(db, queue);
    const [row] = await db
      .select()
      .from(triggerDeliveries)
      .where(eq(triggerDeliveries.id, deliveryId));
    expect(row?.status).toBe("failed");
  });

  it("re-enqueues on a duplicate delivery id whose original never got its job", async () => {
    const t = await createTrigger();
    const first = await jsonOf<{ deliveryId: string }>(
      await send(t.token as string, { event: "x" }, { deliveryId: "evt-stranded" }),
    );
    enqueued.length = 0;
    const second = await send(t.token as string, { event: "x" }, { deliveryId: "evt-stranded" });
    expect(second.status).toBe(200);
    // still one row, but the sender's retry unsticks it rather than 200-ing
    // into a delivery that no job and no UI action can reach
    expect(enqueued).toContain(first.deliveryId);
    const rows = await db
      .select()
      .from(triggerDeliveries)
      .where(eq(triggerDeliveries.externalId, "evt-stranded"));
    expect(rows).toHaveLength(1);
  });

  it("rejects an oversized body with no Content-Length, and a junk one", async () => {
    const t = await createTrigger();
    const big = "x".repeat(70_000);
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ blob: big });
    const sig = `v1=${createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex")}`;

    // a chunked body has no Content-Length at all
    const chunked = await app.request(`/api/triggers/${t.token}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TRIGGER_TIMESTAMP_HEADER]: ts,
        [TRIGGER_SIGNATURE_HEADER]: sig,
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }),
      // required by fetch for a stream body
      duplex: "half",
    });
    expect(chunked.status).toBe(413);

    // Number("abc") is NaN and NaN > limit is false — a junk header must not
    // become a way past the check
    const junk = await app.request(`/api/triggers/${t.token}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "not-a-number",
        [TRIGGER_TIMESTAMP_HEADER]: ts,
        [TRIGGER_SIGNATURE_HEADER]: sig,
      },
      body,
    });
    expect(junk.status).toBe(413);
  });

  it("deletes the signing secret with the trigger", async () => {
    const t = await createTrigger();
    const [row] = await db.select().from(triggerEndpoints).where(eq(triggerEndpoints.id, t.id));
    const secretId = row?.secretRef as string;
    expect(await db.select().from(secrets).where(eq(secrets.id, secretId))).toHaveLength(1);

    await admin.request(`/api/v1/projects/${projectId}/triggers/${t.id}`, { method: "DELETE" });
    // no orphaned key material: nothing else references it, so nothing would
    // ever reap it
    expect(await db.select().from(secrets).where(eq(secrets.id, secretId))).toHaveLength(0);
  });

  // ── review round 2 regressions ─────────────────────────────────────────────

  it("commits the run and its bookkeeping together, so a crash cannot duplicate", async () => {
    const t = await createTrigger();
    const { deliveryId } = await jsonOf<{ deliveryId: string }>(
      await send(t.token as string, { event: "x" }),
    );
    const runsBefore = (await db.select().from(runs)).length;

    // make the delivery's success write fail INSIDE the transaction
    await db.execute(
      `alter table trigger_deliveries add constraint tmp_block_succeeded
       check (status <> 'succeeded') not valid`,
    );
    try {
      // the bookkeeping write fails, so the whole submission rolls back with
      // it: no orphan run for a retry to duplicate, which is the
      // duplicate-charge path
      expect((await fireTrigger(db, queue, deliveryId)).kind).toBe("failed");
      expect((await db.select().from(runs)).length).toBe(runsBefore);
    } finally {
      await db.execute(`alter table trigger_deliveries drop constraint tmp_block_succeeded`);
    }

    // and once the write can land, exactly one run appears
    await db
      .update(triggerDeliveries)
      .set({ status: "pending", attempts: 0, lastAttemptAt: null })
      .where(eq(triggerDeliveries.id, deliveryId));
    expect((await fireTrigger(db, queue, deliveryId)).kind).toBe("submitted");
    expect((await db.select().from(runs)).length).toBe(runsBefore + 1);
  });

  it("still answers 202 when the inbound enqueue fails", async () => {
    const t = await createTrigger();
    const brokenApp = createApp({
      db,
      queue: makeFakeQueue({
        enqueueTriggerDelivery: async () => {
          throw new Error("queue is down");
        },
      }),
    });
    const raw = JSON.stringify({ event: "x" });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v1=${createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex")}`;
    const res = await brokenApp.request(`/api/triggers/${t.token}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TRIGGER_TIMESTAMP_HEADER]: ts,
        [TRIGGER_SIGNATURE_HEADER]: sig,
      },
      body: raw,
    });
    // a 500 would make the sender retry, and without a delivery-id header that
    // retry inserts a SECOND delivery and produces a second run
    expect(res.status).toBe(202);
  });

  it("keeps the delivery pending when trigger.failed cannot be announced", async () => {
    // `failed` is what makes the retry's claim reject, so it must not commit
    // without the announcement that no sweeper can reconstruct
    await db.insert(notificationEndpoints).values({
      projectId,
      kind: "generic",
      name: "blocker-trig",
      url: "https://example.com/blocked",
      events: [],
      createdBy: (await db.select().from(triggerEndpoints).limit(1))[0]?.createdBy as string,
    });
    const t = await createTrigger({ params: { dateRange: "x", rawNotes: "y" } });
    // make submission fail so we reach the catch path
    await db.update(taskTypes).set({ enabled: false }).where(eq(taskTypes.id, taskTypeId));
    const { deliveryId } = await jsonOf<{ deliveryId: string }>(
      await send(t.token as string, { event: "x" }),
    );
    await db.update(taskTypes).set({ enabled: true }).where(eq(taskTypes.id, taskTypeId));

    await db.execute(
      `alter table notification_deliveries add constraint tmp_block_trigger_failed
       check (event_type <> 'trigger.failed') not valid`,
    );
    try {
      await db
        .update(triggerEndpoints)
        .set({ params: { nope: 1 } })
        .where(eq(triggerEndpoints.id, t.id));
      await expect(fireTrigger(db, queue, deliveryId)).rejects.toThrow();
      const [row] = await db
        .select()
        .from(triggerDeliveries)
        .where(eq(triggerDeliveries.id, deliveryId));
      expect(row?.status).toBe("pending"); // rolled back, so the retry still has work
    } finally {
      await db.execute(
        `alter table notification_deliveries drop constraint tmp_block_trigger_failed`,
      );
    }
  });

  it("a retried delivery survives a sweep and is not immediately re-failed", async () => {
    const t = await createTrigger();
    const { deliveryId } = await jsonOf<{ deliveryId: string }>(
      await send(t.token as string, { event: "x" }),
    );
    // the exhausted state Retry exists to rescue
    await db
      .update(triggerDeliveries)
      .set({
        status: "failed",
        attempts: 8,
        lastError: "the real error",
        lastAttemptAt: new Date(Date.now() - 5 * 60_000),
      })
      .where(eq(triggerDeliveries.id, deliveryId));

    const res = await admin.request(
      `/api/v1/projects/${projectId}/triggers/deliveries/${deliveryId}/retry`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);

    await sweepTriggerDeliveries(db, queue);
    const [row] = await db
      .select()
      .from(triggerDeliveries)
      .where(eq(triggerDeliveries.id, deliveryId));
    // without the attempts reset the sweeper re-fails it instantly, and
    // attempts only ever climb, so it could never escape
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(0);
  });

  it("refuses to retry a delivery that already produced a run", async () => {
    const t = await createTrigger();
    const { deliveryId } = await jsonOf<{ deliveryId: string }>(
      await send(t.token as string, { event: "x" }),
    );
    await fireTrigger(db, queue, deliveryId);
    // a failure recorded after the run committed would otherwise let one click
    // charge the project a second time
    await db
      .update(triggerDeliveries)
      .set({ status: "failed" })
      .where(eq(triggerDeliveries.id, deliveryId));
    const res = await admin.request(
      `/api/v1/projects/${projectId}/triggers/deliveries/${deliveryId}/retry`,
      { method: "POST" },
    );
    expect(res.status).toBe(409);
  });

  it("verifies a signature over bytes that are not valid UTF-8", async () => {
    const t = await createTrigger();
    // a lone 0xFF is not valid UTF-8; a decode-then-hash turns it into U+FFFD
    // and the signature can never match
    const body = Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v1=${createHmac("sha256", SECRET).update(`${ts}.`).update(body).digest("hex")}`;
    const res = await app.request(`/api/triggers/${t.token}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TRIGGER_TIMESTAMP_HEADER]: ts,
        [TRIGGER_SIGNATURE_HEADER]: sig,
      },
      body,
    });
    expect(res.status).toBe(202);
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

  // ── review round 3 regressions ─────────────────────────────────────────────

  it("treats a blank delivery id as absent rather than as one shared key", async () => {
    // `Headers.get` returns "" for a present-but-empty header, and "" is not
    // null — so the partial dedupe index stored and matched it. Every request
    // from the endpoint collapsed onto ONE delivery, and once that row
    // succeeded every later webhook was answered `200 accepted` and ran
    // nothing at all. A templating bug resolving empty is all it took.
    const trigger = await createTrigger();
    const first = await send(trigger.token as string, { event: "a" }, { deliveryId: "" });
    const second = await send(trigger.token as string, { event: "b" }, { deliveryId: "   " });

    expect([first.status, second.status]).toEqual([202, 202]);
    const a = await jsonOf<{ deliveryId: string }>(first);
    const b = await jsonOf<{ deliveryId: string }>(second);
    expect(a.deliveryId).not.toBe(b.deliveryId);

    const rows = await db
      .select()
      .from(triggerDeliveries)
      .where(eq(triggerDeliveries.endpointId, trigger.id));
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.externalId === null)).toBe(true);
  });

  it("rejects an over-long delivery id instead of truncating it into a collision", async () => {
    // truncation rewrites the sender's idempotency key into a different one,
    // so two distinct events sharing a prefix silently became one delivery —
    // the second's payload discarded behind `200 {accepted: true}`
    const trigger = await createTrigger();
    const long = `evt-${"x".repeat(TRIGGER_DELIVERY_ID_MAX_LENGTH)}`;
    const res = await send(trigger.token as string, { event: "a" }, { deliveryId: long });
    expect(res.status).toBe(400);

    // and nothing was stored under a rewritten key
    const rows = await db
      .select()
      .from(triggerDeliveries)
      .where(eq(triggerDeliveries.endpointId, trigger.id));
    expect(rows.length).toBe(0);
  });

  it("acknowledges the sender without waiting for the queue", async () => {
    // enqueueAfterCommit bounds failure, never latency, and pg-boss's pool
    // waits indefinitely for a connection. Awaiting it meant a stalled
    // database held the ack open until Bun's idleTimeout killed the socket —
    // a connection reset, which is the most retry-triggering answer there is,
    // and without a delivery id that retry produces a second run.
    const stalled = createApp({
      db,
      queue: makeFakeQueue({ enqueueTriggerDelivery: () => new Promise<void>(() => {}) }),
    });
    const trigger = await createTrigger();
    const raw = JSON.stringify({ event: "stalled" });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await Promise.race([
      stalled.request(`/api/triggers/${trigger.token}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TRIGGER_TIMESTAMP_HEADER]: ts,
          [TRIGGER_SIGNATURE_HEADER]: `v1=${createHmac("sha256", SECRET)
            .update(`${ts}.${raw}`)
            .digest("hex")}`,
        },
        body: raw,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ack blocked")), 2_000)),
    ]);
    expect(res.status).toBe(202);
    // the row is durable, so the delivery sweeper is what completes it
    const [row] = await db
      .select()
      .from(triggerDeliveries)
      .where(eq(triggerDeliveries.endpointId, trigger.id));
    expect(row?.status).toBe("pending");
  });
});
