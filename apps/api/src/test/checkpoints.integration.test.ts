import { beforeAll, describe, expect, it } from "bun:test";
import type { RunQueue } from "@agrippa/core";
import {
  checkpoints,
  fabri,
  orchestrationTemplates,
  repoConnections,
  runEvents,
  runs,
  scenarios,
  taskTypes,
  templateVersions,
} from "@agrippa/db";
import { FakeExecutor, type FakeStepBehavior } from "@agrippa/executor-core";
import {
  compileTemplate,
  type EngineDeps,
  executeRun,
  FakeResourceMaterializer,
  FakeScmService,
  FakeWorkspaceManager,
  InMemoryArtifactStore,
  InProcessEventBus,
  silentLogger,
} from "@agrippa/orchestration";
import { and, eq } from "drizzle-orm";
import type { App } from "../app";
import { createApp } from "../app";
import { freshTestDb, jsonOf, postgresAvailable, signUp, type TestClient } from "./helpers";

const dbUp = await postgresAvailable();

/** Slimmed requirement-delivery spine: Q&A checkpoint → plan gate → review-fix loop → PR. */
const V2_YAML = `
apiVersion: agrippa/v2
kind: OrchestrationTemplate
metadata:
  slug: swdev.checkpoint-fixture
  scenario: software-development
  name: { en: "Checkpoint Fixture", zh-CN: "检查点夹具" }
  description: { en: "api test fixture", zh-CN: "接口测试夹具" }
spec:
  agents:
    implementer: { label: { en: "Implementer", zh-CN: "实现者" }, faber: forge, executor: fake }
    reviewer: { label: { en: "Reviewer", zh-CN: "评审者" }, faber: sentinel, executor: fake }
  inputs:
    - { key: requirement, type: text, required: true, label: { en: "Requirement", zh-CN: "需求" } }
    - { key: repo, type: repoRef, required: true, label: { en: "Repo", zh-CN: "仓库" } }
  workspace: { repo: "\${inputs.repo}", access: readWrite }
  models:
    roles:
      coding: { tier: strong }
  phases:
    - id: setup
      name: { en: "Setup", zh-CN: "准备" }
      steps:
        - { id: checkout, kind: system, action: workspace.checkout }
        - { id: branch, kind: system, action: git.branch }
    - id: clarify
      name: { en: "Clarify", zh-CN: "澄清" }
      steps:
        - id: analyze
          kind: agent
          agent: implementer
          model: { role: coding }
          instructions: "Analyze \${inputs.requirement}"
          produces: [questions]
        - id: clarify-qa
          kind: checkpoint
          checkpoint: { kind: input, source: questions, title: { en: "Questions", zh-CN: "问题" } }
    - kind: loop
      id: review-fix
      name: { en: "Review", zh-CN: "评审" }
      maxIterations: 2
      until: checkpoints.review-gate.outcome == 'pass'
      onMaxIterations: continue
      phases:
        - id: review-round
          name: { en: "Round", zh-CN: "轮次" }
          steps:
            - id: review
              kind: agent
              agent: reviewer
              model: { role: coding }
              instructions: "Review it"
              produces: [review-report]
            - id: review-gate
              kind: checkpoint
              checkpoint: { kind: review-gate, source: review-report, title: { en: "Findings", zh-CN: "评审结果" } }
            - id: fix
              kind: agent
              agent: implementer
              model: { role: coding }
              when: checkpoints.review-gate.outcome == 'fix'
              instructions: "Fix \${checkpoints.review-gate.selectedFindings}"
              produces: [changes]
    - id: publish
      name: { en: "Publish", zh-CN: "发布" }
      steps:
        - { id: push, kind: system, action: git.push }
        - id: open-pr
          kind: system
          action: pr.open
          with: { title: "\${run.taskTitle}" }
          produces: [pull-request]
  outputs:
    artifacts:
      - { key: questions, kind: json, required: false }
      - { key: changes, kind: patch, required: false }
      - { key: review-report, kind: json, required: true }
      - { key: pull-request, kind: link, required: true }
`;

