import { isTerminalRunStatus, type RunExecutePayload } from "@agrippa/core";
import { checkpoints, type Db, runs } from "@agrippa/db";
import {
  appendRunEvent,
  type BossQueue,
  durationToMinutes,
  type EngineDeps,
  ExecutorUnavailableError,
  executeRun,
  finalizeRun,
  type RunControlHandle,
  remoteEngineDeps,
  renewRunLeases,
  routeRun,
  syncRunNotifications,
} from "@agrippa/orchestration";
import { and, eq } from "drizzle-orm";
import type { JobWithMetadata, PgBoss } from "pg-boss";

/**
 * The run.execute job handler plus its bookkeeping helpers, extracted from the
 * worker entrypoint so the fetch loop below (and integration tests) can drive
 * the exact production body without booting a worker process. Behavior is the
 * former boss.work() callback, unchanged: resolving normally completes the
 * job, throwing fails it (pg-boss then retries within retryLimit).
 */
export type RunConsumer = {
  handleRunJob(job: JobWithMetadata<RunExecutePayload>): Promise<void>;
  scheduleApprovalExpiry(runId: string): Promise<void>;
  syncNotificationsBestEffort(runId: string): Promise<void>;
  markRunFailed(runId: string, err: unknown): Promise<void>;
  /** Abort every in-flight engine for graceful shutdown (they exit `drained`). */
  drainActive(): void;
  /**
   * Renew this worker's leases on every in-flight run; an engine whose lease
   * could not be renewed is told to stop (`lostLease`). Call on a cadence of
   * ~TTL/3 (30s for the default 90s TTL). No-op without a lease identity.
   */
  renewLeases(): Promise<void>;
};

export function createRunConsumer(db: Db, deps: EngineDeps, queue: BossQueue): RunConsumer {
  const active = new Map<string, RunControlHandle>();
  /**
   * Trigger-site delivery syncs are best-effort: the reconciliation sweeper is
   * the delivery guarantee, so a bookkeeping failure must never fail (or
   * pg-boss-retry) the critical work that preceded it.
   */
  async function syncNotificationsBestEffort(runId: string): Promise<void> {
    try {
      await syncRunNotifications(db, queue, runId);
    } catch (err) {
      deps.logger.warn(`notification sync failed for run ${runId}`, { err: String(err) });
    }
  }

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
    await syncNotificationsBestEffort(runId);
  }

  async function handleRunJob(job: JobWithMetadata<RunExecutePayload>): Promise<void> {
    const { runId } = job.data;
    const meta = job as unknown as { retryCount?: number; retryLimit?: number };
    try {
      // Routing happens before engine construction (ADR-0017): a daemon-routed
      // run gets per-run deps whose executors are RemoteExecutor proxies and
      // whose workspace is the remote variant — the engine itself is unaware.
      // Deterministic given (run row, registry), pin absolute, so a resume
      // re-derives the identical decision.
      let runDeps = deps;
      const [runRow] = await db.select().from(runs).where(eq(runs.id, runId));
      if (runRow && !isTerminalRunStatus(runRow.status)) {
        const decision = await routeRun(db, runRow);
        if (decision.kind === "remote") {
          deps.logger.info(
            `run ${runId}: routed to runtime '${decision.runtime.name}' (${decision.runtime.id})`,
          );
          runDeps = remoteEngineDeps(deps, runRow, decision.runtime);
        }
      }
      const outcome = await executeRun(runDeps, runId, {
        onStarted: (handle) => active.set(runId, handle),
      });
      deps.logger.info(`run ${runId}: ${outcome}`);
      if (outcome === "waiting_approval") await scheduleApprovalExpiry(runId);
      if (outcome === "drained") {
        // fast handoff: the engine released the lease without finalizing, so
        // any worker can claim immediately; completing (not failing) the job
        // means drains never burn the retryLimit budget. Singleton keys make
        // the re-enqueue safe, and the lease sweeper backstops a lost send.
        await queue.enqueueRun(runId);
        return;
      }
      // post-commit delivery sync (idempotent) — covers checkpoint.required
      // and every engine-side terminal event in one place
      await syncNotificationsBestEffort(runId);
    } catch (err) {
      // Heterogeneous fleet: this worker lacks the run's executor. Executor-set
      // queue routing (A1) makes this a deploy-skew fallback — only jobs from
      // the legacy run.execute queue can still land on the wrong worker. The
      // throw happens before any status transition, so for pre-claim states
      // we DECLINE the job (no pg-boss retries burned) and let the sweepers
      // re-enqueue — `queued` runs re-enqueue after 30s (queuedAt never
      // refreshes), decided `waiting_approval` runs via the stranded-
      // checkpoint sweep; a still-pending checkpoint re-enqueues on its
      // decision. The re-enqueue routes to the correct set queue. A `running`
      // run (crash-recovery pickup) still rethrows: the lease sweeper
      // re-enqueues it once the dead owner's lease expires.
      if (
        (typeof err === "object" &&
          err !== null &&
          (err as { code?: string }).code === "executor_unavailable_on_worker") ||
        err instanceof ExecutorUnavailableError
      ) {
        const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
        if (run && (run.status === "queued" || run.status === "waiting_approval")) {
          deps.logger.warn(`run ${runId}: declining — ${String((err as Error).message)}`);
          // one timeline event so the SPA can show WHY the run is waiting
          await appendRunEvent(db, {
            runId,
            type: "run.deferred",
            payload: { reason: String((err as Error).message) },
          });
          return;
        }
      }
      deps.logger.error(`run ${runId} crashed`, { err: String(err) });
      if ((meta.retryCount ?? 0) >= (meta.retryLimit ?? 0)) {
        await markRunFailed(runId, err);
      }
      throw err; // let pg-boss retry — the engine resumes step-granularly
    } finally {
      active.delete(runId);
    }
  }

  function drainActive(): void {
    for (const handle of active.values()) handle.drain();
  }

  async function renewLeases(): Promise<void> {
    const owner = deps.lease?.owner;
    if (!owner || active.size === 0) return;
    const held = [...active.keys()];
    const renewed = new Set(await renewRunLeases(db, owner, held, deps.lease?.ttlMs));
    for (const runId of held) {
      if (renewed.has(runId)) continue;
      // expired and swept (or the run left `running`) — another owner may
      // already be executing, so this engine must stop without re-enqueueing
      deps.logger.warn(`run ${runId}: lease lost — stopping local execution`);
      active.get(runId)?.lostLease();
    }
  }

  return {
    handleRunJob,
    scheduleApprovalExpiry,
    syncNotificationsBestEffort,
    markRunFailed,
    drainActive,
    renewLeases,
  };
}

