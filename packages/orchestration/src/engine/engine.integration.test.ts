import { describe, expect, it } from "bun:test";
import path from "node:path";
import {
  artifacts,
  checkpoints,
  createDb,
  type Db,
  migrateDb,
  models,
  orchestrationTemplates,
  projectQuotas,
  projectResourceGrants,
  projects,
  runEvents,
  runSteps,
  runs,
  seed,
  tasks,
  taskTypes,
  templateVersions,
  tokenUsage,
  users,
} from "@agrippa/db";
import { FakeExecutor, type FakeStepBehavior } from "@agrippa/executor-core";
import { and, asc, eq, sql } from "drizzle-orm";
import { compileTemplate } from "../compile";
import { buildParamsValidator, resolveModelRoles } from "../resolve";
import { seedBuiltinTemplates } from "../seed-builtins";
import type { TemplateDoc } from "../template-schema";
import { InProcessEventBus } from "./bus";
import type { EngineDeps } from "./deps";
import { ExecutorUnavailableError, executeRun } from "./engine";
import {
  FakeResourceMaterializer,
  FakeScmService,
  FakeWorkspaceManager,
  InMemoryArtifactStore,
  silentLogger,
} from "./fakes";
import {
  appendRunEvent,
  decideCheckpoint,
  finalizeRun,
  findStrandedCheckpointRuns,
  transitionRun,
} from "./run-lifecycle";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/agrippa_test";
const TEMPLATES_DIR = path.resolve(import.meta.dirname, "../../../../templates");

// one pool for the whole suite — a pool per fixture exhausts max_connections
const sharedDb = createDb(TEST_DATABASE_URL);
let dbUp = true;
try {
  await sharedDb.execute(sql`select 1`);
} catch {
  dbUp = false;
  console.warn("[test] postgres unreachable — skipping engine integration suite");
}

type Fixture = {
  db: Db;
  runId: string;
  template: TemplateDoc;
  bus: InProcessEventBus;
  workspace: FakeWorkspaceManager;
  makeDeps: (
    script: Record<string, FakeStepBehavior>,
    opts?: DepsOptions,
  ) => EngineDeps & {
    executor: FakeExecutor;
  };
};

type DepsOptions = { mcpServers?: string[]; skills?: string[] };

type FixtureOptions = {
  params?: Record<string, unknown>;
  quota?: { costLimitUsd?: number; tokenLimit?: number };
  /** Override the run's authorized-resource manifest (default: all template resources). */
  resourceManifest?: { mcpServers: string[]; skills: string[] };
};

async function setupFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const db = sharedDb;
  await db.execute(sql`drop schema public cascade`);
  await db.execute(sql`create schema public`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await migrateDb(db);
  await seed(db);
  await seedBuiltinTemplates(db, TEMPLATES_DIR);

  const orgRows = (await db.execute(sql`select id from orgs limit 1`)) as Array<{ id: string }>;
  const orgId = orgRows[0]?.id;
  if (!orgId) throw new Error("fixture: org missing after seed");
  const [user] = await db
    .insert(users)
    .values({
      id: Bun.randomUUIDv7(),
      name: "Engine Tester",
      email: `engine-${Bun.randomUUIDv7()}@example.com`,
      orgId,
    })
    .returning();
  if (!user) throw new Error("fixture: user insert failed");

  const [project] = await db
    .insert(projects)
    .values({ orgId: user.orgId, slug: "engine-test", name: "Engine Test", createdBy: user.id })
    .returning();
  if (!project) throw new Error("fixture: project insert failed");

  // grant all seeded models
  const allModels = await db.select().from(models);
  await db.insert(projectResourceGrants).values(
    allModels.map((m) => ({
      projectId: project.id,
      resourceType: "model" as const,
      resourceId: m.id,
      grantedBy: user.id,
    })),
  );
  if (options.quota) {
    await db.insert(projectQuotas).values({
      projectId: project.id,
      costLimitUsd: options.quota.costLimitUsd?.toString(),
      tokenLimit: options.quota.tokenLimit,
      hardStop: true,
    });
  }

  // pinned template: swdev.bug-localize-fix v1
  const [head] = await db
    .select()
    .from(orchestrationTemplates)
    .where(eq(orchestrationTemplates.slug, "swdev.bug-localize-fix"));
  if (!head?.latestPublishedVersionId) throw new Error("fixture: builtin template not published");
  const [version] = await db
    .select()
    .from(templateVersions)
    .where(eq(templateVersions.id, head.latestPublishedVersionId));
  if (!version) throw new Error("fixture: template version missing");
  const template = version.compiled as unknown as TemplateDoc;

  const [taskType] = await db.select().from(taskTypes).where(eq(taskTypes.templateId, head.id));
  if (!taskType) throw new Error("fixture: task type missing");

  const validator = buildParamsValidator(template.spec.inputs);
  const params = validator.parse({
    bugReport: "The widget crashes on empty input",
    repo: { repoConnectionId: Bun.randomUUIDv7() },
    ...options.params,
  });
  const modelResolution = await resolveModelRoles(db, project.id, template.spec.models);

  const [task] = await db
    .insert(tasks)
    .values({
      orgId: user.orgId,
      projectId: project.id,
      taskTypeId: taskType.id,
      title: "Fix widget crash",
      params,
      createdBy: user.id,
    })
    .returning();
  if (!task) throw new Error("fixture: task insert failed");

  const [run] = await db
    .insert(runs)
    .values({
      taskId: task.id,
      projectId: project.id,
      number: 1,
      templateVersionId: version.id,
      faberId: taskType.defaultFaberId,
      executorId: "fake",
      paramsSnapshot: params,
      modelResolution,
      resourceManifest: options.resourceManifest ?? {
        mcpServers: template.spec.resources.mcpServers.map((m) => m.ref),
        skills: template.spec.resources.skills.map((s) => s.ref.split("@")[0] as string),
      },
      budget: template.spec.budgets as unknown as Record<string, unknown>,
      createdBy: user.id,
    })
    .returning();
  if (!run) throw new Error("fixture: run insert failed");

  const bus = new InProcessEventBus();
  const workspace = new FakeWorkspaceManager();

  const makeDeps: Fixture["makeDeps"] = (script, opts = {}) => {
    const executor = new FakeExecutor(script);
    return {
      db,
      executors: { fake: executor },
      executor,
      bus,
      workspace,
      resources: new FakeResourceMaterializer({
        mcpServers: opts.mcpServers ?? [],
        ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
      }),
      artifacts: new InMemoryArtifactStore(),
      logger: silentLogger,
    };
  };

  return { db, runId: run.id, template, bus, workspace, makeDeps };
}

/** Standard scripts producing the contract artifacts. */
const HAPPY_SCRIPT: Record<string, FakeStepBehavior> = {
  "reproduce-bug": {
    kind: "succeed",
    usage: { inputTokens: 1000, outputTokens: 500 },
    events: [{ type: "artifact", key: "reproduction-report", kind: "markdown", inline: "# Repro" }],
    output: "reproduced",
  },
  "find-root-cause": {
    kind: "succeed",
    usage: { inputTokens: 2000, outputTokens: 1000 },
    events: [
      { type: "artifact", key: "localization-report", kind: "markdown", inline: "# Root cause" },
    ],
    output: "found root cause in widget.ts",
  },
  "implement-fix": {
    kind: "succeed",
    usage: { inputTokens: 3000, outputTokens: 1500 },
    output: "fix implemented",
    // no patch artifact — the engine generates it via workspace.diff
  },
  "run-tests": {
    kind: "succeed",
    usage: { inputTokens: 500, outputTokens: 200 },
    output: "all green",
  },
  summarize: {
    kind: "succeed",
    usage: { inputTokens: 400, outputTokens: 300 },
    events: [{ type: "artifact", key: "fix-report", kind: "markdown", inline: "# Fixed" }],
    output: "done",
  },
};

async function approve(db: Db, runId: string): Promise<void> {
  await db
    .update(checkpoints)
    .set({ status: "approved", decidedAt: new Date() })
    .where(eq(checkpoints.runId, runId));
}

