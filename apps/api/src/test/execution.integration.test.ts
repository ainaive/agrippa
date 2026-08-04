import { beforeAll, describe, expect, it } from "bun:test";
import type { RunQueue } from "@agrippa/core";
import { auditLogs, fabri, mcpServers, repoConnections, runs, skillVersions } from "@agrippa/db";
import { FakeExecutor, type FakeStepBehavior } from "@agrippa/executor-core";
import {
  type EngineDeps,
  executeRun,
  FakeResourceMaterializer,
  FakeWorkspaceManager,
  InMemoryArtifactStore,
  InProcessEventBus,
  silentLogger,
} from "@agrippa/orchestration";
import { desc, eq } from "drizzle-orm";
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

const SCRIPT: Record<string, FakeStepBehavior> = {
  "reproduce-bug": {
    kind: "succeed",
    usage: { inputTokens: 500, outputTokens: 200 },
    events: [{ type: "artifact", key: "reproduction-report", kind: "markdown", inline: "# R" }],
  },
  "find-root-cause": {
    kind: "succeed",
    usage: { inputTokens: 800, outputTokens: 300 },
    events: [
      { type: "artifact", key: "localization-report", kind: "markdown", inline: "# Root cause" },
    ],
  },
  summarize: {
    kind: "succeed",
    events: [{ type: "artifact", key: "fix-report", kind: "markdown", inline: "# Fixed" }],
  },
};

