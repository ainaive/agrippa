import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";
import { runExecuteQueueName, runExecuteSubsetQueues } from "@agrippa/core";
import {
  checkpoints,
  createDb,
  migrateDb,
  models,
  newRunIdentity,
  orchestrationTemplates,
  projectResourceGrants,
  projects,
  runEvents,
  runs,
  runtimes,
  seed,
  tasks,
  taskTypes,
  templateVersions,
  users,
} from "@agrippa/db";
import { FakeExecutor, type FakeStepBehavior } from "@agrippa/executor-core";
import {
  type BossQueue,
  buildParamsValidator,
  createRunQueue,
  dbRunExecutorResolver,
  type EngineDeps,
  FakeResourceMaterializer,
  FakeWorkspaceManager,
  InMemoryArtifactStore,
  InProcessEventBus,
  resolveModelRoles,
  seedBuiltinTemplates,
  silentLogger,
  type TemplateDoc,
} from "@agrippa/orchestration";
import { eq, sql } from "drizzle-orm";
import {
  createRunConsumer,
  pinVerifiedAfterClaim,
  type RunFetchLoop,
  routingPinChanged,
  startRunFetchLoop,
} from "./consumer";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/agrippa_test";
const TEMPLATES_DIR = path.resolve(import.meta.dirname, "../../../templates");

// one pool for the whole suite — a pool per fixture exhausts max_connections
const db = createDb(TEST_DATABASE_URL);
let dbUp = true;
try {
  await db.execute(sql`select 1`);
} catch {
  dbUp = false;
  console.warn("[test] postgres unreachable — skipping heterogeneous fleet suite");
}

/** The bug-localize-fix happy path (same script the engine suite uses). */
const HAPPY_SCRIPT: Record<string, FakeStepBehavior> = {
  "reproduce-bug": {
    kind: "succeed",
    events: [{ type: "artifact", key: "reproduction-report", kind: "markdown", inline: "# Repro" }],
    output: "reproduced",
  },
  "find-root-cause": {
    kind: "succeed",
    events: [
      { type: "artifact", key: "localization-report", kind: "markdown", inline: "# Root cause" },
    ],
    output: "found root cause",
  },
  "implement-fix": { kind: "succeed", output: "fix implemented" },
  "run-tests": { kind: "succeed", output: "all green" },
  summarize: {
    kind: "succeed",
    events: [{ type: "artifact", key: "fix-report", kind: "markdown", inline: "# Fixed" }],
    output: "done",
  },
};

const waitFor = async (
  probe: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await Bun.sleep(50);
  }
  throw new Error("waitFor: condition not reached");
};

/**
 * The Phase A verify criterion: with a mixed fleet, a run requiring an
 * executor only worker B has NEVER lands on worker A — structurally, via the
 * executor-set queues, with zero decline (`run.deferred`) events burned.
 * Two full in-process workers: real queue, real fetch loop, real engine
 * through the production `createRunConsumer` handler; only the executors and
 * the workspace are fakes.
 */