describe.skipIf(!dbUp)("orchestration engine (FakeExecutor compliance suite)", () => {
  it("runs to the approval gate, pauses without holding state, then resumes to success", async () => {
    const { db, runId, makeDeps, workspace } = await setupFixture();
    const deps = makeDeps(HAPPY_SCRIPT);

    // Leg 1 → waiting_approval
    expect(await executeRun(deps, runId)).toBe("waiting_approval");
    const [run1] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run1?.status).toBe("waiting_approval");
    const [approval] = await db.select().from(checkpoints).where(eq(checkpoints.runId, runId));
    expect(approval?.status).toBe("pending");
    expect(approval?.checkpointId).toBe("approve-fix-plan");

    const stepsAfterLeg1 = await db
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, runId))
      .orderBy(asc(runSteps.seq));
    expect(stepsAfterLeg1.map((s) => [s.stepId, s.status])).toEqual([
      ["setup", "succeeded"],
      ["reproduce-bug", "succeeded"],
      ["find-root-cause", "succeeded"],
      // the approval gate is a checkpoint step now — its pause is a step row
      ["approve-fix-plan", "waiting_approval"],
    ]);
    // system step performed the checkout with the resolved repoRef object
    expect(workspace.checkouts).toHaveLength(1);
    expect(workspace.checkouts[0]?.spec).toHaveProperty("repo.repoConnectionId");

    // Leg 2: approve → resume → succeed
    await approve(db, runId);
    const deps2 = makeDeps(HAPPY_SCRIPT);
    expect(await executeRun(deps2, runId)).toBe("succeeded");

    const [run2] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run2?.status).toBe("succeeded");
    expect(Number((run2?.usageTotals as { costUsd: number } | null)?.costUsd)).toBeGreaterThan(0);

    // succeeded steps were NOT re-executed on resume
    expect(deps2.executor.attempts.get("reproduce-bug")).toBeUndefined();
    expect(deps2.executor.attempts.get("find-root-cause")).toBeUndefined();

    // open-pr skipped (autoOpenPr=false); patch auto-generated by the engine
    const stepRows = await db.select().from(runSteps).where(eq(runSteps.runId, runId));
    expect(stepRows.find((s) => s.stepId === "open-pr")?.status).toBe("skipped");
    const artifactRows = await db.select().from(artifacts).where(eq(artifacts.runId, runId));
    const keys = artifactRows.map((a) => a.artifactKey).sort();
    expect(keys).toEqual(["fix-report", "localization-report", "patch", "reproduction-report"]);
    expect(artifactRows.find((a) => a.artifactKey === "patch")?.inline).toContain("diff --git");

    // event log is a gap-free, monotonically increasing sequence
    const events = await db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.seq));
    expect(events[0]?.type).toBe("run.started");
    expect(events.at(-1)?.type).toBe("run.succeeded");
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.some((e) => e.type === "checkpoint.required")).toBe(true);
    expect(events.some((e) => e.type === "run.resumed")).toBe(true);

    // workspace cleaned up on terminal state
    expect(workspace.cleaned).toContain(runId);
  });

  it("rejecting the checkpoint fails the run with approval_rejected", async () => {
    const { db, runId, makeDeps } = await setupFixture();
    await executeRun(makeDeps(HAPPY_SCRIPT), runId);
    await db
      .update(checkpoints)
      .set({ status: "rejected", decidedAt: new Date() })
      .where(eq(checkpoints.runId, runId));

    expect(await executeRun(makeDeps(HAPPY_SCRIPT), runId)).toBe("failed");
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect((run?.error as { code: string } | null)?.code).toBe("approval_rejected");
  });

  it("retries a failing step and succeeds on the second attempt", async () => {
    const { db, runId, makeDeps } = await setupFixture();
    const script: Record<string, FakeStepBehavior> = {
      ...HAPPY_SCRIPT,
      "run-tests": {
        kind: "fail",
        failuresBeforeSuccess: 1,
        usage: { inputTokens: 100, outputTokens: 50 },
      },
    };
    await executeRun(makeDeps(script), runId);
    await approve(db, runId);
    const deps = makeDeps(script);
    expect(await executeRun(deps, runId)).toBe("succeeded");
    expect(deps.executor.attempts.get("run-tests")).toBe(2);

    const attempts = await db
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, runId), eq(runSteps.stepId, "run-tests")));
    expect(attempts.map((a) => [a.attempt, a.status]).sort()).toEqual([
      [1, "failed"],
      [2, "succeeded"],
    ]);
    // usage recorded once per attempt — no double counting
    const usageRows = await db.select().from(tokenUsage).where(eq(tokenUsage.runId, runId));
    expect(usageRows.filter((u) => u.attempt === 1).length).toBeGreaterThan(0);
  });

  it("onFailure: continue lets the run proceed past a permanently failing step", async () => {
    const { db, runId, makeDeps } = await setupFixture();
    const script: Record<string, FakeStepBehavior> = {
      ...HAPPY_SCRIPT,
      "reproduce-bug": { kind: "fail", message: "cannot reproduce" },
    };
    expect(await executeRun(makeDeps(script), runId)).toBe("waiting_approval");
    const rows = await db
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, runId), eq(runSteps.stepId, "reproduce-bug")));
    expect(rows[0]?.status).toBe("failed");
    // run kept going to the localize phase and the approval gate
    const [approval] = await db.select().from(checkpoints).where(eq(checkpoints.runId, runId));
    expect(approval?.status).toBe("pending");
  });

  it("aborts the run when the template budget is exceeded", async () => {
    const { db, runId, makeDeps } = await setupFixture();
    // strong-tier output at $25/MTok: 2M output tokens ≈ $50 > $8 budget
    const script: Record<string, FakeStepBehavior> = {
      ...HAPPY_SCRIPT,
      "find-root-cause": {
        kind: "succeed",
        usage: { inputTokens: 10_000, outputTokens: 2_000_000 },
        output: "expensive",
      },
    };
    expect(await executeRun(makeDeps(script), runId)).toBe("failed");
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect((run?.error as { code: string } | null)?.code).toBe("budget_exceeded");
  });

  it("hard-stop project quota aborts mid-run", async () => {
    const { db, runId, makeDeps } = await setupFixture({ quota: { tokenLimit: 2000 } });
    expect(await executeRun(makeDeps(HAPPY_SCRIPT), runId)).toBe("failed");
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect((run?.error as { code: string } | null)?.code).toBe("budget_exceeded");
  });

  it("resume does not double-count the run's own spend against the quota", async () => {
    const { runId, makeDeps } = await setupFixture({ quota: { tokenLimit: 3000 } });
    // cheap pre-approval steps: reproduce-bug spends 1600, find-root-cause 200
    const cheap: Record<string, FakeStepBehavior> = {
      ...HAPPY_SCRIPT,
      "reproduce-bug": {
        kind: "succeed",
        usage: { inputTokens: 1000, outputTokens: 600 },
        events: [{ type: "artifact", key: "reproduction-report", kind: "markdown", inline: "# R" }],
        output: "reproduced",
      },
      "find-root-cause": {
        kind: "succeed",
        usage: { inputTokens: 100, outputTokens: 100 },
        events: [
          { type: "artifact", key: "localization-report", kind: "markdown", inline: "# RC" },
        ],
        output: "rc",
      },
    };
    // spend 1600, then crash before the approval gate
    await expect(
      executeRun(makeDeps({ ...cheap, "find-root-cause": { kind: "crash" } }), runId),
    ).rejects.toThrow("simulated worker crash");

    // 1600 is already persisted. The old code subtracted it from the headroom
    // AND seeded the meter with it, double-counting on resume and tripping the
    // 3000 quota (1600 > 3000 - 1600). It must instead reach the approval gate.
    expect(await executeRun(makeDeps(cheap), runId)).toBe("waiting_approval");
  });

  it("crash mid-step → queue retry resumes, skips succeeded steps, never double-counts usage", async () => {
    const { db, runId, makeDeps } = await setupFixture();
    await executeRun(makeDeps(HAPPY_SCRIPT), runId);
    await approve(db, runId);

    // the worker dies during run-tests, after usage was recorded
    const crashing = makeDeps({
      ...HAPPY_SCRIPT,
      "run-tests": { kind: "crash", usage: { inputTokens: 100, outputTokens: 50 } },
    });
    await expect(executeRun(crashing, runId)).rejects.toThrow("simulated worker crash");
    const [afterCrash] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(afterCrash?.status).toBe("running"); // not finalized — pg-boss will retry

    // retry with a healthy worker
    const healthy = makeDeps(HAPPY_SCRIPT);
    expect(await executeRun(healthy, runId)).toBe("succeeded");

    // implement-fix succeeded before the crash — not re-executed
    expect(healthy.executor.attempts.get("implement-fix")).toBeUndefined();
    // run-tests re-ran as attempt 2; crashed attempt-1 row marked failed
    const attempts = await db
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, runId), eq(runSteps.stepId, "run-tests")));
    expect(attempts.map((a) => [a.attempt, a.status]).sort()).toEqual([
      [1, "failed"],
      [2, "succeeded"],
    ]);
    // usage rows keyed by attempt: crash usage kept once, retry usage separate
    const usageRows = await db.select().from(tokenUsage).where(eq(tokenUsage.runId, runId));
    const runTestRows = usageRows.filter((u) => attempts.map((a) => a.id).includes(u.stepId ?? ""));
    expect(runTestRows).toHaveLength(2);
  });

  it("crash on a no-retry step re-executes it on resume and resumes the session", async () => {
    const { db, runId, makeDeps } = await setupFixture();
    // find-root-cause carries no template retry; crash it mid-step
    const crashing = makeDeps({ ...HAPPY_SCRIPT, "find-root-cause": { kind: "crash" } });
    await expect(executeRun(crashing, runId)).rejects.toThrow("simulated worker crash");

    // resume with a healthy worker: without the crash-recovery fix a no-retry
    // step's loop is `for (2; 2 <= 1)` and the step is silently skipped
    const healthy = makeDeps(HAPPY_SCRIPT);
    expect(await executeRun(healthy, runId)).toBe("waiting_approval");

    const attempts = await db
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, runId), eq(runSteps.stepId, "find-root-cause")));
    expect(attempts.map((a) => [a.attempt, a.status]).sort()).toEqual([
      [1, "failed"],
      [2, "succeeded"],
    ]);
    // the recovery attempt resumed the crashed executor session
    const request = healthy.executor.requests.find((r) => r.stepId === "find-root-cause");
    expect(request?.resumeSessionId).toBe("fake-find-root-cause-1");
  });

  it("cancellation mid-step aborts promptly via the control channel", async () => {
    const { db, runId, makeDeps, bus } = await setupFixture();
    const deps = makeDeps({ ...HAPPY_SCRIPT, "find-root-cause": { kind: "hang" } });

    const running = executeRun(deps, runId);
    // wait until the hanging step is live
    for (let i = 0; i < 100; i++) {
      const rows = await db
        .select()
        .from(runSteps)
        .where(and(eq(runSteps.runId, runId), eq(runSteps.stepId, "find-root-cause")));
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await db.update(runs).set({ cancelRequested: true }).where(eq(runs.id, runId));
    await bus.publishControl(runId, "cancel");

    expect(await running).toBe("cancelled");
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run?.status).toBe("cancelled");
    const rows = await db
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, runId), eq(runSteps.stepId, "find-root-cause")));
    expect(rows[0]?.status).toBe("cancelled");
  });

  it("expired duration budget times the run out on pickup", async () => {
    const { db, runId, makeDeps } = await setupFixture();
    // simulate a run that started 46 minutes ago (budget: 45m)
    await db
      .update(runs)
      .set({ status: "running", startedAt: new Date(Date.now() - 46 * 60_000) })
      .where(eq(runs.id, runId));
    expect(await executeRun(makeDeps(HAPPY_SCRIPT), runId)).toBe("timed_out");
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run?.status).toBe("timed_out");
  });

  it("fails with contract_violation when required artifacts were never produced", async () => {
    const { db, runId, makeDeps } = await setupFixture();
    // steps succeed but emit no artifacts at all (and no patch is required to
    // be emitted by the executor — but localization-report never appears)
    const bare: Record<string, FakeStepBehavior> = {};
    await executeRun(makeDeps(bare), runId);
    await approve(db, runId);
    expect(await executeRun(makeDeps(bare), runId)).toBe("failed");
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect((run?.error as { code: string } | null)?.code).toBe("contract_violation");
    expect((run?.error as { message: string } | null)?.message).toContain("localization-report");
  });

  it("runs open-pr when autoOpenPr is true and the optional MCP server is available", async () => {
    const { db, runId, makeDeps } = await setupFixture({ params: { autoOpenPr: true } });
    const script: Record<string, FakeStepBehavior> = {
      ...HAPPY_SCRIPT,
      "open-pr": {
        kind: "succeed",
        events: [
          { type: "artifact", key: "pr-link", kind: "link", inline: "https://github.com/x/1" },
        ],
        output: "pr opened",
      },
    };
    await executeRun(makeDeps(script, { mcpServers: ["github"] }), runId);
    await approve(db, runId);
    const deps = makeDeps(script, { mcpServers: ["github"] });
    expect(await executeRun(deps, runId)).toBe("succeeded");
    const rows = await db
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, runId), eq(runSteps.stepId, "open-pr")));
    expect(rows.at(-1)?.status).toBe("succeeded");
    // the executor received the resolved MCP server
    const request = deps.executor.requests.find((r) => r.stepId === "open-pr");
    expect(request?.mcpServers.map((m) => m.slug)).toEqual(["github"]);
  });

  it("skips open-pr when the optional MCP server is unavailable", async () => {
    const { db, runId, makeDeps } = await setupFixture({ params: { autoOpenPr: true } });
    await executeRun(makeDeps(HAPPY_SCRIPT), runId);
    await approve(db, runId);
    expect(await executeRun(makeDeps(HAPPY_SCRIPT), runId)).toBe("succeeded");
    const rows = await db
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, runId), eq(runSteps.stepId, "open-pr")));
    expect(rows[0]?.status).toBe("skipped");
  });

  it("skips open-pr when the optional MCP server is not authorized, even if it exists", async () => {
    // manifest omits github: the project has no grant. The server is otherwise
    // available (materializer has it), but an ungranted optional resource must
    // never be resolved — else the run would receive the global GitHub token.
    const { db, runId, makeDeps } = await setupFixture({
      params: { autoOpenPr: true },
      resourceManifest: { mcpServers: [], skills: [] },
    });
    await executeRun(makeDeps(HAPPY_SCRIPT, { mcpServers: ["github"] }), runId);
    await approve(db, runId);
    const deps = makeDeps(HAPPY_SCRIPT, { mcpServers: ["github"] });
    expect(await executeRun(deps, runId)).toBe("succeeded");
    const rows = await db
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, runId), eq(runSteps.stepId, "open-pr")));
    expect(rows[0]?.status).toBe("skipped");
    // the executor never saw the github server
    expect(deps.executor.requests.some((r) => r.stepId === "open-pr")).toBe(false);
  });

  it("fails a step whose required skill has no available version", async () => {
    const { db, runId, makeDeps } = await setupFixture();
    await executeRun(makeDeps(HAPPY_SCRIPT), runId);
    await approve(db, runId);
    // no skills resolve — implement-fix's required builtin/git-workflow is missing
    expect(await executeRun(makeDeps(HAPPY_SCRIPT, { skills: [] }), runId)).toBe("failed");
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect((run?.error as { message?: string } | null)?.message).toContain(
      "required resources unavailable",
    );
  });

  it("streams live events over the bus while executing", async () => {
    const { runId, makeDeps, bus } = await setupFixture();
    const seen: string[] = [];
    const subscription = bus.subscribe(runId, (event) => seen.push(event.type));
    await executeRun(makeDeps(HAPPY_SCRIPT), runId);
    subscription.unsubscribe();
    expect(seen[0]).toBe("run.started");
    expect(seen).toContain("step.started");
    expect(seen).toContain("usage");
    expect(seen).toContain("checkpoint.required");
  });

  it("redacts known secret values from persisted events", async () => {
    const secret = "sk-ant-supersecretvalue-1234567890";
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = secret; // the engine seeds its redactor from env
    let db: Db;
    let runId: string;
    try {
      const fx = await setupFixture();
      db = fx.db;
      runId = fx.runId;
      const script: Record<string, FakeStepBehavior> = {
        ...HAPPY_SCRIPT,
        "reproduce-bug": {
          kind: "succeed",
          events: [
            { type: "message.completed", role: "assistant", text: `the key is ${secret} oops` },
            { type: "artifact", key: "reproduction-report", kind: "markdown", inline: "# R" },
          ],
          output: "done",
        },
      };
      await executeRun(fx.makeDeps(script), runId);
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
    const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId));
    const msg = events.find((e) => e.type === "message.completed");
    const serialized = JSON.stringify(msg?.payload);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain(secret);
  });
});

