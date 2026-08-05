import { beforeAll, describe, expect, it } from "bun:test";
import type { RunQueue } from "@agrippa/core";
import {
  auditLogs,
  dispatchEvents,
  dispatches,
  newRunIdentity,
  orchestrationTemplates,
  projects,
  runSteps,
  runs,
  runtimes,
  tasks,
  taskTypes,
} from "@agrippa/db";
import { InProcessEventBus } from "@agrippa/orchestration";
import { eq, sql } from "drizzle-orm";
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

type RuntimeRow = {
  id: string;
  name: string;
  tokenPrefix: string;
  status: string;
  hostname: string | null;
  executors: Array<{ id: string; envAuthProviders?: string[] }>;
  lastSeenAt: string | null;
  registeredAt: string | null;
  token?: string;
};

describe.skipIf(!dbUp)("runtime daemons: tokens, register, heartbeat", () => {
  let app: App;
  let db: Awaited<ReturnType<typeof freshTestDb>>;
  let admin: TestClient;
  let member: TestClient;
  let runtimeId: string;
  let token: string;

  const fakeQueue: RunQueue = makeFakeQueue();

  const daemonRequest = (path: string, body: unknown, auth = token) =>
    app.request(`/api/daemon${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    db = await freshTestDb();
    app = createApp({ db, queue: fakeQueue, bus: new InProcessEventBus() });
    admin = await signUp(app, "Root", "root@example.com");
    member = await signUp(app, "Mia", "mia@example.com");
  });

  it("issues a token exactly once, hash-only at rest, admin-gated", async () => {
    expect(
      (await member.request("/api/v1/runtimes", { method: "POST", json: { name: "laptop" } }))
        .status,
    ).toBe(403);

    const created = await jsonOf<RuntimeRow>(
      await admin.request("/api/v1/runtimes", { method: "POST", json: { name: "dev-laptop" } }),
    );
    runtimeId = created.id;
    token = created.token as string;
    expect(token.startsWith("agrd_")).toBe(true);
    expect(created.tokenPrefix).toBe(token.slice(0, 12));

    // hash-only at rest; the list never returns the token again
    const [row] = await db.select().from(runtimes).where(eq(runtimes.id, runtimeId));
    expect(row?.tokenHash).not.toContain(token.slice(5));
    const listed = await jsonOf<RuntimeRow[]>(await admin.request("/api/v1/runtimes"));
    expect(listed[0]?.token).toBeUndefined();
    expect(listed[0]?.registeredAt).toBeNull();

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "runtime.create"));
    expect(audits).toHaveLength(1);
  });

  it("register authenticates by token, records the advertisement, audits with the runtime actor", async () => {
    expect(
      (await daemonRequest("/register", { hostname: "x", executors: [] }, "agrd_wrong")).status,
    ).toBe(401);
    expect(
      (await daemonRequest("/register", { hostname: "x", executors: [] }, "not-a-token")).status,
    ).toBe(401);

    const res = await daemonRequest("/register", {
      hostname: "mba.local",
      version: "0.1.0",
      executors: [{ id: "claude-agent-sdk", envAuthProviders: ["anthropic"] }],
      features: ["workspace-key", "some-future-thing"],
    });
    expect(res.status).toBe(200);
    const body = await jsonOf<{ runtimeId: string; hints: { keepaliveSec: number } }>(res);
    expect(body.runtimeId).toBe(runtimeId);
    expect(body.hints.keepaliveSec).toBeGreaterThan(0);

    const [row] = await db.select().from(runtimes).where(eq(runtimes.id, runtimeId));
    expect(row?.hostname).toBe("mba.local");
    expect(row?.registeredAt).not.toBeNull();
    expect(row?.lastSeenAt).not.toBeNull();
    expect(row?.executors.map((e) => e.id)).toEqual(["claude-agent-sdk"]);
    // stored verbatim, unknown members included: a newer daemon claiming
    // something this server has not heard of is forward compatibility
    expect(row?.features).toEqual(["workspace-key", "some-future-thing"]);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "runtime.register"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorRuntimeId).toBe(runtimeId);
    expect(audits[0]?.actorUserId).toBeNull();

    // an older daemon omits the field entirely and registers fine — it simply
    // claims nothing, and work that depends on a claim is refused there
    await daemonRequest("/register", {
      hostname: "mba.local",
      executors: [{ id: "claude-agent-sdk" }],
    });
    const [older] = await db.select().from(runtimes).where(eq(runtimes.id, runtimeId));
    expect(older?.features).toEqual([]);
  });

  it("register rejects queue-unsafe and non-catalog executor ids", async () => {
    // advertised ids become pg-boss queue name segments on every worker — an
    // unconstrained id would crash queue creation fleet-wide, and each FRESH
    // pattern-valid id would mint persistent queues (rotation), so ids must
    // also be catalog members
    // "constructor" is the prototype-chain trap: all-lowercase, passes the
    // charset regex, and `in EXECUTOR_CATALOG` would have admitted it
    for (const id of [
      "evil+name",
      "has space",
      "Dot.ted",
      "UPPER",
      "not-a-real-executor",
      "constructor",
    ]) {
      const res = await daemonRequest("/register", {
        hostname: "mba.local",
        executors: [{ id }],
      });
      expect(res.status).toBe(400);
    }
  });

  it("heartbeat bumps lastSeenAt and is not audited", async () => {
    const [before] = await db.select().from(runtimes).where(eq(runtimes.id, runtimeId));
    await Bun.sleep(10);
    expect((await daemonRequest("/heartbeat", {})).status).toBe(200);
    const [after] = await db.select().from(runtimes).where(eq(runtimes.id, runtimeId));
    expect(after?.lastSeenAt?.getTime()).toBeGreaterThan(before?.lastSeenAt?.getTime() ?? 0);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.resourceType, "runtime"));
    expect([...new Set(audits.map((a) => a.action))].sort()).toEqual([
      "runtime.create",
      "runtime.register",
    ]);
  });

  it("revoke kills the token immediately", async () => {
    const revoked = await jsonOf<RuntimeRow>(
      await admin.request(`/api/v1/runtimes/${runtimeId}/revoke`, { method: "POST" }),
    );
    expect(revoked.status).toBe("revoked");
    expect((await daemonRequest("/heartbeat", {})).status).toBe(401);
    // revoking again 404s (CAS on active)
    expect(
      (await admin.request(`/api/v1/runtimes/${runtimeId}/revoke`, { method: "POST" })).status,
    ).toBe(404);
  });
});

describe.skipIf(!dbUp)("dispatch protocol: claim, events, artifacts, terminal", () => {
  let app: App;
  let db: Awaited<ReturnType<typeof freshTestDb>>;
  let admin: TestClient;
  let token: string;
  let otherToken: string;
  let runtimeId: string;
  let runId: string;
  let stepCounter = 0;

  const fakeQueue: RunQueue = makeFakeQueue();

  const daemonPost = (path: string, body: unknown, auth = token) =>
    app.request(`/api/daemon${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
      body: JSON.stringify(body),
    });
  const daemonClaim = (auth = token) =>
    app.request("/api/daemon/claim?wait=0", {
      headers: { authorization: `Bearer ${auth}` },
    });

  /** Fresh step row + pending dispatch addressed to our runtime. */
  const newDispatch = async (): Promise<string> => {
    stepCounter += 1;
    const [step] = await db
      .insert(runSteps)
      .values({
        runId,
        phaseId: "phase",
        stepId: `step-${stepCounter}`,
        iteration: 1,
        attempt: 1,
        seq: stepCounter,
        status: "running",
      })
      .returning();
    const [dispatch] = await db
      .insert(dispatches)
      .values({
        runId,
        stepRowId: step?.id as string,
        runtimeId,
        payload: { request: { stepId: `step-${stepCounter}` }, workspace: null, skills: [] },
      })
      .returning();
    return dispatch?.id as string;
  };

  beforeAll(async () => {
    db = await freshTestDb();
    app = createApp({ db, queue: fakeQueue, bus: new InProcessEventBus() });
    admin = await signUp(app, "Root", "root@example.com");

    const created = await jsonOf<{ id: string; token: string }>(
      await admin.request("/api/v1/runtimes", { method: "POST", json: { name: "d1" } }),
    );
    runtimeId = created.id;
    token = created.token;
    otherToken = (
      await jsonOf<{ token: string }>(
        await admin.request("/api/v1/runtimes", { method: "POST", json: { name: "d2" } }),
      )
    ).token;

    // minimal run fixture for the dispatch FKs (bindings/steps are irrelevant here)
    const orgRows = (await db.execute(sql`select id from orgs limit 1`)) as Array<{ id: string }>;
    const orgId = orgRows[0]?.id as string;
    const userRows = (await db.execute(sql`select id from users limit 1`)) as Array<{
      id: string;
    }>;
    const userId = userRows[0]?.id as string;
    const [project] = await db
      .insert(projects)
      .values({ orgId, slug: "disp", name: "Dispatch", createdBy: userId })
      .returning();
    const [head] = await db
      .select()
      .from(orchestrationTemplates)
      .where(eq(orchestrationTemplates.slug, "swdev.bug-localize-fix"));
    const [taskType] = await db
      .select()
      .from(taskTypes)
      .where(eq(taskTypes.templateId, head?.id as string));
    const [task] = await db
      .insert(tasks)
      .values({
        orgId,
        projectId: project?.id as string,
        taskTypeId: taskType?.id as string,
        title: "dispatch fixture",
        params: {},
        createdBy: userId,
      })
      .returning();
    const [run] = await db
      .insert(runs)
      .values({
        ...newRunIdentity(),
        taskId: task?.id as string,
        projectId: project?.id as string,
        number: 1,
        templateVersionId: head?.latestPublishedVersionId as string,
        faberId: taskType?.defaultFaberId as string,
        executorId: "fake",
        paramsSnapshot: {},
        modelResolution: {},
        createdBy: userId,
      })
      .returning();
    runId = run?.id as string;
  });

  it("names this runtime's spent workspaces — and only once the whole chain released", async () => {
    // Affinity gives the daemon a run's workspace for the run's whole life, so
    // only the server — where the engine finalizes, even for a remote executor
    // — can say when the directory is spent. Without this every remote run
    // leaves a clone on the daemon host permanently.
    const pinned = await jsonOf<{ reapableWorkspaceKeys?: string[] }>(await daemonClaim());
    expect(pinned.reapableWorkspaceKeys ?? []).not.toContain(runId);

    // Released, and the window passed: now the directory is spent.
    await db
      .update(runs)
      .set({
        runtimeId,
        status: "succeeded",
        finishedAt: sql`now()`,
        workspaceExpiresAt: sql`now() + interval '1 hour'`,
      })
      .where(eq(runs.id, runId));
    const withinWindow = await jsonOf<{ reapableWorkspaceKeys?: string[] }>(await daemonClaim());
    expect(withinWindow.reapableWorkspaceKeys ?? []).not.toContain(runId);

    await db
      .update(runs)
      .set({ workspaceExpiresAt: sql`now() - interval '1 minute'` })
      .where(eq(runs.id, runId));
    const done = await jsonOf<{ reapableWorkspaceKeys?: string[] }>(await daemonClaim());
    expect(done.reapableWorkspaceKeys).toContain(runId);

    // A finished run with NO expiry counts as released too — it either
    // predates retention (the engine deleted its workspace on the spot) or
    // lost the release write, and both must reclaim rather than leak forever.
    await db.update(runs).set({ workspaceExpiresAt: null }).where(eq(runs.id, runId));
    const legacy = await jsonOf<{ reapableWorkspaceKeys?: string[] }>(await daemonClaim());
    expect(legacy.reapableWorkspaceKeys).toContain(runId);

    // never another runtime's
    const foreign = await jsonOf<{ reapableWorkspaceKeys?: string[] }>(
      await daemonClaim(otherToken),
    );
    expect(foreign.reapableWorkspaceKeys ?? []).not.toContain(runId);

    // A follow-up sharing the key holds the whole workspace: eligibility is a
    // property of the GROUP, so one live run keeps the directory even though
    // its ancestor released long ago. Reaping here would not cost a re-clone —
    // it would silently drop the completed steps' work.
    const [followup] = await db
      .insert(runs)
      .values({
        ...newRunIdentity(),
        workspaceKey: runId, // inherited
        kind: "followup",
        parentRunId: runId,
        taskId: (await db.select().from(runs).where(eq(runs.id, runId)))[0]?.taskId as string,
        projectId: (await db.select().from(runs).where(eq(runs.id, runId)))[0]?.projectId as string,
        number: 2,
        templateVersionId: (await db.select().from(runs).where(eq(runs.id, runId)))[0]
          ?.templateVersionId as string,
        faberId: (await db.select().from(runs).where(eq(runs.id, runId)))[0]?.faberId as string,
        executorId: "fake",
        paramsSnapshot: {},
        modelResolution: {},
        runtimeId,
        createdBy: (await db.select().from(runs).where(eq(runs.id, runId)))[0]?.createdBy as string,
      })
      .returning();
    const held = await jsonOf<{ reapableWorkspaceKeys?: string[] }>(await daemonClaim());
    expect(held.reapableWorkspaceKeys ?? []).not.toContain(runId);

    // and it is collectable again once the follow-up releases too
    await db
      .update(runs)
      .set({ workspaceExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(runs.id, followup?.id as string));
    const collectable = await jsonOf<{ reapableWorkspaceKeys?: string[] }>(await daemonClaim());
    expect(collectable.reapableWorkspaceKeys).toContain(runId);
    await db.delete(runs).where(eq(runs.id, followup?.id as string));
    await db.update(runs).set({ workspaceExpiresAt: null }).where(eq(runs.id, runId));
  });

  it("claim is atomic, oldest-first, and scoped to the runtime", async () => {
    // empty poll answers 200 with a null dispatch (the abort piggyback rides it)
    const empty = await jsonOf<{ dispatch: null; abortedDispatchIds: string[] }>(
      await daemonClaim(),
    );
    expect(empty.dispatch).toBeNull();

    const first = await newDispatch();
    const second = await newDispatch();

    // another runtime's claim must never see our dispatches
    const foreign = await jsonOf<{ dispatch: null }>(await daemonClaim(otherToken));
    expect(foreign.dispatch).toBeNull();

    // two concurrent claims: each takes a DIFFERENT dispatch, oldest first
    const [a, b] = await Promise.all([daemonClaim(), daemonClaim()]);
    const ra = await jsonOf<{
      dispatch: { id: string; payload: { request: { stepId?: string } } } | null;
    }>(a);
    const rb = await jsonOf<{ dispatch: { id: string } | null }>(b);
    // the payload must arrive as an OBJECT: drizzle stores jsonb as a
    // JSON-encoded string with this driver, and the claim route's raw-SQL
    // read must parse that extra layer or the daemon receives a string
    expect(typeof ra.dispatch?.payload).toBe("object");
    expect(ra.dispatch?.payload.request.stepId).toMatch(/^step-/);
    const takenIds = [ra.dispatch?.id, rb.dispatch?.id];
    expect(new Set(takenIds).size).toBe(2);
    expect(takenIds).toContain(first);
    expect(takenIds).toContain(second);

    const [row] = await db.select().from(dispatches).where(eq(dispatches.id, first));
    expect(row?.status).toBe("claimed");
    expect(row?.lastContactAt).not.toBeNull();
  });

  it("re-offers an orphaned claim (lost response, no events) to its own runtime", async () => {
    // The claim UPDATE can commit while the response socket dies — the daemon
    // never learns it holds the dispatch. With zero events and stale contact,
    // the next poll from the SAME runtime must get it back instead of the
    // deadman burning an attempt 120s later.
    const id = await newDispatch();
    const got = await jsonOf<{ dispatch: { id: string } | null }>(await daemonClaim());
    expect(got.dispatch?.id).toBe(id);

    // fresh contact (keepalives would keep it fresh mid-execution) → NOT re-offered
    const fresh = await jsonOf<{ dispatch: null }>(await daemonClaim());
    expect(fresh.dispatch).toBeNull();

    // stale contact + no events → re-offered, and only to its own runtime
    await db
      .update(dispatches)
      .set({ lastContactAt: sql`now() - interval '30 seconds'` })
      .where(eq(dispatches.id, id));
    const foreign = await jsonOf<{ dispatch: null }>(await daemonClaim(otherToken));
    expect(foreign.dispatch).toBeNull();
    const reoffered = await jsonOf<{ dispatch: { id: string } | null }>(await daemonClaim());
    expect(reoffered.dispatch?.id).toBe(id);

    // once ANY event has landed, a stale claim is the deadman's business
    await daemonPost(`/dispatches/${id}/events`, {
      batch: [{ seq: 1, event: { type: "message", role: "assistant", text: "hi" } }],
    });
    await db
      .update(dispatches)
      .set({ lastContactAt: sql`now() - interval '30 seconds'` })
      .where(eq(dispatches.id, id));
    const withEvents = await jsonOf<{ dispatch: null }>(await daemonClaim());
    expect(withEvents.dispatch).toBeNull();
    // cleanup so later suites see no claimed leftovers
    await db.update(dispatches).set({ status: "failed" }).where(eq(dispatches.id, id));
  });

  it("event batches dedupe on (dispatch, seq) and carry the abort flag back", async () => {
    const id = await newDispatch();
    await daemonClaim();

    const batch = {
      batch: [
        { seq: 1, event: { type: "message", role: "assistant", text: "hi" } },
        { seq: 2, event: { type: "usage", inputTokens: 10, outputTokens: 5 } },
      ],
    };
    const res1 = await jsonOf<{ abort: boolean }>(
      await daemonPost(`/dispatches/${id}/events`, batch),
    );
    expect(res1.abort).toBe(false);
    // at-least-once: the same batch again inserts nothing new
    await daemonPost(`/dispatches/${id}/events`, batch);
    const rows = await db.select().from(dispatchEvents).where(eq(dispatchEvents.dispatchId, id));
    expect(rows).toHaveLength(2);

    // abort rides the response of the next (possibly empty keepalive) batch
    await db.update(dispatches).set({ abortRequested: true }).where(eq(dispatches.id, id));
    const keepalive = await jsonOf<{ abort: boolean }>(
      await daemonPost(`/dispatches/${id}/events`, { batch: [] }),
    );
    expect(keepalive.abort).toBe(true);

    // a foreign runtime cannot post into it
    expect((await daemonPost(`/dispatches/${id}/events`, { batch: [] }, otherToken)).status).toBe(
      404,
    );
  });

  it("bounds an event batch by declared size before parsing", async () => {
    const id = await newDispatch();
    await daemonClaim();
    const res = await app.request(`/api/daemon/dispatches/${id}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(512 * 1024),
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ batch: [] }),
    });
    expect(res.status).toBe(413);
  });

  it("artifact upload stages bytes with a server-computed sha256 and rejects unsafe keys", async () => {
    const id = await newDispatch();
    await daemonClaim();

    const content = "diff --git a/x b/x\n+hello\n";
    const res = await app.request(`/api/daemon/dispatches/${id}/artifacts/.workspace-diff`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: content,
    });
    expect(res.status).toBe(200);
    const staged = await jsonOf<{ staged: string; size: number; sha256: string }>(res);
    expect(staged.staged).toBe(`${id}/.workspace-diff`);
    expect(staged.size).toBe(content.length);
    expect(staged.sha256).toBe(new Bun.CryptoHasher("sha256").update(content).digest("hex"));

    // ".." never reaches the route — URL normalization (of the literal AND the
    // percent-encoded form) resolves the segment away before routing, so
    // traversal dead-ends as a 404. The in-route isSafeArtifactKey guard is
    // defence in depth for non-HTTP callers, unit-tested with the store.
    for (const evil of ["..", "%2e%2e"]) {
      const traversal = await app.request(`/api/daemon/dispatches/${id}/artifacts/${evil}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "x",
      });
      expect(traversal.status).toBe(404);
    }
  });

  it("complete and fail are terminal CAS — the loser gets a 409", async () => {
    const id = await newDispatch();
    await daemonClaim();

    expect((await daemonPost(`/dispatches/${id}/complete`, { baseSha: "abc123" })).status).toBe(
      200,
    );
    const [row] = await db.select().from(dispatches).where(eq(dispatches.id, id));
    expect(row?.status).toBe("completed");
    expect(row?.result).toEqual({ baseSha: "abc123" });
    expect(row?.finishedAt).not.toBeNull();

    expect((await daemonPost(`/dispatches/${id}/complete`, {})).status).toBe(409);
    expect((await daemonPost(`/dispatches/${id}/fail`, { code: "x", message: "y" })).status).toBe(
      409,
    );

    // events after terminal are refused too
    expect((await daemonPost(`/dispatches/${id}/events`, { batch: [] })).status).toBe(409);
  });
});