export type RunFetchLoop = {
  /** Stop fetching; with awaitInFlight (default true) also wait for running jobs to settle. */
  stop(opts?: { awaitInFlight?: boolean }): Promise<void>;
};

/**
 * Manual fetch loop over this worker's executor-set queues (plus the legacy
 * queue). boss.work() is deliberately not used for run.execute: with one
 * work() per subset queue, jobs fetched beyond local concurrency would sit
 * active-but-unstarted on THIS worker, invisible to capable peers — exactly
 * the misrouting set queues exist to prevent. Fetching only up to free slots
 * keeps every unclaimed job visible to the whole fleet.
 *
 * Semantics preserved from work(): a job is fetched at most `slots` at a time
 * per worker, completes on handler resolve, fails on handler throw (pg-boss
 * retry accounting applies), and a crash leaves it to expire back to retry.
 */
export function startRunFetchLoop(cfg: {
  boss: PgBoss;
  queues: readonly string[];
  slots: number;
  handler: (job: JobWithMetadata<RunExecutePayload>) => Promise<void>;
  logger: EngineDeps["logger"];
  tickMs?: number;
}): RunFetchLoop {
  let inFlight = 0;
  let rotate = 0;
  let stopped = false;
  let ticking = false;
  const inFlightJobs = new Set<Promise<void>>();

  const runJob = (queueName: string, job: JobWithMetadata<RunExecutePayload>): void => {
    inFlight++;
    const settled = (async () => {
      try {
        await cfg.handler(job);
        await cfg.boss.complete(queueName, job.id);
      } catch (err) {
        try {
          await cfg.boss.fail(queueName, job.id, { message: String(err) });
        } catch (failErr) {
          // job expiry will return it to retry — losing the fail() is not fatal
          cfg.logger.warn(`fail() errored for job ${job.id} on ${queueName}`, {
            err: String(failErr),
          });
        }
      } finally {
        inFlight--;
      }
    })();
    inFlightJobs.add(settled);
    void settled.finally(() => inFlightJobs.delete(settled));
  };

  const tick = async (): Promise<void> => {
    if (stopped || ticking) return; // a slow tick must not overlap the next
    ticking = true;
    try {
      let capacity = cfg.slots - inFlight;
      const total = cfg.queues.length;
      for (let i = 0; i < total && capacity > 0 && !stopped; i++) {
        const queueName = cfg.queues[(rotate + i) % total] as string;
        let jobs: JobWithMetadata<RunExecutePayload>[] | null = null;
        try {
          jobs = await cfg.boss.fetch<RunExecutePayload>(queueName, {
            batchSize: capacity,
            includeMetadata: true,
          });
        } catch (err) {
          cfg.logger.warn(`fetch failed on ${queueName}`, { err: String(err) });
          continue;
        }
        for (const job of jobs ?? []) {
          capacity--;
          runJob(queueName, job);
        }
      }
      rotate = (rotate + 1) % Math.max(total, 1); // fairness across queues
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => {
    void tick().catch((err) => cfg.logger.warn("fetch loop tick failed", { err: String(err) }));
  }, cfg.tickMs ?? 1000);

  return {
    async stop(opts?: { awaitInFlight?: boolean }): Promise<void> {
      stopped = true;
      clearInterval(timer);
      if (opts?.awaitInFlight !== false) {
        await Promise.allSettled([...inFlightJobs]);
      }
    },
  };
}