describe.skipIf(!dbUp)("run-lifecycle module", () => {
  it("transitionRun is a compare-and-swap on the expected status", async () => {
    const { db, runId } = await setupFixture();
    // queued → running applies once; a second call with the stale `from` fails
    expect(await transitionRun(db, runId, "queued", "running")).toBe(true);
    expect(await transitionRun(db, runId, "queued", "running")).toBe(false);
    // a late finalize cannot overwrite a status it no longer holds
    expect(await transitionRun(db, runId, "running", "cancelled")).toBe(true);
    expect(await transitionRun(db, runId, "running", "succeeded")).toBe(false);
    const [row] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
    expect(row?.status).toBe("cancelled");
  });

  it("appendRunEvent allocates a monotonic per-run seq from the database", async () => {
    const { db, runId } = await setupFixture();
    const a = await appendRunEvent(db, { runId, type: "x.one", payload: {} });
    const b = await appendRunEvent(db, { runId, type: "x.two", payload: {} });
    // concurrent appends must not collide on the unique (run_id, seq) index
    const [c, d] = await Promise.all([
      appendRunEvent(db, { runId, type: "x.three", payload: {} }),
      appendRunEvent(db, { runId, type: "x.four", payload: {} }),
    ]);
    const seqs = [a.seq, b.seq, c.seq, d.seq].sort((m, n) => m - n);
    expect(new Set(seqs).size).toBe(4);
    expect(b.seq).toBeGreaterThan(a.seq);

    // must also work INSIDE a transaction — the old max(seq)+1-with-retry aborted
    // the whole tx on the first unique violation (the approval-flow regression)
    const e = await db.transaction((tx) =>
      appendRunEvent(tx, { runId, type: "x.five", payload: {} }),
    );
    expect(e.seq).toBeGreaterThan(d.seq);
  });

  it("findStrandedCheckpointRuns selects only runs with no pending approval", async () => {
    const { db, runId } = await setupFixture();
    await db.update(runs).set({ status: "waiting_approval" }).where(eq(runs.id, runId));

    // one pending approval → not stranded
    const [a1] = await db
      .insert(checkpoints)
      .values({ runId, checkpointId: "cp-1", status: "pending" })
      .returning();
    expect(await findStrandedCheckpointRuns(db)).not.toContain(runId);

    // a second, earlier checkpoint gets approved while cp-1 is still pending →
    // still not stranded (the multi-approval trap the old innerJoin fell into)
    await db
      .insert(checkpoints)
      .values({ runId, checkpointId: "cp-0", status: "approved" })
      .returning();
    expect(await findStrandedCheckpointRuns(db)).not.toContain(runId);

    // cp-1 decided too → now every approval is decided → stranded, re-enqueue
    await decideCheckpoint(db, a1?.id as string, { status: "approved" });
    expect(await findStrandedCheckpointRuns(db)).toContain(runId);
  });

  it("finalizeRun lets a late cancel win over a success (atomic, no read/CAS gap)", async () => {
    const { db, runId } = await setupFixture();
    await transitionRun(db, runId, "queued", "running");
    await db.update(runs).set({ cancelRequested: true }).where(eq(runs.id, runId));
    // a success that requires no pending cancel is refused, leaving status running
    const r = await finalizeRun(db, {
      runId,
      from: "running",
      to: "succeeded",
      requireNotCancelled: true,
      error: null,
      usageTotals: {},
      eventPayload: {},
    });
    expect(r.outcome).toBe("cancelled_instead");
    const [row] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
    expect(row?.status).toBe("running");
    // re-finalizing as cancelled commits
    const c = await finalizeRun(db, {
      runId,
      from: "running",
      to: "cancelled",
      error: null,
      usageTotals: {},
      eventPayload: {},
    });
    expect(c.outcome).toBe("finalized");
  });

  it("finalizeRun fails a still-queued run and emits the terminal event", async () => {
    const { db, runId } = await setupFixture();
    const err = { code: "internal", message: "boom" };
    const r = await finalizeRun(db, {
      runId,
      from: "queued",
      to: "failed",
      error: err,
      usageTotals: {},
      eventPayload: { error: err },
    });
    expect(r.outcome).toBe("finalized");
    const [run] = await db
      .select({ status: runs.status, finishedAt: runs.finishedAt })
      .from(runs)
      .where(eq(runs.id, runId));
    expect(run?.status).toBe("failed");
    expect(run?.finishedAt).not.toBeNull();
    const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId));
    expect(events.some((e) => e.type === "run.failed")).toBe(true);
  });

  it("decideCheckpoint is a compare-and-swap on pending", async () => {
    const { db, runId } = await setupFixture();
    const [approval] = await db
      .insert(checkpoints)
      .values({ runId, checkpointId: "cp-1", status: "pending" })
      .returning();
    const id = approval?.id as string;
    const first = await decideCheckpoint(db, id, { status: "approved" });
    expect(first?.status).toBe("approved");
    // a racing expiry cannot overwrite the user's decision
    const second = await decideCheckpoint(db, id, { status: "expired" });
    expect(second).toBeNull();
    const [row] = await db
      .select({ status: checkpoints.status })
      .from(checkpoints)
      .where(eq(checkpoints.id, id));
    expect(row?.status).toBe("approved");
  });
});