describe.skipIf(!dbUp)("execution api (submit → engine → approve → artifacts → SSE)", () => {
  let app: App;
  let db: Awaited<ReturnType<typeof freshTestDb>>;
  let admin: TestClient;
  let viewer: TestClient;
  let outsider: TestClient;
  let projectId: string;
  let repoConnectionId: string;
  let taskTypeId: string;
  let taskId: string;
  let runId: string;
  const enqueued: string[] = [];
  const bus = new InProcessEventBus();

  const fakeQueue: RunQueue = makeFakeQueue({
    enqueueRun: async (id) => {
      enqueued.push(id);
    },
  });

  const engineDeps = (): EngineDeps => ({
    db,
    executors: { "claude-agent-sdk": new FakeExecutor(SCRIPT) },
    bus,
    workspace: new FakeWorkspaceManager(),
    resources: new FakeResourceMaterializer(),
    artifacts: new InMemoryArtifactStore(),
    logger: silentLogger,
  });

  beforeAll(async () => {
    db = await freshTestDb();
    app = createApp({ db, queue: fakeQueue, bus });
    admin = await signUp(app, "Root", "root@example.com");
    viewer = await signUp(app, "Vera", "vera@example.com");
    outsider = await signUp(app, "Oz", "oz@example.com");

    projectId = (
      await jsonOf<{ id: string }>(
        await admin.request("/api/v1/projects", {
          method: "POST",
          json: { slug: "exec", name: "Execution" },
        }),
      )
    ).id;
    await admin.request(`/api/v1/projects/${projectId}/members`, {
      method: "POST",
      json: { email: "vera@example.com", role: "viewer" },
    });

    // a repo connection owned by this project — submissions must reference one
    const [conn] = await db
      .insert(repoConnections)
      .values({ projectId, provider: "github", url: "https://github.com/acme/widget.git" })
      .returning();
    repoConnectionId = conn?.id as string;

    const types = await jsonOf<Array<{ id: string; slug: string }>>(
      await admin.request("/api/v1/scenarios/software-development/task-types"),
    );
    taskTypeId = types.find((t) => t.slug === "bug-localize-fix")?.id as string;
  });

  const submitBody = () => ({
    taskTypeId,
    title: "Fix the widget",
    params: {
      bugReport: "It crashes",
      repo: { repoConnectionId },
    },
  });

  it("rejects submission when a required skill is ungranted", async () => {
    // new projects auto-grant built-ins (including both required skills); to
    // exercise the skill_not_granted path, revoke one required skill first.
    const models = await jsonOf<Array<{ id: string }>>(await admin.request("/api/v1/models"));
    const skills = await jsonOf<Array<{ id: string; slug: string }>>(
      await admin.request("/api/v1/skills"),
    );
    const testRunner = skills.find((s) => s.slug === "builtin/test-runner") as {
      id: string;
      slug: string;
    };
    // grants: all models + every skill EXCEPT test-runner
    const revoked = [
      ...models.map((m) => ({ resourceType: "model", resourceId: m.id })),
      ...skills
        .filter((s) => s.id !== testRunner.id)
        .map((s) => ({ resourceType: "skill", resourceId: s.id })),
    ];
    const removePut = await admin.request(`/api/v1/projects/${projectId}/grants`, {
      method: "PUT",
      json: revoked,
    });
    expect(removePut.status).toBe(200);

    const res = await admin.request(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      json: submitBody(),
    });
    expect(res.status).toBe(400);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("skill_not_granted");

    // restore: all models + all skills so later tests can submit
    const grants = [
      ...models.map((m) => ({ resourceType: "model", resourceId: m.id })),
      ...skills.map((s) => ({ resourceType: "skill", resourceId: s.id })),
    ];
    const put = await admin.request(`/api/v1/projects/${projectId}/grants`, {
      method: "PUT",
      json: grants,
    });
    expect(put.status).toBe(200);
  });

  it("validates params against the compiled input schema", async () => {
    const res = await admin.request(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      json: { taskTypeId, title: "Bad", params: { bugReport: "" } },
    });
    expect(res.status).toBe(400);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("validation_failed");
  });

  it("viewers cannot submit", async () => {
    const res = await viewer.request(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      json: submitBody(),
    });
    expect(res.status).toBe(403);
  });

  it("refuses a repoConnectionId belonging to another project", async () => {
    // a connection owned by a different project — cross-tenant IDOR attempt
    const otherId = (
      await jsonOf<{ id: string }>(
        await admin.request("/api/v1/projects", {
          method: "POST",
          json: { slug: "other", name: "Other" },
        }),
      )
    ).id;
    const [foreign] = await db
      .insert(repoConnections)
      .values({ projectId: otherId, provider: "github", url: "https://github.com/acme/secret.git" })
      .returning();

    const res = await admin.request(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      json: {
        taskTypeId,
        title: "IDOR",
        params: { bugReport: "It crashes", repo: { repoConnectionId: foreign?.id } },
      },
    });
    expect(res.status).toBe(400);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("repo_not_in_project");
  });

  it("accepts a valid submission and enqueues the run", async () => {
    const res = await admin.request(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      json: submitBody(),
    });
    expect(res.status).toBe(202);
    const body = await jsonOf<{ taskId: string; runId: string }>(res);
    taskId = body.taskId;
    runId = body.runId;
    expect(enqueued).toContain(runId);

    const run = await jsonOf<{
      status: string;
      executorId: string;
      template: {
        slug: string;
        version: number;
        phases: Array<Record<string, unknown>>;
        limits: Record<string, unknown>;
        modelRoles: Record<string, unknown>;
      };
    }>(await viewer.request(`/api/v1/runs/${runId}`));
    expect(run.status).toBe("queued");
    expect(run.executorId).toBe("claude-agent-sdk");

    // template plan embed: structure + i18n names only. The key allowlist is a
    // leak guard — a phase must never carry step instructions or prompts.
    expect(run.template.slug).toBe("swdev.bug-localize-fix");
    expect(run.template.version).toBeGreaterThanOrEqual(1);
    expect(run.template.phases.length).toBeGreaterThan(0);
    for (const phase of run.template.phases) {
      expect(Object.keys(phase).sort()).toEqual([
        "approval",
        "checkpoints",
        "id",
        "loop",
        "name",
        "stepIds",
      ]);
      expect(Array.isArray(phase.stepIds)).toBe(true);
    }
    const withApproval = run.template.phases.find((p) => p.approval !== null);
    expect(withApproval).toBeDefined();
    expect(Object.keys(withApproval?.approval as Record<string, unknown>).sort()).toEqual([
      "checkpoint",
      "present",
      "title",
    ]);
  });

  it("worker leg 1 pauses at the approval; the API decides; leg 2 succeeds", async () => {
    expect(await executeRun(engineDeps(), runId)).toBe("waiting_approval");

    const approvalsRes = await jsonOf<Array<{ id: string; status: string; kind: string }>>(
      await viewer.request(`/api/v1/runs/${runId}/checkpoints`),
    );
    expect(approvalsRes[0]?.status).toBe("pending");
    expect(approvalsRes[0]?.kind).toBe("approval");
    const approvalId = approvalsRes[0]?.id as string;

    // the pending-checkpoints inbox is membership-scoped
    const inbox = await jsonOf<
      Array<{ id: string; runId: string; taskTitle: string; projectRole: string }>
    >(await viewer.request("/api/v1/checkpoints/pending"));
    expect(inbox.map((i) => i.id)).toContain(approvalId);
    expect(inbox[0]?.taskTitle).toBe("Fix the widget");
    expect(inbox[0]?.projectRole).toBe("viewer");
    const outsiderInbox = await jsonOf<Array<{ id: string }>>(
      await outsider.request("/api/v1/checkpoints/pending"),
    );
    expect(outsiderInbox).toEqual([]);

    // viewers cannot decide
    const denied = await viewer.request(`/api/v1/runs/${runId}/checkpoints/${approvalId}/respond`, {
      method: "POST",
      json: { kind: "approval", decision: "approved" },
    });
    expect(denied.status).toBe(403);

    const decided = await admin.request(`/api/v1/runs/${runId}/checkpoints/${approvalId}/respond`, {
      method: "POST",
      json: { kind: "approval", decision: "approved", comment: "plan looks good" },
    });
    expect(decided.status).toBe(200);
    expect(enqueued.filter((id) => id === runId).length).toBeGreaterThanOrEqual(2);

    expect(await executeRun(engineDeps(), runId)).toBe("succeeded");
    const run = await jsonOf<{ status: string }>(await admin.request(`/api/v1/runs/${runId}`));
    expect(run.status).toBe("succeeded");

    // decided checkpoints leave the inbox
    const drained = await jsonOf<Array<{ id: string }>>(
      await viewer.request("/api/v1/checkpoints/pending"),
    );
    expect(drained.map((i) => i.id)).not.toContain(approvalId);
  });

  it("exposes steps and downloadable artifacts", async () => {
    const steps = await jsonOf<
      Array<{ stepId: string; status: string; usage: { tokens?: number } }>
    >(await viewer.request(`/api/v1/runs/${runId}/steps`));
    const rootCause = steps.find((s) => s.stepId === "find-root-cause");
    expect(rootCause?.status).toBe("succeeded");
    // per-step consumption is aggregated from token_usage into the response
    expect(typeof rootCause?.usage.tokens).toBe("number");

    const artifacts = await jsonOf<Array<{ id: string; artifactKey: string }>>(
      await viewer.request(`/api/v1/runs/${runId}/artifacts`),
    );
    const keys = artifacts.map((a) => a.artifactKey).sort();
    expect(keys).toEqual(["fix-report", "localization-report", "patch", "reproduction-report"]);

    const report = artifacts.find((a) => a.artifactKey === "localization-report");
    const download = await viewer.request(`/api/v1/artifacts/${report?.id}/download`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("# Root cause");
  });

  it("reports usage grouped by model, task type, and day", async () => {
    const usage = await jsonOf<{
      tokens: number;
      byModel: Array<{ model: string; tokens: number }>;
      byTaskType: Array<{ taskTypeNameI18n: Record<string, string> | null; tokens: number }>;
      byDay: Array<{ day: string; tokens: number }>;
      period: { start: string; today: string };
    }>(await viewer.request(`/api/v1/projects/${projectId}/usage`));
    // the fake executor recorded 500+200 and 800+300 tokens
    expect(usage.tokens).toBe(1800);
    expect(usage.byModel.length).toBeGreaterThan(0);
    expect(usage.byTaskType).toHaveLength(1);
    expect(usage.byTaskType[0]?.taskTypeNameI18n?.en).toBeTruthy();
    expect(usage.byDay).toHaveLength(1);
    expect(usage.byDay[0]?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(usage.byDay[0]?.tokens).toBe(1800);
    // period bounds come from the same DB clock that grouped byDay
    expect(usage.period.start).toMatch(/^\d{4}-\d{2}-01$/);
    expect((usage.byDay[0]?.day as string) >= usage.period.start).toBe(true);
    expect((usage.byDay[0]?.day as string) <= usage.period.today).toBe(true);
  });

  it("replays the full event log over SSE, honoring Last-Event-ID", async () => {
    const full = await viewer.request(`/api/v1/runs/${runId}/events`);
    expect(full.status).toBe(200);
    const text = await full.text();
    expect(text).toContain("event: run.started");
    expect(text).toContain("event: checkpoint.required");
    expect(text).toContain("event: run.succeeded");

    // resume from the middle: only later events are replayed
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    // subscribe-before-replay must not deliver any event twice: seq strictly
    // increasing, deduped by cursor (ADR-0007)
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    const middle = ids[Math.floor(ids.length / 2)] as number;
    const partial = await viewer.request(`/api/v1/runs/${runId}/events`, {
      headers: { "last-event-id": String(middle) },
    });
    const partialText = await partial.text();
    const partialIds = [...partialText.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(Math.min(...partialIds)).toBe(middle + 1);
    expect(partialText).toContain("event: run.succeeded");
    expect(partialText).not.toContain("event: run.started");
  });

  it("keeps an idle stream alive with comment frames that carry no event id", async () => {
    // A live (non-terminal) run writes nothing between events, so the stream
    // has to emit something or an intermediary reaps the connection.
    const submit = await admin.request(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      json: submitBody(),
    });
    expect(submit.status).toBe(202);
    const { runId: idleRunId } = await jsonOf<{ runId: string }>(submit);

    // restore rather than delete: an unconditional delete would clobber a value
    // the environment supplied and leak into later tests
    const previousKeepaliveMs = process.env.AGRIPPA_SSE_KEEPALIVE_MS;
    process.env.AGRIPPA_SSE_KEEPALIVE_MS = "1";
    try {
      const res = await viewer.request(`/api/v1/runs/${idleRunId}/events`);
      expect(res.status).toBe(200);

      // the run never terminates here (the queue is a fake), so read until a
      // keepalive shows up rather than draining to completion
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let seen = "";
      // under bun's 5s per-test timeout, so a regression fails the assertion
      // below with a readable diff instead of an opaque timeout
      const deadline = Date.now() + 3_500;
      try {
        while (!seen.includes(": keepalive") && Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          seen += decoder.decode(value, { stream: true });
        }
      } finally {
        await reader.cancel();
      }

      expect(seen).toContain(": keepalive");
      // the frame must not look like an event: no id line means it can never
      // advance the cursor the client reconnects with via Last-Event-ID
      const keepaliveFrames = seen.split("\n\n").filter((f) => f.startsWith(": keepalive"));
      expect(keepaliveFrames.length).toBeGreaterThan(0);
      for (const frame of keepaliveFrames) {
        expect(frame).not.toContain("id:");
        expect(frame).not.toContain("event:");
        expect(frame).not.toContain("data:");
      }
    } finally {
      if (previousKeepaliveMs === undefined) {
        delete process.env.AGRIPPA_SSE_KEEPALIVE_MS;
      } else {
        process.env.AGRIPPA_SSE_KEEPALIVE_MS = previousKeepaliveMs;
      }
    }
  });

  it("cancel finalizes a queued run immediately", async () => {
    const res = await admin.request(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      json: submitBody(),
    });
    const { runId: cancelRunId } = await jsonOf<{ runId: string }>(res);

    const cancel = await admin.request(`/api/v1/runs/${cancelRunId}/cancel`, { method: "POST" });
    expect(cancel.status).toBe(200);
    const [row] = await db.select().from(runs).where(eq(runs.id, cancelRunId));
    // a queued run has no worker holding it — cancel must flip it to terminal
    // straight away, not just set a flag the user never sees reflected
    expect(row?.status).toBe("cancelled");
    expect(row?.cancelRequested).toBe(true);
    expect(row?.finishedAt).not.toBeNull();

    // the run is already terminal, so the worker's executeRun is a no-op
    expect(await executeRun(engineDeps(), cancelRunId)).toBe("already_terminal");
  });

  it("localizes error messages by ?lang and profile locale", async () => {
    // ?lang pins the response language regardless of profile
    const zh = await admin.request(`/api/v1/runs/${Bun.randomUUIDv7()}?lang=zh-CN`);
    expect(zh.status).toBe(404);
    expect((await jsonOf<{ message: string }>(zh)).message).toBe("资源不存在");

    // profile locale drives it when no ?lang is given
    await admin.request("/api/v1/me", { method: "PATCH", json: { locale: "zh-CN" } });
    const profile = await admin.request(`/api/v1/runs/${Bun.randomUUIDv7()}`);
    expect((await jsonOf<{ message: string }>(profile)).message).toBe("资源不存在");
    await admin.request("/api/v1/me", { method: "PATCH", json: { locale: "en" } });
  });

  it("usage reports current-period totals and hard-stop quota blocks new submissions", async () => {
    const usage = await jsonOf<{
      tokens: number;
      byModel: Array<{ model: string }>;
    }>(await admin.request(`/api/v1/projects/${projectId}/usage`));
    expect(usage.tokens).toBeGreaterThan(0); // the succeeded run recorded usage
    expect(usage.byModel.length).toBeGreaterThan(0);

    // exhaust the quota below current consumption → submit rejected before persisting
    await admin.request(`/api/v1/projects/${projectId}/quota`, {
      method: "PUT",
      json: { tokenLimit: 1, hardStop: true },
    });
    const blocked = await admin.request(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      json: submitBody(),
    });
    expect(blocked.status).toBe(400);
    expect((await jsonOf<{ code: string }>(blocked)).code).toBe("quota_exhausted");

    // soft quotas do not block
    await admin.request(`/api/v1/projects/${projectId}/quota`, {
      method: "PUT",
      json: { tokenLimit: 1, hardStop: false },
    });
    const allowed = await admin.request(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      json: submitBody(),
    });
    expect(allowed.status).toBe(202);
    // restore for later tests
    await admin.request(`/api/v1/projects/${projectId}/quota`, {
      method: "PUT",
      json: { tokenLimit: null, hardStop: true },
    });
  });

  it("retry creates run #2 pinned to the same template version", async () => {
    const res = await admin.request(`/api/v1/tasks/${taskId}/retry`, { method: "POST" });
    expect(res.status).toBe(202);
    const body = await jsonOf<{ runId: string; number: number }>(res);
    expect(body.number).toBe(2);
    expect(enqueued).toContain(body.runId);

    const task = await jsonOf<{ runs: Array<{ number: number }> }>(
      await admin.request(`/api/v1/tasks/${taskId}`),
    );
    expect(task.runs.map((r) => r.number)).toEqual([2, 1]);
  });

  it("retry re-resolves against current configuration (ADR-0014)", async () => {
    // no worker in this fixture — mark queued runs terminal so retry is legal
    await db.update(runs).set({ status: "failed" }).where(eq(runs.taskId, taskId));
    const [prev] = await db
      .select()
      .from(runs)
      .where(eq(runs.taskId, taskId))
      .orderBy(desc(runs.number))
      .limit(1);
    const flatten = (resolution: Record<string, unknown> | null | undefined) =>
      Object.values(resolution ?? {}).flatMap((slot) =>
        Object.values(slot as Record<string, { provider: string }>),
      );
    // every run so far resolved anthropic — no dashscope credential existed
    expect(flatten(prev?.modelResolution).some((e) => e.provider === "anthropic")).toBe(true);

    // adding a credential makes dashscope the ranked provider (ADR-0013's
    // credentialed-first consequence) — a retry must pick that up
    await admin.request(`/api/v1/projects/${projectId}/providers`, {
      method: "POST",
      json: { provider: "dashscope", apiKey: "sk-bailian-retry-test" },
    });
    const res = await admin.request(`/api/v1/tasks/${taskId}/retry`, { method: "POST" });
    expect(res.status).toBe(202);
    const { runId: rerunId } = await jsonOf<{ runId: string }>(res);
    const [rerun] = await db.select().from(runs).where(eq(runs.id, rerunId));

    // pinned: template version and params snapshot; re-derived: the resolution
    expect(rerun?.templateVersionId).toBe(prev?.templateVersionId as string);
    expect(rerun?.paramsSnapshot).toEqual(prev?.paramsSnapshot ?? {});
    const entries = flatten(rerun?.modelResolution);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.provider).toBe("dashscope");

    await admin.request(`/api/v1/projects/${projectId}/providers/dashscope`, {
      method: "DELETE",
    });
  });

  it("retry preserves the user's submit-time agent overrides", async () => {
    const types = await jsonOf<Array<{ id: string; slug: string }>>(
      await admin.request("/api/v1/scenarios/software-development/task-types"),
    );
    const rdTypeId = types.find((t) => t.slug === "requirement-delivery")?.id as string;
    const submitted = await admin.request(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      json: {
        taskTypeId: rdTypeId,
        title: "Override survives retry",
        params: { requirement: "Do the thing", repo: { repoConnectionId } },
        // the template pins codex-cli for the reviewer; the user chose otherwise
        agents: { reviewer: { executorId: "claude-agent-sdk" } },
      },
    });
    expect(submitted.status).toBe(202);
    const { taskId: rdTaskId } = await jsonOf<{ taskId: string }>(submitted);

    await db.update(runs).set({ status: "failed" }).where(eq(runs.taskId, rdTaskId));
    const retried = await admin.request(`/api/v1/tasks/${rdTaskId}/retry`, { method: "POST" });
    expect(retried.status).toBe(202);
    const { runId: rerunId } = await jsonOf<{ runId: string }>(retried);
    const [rerun] = await db.select().from(runs).where(eq(runs.id, rerunId));
    expect(rerun?.agentBindings.reviewer?.executorId).toBe("claude-agent-sdk");
  });

  it("retry fails fast when current configuration cannot satisfy the template", async () => {
    await db.update(runs).set({ status: "failed" }).where(eq(runs.taskId, taskId));

    // strip every grant — the manifest re-check fires before model resolution
    await admin.request(`/api/v1/projects/${projectId}/grants`, { method: "PUT", json: [] });
    const ungranted = await admin.request(`/api/v1/tasks/${taskId}/retry`, { method: "POST" });
    expect(ungranted.status).toBe(400);
    expect((await jsonOf<{ code: string }>(ungranted)).code).toBe("skill_not_granted");

    const models = await jsonOf<Array<{ id: string }>>(await admin.request("/api/v1/models"));
    const skillRows = await jsonOf<Array<{ id: string }>>(await admin.request("/api/v1/skills"));
    await admin.request(`/api/v1/projects/${projectId}/grants`, {
      method: "PUT",
      json: [
        ...models.map((m) => ({ resourceType: "model", resourceId: m.id })),
        ...skillRows.map((s) => ({ resourceType: "skill", resourceId: s.id })),
      ],
    });

    // a retry consumes tokens like any run — the quota hard-stop applies
    await admin.request(`/api/v1/projects/${projectId}/quota`, {
      method: "PUT",
      json: { tokenLimit: 1, hardStop: true },
    });
    const blocked = await admin.request(`/api/v1/tasks/${taskId}/retry`, { method: "POST" });
    expect(blocked.status).toBe(400);
    expect((await jsonOf<{ code: string }>(blocked)).code).toBe("quota_exhausted");
    await admin.request(`/api/v1/projects/${projectId}/quota`, {
      method: "PUT",
      json: { tokenLimit: null, hardStop: true },
    });
  });

  it("retry rejects a default faber that was disabled since submit", async () => {
    await db.update(runs).set({ status: "failed" }).where(eq(runs.taskId, taskId));
    const [latest] = await db
      .select({ faberId: runs.faberId })
      .from(runs)
      .where(eq(runs.taskId, taskId))
      .orderBy(desc(runs.number))
      .limit(1);
    await db
      .update(fabri)
      .set({ status: "disabled" })
      .where(eq(fabri.id, latest?.faberId as string));
    const res = await admin.request(`/api/v1/tasks/${taskId}/retry`, { method: "POST" });
    expect(res.status).toBe(400);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("faber_unknown");
    await db
      .update(fabri)
      .set({ status: "active" })
      .where(eq(fabri.id, latest?.faberId as string));
  });

  it("retry rejects a required skill whose versions were all deprecated", async () => {
    await db.update(runs).set({ status: "failed" }).where(eq(runs.taskId, taskId));
    await db.update(skillVersions).set({ status: "deprecated" });
    const res = await admin.request(`/api/v1/tasks/${taskId}/retry`, { method: "POST" });
    expect(res.status).toBe(400);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("skill_version_unavailable");
    await db.update(skillVersions).set({ status: "active" });
  });

  it("concurrent retries serialize: one 202, one run_active conflict, audited", async () => {
    await db.update(runs).set({ status: "failed" }).where(eq(runs.taskId, taskId));
    const [first, second] = await Promise.all([
      admin.request(`/api/v1/tasks/${taskId}/retry`, { method: "POST" }),
      admin.request(`/api/v1/tasks/${taskId}/retry`, { method: "POST" }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([202, 409]);
    const winner = first.status === 202 ? first : second;
    const loser = first.status === 202 ? second : first;
    expect((await jsonOf<{ code: string }>(loser)).code).toBe("run_active");

    // the audit row commits with the retry (every mutation is audited)
    const { runId: newRunId } = await jsonOf<{ runId: string }>(winner);
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.resourceId, newRunId));
    const entry = rows.find((r) => r.action === "task.retry");
    expect(entry).toBeDefined();
    const payload = entry?.payload as { fromRunId?: string } | undefined;
    expect(payload?.fromRunId).toBeDefined();
  });

  it("retry drops an optional MCP server disabled since submit", async () => {
    // bug-localize-fix references MCP 'github' as optional — register + grant it
    const [mcp] = await db
      .insert(mcpServers)
      .values({
        slug: "github",
        nameI18n: { en: "GitHub", "zh-CN": "GitHub" },
        transport: "http",
        config: { url: "https://mcp.example.com" },
      })
      .returning();
    const models = await jsonOf<Array<{ id: string }>>(await admin.request("/api/v1/models"));
    const skillRows = await jsonOf<Array<{ id: string }>>(await admin.request("/api/v1/skills"));
    await admin.request(`/api/v1/projects/${projectId}/grants`, {
      method: "PUT",
      json: [
        ...models.map((m) => ({ resourceType: "model", resourceId: m.id })),
        ...skillRows.map((s) => ({ resourceType: "skill", resourceId: s.id })),
        { resourceType: "mcp_server", resourceId: mcp?.id },
      ],
    });

    await db.update(runs).set({ status: "failed" }).where(eq(runs.taskId, taskId));
    const withMcp = await admin.request(`/api/v1/tasks/${taskId}/retry`, { method: "POST" });
    expect(withMcp.status).toBe(202);
    const { runId: withId } = await jsonOf<{ runId: string }>(withMcp);
    const [runWith] = await db.select().from(runs).where(eq(runs.id, withId));
    expect(runWith?.resourceManifest.mcpServers).toContain("github");

    // disabled → treated as unregistered; the optional ref silently drops
    await db
      .update(mcpServers)
      .set({ status: "disabled" })
      .where(eq(mcpServers.id, mcp?.id as string));
    await db.update(runs).set({ status: "failed" }).where(eq(runs.taskId, taskId));
    const withoutMcp = await admin.request(`/api/v1/tasks/${taskId}/retry`, { method: "POST" });
    expect(withoutMcp.status).toBe(202);
    const { runId: withoutId } = await jsonOf<{ runId: string }>(withoutMcp);
    const [runWithout] = await db.select().from(runs).where(eq(runs.id, withoutId));
    expect(runWithout?.resourceManifest.mcpServers).not.toContain("github");
  });

  it("retry rejects params referencing a deleted repo connection", async () => {
    const [conn] = await db
      .select()
      .from(repoConnections)
      .where(eq(repoConnections.id, repoConnectionId));
    await db.delete(repoConnections).where(eq(repoConnections.id, repoConnectionId));
    await db.update(runs).set({ status: "failed" }).where(eq(runs.taskId, taskId));

    const res = await admin.request(`/api/v1/tasks/${taskId}/retry`, { method: "POST" });
    expect(res.status).toBe(400);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("repo_not_in_project");

    if (conn) await db.insert(repoConnections).values(conn);
  });
});
