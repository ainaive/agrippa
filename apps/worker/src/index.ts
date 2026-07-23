import {
  type ApprovalExpirePayload,
  EXECUTOR_CATALOG,
  isExecutorId,
  isTerminalRunStatus,
  QUEUE_APPROVAL_EXPIRE,
  QUEUE_RUN_EXECUTE,
  type RunExecutePayload,
} from "@agrippa/core";
import { checkpoints, createDb, executorRegistrations, runs } from "@agrippa/db";
import { createClaudeExecutor } from "@agrippa/executor-claude";
import { createCodexExecutor, probeCodexCli } from "@agrippa/executor-codex";
import type { Executor } from "@agrippa/executor-core";
import {
  appendRunEvent,
  createRunQueue,
  decideCheckpoint,
  durationToMinutes,
  type EngineDeps,
  ExecutorUnavailableError,
  executeRun,
  FakeScmService,
  finalizeRun,
  findStrandedCheckpointRuns,
  InProcessEventBus,
  RedisEventBus,
} from "@agrippa/orchestration";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Job, JobWithMetadata } from "pg-boss";
import { DiskArtifactStore } from "./deps/artifacts";
import { DemoExecutor } from "./deps/demo-executor";
import { DbResourceMaterializer } from "./deps/resources";
import { GitScmService } from "./deps/scm";
import { GitWorkspaceManager } from "./deps/workspace";

const db = createDb();
const bus = process.env.REDIS_URL
  ? new RedisEventBus(process.env.REDIS_URL)
  : new InProcessEventBus();
const queue = await createRunQueue(process.env.DATABASE_URL as string);

const executors: Record<string, Executor> = {
  "claude-agent-sdk": createClaudeExecutor(),
  fake: new DemoExecutor(),
};
// codex registers only when the CLI is actually usable on this host — which
// includes supporting the config-isolation flags every step passes
const codexProbe = probeCodexCli();
const codexAuth = Boolean(
  process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.CODEX_HOME,
);
if (codexProbe.ok && codexAuth) {
  executors["codex-cli"] = createCodexExecutor();
  console.log(`[worker] codex executor registered (${codexProbe.version})`);
} else {
  const reason = codexProbe.ok ? "no auth configured" : codexProbe.reason;
  console.log(`[worker] codex executor not registered (${reason})`);
}
// the static catalog in @agrippa/core is what the API/SPA trust — a drifting
// capability set here would let templates pass validation and fail at runtime
for (const [id, executor] of Object.entries(executors)) {
  if (!isExecutorId(id)) throw new Error(`executor '${id}' is not in EXECUTOR_CATALOG`);
  const expected = EXECUTOR_CATALOG[id].capabilities;
  const actual = executor.capabilities as Record<string, boolean>;
  for (const [flag, value] of Object.entries(expected)) {
    // the catalog may promise less than the executor delivers, never more
    if (value && !actual[flag]) {
      throw new Error(`executor '${id}' lacks catalog capability '${flag}'`);
    }
  }
}

/**
 * Advertise what this worker actually registered: the API rejects submissions
 * that bind an executor with no recent registration, so a codex-less
 * deployment fails at submit with an actionable error instead of exhausting
 * queue retries later. Heartbeated below so a reconfigured deployment ages
 * out of the live set.
 */
async function registerExecutors(): Promise<void> {
  for (const executorId of Object.keys(executors)) {
    await db
      .insert(executorRegistrations)
      .values({ executorId, registeredAt: new Date() })
      .onConflictDoUpdate({
        target: executorRegistrations.executorId,
        set: { registeredAt: new Date() },
      });
  }
}
await registerExecutors();

const deps: EngineDeps = {
  db,
  executors,
  bus,
  workspace: new GitWorkspaceManager(db),
  resources: new DbResourceMaterializer(db),
  artifacts: new DiskArtifactStore(),
  scm: process.env.AGRIPPA_SCM === "fake" ? new FakeScmService() : new GitScmService(db),
  logger: {
    info: (msg, extra) => console.log(`[worker] ${msg}`, extra ?? ""),
    warn: (msg, extra) => console.warn(`[worker] ${msg}`, extra ?? ""),
    error: (msg, extra) => console.error(`[worker] ${msg}`, extra ?? ""),
  },
};

const SLOTS = Number(process.env.WORKER_SLOTS ?? 2);

