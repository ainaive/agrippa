import { describe, expect, it } from "bun:test";
import path from "node:path";
import {
  approvals,
  artifacts,
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
import { buildParamsValidator, resolveModelRoles } from "../resolve";
import { seedBuiltinTemplates } from "../seed-builtins";
import type { TemplateDoc } from "../template-schema";
import { InProcessEventBus } from "./bus";
import type { EngineDeps } from "./deps";
import { executeRun } from "./engine";
import {
  FakeResourceMaterializer,
  FakeWorkspaceManager,
  InMemoryArtifactStore,
  silentLogger,
} from "./fakes";
import {
  appendRunEvent,
  decideApproval,
  findStrandedApprovalRuns,
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

type DepsOptions = { mcpServers?: string[] };

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
      resources: new FakeResourceMaterializer({ mcpServers: opts.mcpServers ?? [] }),
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
    .update(approvals)
    .set({ status: "approved", decidedAt: new Date() })
    .where(eq(approvals.runId, runId));
}

describe.skipIf(!dbUp)("orchestration engine (FakeExecutor compliance suite)", () => {
  it("runs to the approval gate, pauses without holding state, then resumes to success", async () => {
    const { db, runId, makeDeps, workspace } = await setupFixture();
    const deps = makeDeps(HAPPY_SCRIPT);

    // Leg 1 → waiting_approval
    expect(await executeRun(deps, runId)).toBe("waiting_approval");
    const [run1] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run1?.status).toBe("waiting_approval");
    const [approval] = await db.select().from(approvals).where(eq(approvals.runId, runId));
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
    expect(events.some((e) => e.type === "approval.required")).toBe(true);
    expect(events.some((e) => e.type === "run.resumed")).toBe(true);

    // workspace cleaned up on terminal state
    expect(workspace.cleaned).toContain(runId);
  });

  it("rejecting the checkpoint fails the run with approval_rejected", async () => {
    const { db, runId, makeDeps } = await setupFixture();
    await executeRun(makeDeps(HAPPY_SCRIPT), runId);
    await db
      .update(approvals)
      .set({ status: "rejected", decidedAt: new Date() })
      .where(eq(approvals.runId, runId));

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
    const [approval] = await db.select().from(approvals).where(eq(approvals.runId, runId));
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

  it("streams live events over the bus while executing", async () => {
    const { runId, makeDeps, bus } = await setupFixture();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe(runId, (event) => seen.push(event.type));
    await executeRun(makeDeps(HAPPY_SCRIPT), runId);
    unsubscribe();
    expect(seen[0]).toBe("run.started");
    expect(seen).toContain("step.started");
    expect(seen).toContain("usage");
    expect(seen).toContain("approval.required");
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
  });

  it("findStrandedApprovalRuns selects only runs with no pending approval", async () => {
    const { db, runId } = await setupFixture();
    await db.update(runs).set({ status: "waiting_approval" }).where(eq(runs.id, runId));

    // one pending approval → not stranded
    const [a1] = await db
      .insert(approvals)
      .values({ runId, checkpointId: "cp-1", status: "pending" })
      .returning();
    expect(await findStrandedApprovalRuns(db)).not.toContain(runId);

    // a second, earlier checkpoint gets approved while cp-1 is still pending →
    // still not stranded (the multi-approval trap the old innerJoin fell into)
    await db
      .insert(approvals)
      .values({ runId, checkpointId: "cp-0", status: "approved" })
      .returning();
    expect(await findStrandedApprovalRuns(db)).not.toContain(runId);

    // cp-1 decided too → now every approval is decided → stranded, re-enqueue
    await decideApproval(db, a1?.id as string, { status: "approved" });
    expect(await findStrandedApprovalRuns(db)).toContain(runId);
  });

  it("decideApproval is a compare-and-swap on pending", async () => {
    const { db, runId } = await setupFixture();
    const [approval] = await db
      .insert(approvals)
      .values({ runId, checkpointId: "cp-1", status: "pending" })
      .returning();
    const id = approval?.id as string;
    const first = await decideApproval(db, id, { status: "approved" });
    expect(first?.status).toBe("approved");
    // a racing expiry cannot overwrite the user's decision
    const second = await decideApproval(db, id, { status: "expired" });
    expect(second).toBeNull();
    const [row] = await db
      .select({ status: approvals.status })
      .from(approvals)
      .where(eq(approvals.id, id));
    expect(row?.status).toBe("approved");
  });
});