describe.skipIf(!dbUp)("heterogeneous fleet routing (Phase A verify)", () => {
  let queue: BossQueue;
  const loops: RunFetchLoop[] = [];
  let template: TemplateDoc;
  let templateVersionId: string;
  let projectId: string;
  let userId: string;
  let taskTypeId: string;
  let defaultFaberId: string;

  // worker A registers only `fake`; worker B registers both
  const fakeOnA = new FakeExecutor(HAPPY_SCRIPT);
  const fakeOnB = new FakeExecutor(HAPPY_SCRIPT);
  const claudeOnB = new FakeExecutor(HAPPY_SCRIPT);

  const depsFor = (executors: EngineDeps["executors"]): EngineDeps => ({
    db,
    executors,
    bus: new InProcessEventBus(),
    workspace: new FakeWorkspaceManager(),
    resources: new FakeResourceMaterializer(),
    artifacts: new InMemoryArtifactStore(),
    logger: silentLogger,
  });

  beforeAll(async () => {
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`create schema public`);
    await db.execute(sql`drop schema if exists drizzle cascade`);
    await migrateDb(db);
    await seed(db);
    await seedBuiltinTemplates(db, TEMPLATES_DIR);

    const orgRows = (await db.execute(sql`select id from orgs limit 1`)) as Array<{ id: string }>;
    const orgId = orgRows[0]?.id as string;
    const [user] = await db
      .insert(users)
      .values({ id: Bun.randomUUIDv7(), name: "Fleet Tester", email: "fleet@example.com", orgId })
      .returning();
    userId = user?.id as string;
    const [project] = await db
      .insert(projects)
      .values({ orgId, slug: "fleet-test", name: "Fleet Test", createdBy: userId })
      .returning();
    projectId = project?.id as string;
    // anthropic only: dashscope/openai models outrank them, and this fixture
    // bypasses slot-aware provider filtering (resolveModelRoles is v1-era) —
    // a dashscope resolution would fail the cataloged claude executor with
    // provider_credential_required (project-policy auth) before any routing
    const allModels = await db.select().from(models);
    await db.insert(projectResourceGrants).values(
      allModels
        .filter((m) => m.provider === "anthropic")
        .map((m) => ({
          projectId,
          resourceType: "model" as const,
          resourceId: m.id,
          grantedBy: userId,
        })),
    );

    const [head] = await db
      .select()
      .from(orchestrationTemplates)
      .where(eq(orchestrationTemplates.slug, "swdev.bug-localize-fix"));
    const [version] = await db
      .select()
      .from(templateVersions)
      .where(eq(templateVersions.id, head?.latestPublishedVersionId as string));
    template = version?.compiled as unknown as TemplateDoc;
    templateVersionId = version?.id as string;
    const [taskType] = await db
      .select()
      .from(taskTypes)
      .where(eq(taskTypes.templateId, head?.id as string));
    taskTypeId = taskType?.id as string;
    defaultFaberId = taskType?.defaultFaberId as string;

    queue = await createRunQueue(TEST_DATABASE_URL, {
      resolveRunExecutors: dbRunExecutorResolver(db),
    });

    const workerA = createRunConsumer(db, depsFor({ fake: fakeOnA }), queue);
    const workerB = createRunConsumer(
      db,
      depsFor({ fake: fakeOnB, "claude-agent-sdk": claudeOnB }),
      queue,
    );
    const queuesA = runExecuteSubsetQueues(["fake"]);
    const queuesB = runExecuteSubsetQueues(["fake", "claude-agent-sdk"]);
    for (const name of [...queuesA, ...queuesB]) await queue.boss.createQueue(name);
    loops.push(
      startRunFetchLoop({
        boss: queue.boss,
        queues: queuesA,
        slots: 2,
        handler: workerA.handleRunJob,
        logger: silentLogger,
        tickMs: 100,
      }),
      startRunFetchLoop({
        boss: queue.boss,
        queues: queuesB,
        slots: 2,
        handler: workerB.handleRunJob,
        logger: silentLogger,
        tickMs: 100,
      }),
    );
  });

  afterAll(async () => {
    for (const loop of loops) await loop.stop({ awaitInFlight: false });
    await queue?.stop();
  });

  const provisionRun = async (executorId: string, number: number): Promise<string> => {
    const params = buildParamsValidator(template.spec.inputs).parse({
      bugReport: "The widget crashes on empty input",
      repo: { repoConnectionId: Bun.randomUUIDv7() },
    });
    const modelResolution = await resolveModelRoles(db, projectId, template.spec.models);
    const [task] = await db
      .insert(tasks)
      .values({
        orgId: (await db.select().from(projects).where(eq(projects.id, projectId)))[0]
          ?.orgId as string,
        projectId,
        taskTypeId,
        title: `Fleet run ${number}`,
        params,
        createdBy: userId,
      })
      .returning();
    const [run] = await db
      .insert(runs)
      .values({
        ...newRunIdentity(),
        taskId: task?.id as string,
        projectId,
        number,
        templateVersionId,
        faberId: defaultFaberId,
        executorId,
        paramsSnapshot: params,
        modelResolution,
        resourceManifest: { mcpServers: [], skills: [] },
        createdBy: userId,
      })
      .returning();
    return run?.id as string;
  };

  /** Drive a run through both legs: to the approval pause, approve, resume. */
  const runToCompletion = async (runId: string): Promise<void> => {
    await queue.enqueueRun(runId);
    await waitFor(async () => {
      const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
      return run?.status === "waiting_approval";
    });
    await db
      .update(checkpoints)
      .set({ status: "approved", decidedAt: new Date() })
      .where(eq(checkpoints.runId, runId));
    await queue.enqueueRun(runId);
    await waitFor(async () => {
      const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
      return run?.status === "succeeded";
    });
  };

  it("a claude-requiring run executes on worker B and never touches worker A", async () => {
    const runId = await provisionRun("claude-agent-sdk", 1);
    await queue.enqueueRun(runId);

    // routed to the single-executor set queue for claude-agent-sdk
    const [job] = (await db.execute(
      sql`select name from pgboss.job where data->>'runId' = ${runId} order by created_on desc limit 1`,
    )) as unknown as Array<{ name: string }>;
    expect(job?.name).toBe(runExecuteQueueName(["claude-agent-sdk"]));

    await waitFor(async () => {
      const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
      return run?.status === "waiting_approval";
    });
    await db
      .update(checkpoints)
      .set({ status: "approved", decidedAt: new Date() })
      .where(eq(checkpoints.runId, runId));
    await queue.enqueueRun(runId);
    await waitFor(async () => {
      const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
      return run?.status === "succeeded";
    });

    // both legs executed by B's claude executor (5 agent steps total); A saw
    // nothing, and no decline events were burned anywhere — routing made the
    // mismatch impossible rather than recoverable
    expect(claudeOnB.requests.length).toBe(5);
    expect(fakeOnA.requests.length).toBe(0);
    expect(fakeOnB.requests.length).toBe(0);
    const deferred = await db.select().from(runEvents).where(eq(runEvents.type, "run.deferred"));
    expect(deferred.length).toBe(0);
  });

  it("a fake-only run is eligible for either worker and each step runs exactly once", async () => {
    const claudeBefore = claudeOnB.requests.length;
    const runId = await provisionRun("fake", 2);
    await runToCompletion(runId);

    // each leg is one job claimed atomically by ONE worker, so the 5 agent
    // steps split across A and B but never duplicate
    expect(fakeOnA.requests.length + fakeOnB.requests.length).toBe(5);
    expect(claudeOnB.requests.length).toBe(claudeBefore);
  });

  it("routingPinChanged flags only a MOVED pin (routing races the lease)", async () => {
    const runId = await provisionRun("fake", 3);
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    const [runtime] = await db
      .insert(runtimes)
      .values({
        orgId: project?.orgId as string,
        name: "pin-race",
        tokenHash: "h",
        tokenPrefix: `agrd_${Bun.randomUUIDv7().slice(-7)}`,
        executors: [],
        createdBy: userId,
      })
      .returning({ id: runtimes.id });
    const runtimeId = runtime?.id as string;

    // routed central (expected null), pin still null → proceed
    expect(await routingPinChanged(db, runId, null)).toBe(false);
    // a concurrent delivery pinned the run in the routing→claim window → drain
    await db.update(runs).set({ runtimeId }).where(eq(runs.id, runId));
    expect(await routingPinChanged(db, runId, null)).toBe(true);
    // routed remote to that runtime (expected = pin) → proceed; the dead-pin
    // path is the same shape (routeRun returns central WITH the stale pin as
    // expectedPin), so neither may drain-loop
    expect(await routingPinChanged(db, runId, runtimeId)).toBe(false);

    // the engine's awaited postClaim gate: proceeds on match, drains on
    // mismatch — and FAILS CLOSED when the check itself errors (proceeding
    // unverified with possibly-wrong deps is the bug)
    expect(await pinVerifiedAfterClaim(db, runId, runtimeId, silentLogger)).toBe(true);
    expect(await pinVerifiedAfterClaim(db, runId, null, silentLogger)).toBe(false);
    const brokenDb = {
      select: () => {
        throw new Error("connection reset");
      },
    } as unknown as typeof db;
    expect(await pinVerifiedAfterClaim(brokenDb, runId, runtimeId, silentLogger)).toBe(false);

    await db.update(runs).set({ runtimeId: null }).where(eq(runs.id, runId));
    await db.delete(runtimes).where(eq(runtimes.id, runtimeId));
  });
});