const FINDINGS = [
  { id: "f1", severity: "major", title: "Bug A", detail: "boom" },
  { id: "f2", severity: "minor", title: "Nit B", detail: "meh" },
];

const SCRIPT: Record<string, FakeStepBehavior> = {
  analyze: {
    kind: "succeed",
    events: [
      {
        type: "artifact",
        key: "questions",
        kind: "json",
        inline: { questions: [{ id: "q1", text: "Which flavor?", recommended: "vanilla" }] },
      },
    ],
  },
  "review@1": {
    kind: "succeed",
    events: [
      { type: "artifact", key: "review-report", kind: "json", inline: { findings: FINDINGS } },
    ],
  },
  "review@2": {
    kind: "succeed",
    events: [{ type: "artifact", key: "review-report", kind: "json", inline: { findings: [] } }],
  },
};

describe.skipIf(!dbUp)("checkpoint interaction api (respond, comments, agent slots)", () => {
  let app: App;
  let db: Awaited<ReturnType<typeof freshTestDb>>;
  let admin: TestClient;
  let member: TestClient;
  let viewer: TestClient;
  let projectId: string;
  let repoConnectionId: string;
  let taskTypeId: string;
  let runId: string;
  let forgeId: string;
  let navigatorId: string;
  const bus = new InProcessEventBus();
  const scm = new FakeScmService();

  const fakeQueue: RunQueue = {
    enqueueRun: async () => {},
    enqueueApprovalExpiry: async () => {},
  };

  const engineDeps = (): EngineDeps => ({
    db,
    executors: { fake: new FakeExecutor(SCRIPT) },
    bus,
    workspace: new FakeWorkspaceManager(),
    resources: new FakeResourceMaterializer(),
    artifacts: new InMemoryArtifactStore(),
    scm,
    logger: silentLogger,
  });

  beforeAll(async () => {
    db = await freshTestDb();
    app = createApp({ db, queue: fakeQueue, bus });
    admin = await signUp(app, "Root", "root@example.com");
    member = await signUp(app, "Mia", "mia@example.com");
    viewer = await signUp(app, "Vera", "vera@example.com");

    projectId = (
      await jsonOf<{ id: string }>(
        await admin.request("/api/v1/projects", {
          method: "POST",
          json: { slug: "ckpt", name: "Checkpoints" },
        }),
      )
    ).id;
    await admin.request(`/api/v1/projects/${projectId}/members`, {
      method: "POST",
      json: { email: "mia@example.com", role: "member" },
    });
    await admin.request(`/api/v1/projects/${projectId}/members`, {
      method: "POST",
      json: { email: "vera@example.com", role: "viewer" },
    });
    const models = await jsonOf<Array<{ id: string }>>(await admin.request("/api/v1/models"));
    await admin.request(`/api/v1/projects/${projectId}/grants`, {
      method: "PUT",
      json: models.map((m) => ({ resourceType: "model", resourceId: m.id })),
    });
    const [conn] = await db
      .insert(repoConnections)
      .values({ projectId, provider: "github", url: "https://github.com/acme/widget.git" })
      .returning();
    repoConnectionId = conn?.id as string;

    // publish the v2 fixture template + a task type bound to it
    const { compiled, checksum } = compileTemplate(V2_YAML);
    const [scenario] = await db
      .select()
      .from(scenarios)
      .where(eq(scenarios.slug, "software-development"));
    const fabriRows = await db.select().from(fabri);
    forgeId = fabriRows.find((f) => f.slug === "forge")?.id as string;
    navigatorId = fabriRows.find((f) => f.slug === "navigator")?.id as string;
    const [head] = await db
      .insert(orchestrationTemplates)
      .values({
        slug: compiled.metadata.slug,
        scenarioId: scenario?.id as string,
        nameI18n: compiled.metadata.name,
      })
      .returning();
    const [version] = await db
      .insert(templateVersions)
      .values({
        templateId: head?.id as string,
        version: 1,
        status: "published",
        sourceYaml: V2_YAML,
        compiled: compiled as unknown as Record<string, unknown>,
        checksum,
        publishedAt: new Date(),
      })
      .returning();
    await db
      .update(orchestrationTemplates)
      .set({ latestPublishedVersionId: version?.id })
      .where(eq(orchestrationTemplates.id, head?.id as string));
    const [taskType] = await db
      .insert(taskTypes)
      .values({
        scenarioId: scenario?.id as string,
        slug: "checkpoint-fixture",
        nameI18n: compiled.metadata.name,
        descriptionI18n: compiled.metadata.description,
        templateId: head?.id as string,
        defaultFaberId: forgeId,
      })
      .returning();
    taskTypeId = taskType?.id as string;
  });

  it("exposes agent slots on the task-type detail", async () => {
    const detail = await jsonOf<{
      agents: Record<string, { overridable: boolean; defaultExecutorId: string }>;
      fabriOptions: Array<{ slug: string }>;
    }>(await member.request(`/api/v1/task-types/${taskTypeId}`));
    expect(Object.keys(detail.agents)).toEqual(["implementer", "reviewer"]);
    expect(detail.agents.reviewer?.defaultExecutorId).toBe("fake");
    expect(detail.fabriOptions.map((f) => f.slug)).toContain("sentinel");
  });

  it("submits with agent overrides and freezes slot bindings onto the run", async () => {
    // unknown slot → 400
    const badSlot = await member.request(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      json: {
        taskTypeId,
        title: "Deliver it",
        params: { requirement: "Add dark mode", repo: { repoConnectionId } },
        agents: { ghost: { faberId: navigatorId } },
      },
    });
    expect(badSlot.status).toBe(400);
    expect((await jsonOf<{ code: string }>(badSlot)).code).toBe("slot_unknown");

    // codex needs an openai model — none granted, so submit fails actionably
    const noProvider = await member.request(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      json: {
        taskTypeId,
        title: "Deliver it",
        params: { requirement: "Add dark mode", repo: { repoConnectionId } },
        agents: { reviewer: { executorId: "codex-cli" } },
      },
    });
    expect(noProvider.status).toBe(400);
    expect((await jsonOf<{ code: string }>(noProvider)).code).toBe("model_unresolvable");

    const res = await member.request(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      json: {
        taskTypeId,
        title: "Deliver dark mode",
        params: { requirement: "Add dark mode", repo: { repoConnectionId } },
        agents: { reviewer: { faberId: navigatorId } },
      },
    });
    expect(res.status).toBe(202);
    runId = (await jsonOf<{ runId: string }>(res)).runId;

    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run?.agentBindings.implementer?.faberId).toBe(forgeId);
    expect(run?.agentBindings.reviewer?.faberId).toBe(navigatorId);
    expect(run?.executorId).toBe("fake"); // primary slot denormalization
    // model resolution is slot-keyed now
    expect(Object.keys(run?.modelResolution ?? {}).sort()).toEqual(["implementer", "reviewer"]);
  });

  it("pauses at the input checkpoint and enforces respond kind + RBAC + answers", async () => {
    expect(await executeRun(engineDeps(), runId)).toBe("waiting_approval");
    const detail = await jsonOf<{
      agents: Record<string, { executorLabel: string; faberSlug: string }>;
      checkpoints: Array<{ id: string; kind: string; status: string }>;
      workBranch: string | null;
    }>(await member.request(`/api/v1/runs/${runId}`));
    expect(detail.workBranch).toBe(`agrippa/run-1`);
    expect(detail.agents.reviewer?.faberSlug).toBe("navigator");
    const pending = detail.checkpoints.find((ckpt) => ckpt.status === "pending");
    expect(pending?.kind).toBe("input");
    const checkpointId = pending?.id as string;

    // the generalized inbox carries the kind
    const inbox = await jsonOf<Array<{ id: string; kind: string }>>(
      await member.request("/api/v1/checkpoints/pending"),
    );
    expect(inbox.find((i) => i.id === checkpointId)?.kind).toBe("input");

    // viewers cannot respond
    const denied = await viewer.request(
      `/api/v1/runs/${runId}/checkpoints/${checkpointId}/respond`,
      {
        method: "POST",
        json: { kind: "input", answers: { q1: "vanilla" } },
      },
    );
    expect(denied.status).toBe(403);

    // kind mismatch is rejected
    const wrongKind = await member.request(
      `/api/v1/runs/${runId}/checkpoints/${checkpointId}/respond`,
      { method: "POST", json: { kind: "approval", decision: "approved" } },
    );
    expect(wrongKind.status).toBe(409);

    // required answers enforced against the snapshot
    const missing = await member.request(
      `/api/v1/runs/${runId}/checkpoints/${checkpointId}/respond`,
      { method: "POST", json: { kind: "input", answers: {} } },
    );
    expect(missing.status).toBe(400);

    const ok = await member.request(`/api/v1/runs/${runId}/checkpoints/${checkpointId}/respond`, {
      method: "POST",
      json: { kind: "input", answers: { q1: "vanilla" } },
    });
    expect(ok.status).toBe(200);

    // double-respond conflicts
    const again = await member.request(
      `/api/v1/runs/${runId}/checkpoints/${checkpointId}/respond`,
      { method: "POST", json: { kind: "input", answers: { q1: "chocolate" } } },
    );
    expect(again.status).toBe(409);
  });

  it("review-gate respond validates findings and drives the fix round to a PR", async () => {
    expect(await executeRun(engineDeps(), runId)).toBe("waiting_approval");
    const [gate] = await db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.runId, runId), eq(checkpoints.status, "pending")));
    expect(gate?.kind).toBe("review-gate");

    // fix with no selection / unknown ids → 400
    const empty = await member.request(`/api/v1/runs/${runId}/checkpoints/${gate?.id}/respond`, {
      method: "POST",
      json: { kind: "review-gate", outcome: "fix", selectedFindingIds: [] },
    });
    expect(empty.status).toBe(400);
    const unknown = await member.request(`/api/v1/runs/${runId}/checkpoints/${gate?.id}/respond`, {
      method: "POST",
      json: { kind: "review-gate", outcome: "fix", selectedFindingIds: ["nope"] },
    });
    expect(unknown.status).toBe(400);

    const ok = await member.request(`/api/v1/runs/${runId}/checkpoints/${gate?.id}/respond`, {
      method: "POST",
      json: { kind: "review-gate", outcome: "fix", selectedFindingIds: ["f1"] },
    });
    expect(ok.status).toBe(200);
    const decided = await jsonOf<{
      response: { outcome: string; selectedFindings: unknown[]; acceptedFindingIds: string[] };
    }>(ok);
    expect(decided.response.outcome).toBe("fix");
    expect(decided.response.selectedFindings).toHaveLength(1);
    expect(decided.response.acceptedFindingIds).toEqual(["f2"]);

    // fix runs, round 2 reviews clean, platform pushes + opens the PR
    expect(await executeRun(engineDeps(), runId)).toBe("succeeded");
    expect(scm.pullRequests).toHaveLength(1);
    expect(scm.pullRequests[0]?.spec.title).toBe("Deliver dark mode");
    expect(scm.pullRequests[0]?.spec.body).toContain("Nit B"); // waived finding listed
  });

  it("comments post as members, stream as run events, and stay read-only for viewers", async () => {
    const denied = await viewer.request(`/api/v1/runs/${runId}/comments`, {
      method: "POST",
      json: { body: "sneaky" },
    });
    expect(denied.status).toBe(403);

    const created = await member.request(`/api/v1/runs/${runId}/comments`, {
      method: "POST",
      json: { body: "Looks great — shipping it." },
    });
    expect(created.status).toBe(201);

    const list = await jsonOf<Array<{ body: string; userName: string }>>(
      await viewer.request(`/api/v1/runs/${runId}/comments`),
    );
    expect(list).toHaveLength(1);
    expect(list[0]?.userName).toBe("Mia");

    const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId));
    const commentEvent = events.find((e) => e.type === "comment.added");
    expect(commentEvent).toBeDefined();
    const payload = commentEvent?.payload as { user: { name: string } } | undefined;
    expect(payload?.user.name).toBe("Mia");
  });
});
