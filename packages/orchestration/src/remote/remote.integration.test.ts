import { beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";
import {
  createDb,
  type Db,
  dispatchEvents,
  dispatches,
  mcpServers,
  migrateDb,
  newRunIdentity,
  orchestrationTemplates,
  projects,
  providerCredentials,
  repoConnections,
  runEvents,
  runSteps,
  runs,
  runtimes,
  secrets,
  seed,
  tasks,
  taskTypes,
  users,
  workerHeartbeats,
} from "@agrippa/db";
import type { StepExecutionRequest } from "@agrippa/executor-core";
import { and, eq, sql } from "drizzle-orm";
import type { EngineDeps } from "../engine/deps";
import { FakeResourceMaterializer, silentLogger } from "../engine/fakes";
import { seedBuiltinTemplates } from "../seed-builtins";
import { sweepOfflineRuntimes } from "./offline";
import { remoteEngineDeps } from "./remote-deps";
import { RemoteExecutor } from "./remote-executor";
import { RemoteWorkspaceManager } from "./remote-workspace";
import { routeRun } from "./routing";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/agrippa_test";
const TEMPLATES_DIR = path.resolve(import.meta.dirname, "../../../../templates");

// one pool for the whole suite — a pool per fixture exhausts max_connections
const db: Db = createDb(TEST_DATABASE_URL);
let dbUp = true;
try {
  await db.execute(sql`select 1`);
} catch {
  dbUp = false;
  console.warn("[test] postgres unreachable — skipping remote transport suite");
}

let orgId: string;
let userId: string;
let projectId: string;
let plainTemplateVersionId: string; // no git.push
let pushTemplateVersionId: string; // contains git.push
let faberId: string;
let taskId: string;
let runNumber = 0;

const CLAUDE_RESOLUTION = {
  coding: {
    role: "coding",
    tier: "strong",
    modelId: Bun.randomUUIDv7(),
    provider: "anthropic",
    providerModelId: "claude-opus-4-8",
    rank: 80,
  },
};

async function newRun(
  overrides: Partial<typeof runs.$inferInsert> = {},
): Promise<typeof runs.$inferSelect> {
  runNumber += 1;
  const [run] = await db
    .insert(runs)
    .values({
      ...newRunIdentity(),
      taskId,
      projectId,
      number: runNumber,
      templateVersionId: plainTemplateVersionId,
      faberId,
      executorId: "claude-agent-sdk",
      paramsSnapshot: {},
      modelResolution: CLAUDE_RESOLUTION,
      createdBy: userId,
      ...overrides,
    })
    .returning();
  return run as typeof runs.$inferSelect;
}

async function newRuntime(
  executors: Array<{ id: string; envAuthProviders?: string[] }>,
  opts: { seenSecondsAgo?: number; name?: string } = {},
): Promise<string> {
  const [row] = await db
    .insert(runtimes)
    .values({
      orgId,
      name: opts.name ?? `rt-${Bun.randomUUIDv7().slice(-6)}`,
      tokenHash: "h",
      tokenPrefix: `agrd_${Bun.randomUUIDv7().slice(-7)}`,
      executors,
      lastSeenAt: sql`now() - interval '${sql.raw(String(opts.seenSecondsAgo ?? 0))} seconds'`,
      createdBy: userId,
    })
    .returning({ id: runtimes.id });
  return row?.id as string;
}

describe.skipIf(!dbUp)("remote routing + transport (ADR-0017)", () => {
  beforeAll(async () => {
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`create schema public`);
    await db.execute(sql`drop schema if exists drizzle cascade`);
    await migrateDb(db);
    await seed(db);
    await seedBuiltinTemplates(db, TEMPLATES_DIR);

    const orgRows = (await db.execute(sql`select id from orgs limit 1`)) as Array<{ id: string }>;
    orgId = orgRows[0]?.id as string;
    const [user] = await db
      .insert(users)
      .values({ id: Bun.randomUUIDv7(), name: "Remote", email: "remote@example.com", orgId })
      .returning();
    userId = user?.id as string;
    const [project] = await db
      .insert(projects)
      .values({ orgId, slug: "remote", name: "Remote", createdBy: userId })
      .returning();
    projectId = project?.id as string;

    const templateFor = async (slug: string): Promise<{ versionId: string; faberId: string }> => {
      const [head] = await db
        .select()
        .from(orchestrationTemplates)
        .where(eq(orchestrationTemplates.slug, slug));
      const [taskType] = await db
        .select()
        .from(taskTypes)
        .where(eq(taskTypes.templateId, head?.id as string));
      return {
        versionId: head?.latestPublishedVersionId as string,
        faberId: taskType?.defaultFaberId as string,
      };
    };
    const plain = await templateFor("pm.weekly-report"); // no workspace, no git.push
    const push = await templateFor("swdev.requirement-delivery"); // has git.push
    plainTemplateVersionId = plain.versionId;
    pushTemplateVersionId = push.versionId;
    faberId = plain.faberId;

    const [task] = await db
      .insert(tasks)
      .values({
        orgId,
        projectId,
        taskTypeId: (await db.select().from(taskTypes).limit(1))[0]?.id as string,
        title: "remote fixture",
        params: {},
        createdBy: userId,
      })
      .returning();
    taskId = task?.id as string;
  });

  it("routes central when nothing remote is live, remote when only a daemon covers", async () => {
    const run = await newRun();
    expect((await routeRun(db, run)).kind).toBe("central");

    const runtimeId = await newRuntime([
      { id: "claude-agent-sdk", envAuthProviders: ["anthropic"] },
    ]);
    const decision = await routeRun(db, run);
    expect(decision.kind).toBe("remote");
    if (decision.kind === "remote") expect(decision.runtime.id).toBe(runtimeId);

    // the pin persisted and is absolute: a fresher runtime does not steal it
    const [pinned] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(pinned?.runtimeId).toBe(runtimeId);
    await newRuntime([{ id: "claude-agent-sdk", envAuthProviders: ["anthropic"] }]);
    const again = await routeRun(db, pinned as typeof runs.$inferSelect);
    expect(again.kind === "remote" && again.runtime.id === runtimeId).toBe(true);

    await db.update(runs).set({ runtimeId: null });
    await db.delete(runtimes);
  });

  it("central-only strict: stored credential, project-policy provider, authed MCP, git.push", async () => {
    await newRuntime([{ id: "claude-agent-sdk", envAuthProviders: ["anthropic"] }]);

    // stored project credential for a resolved env-policy provider → central
    const [secret] = await db
      .insert(secrets)
      .values({ orgId, kind: "provider_api_key", ciphertext: "x", createdBy: userId })
      .returning({ id: secrets.id });
    await db.insert(providerCredentials).values({
      projectId,
      provider: "anthropic",
      secretRef: secret?.id as string,
    });
    const credentialed = await newRun();
    expect((await routeRun(db, credentialed)).kind).toBe("central");
    await db.delete(providerCredentials);

    // project-policy provider in the resolution → central even with no credential
    const dashscope = await newRun({
      modelResolution: {
        coding: { ...CLAUDE_RESOLUTION.coding, provider: "dashscope" },
      },
    });
    expect((await routeRun(db, dashscope)).kind).toBe("central");

    // authorized MCP server with platform-held auth → central
    const [mcp] = await db
      .insert(mcpServers)
      .values({
        slug: `gh-${Bun.randomUUIDv7().slice(-6)}`,
        nameI18n: { en: "GitHub", "zh-CN": "GitHub" },
        transport: "http",
        config: {},
        authSecretRef: secret?.id as string,
      })
      .returning({ slug: mcpServers.slug });
    const withMcp = await newRun({
      resourceManifest: { mcpServers: [mcp?.slug as string], skills: [] },
    });
    expect((await routeRun(db, withMcp)).kind).toBe("central");

    // publishing templates route like any other since the ADR-0017 inversion
    // (git.branch is a remote no-op; git.push applies the approved patch to a
    // pristine server-side clone) — with a covering daemon live, this goes
    // remote. Note: requirement-delivery binds a codex reviewer slot, so the
    // daemon must advertise codex too.
    const publisher = await newRuntime([
      { id: "claude-agent-sdk", envAuthProviders: ["anthropic"] },
      { id: "codex-cli", envAuthProviders: ["anthropic", "openai"] },
    ]);
    const publishing = await newRun({ templateVersionId: pushTemplateVersionId });
    const publishDecision = await routeRun(db, publishing);
    expect(publishDecision.kind === "remote" && publishDecision.runtime.id === publisher).toBe(
      true,
    );
    await db.update(runs).set({ runtimeId: null });

    await db.update(runs).set({ runtimeId: null });
    await db.delete(runtimes);
  });

  it("prefers central coverage and scores daemon env auth per executor", async () => {
    // live-and-READY central worker covering the set → central even with a
    // live daemon
    await db.insert(workerHeartbeats).values({
      containerId: "w-central",
      executors: [{ id: "claude-agent-sdk" }],
      consumersReadyAt: new Date(),
    });
    await newRuntime([{ id: "claude-agent-sdk", envAuthProviders: ["anthropic"] }]);
    const run = await newRun();
    expect((await routeRun(db, run)).kind).toBe("central");
    await db.delete(workerHeartbeats);

    // a boot-wedged worker (heartbeats, never became ready) and a stale one
    // (silent past the 150s window) are NOT capable pollers — the daemon wins
    await db.insert(workerHeartbeats).values([
      {
        containerId: "w-wedged",
        executors: [{ id: "claude-agent-sdk" }],
        consumersReadyAt: null,
      },
      {
        containerId: "w-stale",
        executors: [{ id: "claude-agent-sdk" }],
        consumersReadyAt: new Date(),
        heartbeatAt: sql`now() - interval '10 minutes'`,
      },
    ]);
    await db.update(runs).set({ runtimeId: null });
    expect((await routeRun(db, run)).kind).toBe("remote");
    await db.delete(workerHeartbeats);

    // a daemon whose executor advertises NO anthropic auth is ineligible
    await db.update(runs).set({ runtimeId: null });
    await db.delete(runtimes);
    await newRuntime([{ id: "claude-agent-sdk", envAuthProviders: ["openai"] }]);
    expect((await routeRun(db, run)).kind).toBe("central");

    // stale daemons are ineligible
    await db.update(runs).set({ runtimeId: null });
    await db.delete(runtimes);
    await newRuntime([{ id: "claude-agent-sdk", envAuthProviders: ["anthropic"] }], {
      seenSecondsAgo: 120,
    });
    expect((await routeRun(db, run)).kind).toBe("central");
    await db.update(runs).set({ runtimeId: null });
    await db.delete(runtimes);
  });

  it("a keyless central worker does not mask an authenticated daemon", async () => {
    // central advertises the executor but NO env auth for the resolved
    // provider — the primary BYO-credentials scenario: the run must go remote
    await db.insert(workerHeartbeats).values({
      containerId: "w-keyless",
      executors: [{ id: "claude-agent-sdk", envAuthProviders: [] }],
      consumersReadyAt: new Date(),
    });
    const runtimeId = await newRuntime([
      { id: "claude-agent-sdk", envAuthProviders: ["anthropic"] },
    ]);
    const run = await newRun();
    const decision = await routeRun(db, run);
    expect(decision.kind === "remote" && decision.runtime.id === runtimeId).toBe(true);
    await db.delete(workerHeartbeats);
    await db.update(runs).set({ runtimeId: null });
    await db.delete(runtimes);
  });

  it("scores env auth per executor, not as a cross-product", async () => {
    // claude implementer on anthropic + codex reviewer on openai: each
    // executor must authenticate ITS OWN provider only
    const mixed = await newRun({
      agentBindings: {
        implementer: { faberId, executorId: "claude-agent-sdk" },
        reviewer: { faberId, executorId: "codex-cli" },
      },
      modelResolution: {
        implementer: CLAUDE_RESOLUTION,
        reviewer: {
          coding: {
            ...CLAUDE_RESOLUTION.coding,
            provider: "openai",
            providerModelId: "gpt-5-codex",
          },
        },
      },
    });

    // the flagship mixed fleet: eligible (a cross-product check would demand
    // codex⊇anthropic and claude⊇openai and wrongly send this central)
    const good = await newRuntime([
      { id: "claude-agent-sdk", envAuthProviders: ["anthropic"] },
      { id: "codex-cli", envAuthProviders: ["openai"] },
    ]);
    const decision = await routeRun(db, mixed);
    expect(decision.kind === "remote" && decision.runtime.id === good).toBe(true);
    await db.update(runs).set({ runtimeId: null });
    await db.delete(runtimes);

    // swapped auth: each executor lacks exactly its own provider → ineligible
    await newRuntime([
      { id: "claude-agent-sdk", envAuthProviders: ["openai"] },
      { id: "codex-cli", envAuthProviders: ["anthropic"] },
    ]);
    expect((await routeRun(db, mixed)).kind).toBe("central");
    await db.update(runs).set({ runtimeId: null });
    await db.delete(runtimes);
  });

  it("a pin-CAS loser adopts the persisted winner instead of its local choice", async () => {
    // Routing runs before the execution lease, so two deliveries can race:
    // simulate the loser by handing routeRun a STALE run object (runtimeId
    // null in memory) whose DB row a concurrent delivery already pinned.
    const winner = await newRuntime([{ id: "claude-agent-sdk", envAuthProviders: ["anthropic"] }], {
      name: "winner",
    });
    const run = await newRun();
    await db.update(runs).set({ runtimeId: winner }).where(eq(runs.id, run.id));

    // a fresher candidate exists — the loser's local scoring would pick it
    const fresher = await newRuntime(
      [{ id: "claude-agent-sdk", envAuthProviders: ["anthropic"] }],
      { name: "fresher" },
    );
    const stale = { ...run, runtimeId: null }; // what the loser read pre-race
    const decision = await routeRun(db, stale as typeof runs.$inferSelect);
    expect(decision.kind === "remote" && decision.runtime.id === winner).toBe(true);
    expect(decision.kind === "remote" && decision.runtime.id === fresher).toBe(false);
    // and the persisted pin was not overwritten
    const [after] = await db
      .select({ runtimeId: runs.runtimeId })
      .from(runs)
      .where(eq(runs.id, run.id));
    expect(after?.runtimeId).toBe(winner);

    await db.update(runs).set({ runtimeId: null });
    await db.delete(runtimes);
  });

  it("a started, unpinned run stays central — placement is sticky", async () => {
    // A run that executed centrally (startedAt set, never pinned — remote
    // execution always pins pre-claim), paused at approval, and lost its
    // worker must NOT migrate to a newly available daemon: its checkout step
    // already succeeded on a central host, and the daemon would run the
    // remaining steps in an empty scratch dir.
    await newRuntime([{ id: "claude-agent-sdk", envAuthProviders: ["anthropic"] }]);
    const run = await newRun({ startedAt: new Date(), status: "waiting_approval" });
    expect((await routeRun(db, run)).kind).toBe("central");
    const [after] = await db
      .select({ runtimeId: runs.runtimeId })
      .from(runs)
      .where(eq(runs.id, run.id));
    expect(after?.runtimeId).toBeNull();
    await db.delete(runtimes);
  });

  it("a follow-up inherits placement — never re-routed onto a daemon", async () => {
    // Its workspace exists on exactly one host class. Unpinned means the
    // ancestor ran centrally, so placing the follow-up on a daemon would hand
    // the agent an empty directory and let it report success (ADR-0018).
    await newRuntime([{ id: "claude-agent-sdk", envAuthProviders: ["anthropic"] }]);
    const ancestor = await newRun();
    const followup = await newRun({
      kind: "followup",
      parentRunId: ancestor.id,
      workspaceKey: ancestor.workspaceKey,
    });
    expect((await routeRun(db, followup)).kind).toBe("central");
    const [after] = await db
      .select({ runtimeId: runs.runtimeId })
      .from(runs)
      .where(eq(runs.id, followup.id));
    expect(after?.runtimeId).toBeNull();
    await db.delete(runtimes);
  });

  it("refuses a follow-up pinned to a daemon that cannot honor workspace keys", async () => {
    // Version skew that is a CORRECTNESS hazard, not a compatibility one: a
    // daemon ignoring the key clones fresh, reports success, and the follow-up
    // silently loses the work it exists to continue. Refused — and refused as
    // a deferral, so upgrading the daemon makes the run proceed by itself.
    const oldRuntime = await newRuntime([
      { id: "claude-agent-sdk", envAuthProviders: ["anthropic"] },
    ]);
    const ancestor = await newRun({ runtimeId: oldRuntime });
    const followup = await newRun({
      kind: "followup",
      parentRunId: ancestor.id,
      workspaceKey: ancestor.workspaceKey,
      runtimeId: oldRuntime,
    });
    await expect(routeRun(db, followup)).rejects.toThrow("does not support 'workspace-key'");

    // an ordinary run is unaffected — only follow-ups depend on the claim
    const ordinary = await newRun({ runtimeId: oldRuntime });
    expect((await routeRun(db, ordinary)).kind).toBe("remote");

    // and the same daemon after an upgrade serves it
    await db
      .update(runtimes)
      .set({ features: ["workspace-key"] })
      .where(eq(runtimes.id, oldRuntime));
    expect((await routeRun(db, followup)).kind).toBe("remote");
    await db.update(runs).set({ runtimeId: null });
    await db.delete(runtimes);
  });

  it("a STALE snapshot cannot pin a run that has since started centrally", async () => {
    // Delivery B read the run before delivery A executed a whole central leg
    // and released its lease (waiting_approval). B's snapshot passes the
    // startedAt fast path, so only the CAS's `started_at IS NULL` condition
    // stands between B and a poisoned pin the post-claim verify would bless.
    await newRuntime([{ id: "claude-agent-sdk", envAuthProviders: ["anthropic"] }]);
    const run = await newRun({ startedAt: new Date(), status: "waiting_approval" });
    const stale = { ...run, startedAt: null, runtimeId: null };
    expect((await routeRun(db, stale as typeof runs.$inferSelect)).kind).toBe("central");
    const [after] = await db
      .select({ runtimeId: runs.runtimeId })
      .from(runs)
      .where(eq(runs.id, run.id));
    expect(after?.runtimeId).toBeNull();
    await db.delete(runtimes);
  });

  it("refuses to pin a run whose lease another worker holds", async () => {
    // A duplicate delivery routing while the owner executes must not poison
    // the pin: its own claim will fail RunClaimLost, so the pin write rejects
    // leased runs and the delivery returns central with no side effects.
    await newRuntime([{ id: "claude-agent-sdk", envAuthProviders: ["anthropic"] }]);
    const run = await newRun();
    await db
      .update(runs)
      .set({ leaseOwner: "owner-a", leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(runs.id, run.id));

    expect((await routeRun(db, run)).kind).toBe("central");
    const [after] = await db
      .select({ runtimeId: runs.runtimeId })
      .from(runs)
      .where(eq(runs.id, run.id));
    expect(after?.runtimeId).toBeNull();

    // an EXPIRED lease is a dead owner — pinning is legitimate again
    await db
      .update(runs)
      .set({ leaseExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(runs.id, run.id));
    expect((await routeRun(db, run)).kind).toBe("remote");

    await db.update(runs).set({ runtimeId: null, leaseOwner: null, leaseExpiresAt: null });
    await db.delete(runtimes);
  });

  it("remote guard: project credentials fail typed, platform-authed MCP reports missing", async () => {
    const runtimeId = await newRuntime([
      { id: "claude-agent-sdk", envAuthProviders: ["anthropic"] },
    ]);
    const [runtime] = await db.select().from(runtimes).where(eq(runtimes.id, runtimeId));
    const run = await newRun({ runtimeId });

    const [secret] = await db
      .insert(secrets)
      .values({ orgId, kind: "mcp_auth", ciphertext: "x", createdBy: userId })
      .returning({ id: secrets.id });
    const authedSlug = `authed-${Bun.randomUUIDv7().slice(-6)}`;
    const openSlug = `open-${Bun.randomUUIDv7().slice(-6)}`;
    await db.insert(mcpServers).values([
      {
        slug: authedSlug,
        nameI18n: { en: "Authed", "zh-CN": "Authed" },
        transport: "http",
        config: {},
        authSecretRef: secret?.id as string,
      },
      { slug: openSlug, nameI18n: { en: "Open", "zh-CN": "Open" }, transport: "http", config: {} },
    ]);

    const inner = new FakeResourceMaterializer({
      providerCredentials: { anthropic: { apiKey: "sk-live-platform" } },
      mcpServers: [authedSlug, openSlug],
    });
    const base = { db, resources: inner, executors: {}, logger: silentLogger };
    const deps = remoteEngineDeps(
      base as unknown as EngineDeps,
      run,
      runtime as typeof runtimes.$inferSelect,
    );

    // a credential added after the pin (paused run) must never serialize out —
    // it fails typed instead of shipping or silently inverting precedence
    const err = await deps.resources
      .providerCredential(projectId, "anthropic")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("provider_credential_unroutable");

    // platform-held MCP auth: reported missing (with the reason), not shipped
    const mcp = await deps.resources.mcpServers([openSlug, authedSlug]);
    expect(mcp.resolved.map((r) => r.slug)).toEqual([openSlug]);
    expect(mcp.missing).toEqual([
      `${authedSlug} (platform-held MCP auth cannot ship to a remote runtime)`,
    ]);

    await db.update(runs).set({ runtimeId: null });
    await db.delete(runtimes);
  });

  const baseRequest = (runId: string, stepId: string): StepExecutionRequest => ({
    runId,
    stepId,
    iteration: 1,
    instructions: "do it",
    systemPrompt: "sys",
    model: { provider: "anthropic", providerModelId: "claude-opus-4-8", modelId: "m" },
    subagents: [],
    skills: [],
    mcpServers: [],
    toolPolicy: { writeRoot: "/tmp/ws", access: "readWrite" },
    limits: { maxTurns: 5 },
    workspaceDir: "/tmp/ws",
    priorContext: [],
    expectedArtifacts: [],
  });

  const runningStepRow = async (runId: string, stepId: string): Promise<string> => {
    const [row] = await db
      .insert(runSteps)
      .values({ runId, phaseId: "p", stepId, iteration: 1, attempt: 1, seq: 1, status: "running" })
      .returning({ id: runSteps.id });
    return row?.id as string;
  };

  const makeExecutor = (runtimeId: string, opts?: { deadmanMs?: number }) =>
    new RemoteExecutor({
      db,
      runtimeId,
      executorId: "claude-agent-sdk",
      capabilities: {
        subagents: true,
        mcp: true,
        skills: true,
        resume: "verified",
        streaming: true,
      },
      workspaceSpec: async () => null,
      logger: silentLogger,
      pollMs: 25,
      deadmanMs: opts?.deadmanMs ?? 120_000,
    });

  it("streams daemon events in seq order, rewrites artifacts to staged, terminates", async () => {
    const runtimeId = await newRuntime([{ id: "claude-agent-sdk" }]);
    const run = await newRun({ runtimeId });
    const stepRowId = await runningStepRow(run.id, "step-a");
    const executor = makeExecutor(runtimeId);

    const controller = new AbortController();
    const seen: string[] = [];
    let stagedRef: string | undefined;
    const consume = (async () => {
      for await (const event of executor.executeStep(baseRequest(run.id, "step-a"), {
        signal: controller.signal,
        logger: silentLogger,
      })) {
        seen.push(event.type);
        if (event.type === "artifact") stagedRef = event.staged;
      }
    })();

    // simulate the daemon: claim, stream, complete
    let dispatchId = "";
    for (let i = 0; i < 100 && !dispatchId; i++) {
      const [d] = await db
        .select({ id: dispatches.id })
        .from(dispatches)
        .where(and(eq(dispatches.runId, run.id), eq(dispatches.stepRowId, stepRowId)));
      dispatchId = d?.id ?? "";
      if (!dispatchId) await Bun.sleep(20);
    }
    expect(dispatchId).not.toBe("");
    await db
      .update(dispatches)
      .set({ status: "claimed", claimedAt: sql`now()`, lastContactAt: sql`now()` })
      .where(eq(dispatches.id, dispatchId));
    await db.insert(dispatchEvents).values([
      { dispatchId, seq: 1, event: { type: "message", role: "assistant", text: "hi" } },
      {
        dispatchId,
        seq: 2,
        event: { type: "artifact", key: "report", kind: "markdown", path: "report" },
      },
      { dispatchId, seq: 3, event: { type: "step.completed", output: "done" } },
    ]);
    await db
      .update(dispatches)
      .set({ status: "completed", finishedAt: sql`now()` })
      .where(eq(dispatches.id, dispatchId));

    await consume;
    expect(seen).toEqual(["message", "artifact", "step.completed"]);
    expect(stagedRef).toBe(`${dispatchId}/report`);
  });

  it("maps ctx.signal to the abort flag and kills silent dispatches via deadman", async () => {
    const runtimeId = await newRuntime([{ id: "claude-agent-sdk" }]);
    const run = await newRun({ runtimeId });
    await runningStepRow(run.id, "step-b");
    const executor = makeExecutor(runtimeId, { deadmanMs: 400 });

    const controller = new AbortController();
    const events: string[] = [];
    const consume = (async () => {
      for await (const event of executor.executeStep(baseRequest(run.id, "step-b"), {
        signal: controller.signal,
        logger: silentLogger,
      })) {
        events.push(event.type);
      }
    })();

    await Bun.sleep(100);
    controller.abort();
    await Bun.sleep(100);
    const [d] = await db.select().from(dispatches).where(eq(dispatches.runId, run.id));
    expect(d?.abortRequested).toBe(true);

    // nobody ever claims it — the deadman fails the dispatch and the stream
    await consume;
    expect(events).toEqual(["step.failed"]);
    const [after] = await db.select().from(dispatches).where(eq(dispatches.runId, run.id));
    expect(after?.status).toBe("failed");
  });

  it("aborts stale predecessors when a new attempt dispatches", async () => {
    const runtimeId = await newRuntime([{ id: "claude-agent-sdk" }]);
    const run = await newRun({ runtimeId });
    const oldRow = await runningStepRow(run.id, "step-old");
    // mark the old attempt row failed-crashed (a drained attempt), leaving its
    // dispatch claimed on the daemon
    const [stale] = await db
      .insert(dispatches)
      .values({
        runId: run.id,
        stepRowId: oldRow,
        runtimeId,
        status: "claimed",
        payload: {},
      })
      .returning({ id: dispatches.id });
    await db
      .update(runSteps)
      .set({ status: "failed", error: { code: "crashed", message: "drained" } })
      .where(eq(runSteps.id, oldRow));

    const [newRow] = await db
      .insert(runSteps)
      .values({
        runId: run.id,
        phaseId: "p",
        stepId: "step-old",
        iteration: 1,
        attempt: 2,
        seq: 2,
        status: "running",
      })
      .returning({ id: runSteps.id });
    expect(newRow).toBeDefined();

    const executor = makeExecutor(runtimeId, { deadmanMs: 300 });
    const controller = new AbortController();
    const consume = (async () => {
      const drained: string[] = [];
      for await (const event of executor.executeStep(baseRequest(run.id, "step-old"), {
        signal: controller.signal,
        logger: silentLogger,
      })) {
        drained.push(event.type); // deadman will end the stream
      }
      return drained;
    })();
    await consume;

    const [staleAfter] = await db
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, stale?.id as string));
    expect(staleAfter?.abortRequested).toBe(true);
  });

  it("refuses to dispatch a request carrying platform provider credentials", async () => {
    const runtimeId = await newRuntime([{ id: "claude-agent-sdk" }]);
    const run = await newRun({ runtimeId });
    await runningStepRow(run.id, "step-leak");
    const executor = makeExecutor(runtimeId);

    const request: StepExecutionRequest = {
      ...baseRequest(run.id, "step-leak"),
      providerAuth: { provider: "anthropic", apiKey: "sk-live-should-never-ship" },
    };
    const controller = new AbortController();
    const iterate = async (): Promise<void> => {
      for await (const _ of executor.executeStep(request, {
        signal: controller.signal,
        logger: silentLogger,
      })) {
        // drain — the guard must throw before any event
      }
    };
    await expect(iterate()).rejects.toThrow(/refusing to dispatch/);
    // and nothing was persisted for a daemon to claim
    const rows = await db.select().from(dispatches).where(eq(dispatches.runId, run.id));
    expect(rows).toHaveLength(0);
  });

  it("checkout pins the publication base server-side (ls-remote at checkout)", async () => {
    // local bare origin with two commits: the pin is resolved by the SERVER
    // before any daemon involvement
    const sh = (args: string[], cwd?: string): string => {
      const res = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      if (res.exitCode !== 0) throw new Error(`git ${args[0]}: ${res.stderr.toString()}`);
      return res.stdout.toString();
    };
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const origin = `${mkdtempSync(path.join(tmpdir(), "agrippa-remote-origin-"))}/repo.git`;
    sh(["init", "--bare", "-b", "main", origin]);
    const work = mkdtempSync(path.join(tmpdir(), "agrippa-remote-work-"));
    sh(["clone", origin, work]);
    sh(["-C", work, "config", "user.email", "f@example.com"]);
    sh(["-C", work, "config", "user.name", "Fixture"]);
    await Bun.write(path.join(work, "README.md"), "# base\n");
    sh(["add", "-A"], work);
    sh(["commit", "-m", "init"], work);
    sh(["push", "origin", "main"], work);
    const tipSha = sh(["rev-parse", "HEAD"], work).trim();

    const [conn] = await db
      .insert(repoConnections)
      .values({ projectId, provider: "generic-git", url: origin, defaultBranch: "main" })
      .returning({ id: repoConnections.id });
    const runtimeId = await newRuntime([{ id: "claude-agent-sdk" }]);
    const run = await newRun({ runtimeId });

    const manager = new RemoteWorkspaceManager(db, runtimeId);
    await manager.checkout(run.id, {
      repo: { repoConnectionId: conn?.id as string },
      ref: "main",
      access: "readWrite",
      projectId,
    });
    const spec = await manager.workspaceSpec(run.id);
    expect(spec?.repoUrl).toBe(origin);
    expect(spec?.ref).toBe("main");
    expect(spec?.baseSha).toBe(tipSha);

    // annotated tag: ls-remote's first line is the TAG OBJECT — the pin must
    // be the peeled commit (the daemon checks out and reports the commit, and
    // git.push needs a commit parent), or publication always rejects
    sh(["-C", work, "tag", "-a", "v1", "-m", "release"]);
    sh(["push", "origin", "v1"], work);
    const tagObjectSha = sh(["rev-parse", "v1"], work).trim();
    const peeledSha = sh(["rev-parse", "v1^{commit}"], work).trim();
    expect(tagObjectSha).not.toBe(peeledSha); // annotated → a real tag object

    const tagged = await newRun({ runtimeId });
    await manager.checkout(tagged.id, {
      repo: { repoConnectionId: conn?.id as string },
      ref: "v1",
      access: "readWrite",
      projectId,
    });
    const taggedSpec = await manager.workspaceSpec(tagged.id);
    expect(taggedSpec?.baseSha).toBe(peeledSha);
  });
});