// ── agrippa/v2: slots, checkpoints, loops, SCM (requirement-delivery spine) ──

const V2_FIXTURE_YAML = `
apiVersion: agrippa/v2
kind: OrchestrationTemplate
metadata:
  slug: swdev.v2-loop-fixture
  scenario: software-development
  name: { en: "V2 Fixture", zh-CN: "V2 夹具" }
  description: { en: "engine compliance fixture", zh-CN: "引擎合规夹具" }
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
      review: { tier: balanced }
  phases:
    - id: setup
      name: { en: "Setup", zh-CN: "准备" }
      steps:
        - { id: checkout, kind: system, action: workspace.checkout }
        - { id: branch, kind: system, action: git.branch }
    - kind: loop
      id: clarify
      name: { en: "Clarify", zh-CN: "澄清" }
      maxIterations: 2
      until: checkpoints.clarify-qa.outcome == 'pass'
      onMaxIterations: continue
      phases:
        - id: clarify-round
          name: { en: "Round", zh-CN: "轮次" }
          steps:
            - id: analyze
              kind: agent
              agent: implementer
              model: { role: coding }
              instructions: "Analyze. Prior answers: \${checkpoints.clarify-qa.answers}"
              produces: [questions]
            - id: clarify-qa
              kind: checkpoint
              checkpoint: { kind: input, source: questions, title: { en: "Questions", zh-CN: "问题" } }
    - id: plan
      name: { en: "Plan", zh-CN: "规划" }
      steps:
        - id: draft-plan
          kind: agent
          agent: implementer
          model: { role: coding }
          instructions: "Plan it"
          produces: [implementation-plan]
        - id: confirm-plan
          kind: checkpoint
          checkpoint: { kind: approval, present: [implementation-plan], title: { en: "Confirm", zh-CN: "确认" } }
    - id: implement
      name: { en: "Implement", zh-CN: "实现" }
      steps:
        - id: implement
          kind: agent
          agent: implementer
          model: { role: coding }
          instructions: "Implement it"
          produces: [changes]
    - kind: loop
      id: review-fix
      name: { en: "Review", zh-CN: "评审" }
      maxIterations: 3
      until: checkpoints.review-gate.outcome == 'pass'
      onMaxIterations: continue
      phases:
        - id: review-round
          name: { en: "Round", zh-CN: "轮次" }
          steps:
            - id: review
              kind: agent
              agent: reviewer
              access: readOnly
              model: { role: review }
              instructions: "Review the diff"
              produces: [review-report]
            - id: review-gate
              kind: checkpoint
              checkpoint: { kind: review-gate, source: review-report, title: { en: "Findings", zh-CN: "评审结果" } }
            - id: fix
              kind: agent
              agent: implementer
              model: { role: coding }
              when: checkpoints.review-gate.outcome == 'fix'
              instructions: "Fix: \${checkpoints.review-gate.selectedFindings}"
              produces: [changes]
    - id: publish
      name: { en: "Publish", zh-CN: "发布" }
      steps:
        - id: confirm-publish
          kind: checkpoint
          when: checkpoints.review-gate.outcome == 'fix'
          checkpoint: { kind: approval, title: { en: "Publish anyway?", zh-CN: "仍要发布？" } }
        - { id: push, kind: system, action: git.push, retry: { max: 2 } }
        - id: open-pr
          kind: system
          action: pr.open
          with: { title: "\${run.taskTitle}", body: "Delivered: \${inputs.requirement}" }
          produces: [pull-request]
  outputs:
    artifacts:
      - { key: questions, kind: json, required: false }
      - { key: implementation-plan, kind: markdown, required: true }
      - { key: changes, kind: patch, required: true }
      - { key: review-report, kind: json, required: true }
      - { key: pull-request, kind: link, required: true }
    summary: { from: implementation-plan }
`;

