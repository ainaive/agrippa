import { beforeAll, describe, expect, it } from "bun:test";
import type { RunQueue } from "@agrippa/core";
import { repoConnections, runs } from "@agrippa/db";
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
import { eq } from "drizzle-orm";
import type { App } from "../app";
import { createApp } from "../app";
import { freshTestDb, jsonOf, postgresAvailable, signUp, type TestClient } from "./helpers";

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
  let projectId: string;
  let repoConnectionId: string;
  let taskTypeId: string;
  let taskId: string;
  let runId: string;
  const enqueued: string[] = [];
  const bus = new InProcessEventBus();

  const fakeQueue: RunQueue = {
    enqueueRun: async (id) => {
      enqueued.push(id);
    },
    enqueueApprovalExpiry: async () => {},
  };

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

  it("rejects submission until required resources are granted", async () => {
    const res = await admin.request(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      json: submitBody(),
    });
    expect(res.status).toBe(400);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("skill_not_granted");

    // grant all models + both builtin skills via the grants API
    const models = await jsonOf<Array<{ id: string }>>(await admin.request("/api/v1/models"));
    const skills = await jsonOf<Array<{ id: string; slug: string }>>(
      await admin.request("/api/v1/skills"),
    );
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

    const run = await jsonOf<{ status: string; executorId: string }>(
      await admin.request(`/api/v1/runs/${runId}`),
    );
    expect(run.status).toBe("queued");
    expect(run.executorId).toBe("claude-agent-sdk");
  });

  it("worker leg 1 pauses at the approval; the API decides; leg 2 succeeds", async () => {
    expect(await executeRun(engineDeps(), runId)).toBe("waiting_approval");

    const approvalsRes = await jsonOf<Array<{ id: string; status: string }>>(
      await viewer.request(`/api/v1/runs/${runId}/approvals`),
    );
    expect(approvalsRes[0]?.status).toBe("pending");
    const approvalId = approvalsRes[0]?.id as string;

    // viewers cannot decide
    const denied = await viewer.request(`/api/v1/runs/${runId}/approvals/${approvalId}`, {
      method: "POST",
      json: { decision: "approved" },
    });
    expect(denied.status).toBe(403);

    const decided = await admin.request(`/api/v1/runs/${runId}/approvals/${approvalId}`, {
      method: "POST",
      json: { decision: "approved", comment: "plan looks good" },
    });
    expect(decided.status).toBe(200);
    expect(enqueued.filter((id) => id === runId).length).toBeGreaterThanOrEqual(2);

    expect(await executeRun(engineDeps(), runId)).toBe("succeeded");
    const run = await jsonOf<{ status: string }>(await admin.request(`/api/v1/runs/${runId}`));
    expect(run.status).toBe("succeeded");
  });

  it("exposes steps and downloadable artifacts", async () => {
    const steps = await jsonOf<Array<{ stepId: string; status: string }>>(
      await viewer.request(`/api/v1/runs/${runId}/steps`),
    );
    expect(steps.find((s) => s.stepId === "find-root-cause")?.status).toBe("succeeded");

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

  it("replays the full event log over SSE, honoring Last-Event-ID", async () => {
    const full = await viewer.request(`/api/v1/runs/${runId}/events`);
    expect(full.status).toBe(200);
    const text = await full.text();
    expect(text).toContain("event: run.started");
    expect(text).toContain("event: approval.required");
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

  it("cancel marks the run and the engine honors it", async () => {
    const res = await admin.request(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      json: submitBody(),
    });
    const { runId: cancelRunId } = await jsonOf<{ runId: string }>(res);

    const cancel = await admin.request(`/api/v1/runs/${cancelRunId}/cancel`, { method: "POST" });
    expect(cancel.status).toBe(200);
    const [row] = await db.select().from(runs).where(eq(runs.id, cancelRunId));
    expect(row?.cancelRequested).toBe(true);

    expect(await executeRun(engineDeps(), cancelRunId)).toBe("cancelled");
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
      costUsd: number;
      tokens: number;
      byModel: Array<{ model: string }>;
    }>(await admin.request(`/api/v1/projects/${projectId}/usage`));
    expect(usage.tokens).toBeGreaterThan(0); // the succeeded run recorded usage
    expect(usage.byModel.length).toBeGreaterThan(0);

    // exhaust the quota below current spend → submit rejected before persisting
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
});