await queue.boss.work(
  QUEUE_RUN_EXECUTE,
  {
    batchSize: 1,
    includeMetadata: true,
    pollingIntervalSeconds: 1,
    localConcurrency: SLOTS,
  } as const,
  async (jobs: JobWithMetadata<RunExecutePayload>[]) => {
    for (const job of jobs) {
      const { runId } = job.data;
      const meta = job as unknown as { retryCount?: number; retryLimit?: number };
      try {
        const outcome = await executeRun(deps, runId);
        deps.logger.info(`run ${runId}: ${outcome}`);
        if (outcome === "waiting_approval") await scheduleApprovalExpiry(runId);
      } catch (err) {
        // Heterogeneous fleet: this worker lacks the run's executor. The
        // throw happens before any status transition, so for pre-claim states
        // we DECLINE the job (no pg-boss retries burned) and let the sweepers
        // re-enqueue — `queued` runs re-enqueue after 30s (queuedAt never
        // refreshes), decided `waiting_approval` runs via the stranded-
        // checkpoint sweep; a still-pending checkpoint re-enqueues on its
        // decision. The run bounces ≤60s at a time until a capable worker
        // takes it. A `running` run (crash-recovery pickup) must rethrow:
        // nothing re-enqueues an unclaimed running run today — the execution
        // lease is ADR-0009 future work.
        if (
          (typeof err === "object" &&
            err !== null &&
            (err as { code?: string }).code === "executor_unavailable_on_worker") ||
          err instanceof ExecutorUnavailableError
        ) {
          const [run] = await db
            .select({ status: runs.status })
            .from(runs)
            .where(eq(runs.id, runId));
          if (run && (run.status === "queued" || run.status === "waiting_approval")) {
            deps.logger.warn(`run ${runId}: declining — ${String((err as Error).message)}`);
            // one timeline event so the SPA can show WHY the run is waiting
            await appendRunEvent(db, {
              runId,
              type: "run.deferred",
              payload: { reason: String((err as Error).message) },
            });
            continue;
          }
        }
        deps.logger.error(`run ${runId} crashed`, { err: String(err) });
        if ((meta.retryCount ?? 0) >= (meta.retryLimit ?? 0)) {
          await markRunFailed(runId, err);
        }
        throw err; // let pg-boss retry — the engine resumes step-granularly
      }
    }
  },
);

await queue.boss.work(QUEUE_APPROVAL_EXPIRE, async (jobs: Job<ApprovalExpirePayload>[]) => {
  for (const job of jobs) {
    // CAS pending → expired; null means a user already decided it (or a prior
    // run of this job did) — nothing to do
    const expired = await decideCheckpoint(db, job.data.approvalId, { status: "expired" });
    if (!expired) continue;
    deps.logger.warn(`approval ${expired.id} expired — resuming run for onTimeout handling`);
    await queue.enqueueRun(job.data.runId); // engine applies the template's onTimeout
  }
});

async function scheduleApprovalExpiry(runId: string): Promise<void> {
  const rows = await db
    .select()
    .from(checkpoints)
    .where(and(eq(checkpoints.runId, runId), eq(checkpoints.status, "pending")));
  for (const approval of rows) {
    const payload = approval.payload as { timeoutMinutes?: number };
    const minutes = payload.timeoutMinutes ?? durationToMinutes("24h");
    await queue.enqueueApprovalExpiry(
      { approvalId: approval.id, runId },
      approval.requestedAt.getTime() + minutes * 60_000,
    );
  }
}

async function markRunFailed(runId: string, err: unknown): Promise<void> {
  const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
  if (!run || isTerminalRunStatus(run.status)) return;
  // one shared finalization impl: CAS from the *current* status (so a queued run
  // whose setup threw before it was claimed transitions queued→failed, not the
  // illegal queued→failed of a hard-coded from), and it emits the terminal event
  // that the old id-only update omitted
  const error = { code: "internal", message: `retries exhausted: ${String(err).slice(0, 500)}` };
  await finalizeRun(db, {
    runId,
    from: run.status,
    to: "failed",
    error,
    usageTotals: {},
    eventPayload: { error },
  });
}

/**
 * Reconciliation sweeper: re-enqueues queued runs whose job got lost (e.g.
 * the API crashed between commit and send). Singleton keys make this safe.
 */
setInterval(async () => {
  try {
    const stragglers = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.status, "queued"), lt(runs.queuedAt, sql`now() - interval '30 seconds'`)));
    for (const run of stragglers) await queue.enqueueRun(run.id);

    // runs paused on an approval that has since been decided but whose resume
    // enqueue was lost (e.g. the API/worker died between the decision and the
    // send) — re-enqueue so the decision actually takes effect
    for (const runId of await findStrandedCheckpointRuns(db)) await queue.enqueueRun(runId);

    // executor-availability heartbeat (the API's live window is minutes-wide)
    await registerExecutors();
  } catch (err) {
    deps.logger.warn("sweeper failed", { err: String(err) });
  }
}, 60_000);

console.log(`[worker] up — slots=${SLOTS} redis=${Boolean(process.env.REDIS_URL)}`);

process.on("SIGTERM", async () => {
  deps.logger.info("draining…");
  await queue.stop();
  process.exit(0);
});