type V2Fixture = {
  db: Db;
  runId: string;
  userId: string;
  scm: FakeScmService;
  workspace: FakeWorkspaceManager;
  makeDeps: (
    implScript: Record<string, FakeStepBehavior>,
    revScript: Record<string, FakeStepBehavior>,
  ) => EngineDeps & { impl: FakeExecutor; rev: FakeExecutor };
};

async function setupV2Fixture(sourceYaml = V2_FIXTURE_YAML): Promise<V2Fixture> {
  const db = sharedDb;
  await db.execute(sql`drop schema public cascade`);
  await db.execute(sql`create schema public`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await migrateDb(db);
  await seed(db);

  const orgRows = (await db.execute(sql`select id from orgs limit 1`)) as Array<{ id: string }>;
  const orgId = orgRows[0]?.id as string;
  const [user] = await db
    .insert(users)
    .values({
      id: Bun.randomUUIDv7(),
      name: "Engine Tester",
      email: `engine-${Bun.randomUUIDv7()}@example.com`,
      orgId,
    })
    .returning();
  if (!user) throw new Error("fixture: user insert failed");
  const [project] = await db
    .insert(projects)
    .values({ orgId, slug: "v2-test", name: "V2 Test", createdBy: user.id })
    .returning();
  if (!project) throw new Error("fixture: project insert failed");
  const allModels = await db.select().from(models);
  await db.insert(projectResourceGrants).values(
    allModels.map((m) => ({
      projectId: project.id,
      resourceType: "model" as const,
      resourceId: m.id,
      grantedBy: user.id,
    })),
  );

  const { compiled, checksum } = compileTemplate(sourceYaml);
  const [scenario] = (await db.execute(
    sql`select id from scenarios where slug = 'software-development'`,
  )) as Array<{ id: string }>;
  const [head] = await db
    .insert(orchestrationTemplates)
    .values({
      slug: compiled.metadata.slug,
      scenarioId: scenario?.id as string,
      nameI18n: compiled.metadata.name,
    })
    .returning();
  if (!head) throw new Error("fixture: template head insert failed");
  const [version] = await db
    .insert(templateVersions)
    .values({
      templateId: head.id,
      version: 1,
      status: "published",
      sourceYaml,
      compiled: compiled as unknown as Record<string, unknown>,
      checksum,
      publishedAt: new Date(),
    })
    .returning();
  if (!version) throw new Error("fixture: version insert failed");

  const fabriRows = (await db.execute(sql`select id, slug from fabri`)) as Array<{
    id: string;
    slug: string;
  }>;
  const forge = fabriRows.find((f) => f.slug === "forge")?.id as string;
  const sentinel = fabriRows.find((f) => f.slug === "sentinel")?.id as string;

  const [anyTaskType] = await db.select().from(taskTypes).limit(1);
  if (!anyTaskType) throw new Error("fixture: no task type");
  const params = {
    requirement: "Add dark mode",
    repo: { repoConnectionId: Bun.randomUUIDv7() },
  };
  const modelResolution = await resolveModelRoles(db, project.id, compiled.spec.models);
  const [task] = await db
    .insert(tasks)
    .values({
      orgId,
      projectId: project.id,
      taskTypeId: anyTaskType.id,
      title: "Deliver dark mode",
      params,
      createdBy: user.id,
    })
    .returning();
  if (!task) throw new Error("fixture: task insert failed");
  const [run] = await db
    .insert(runs)
    .values({
      taskId: task.id,
      projectId: project.id,
      number: 1,
      templateVersionId: version.id,
      faberId: forge,
      executorId: "fake-impl",
      agentBindings: {
        implementer: { faberId: forge, executorId: "fake-impl" },
        reviewer: { faberId: sentinel, executorId: "fake-rev" },
      },
      paramsSnapshot: params,
      modelResolution: { implementer: modelResolution, reviewer: modelResolution },
      resourceManifest: { mcpServers: [], skills: [] },
      budget: {},
      createdBy: user.id,
    })
    .returning();
  if (!run) throw new Error("fixture: run insert failed");

  const bus = new InProcessEventBus();
  const workspace = new FakeWorkspaceManager();
  const scm = new FakeScmService();
  const makeDeps: V2Fixture["makeDeps"] = (implScript, revScript) => {
    const impl = new FakeExecutor(implScript);
    const rev = new FakeExecutor(revScript);
    return {
      db,
      executors: { "fake-impl": impl, "fake-rev": rev },
      impl,
      rev,
      bus,
      workspace,
      scm,
      resources: new FakeResourceMaterializer({ mcpServers: [] }),
      artifacts: new InMemoryArtifactStore(),
      logger: silentLogger,
    };
  };
  return { db, runId: run.id, userId: user.id, scm, workspace, makeDeps };
}

const FINDING_A = {
  id: "f1",
  severity: "major",
  file: "src/app.ts",
  line: 10,
  title: "Unhandled null",
  detail: "value may be null",
};
const FINDING_B = {
  id: "f2",
  severity: "minor",
  title: "Naming nit",
  detail: "rename for clarity",
};

const IMPL_SCRIPT: Record<string, FakeStepBehavior> = {
  "analyze@1": {
    kind: "succeed",
    events: [
      {
        type: "artifact",
        key: "questions",
        kind: "json",
        inline: {
          questions: [{ id: "q1", text: "Which theme store?", recommended: "css variables" }],
        },
      },
    ],
    output: "asked one question",
  },
  "analyze@2": {
    kind: "succeed",
    events: [{ type: "artifact", key: "questions", kind: "json", inline: { questions: [] } }],
    output: "all clear",
  },
  "draft-plan": {
    kind: "succeed",
    events: [
      { type: "artifact", key: "implementation-plan", kind: "markdown", inline: "# The plan" },
    ],
    output: "planned",
  },
  implement: { kind: "succeed", usage: { inputTokens: 100, outputTokens: 50 }, output: "built" },
  fix: { kind: "succeed", output: "fixed the findings" },
};

const REV_CLEAN_ON_2: Record<string, FakeStepBehavior> = {
  "review@1": {
    kind: "succeed",
    events: [
      {
        type: "artifact",
        key: "review-report",
        kind: "json",
        inline: { summary: "two issues", findings: [FINDING_A, FINDING_B] },
      },
    ],
    output: "found 2 issues",
  },
  "review@2": {
    kind: "succeed",
    events: [{ type: "artifact", key: "review-report", kind: "json", inline: { findings: [] } }],
    output: "clean",
  },
};

describe.skipIf(!dbUp)("orchestration engine (agrippa/v2 slots, checkpoints, loops, scm)", () => {
  it("runs the full requirement-delivery spine: Q&A loop, plan gate, review-fix loop, platform PR", async () => {
    const fx = await setupV2Fixture();

    // Leg 1 → pauses at the input checkpoint with the questions snapshot
    let deps = fx.makeDeps(IMPL_SCRIPT, REV_CLEAN_ON_2);
    expect(await executeRun(deps, fx.runId)).toBe("waiting_approval");
    let [pending] = await fx.db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.runId, fx.runId), eq(checkpoints.status, "pending")));
    expect(pending?.checkpointId).toBe("clarify-qa");
    expect(pending?.kind).toBe("input");
    expect((pending?.payload as { questions: unknown[] } | undefined)?.questions).toHaveLength(1);
    // the platform created the work branch before any agent ran
    // the DEFAULT branch name: run number + the run id's random tail (task-
    // scoped run numbers would otherwise collide across tasks)
    expect(fx.scm.branches).toHaveLength(1);
    expect(fx.scm.branches[0]?.runId).toBe(fx.runId);
    expect(fx.scm.branches[0]?.name).toMatch(/^agrippa\/run-1-[0-9a-f]{12}$/);
    expect(fx.scm.branches[0]?.name.endsWith(fx.runId.replaceAll("-", "").slice(-12))).toBe(true);

    // answer → round 2 asks nothing → auto-pass → pauses at the plan approval
    await decideCheckpoint(fx.db, pending?.id as string, {
      status: "approved",
      decidedBy: fx.userId,
      response: { kind: "input", outcome: "answered", answers: { q1: "tailwind tokens" } },
    });
    deps = fx.makeDeps(IMPL_SCRIPT, REV_CLEAN_ON_2);
    expect(await executeRun(deps, fx.runId)).toBe("waiting_approval");
    // the second analyze round saw the first round's answers interpolated
    const analyze2 = deps.impl.requests.find((r) => r.stepId === "analyze" && r.iteration === 2);
    expect(analyze2?.instructions).toContain("tailwind tokens");
    expect(analyze2?.agentSlot).toBe("implementer");
    [pending] = await fx.db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.runId, fx.runId), eq(checkpoints.status, "pending")));
    expect(pending?.checkpointId).toBe("confirm-plan");

    // approve the plan → implement runs → pauses at review-gate round 1
    await decideCheckpoint(fx.db, pending?.id as string, {
      status: "approved",
      decidedBy: fx.userId,
      response: { kind: "approval", outcome: "approved" },
    });
    deps = fx.makeDeps(IMPL_SCRIPT, REV_CLEAN_ON_2);
    expect(await executeRun(deps, fx.runId)).toBe("waiting_approval");
    [pending] = await fx.db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.runId, fx.runId), eq(checkpoints.status, "pending")));
    expect(pending?.checkpointId).toBe("review-gate");
    expect(pending?.kind).toBe("review-gate");
    expect((pending?.payload as { findings: unknown[] } | undefined)?.findings).toHaveLength(2);
    // reviewer steps went to the reviewer executor, implementer steps to the other
    expect(deps.rev.requests.map((r) => r.stepId)).toEqual(["review"]);
    expect(deps.rev.requests[0]?.agentSlot).toBe("reviewer");
    expect(deps.impl.requests.every((r) => r.agentSlot === "implementer")).toBe(true);

    // fix one finding, accept the other → fix runs → round 2 reviews clean →
    // publish gate skipped (outcome is pass) → push + PR → succeeded
    await decideCheckpoint(fx.db, pending?.id as string, {
      status: "approved",
      decidedBy: fx.userId,
      response: {
        kind: "review-gate",
        outcome: "fix",
        selectedFindings: [FINDING_A] as never,
        acceptedFindings: [FINDING_B] as never,
        acceptedFindingIds: ["f2"],
      },
    });
    deps = fx.makeDeps(IMPL_SCRIPT, REV_CLEAN_ON_2);
    expect(await executeRun(deps, fx.runId)).toBe("succeeded");

    // the fix step saw exactly the selected finding
    const fixReq = deps.impl.requests.find((r) => r.stepId === "fix");
    expect(fixReq?.iteration).toBe(1);
    expect(fixReq?.instructions).toContain("Unhandled null");
    expect(fixReq?.instructions).not.toContain("Naming nit");
    // round 2: fix is skipped (auto-pass), loop completed
    const stepRows = await fx.db.select().from(runSteps).where(eq(runSteps.runId, fx.runId));
    expect(stepRows.find((s) => s.stepId === "fix" && s.iteration === 2)?.status).toBe("skipped");
    expect(stepRows.find((s) => s.stepId === "confirm-publish")?.status).toBe("skipped");
    expect(stepRows.find((s) => s.stepId === "review" && s.iteration === 2)?.status).toBe(
      "succeeded",
    );

    // platform-side push + PR with the waiver section in the body
    expect(fx.scm.pushes).toHaveLength(1);
    expect(fx.scm.pushes[0]?.branch).toMatch(/^agrippa\/run-1-[0-9a-f]{12}$/);
    expect(fx.scm.pullRequests).toHaveLength(1);
    const pr = fx.scm.pullRequests[0]?.spec;
    expect(pr?.head).toMatch(/^agrippa\/run-1-[0-9a-f]{12}$/);
    expect(pr?.title).toBe("Deliver dark mode");
    expect(pr?.body).toContain("Delivered: Add dark mode");
    expect(pr?.body).toContain("## Accepted review findings");
    expect(pr?.body).toContain("**minor** Naming nit");
    expect(pr?.body).toContain("accepted by Engine Tester");
    expect(pr?.body).not.toContain("Unhandled null"); // fixed, not waived

    // artifacts: per-iteration review reports, PR link, iteration-2 auto rows
    const artifactRows = await fx.db.select().from(artifacts).where(eq(artifacts.runId, fx.runId));
    const reviewRows = artifactRows.filter((a) => a.artifactKey === "review-report");
    expect(reviewRows.map((a) => a.iteration).sort()).toEqual([1, 2]);
    const prLink = artifactRows.find((a) => a.artifactKey === "pull-request");
    expect(String(prLink?.inline)).toStartWith("https://fake.scm/pr/");
    // the fix round re-diffed the workspace into a fresh changes patch
    expect(artifactRows.filter((a) => a.artifactKey === "changes")).toHaveLength(2);

    // auto-passed checkpoints recorded themselves with auto responses
    const ckptRows = await fx.db.select().from(checkpoints).where(eq(checkpoints.runId, fx.runId));
    const autoGate = ckptRows.find((c) => c.checkpointId === "review-gate" && c.iteration === 2);
    expect(autoGate?.status).toBe("approved");
    expect(autoGate?.response?.kind === "review-gate" && autoGate.response.auto).toBe(true);

    // loop lifecycle events
    const events = await fx.db.select().from(runEvents).where(eq(runEvents.runId, fx.runId));
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "loop.completed")).toHaveLength(2);
    expect(types).toContain("branch.created");
    expect(types).toContain("branch.pushed");
    expect(types).toContain("pr.opened");
  });

  it("review-fix exhaustion with onMaxIterations: continue asks before publishing", async () => {
    const fx = await setupV2Fixture();
    const alwaysDirty: Record<string, FakeStepBehavior> = {
      review: {
        kind: "succeed",
        events: [
          {
            type: "artifact",
            key: "review-report",
            kind: "json",
            inline: { findings: [FINDING_A] },
          },
        ],
        output: "still dirty",
      },
    };

    let outcome = await executeRun(fx.makeDeps(IMPL_SCRIPT, alwaysDirty), fx.runId);
    // clarify-qa round 1 pauses first — answer it, then approve the plan
    for (const checkpointId of ["clarify-qa", "confirm-plan"]) {
      expect(outcome).toBe("waiting_approval");
      const [pending] = await fx.db
        .select()
        .from(checkpoints)
        .where(and(eq(checkpoints.runId, fx.runId), eq(checkpoints.status, "pending")));
      expect(pending?.checkpointId).toBe(checkpointId);
      await decideCheckpoint(fx.db, pending?.id as string, {
        status: "approved",
        decidedBy: fx.userId,
        response:
          checkpointId === "clarify-qa"
            ? { kind: "input", outcome: "answered", answers: { q1: "x" } }
            : { kind: "approval", outcome: "approved" },
      });
      outcome = await executeRun(fx.makeDeps(IMPL_SCRIPT, alwaysDirty), fx.runId);
    }

    // three review rounds, each decided "fix" — the loop exhausts
    for (let round = 1; round <= 3; round++) {
      expect(outcome).toBe("waiting_approval");
      const [pending] = await fx.db
        .select()
        .from(checkpoints)
        .where(and(eq(checkpoints.runId, fx.runId), eq(checkpoints.status, "pending")));
      expect(pending?.checkpointId).toBe("review-gate");
      expect(pending?.iteration).toBe(round);
      await decideCheckpoint(fx.db, pending?.id as string, {
        status: "approved",
        decidedBy: fx.userId,
        response: {
          kind: "review-gate",
          outcome: "fix",
          selectedFindings: [FINDING_A] as never,
          acceptedFindings: [],
          acceptedFindingIds: [],
        },
      });
      outcome = await executeRun(fx.makeDeps(IMPL_SCRIPT, alwaysDirty), fx.runId);
    }

    // exhausted after an un-reviewed fix → the publish gate asks the user
    expect(outcome).toBe("waiting_approval");
    const [publishGate] = await fx.db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.runId, fx.runId), eq(checkpoints.status, "pending")));
    expect(publishGate?.checkpointId).toBe("confirm-publish");
    const events = await fx.db.select().from(runEvents).where(eq(runEvents.runId, fx.runId));
    expect(events.some((e) => e.type === "loop.exhausted")).toBe(true);

    await decideCheckpoint(fx.db, publishGate?.id as string, {
      status: "approved",
      decidedBy: fx.userId,
      response: { kind: "approval", outcome: "approved" },
    });
    expect(await executeRun(fx.makeDeps(IMPL_SCRIPT, alwaysDirty), fx.runId)).toBe("succeeded");
    expect(fx.scm.pullRequests).toHaveLength(1);
  });

  it("review-fix exhaustion with onMaxIterations: fail fails the run", async () => {
    const failingYaml = V2_FIXTURE_YAML.replace(
      "maxIterations: 3\n      until: checkpoints.review-gate.outcome == 'pass'\n      onMaxIterations: continue",
      "maxIterations: 1\n      until: checkpoints.review-gate.outcome == 'pass'\n      onMaxIterations: fail",
    );
    expect(failingYaml).toContain("onMaxIterations: fail");
    const fx = await setupV2Fixture(failingYaml);
    const alwaysDirty: Record<string, FakeStepBehavior> = {
      review: {
        kind: "succeed",
        events: [
          {
            type: "artifact",
            key: "review-report",
            kind: "json",
            inline: { findings: [FINDING_A] },
          },
        ],
        output: "still dirty",
      },
    };

    let outcome = await executeRun(fx.makeDeps(IMPL_SCRIPT, alwaysDirty), fx.runId);
    for (const response of [
      { kind: "input", outcome: "answered", answers: { q1: "x" } } as const,
      { kind: "approval", outcome: "approved" } as const,
      {
        kind: "review-gate",
        outcome: "fix",
        selectedFindings: [FINDING_A] as never,
        acceptedFindings: [],
        acceptedFindingIds: [],
      } as const,
    ]) {
      expect(outcome).toBe("waiting_approval");
      const [pending] = await fx.db
        .select()
        .from(checkpoints)
        .where(and(eq(checkpoints.runId, fx.runId), eq(checkpoints.status, "pending")));
      await decideCheckpoint(fx.db, pending?.id as string, {
        status: "approved",
        decidedBy: fx.userId,
        response: response as never,
      });
      outcome = await executeRun(fx.makeDeps(IMPL_SCRIPT, alwaysDirty), fx.runId);
    }

    expect(outcome).toBe("failed");
    const [run] = await fx.db.select().from(runs).where(eq(runs.id, fx.runId));
    expect((run?.error as { code: string } | null)?.code).toBe("loop_exhausted");
  });

  it("fails the producing step (with retries) when an interaction artifact is malformed", async () => {
    // review emits a report that violates the schema on every attempt — the
    // store-time validation must fail the STEP (template retry applies), and
    // the gate must never see the malformed report as "no findings"
    const retryYaml = V2_FIXTURE_YAML.replace(
      '              instructions: "Review the diff"',
      '              retry: { max: 1 }\n              instructions: "Review the diff"',
    );
    expect(retryYaml).toContain("retry: { max: 1 }");
    const fx = await setupV2Fixture(retryYaml);
    const badReview: Record<string, FakeStepBehavior> = {
      review: {
        kind: "succeed",
        events: [
          {
            type: "artifact",
            key: "review-report",
            kind: "json",
            // missing severity/detail — fails reviewReportSchema
            inline: { findings: [{ id: "f1", title: "half a finding" }] },
          },
        ],
        output: "reviewed",
      },
    };

    let outcome = await executeRun(fx.makeDeps(IMPL_SCRIPT, badReview), fx.runId);
    for (const response of [
      { kind: "input", outcome: "answered", answers: { q1: "x" } } as const,
      { kind: "approval", outcome: "approved" } as const,
    ]) {
      expect(outcome).toBe("waiting_approval");
      const [pending] = await fx.db
        .select()
        .from(checkpoints)
        .where(and(eq(checkpoints.runId, fx.runId), eq(checkpoints.status, "pending")));
      await decideCheckpoint(fx.db, pending?.id as string, {
        status: "approved",
        decidedBy: fx.userId,
        response: response as never,
      });
      outcome = await executeRun(fx.makeDeps(IMPL_SCRIPT, badReview), fx.runId);
    }

    expect(outcome).toBe("failed");
    const [run] = await fx.db.select().from(runs).where(eq(runs.id, fx.runId));
    expect((run?.error as { code: string } | null)?.code).toBe("contract_violation");
    // both attempts ran and failed — store-time validation is retryable
    const reviewRows = await fx.db
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, fx.runId), eq(runSteps.stepId, "review")));
    expect(reviewRows.map((r) => r.status).sort()).toEqual(["failed", "failed"]);
    // the malformed artifact never became a row, and the gate never opened
    const reportRows = await fx.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.runId, fx.runId), eq(artifacts.artifactKey, "review-report")));
    expect(reportRows).toHaveLength(0);
    const gateRows = await fx.db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.runId, fx.runId), eq(checkpoints.checkpointId, "review-gate")));
    expect(gateRows).toHaveLength(0);
  });

  it("fails the run when a review gate has no report at all", async () => {
    const fx = await setupV2Fixture();
    const silentReview: Record<string, FakeStepBehavior> = {
      // succeeds without emitting the review-report artifact
      review: { kind: "succeed", output: "looks fine to me" },
    };

    let outcome = await executeRun(fx.makeDeps(IMPL_SCRIPT, silentReview), fx.runId);
    for (const response of [
      { kind: "input", outcome: "answered", answers: { q1: "x" } } as const,
      { kind: "approval", outcome: "approved" } as const,
    ]) {
      expect(outcome).toBe("waiting_approval");
      const [pending] = await fx.db
        .select()
        .from(checkpoints)
        .where(and(eq(checkpoints.runId, fx.runId), eq(checkpoints.status, "pending")));
      await decideCheckpoint(fx.db, pending?.id as string, {
        status: "approved",
        decidedBy: fx.userId,
        response: response as never,
      });
      outcome = await executeRun(fx.makeDeps(IMPL_SCRIPT, silentReview), fx.runId);
    }

    // a gate without evidence must never auto-pass into a published PR
    expect(outcome).toBe("failed");
    const [run] = await fx.db.select().from(runs).where(eq(runs.id, fx.runId));
    expect((run?.error as { code: string } | null)?.code).toBe("contract_violation");
    expect(fx.scm.pullRequests).toHaveLength(0);
  });

  it("rejects a questions artifact whose select question has no options", async () => {
    const fx = await setupV2Fixture();
    const badQuestions: Record<string, FakeStepBehavior> = {
      ...IMPL_SCRIPT,
      "analyze@1": {
        kind: "succeed",
        events: [
          {
            type: "artifact",
            key: "questions",
            kind: "json",
            inline: {
              questions: [{ id: "q1", text: "Pick one", kind: "select", required: true }],
            },
          },
        ],
        output: "asked an unanswerable question",
      },
    };

    // an unanswerable required select would deadlock the checkpoint — the
    // producing step must fail instead
    expect(await executeRun(fx.makeDeps(badQuestions, REV_CLEAN_ON_2), fx.runId)).toBe("failed");
    const analyzeRows = await fx.db
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, fx.runId), eq(runSteps.stepId, "analyze")));
    expect(analyzeRows.at(-1)?.status).toBe("failed");
    expect((analyzeRows.at(-1)?.error as { code: string } | null)?.code).toBe("contract_violation");
  });

  it("fails the run instead of publishing evidence that drifted after review", async () => {
    const fx = await setupV2Fixture();
    const quickImpl: Record<string, FakeStepBehavior> = {
      ...IMPL_SCRIPT,
      "analyze@1": {
        kind: "succeed",
        events: [{ type: "artifact", key: "questions", kind: "json", inline: { questions: [] } }],
        output: "no questions",
      },
    };
    const dirtyReview: Record<string, FakeStepBehavior> = {
      review: {
        kind: "succeed",
        events: [
          {
            type: "artifact",
            key: "review-report",
            kind: "json",
            inline: { findings: [FINDING_A] },
          },
        ],
        output: "one issue",
      },
    };

    // plan approval first
    expect(await executeRun(fx.makeDeps(quickImpl, dirtyReview), fx.runId)).toBe(
      "waiting_approval",
    );
    const [plan] = await fx.db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.runId, fx.runId), eq(checkpoints.status, "pending")));
    await decideCheckpoint(fx.db, plan?.id as string, {
      status: "approved",
      decidedBy: fx.userId,
      response: { kind: "approval", outcome: "approved" },
    });
    // implement runs and stores its patch; review reports findings → gate pause.
    // The reviewer must run read-only: its writes could never be re-reviewed.
    const pauseDeps = fx.makeDeps(quickImpl, dirtyReview);
    expect(await executeRun(pauseDeps, fx.runId)).toBe("waiting_approval");
    expect(pauseDeps.rev.requests[0]?.toolPolicy.access).toBe("readOnly");
    expect(pauseDeps.impl.requests[0]?.toolPolicy.access).toBe("readWrite");
    const [gate] = await fx.db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.runId, fx.runId), eq(checkpoints.status, "pending")));
    await decideCheckpoint(fx.db, gate?.id as string, {
      status: "approved",
      decidedBy: fx.userId,
      response: {
        kind: "review-gate",
        outcome: "pass",
        selectedFindings: [],
        acceptedFindings: [FINDING_A] as never,
        acceptedFindingIds: ["f1"],
      },
    });
    // the workspace moved AFTER the gate approved the stored patch — the run
    // must refuse to publish what nobody reviewed, not silently refresh it
    fx.workspace.diffOutput = "diff --git a/drifted b/drifted\n+somebody touched this\n";
    expect(await executeRun(fx.makeDeps(quickImpl, dirtyReview), fx.runId)).toBe("failed");

    const [run] = await fx.db.select().from(runs).where(eq(runs.id, fx.runId));
    expect((run?.error as { code: string } | null)?.code).toBe("contract_violation");
    expect((run?.error as { message: string } | null)?.message).toContain("changed after");
    expect(fx.scm.pushes).toHaveLength(0);
  });

  it("fails a resumed run whose workspace is gone (host changed)", async () => {
    const fx = await setupV2Fixture();
    const cleanReview: Record<string, FakeStepBehavior> = {
      review: {
        kind: "succeed",
        events: [
          { type: "artifact", key: "review-report", kind: "json", inline: { findings: [] } },
        ],
        output: "clean",
      },
    };
    const quickImpl: Record<string, FakeStepBehavior> = {
      ...IMPL_SCRIPT,
      "analyze@1": {
        kind: "succeed",
        events: [{ type: "artifact", key: "questions", kind: "json", inline: { questions: [] } }],
        output: "no questions",
      },
    };

    // checkout succeeds, then the run pauses at the plan approval
    expect(await executeRun(fx.makeDeps(quickImpl, cleanReview), fx.runId)).toBe(
      "waiting_approval",
    );
    const [plan] = await fx.db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.runId, fx.runId), eq(checkpoints.status, "pending")));
    await decideCheckpoint(fx.db, plan?.id as string, {
      status: "approved",
      decidedBy: fx.userId,
      response: { kind: "approval", outcome: "approved" },
    });
    // the resume lands on a worker host that never had the checkout — the run
    // must fail with the real reason, not proceed against an empty directory
    fx.workspace.intact = false;
    expect(await executeRun(fx.makeDeps(quickImpl, cleanReview), fx.runId)).toBe("failed");
    const [run] = await fx.db.select().from(runs).where(eq(runs.id, fx.runId));
    expect((run?.error as { code: string } | null)?.code).toBe("workspace_lost");
  });

  it("throws the typed unavailable error before any status transition when a slot's executor is missing", async () => {
    const fx = await setupV2Fixture();
    // a worker in a heterogeneous fleet that didn't register the implementer's
    // executor must be able to DECLINE the job — that requires a matchable
    // error thrown while the run is still queued (no transition to roll back)
    const deps = fx.makeDeps(IMPL_SCRIPT, REV_CLEAN_ON_2);
    delete (deps.executors as Record<string, unknown>)["fake-impl"];

    let thrown: unknown;
    try {
      await executeRun(deps, fx.runId);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ExecutorUnavailableError);
    expect((thrown as ExecutorUnavailableError).code).toBe("executor_unavailable_on_worker");
    const [run] = await fx.db.select().from(runs).where(eq(runs.id, fx.runId));
    expect(run?.status).toBe("queued");
  });

  it("retries transient scm push failures per the template retry policy", async () => {
    const fx = await setupV2Fixture();
    fx.scm.failNext.push = 1;
    const cleanReview: Record<string, FakeStepBehavior> = {
      review: {
        kind: "succeed",
        events: [
          { type: "artifact", key: "review-report", kind: "json", inline: { findings: [] } },
        ],
        output: "clean",
      },
    };
    const quickImpl: Record<string, FakeStepBehavior> = {
      ...IMPL_SCRIPT,
      "analyze@1": {
        kind: "succeed",
        events: [{ type: "artifact", key: "questions", kind: "json", inline: { questions: [] } }],
        output: "no questions",
      },
    };

    // no questions → auto-pass → only the plan approval pauses
    expect(await executeRun(fx.makeDeps(quickImpl, cleanReview), fx.runId)).toBe(
      "waiting_approval",
    );
    const [pending] = await fx.db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.runId, fx.runId), eq(checkpoints.status, "pending")));
    expect(pending?.checkpointId).toBe("confirm-plan");
    await decideCheckpoint(fx.db, pending?.id as string, {
      status: "approved",
      decidedBy: fx.userId,
      response: { kind: "approval", outcome: "approved" },
    });
    expect(await executeRun(fx.makeDeps(quickImpl, cleanReview), fx.runId)).toBe("succeeded");

    // first push attempt failed, retry succeeded
    const pushRows = await fx.db
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, fx.runId), eq(runSteps.stepId, "push")))
      .orderBy(asc(runSteps.attempt));
    expect(pushRows.map((r) => r.status)).toEqual(["failed", "succeeded"]);
    expect(fx.scm.pushes).toHaveLength(1);
  });
});
