import {
  type ApprovalExpirePayload,
  isTerminalRunStatus,
  QUEUE_APPROVAL_EXPIRE,
  QUEUE_RUN_EXECUTE,
  type RunExecutePayload,
} from "@agrippa/core";
import { approvals, createDb, runs } from "@agrippa/db";
import { createClaudeExecutor } from "@agrippa/executor-claude";
import { FakeExecutor } from "@agrippa/executor-core";
import {
  createRunQueue,
  durationToMinutes,
  type EngineDeps,
  executeRun,
  InProcessEventBus,
  RedisEventBus,
} from "@agrippa/orchestration";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Job, JobWithMetadata } from "pg-boss";
import { DiskArtifactStore } from "./deps/artifacts";
import { DbResourceMaterializer } from "./deps/resources";
import { GitWorkspaceManager } from "./deps/workspace";

const db = createDb();
const bus = process.env.REDIS_URL
  ? new RedisEventBus(process.env.REDIS_URL)
  : new InProcessEventBus();
const queue = await createRunQueue(process.env.DATABASE_URL as string);

const deps: EngineDeps = {
  db,
  executors: {
    "claude-agent-sdk": createClaudeExecutor(),
    fake: new FakeExecutor(demoScript()),
  },
  bus,
  workspace: new GitWorkspaceManager(db),
  resources: new DbResourceMaterializer(db),
  artifacts: new DiskArtifactStore(),
  logger: {
    info: (msg, extra) => console.log(`[worker] ${msg}`, extra ?? ""),
    warn: (msg, extra) => console.warn(`[worker] ${msg}`, extra ?? ""),
    error: (msg, extra) => console.error(`[worker] ${msg}`, extra ?? ""),
  },
};

/** Demo behaviors for AGRIPPA_EXECUTOR=fake runs — every step just succeeds. */
function demoScript() {
  return {};
}

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
    const [approval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, job.data.approvalId));
    if (approval?.status !== "pending") continue;
    await db
      .update(approvals)
      .set({ status: "expired", decidedAt: new Date() })
      .where(eq(approvals.id, approval.id));
    deps.logger.warn(`approval ${approval.id} expired — resuming run for onTimeout handling`);
    await queue.enqueueRun(job.data.runId); // engine applies the template's onTimeout
  }
});

async function scheduleApprovalExpiry(runId: string): Promise<void> {
  const rows = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.runId, runId), eq(approvals.status, "pending")));
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
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run || isTerminalRunStatus(run.status)) return;
  await db
    .update(runs)
    .set({
      status: "failed",
      finishedAt: new Date(),
      error: { code: "internal", message: `retries exhausted: ${String(err).slice(0, 500)}` },
    })
    .where(eq(runs.id, runId));
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