describe.skipIf(!dbUp)("runtime-offline notifications (Track N deferral)", () => {
  it("flags pinned running runs exactly once per outage", async () => {
    const runtimeId = await newRuntime([{ id: "claude-agent-sdk" }], { seenSecondsAgo: 400 });
    const run = await newRun({ runtimeId, status: "running" });
    const bystander = await newRun({ runtimeId, status: "succeeded" });

    const first = await sweepOfflineRuntimes(db);
    expect(first).toEqual([run.id]);
    const events = await db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, run.id), eq(runEvents.type, "runtime.offline")));
    expect(events).toHaveLength(1);
    expect((events[0]?.payload as { runtimeName?: string } | undefined)?.runtimeName).toBeDefined();
    // terminal runs pinned to the same runtime are not flagged
    const bystanderEvents = await db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, bystander.id), eq(runEvents.type, "runtime.offline")));
    expect(bystanderEvents).toHaveLength(0);

    // same outage, next sweep: the watermark suppresses a duplicate
    expect(await sweepOfflineRuntimes(db)).toEqual([]);

    // it recovered (seen after the notification) and died again → re-notify
    await db
      .update(runtimes)
      .set({
        lastSeenAt: sql`now() - interval '400 seconds'`,
        notifiedOfflineAt: sql`now() - interval '500 seconds'`,
      })
      .where(eq(runtimes.id, runtimeId));
    expect(await sweepOfflineRuntimes(db)).toEqual([run.id]);
    // no cleanup: earlier transport tests left dispatches referencing other
    // runtimes, and this is the file's final suite
  });
});
