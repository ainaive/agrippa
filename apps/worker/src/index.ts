import { hostname } from "node:os";
import {
  type ApprovalExpirePayload,
  EXECUTOR_CATALOG,
  isExecutorId,
  type NotificationDeliverPayload,
  QUEUE_APPROVAL_EXPIRE,
  QUEUE_NOTIFICATION_DELIVER,
  QUEUE_SCHEDULE_FIRE,
  type ScheduleFirePayload,
} from "@agrippa/core";
import {
  awaitSchema,
  createDb,
  notificationDeliveries,
  runs,
  runtimes,
  taskSchedules,
} from "@agrippa/db";
import { createClaudeExecutor } from "@agrippa/executor-claude";
import { createCodexExecutor, probeCodexCli } from "@agrippa/executor-codex";
import type { Executor } from "@agrippa/executor-core";
import {
  appendRunEvent,
  createRunQueue,
  DiskArtifactStore,
  dbRunExecutorResolver,
  decideCheckpoint,
  type EngineDeps,
  FakeScmService,
  findStrandedCheckpointRuns,
  fireSchedule,
  InProcessEventBus,
  liveCentralWorkerSets,
  RedisEventBus,
  sweepNotificationDeliveries,
  sweepOfflineRuntimes,
  sweepRunLeases,
} from "@agrippa/orchestration";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Job, JobWithMetadata } from "pg-boss";
import { createRunConsumer, startRunFetchLoop } from "./consumer";
import { DemoExecutor } from "./deps/demo-executor";
import { deliverNotification } from "./deps/notify";
import {
  markBootStarted,
  markConsumersReady,
  touchWorkerHeartbeat,
  WORKER_SCHEMA_WAIT_MS,
} from "./deps/readiness";
import { DbResourceMaterializer } from "./deps/resources";
import { GitScmService } from "./deps/scm";
import { GitWorkspaceManager } from "./deps/workspace";
import { selectRunQueues } from "./run-queues";

const db = createDb();
// inside a compose container the hostname IS the container id — the identity
// deploy verification counts readiness rows by. Boot-start clears any prior
// boot's readiness FIRST, so a boot that wedges below never looks ready.
const containerId = hostname();

// The api migrates on boot; this worker only reads and writes, so it waits for
// the schema its own build expects rather than crashing on a table the
// database has not been given yet (a crash-looping worker fails deploy
// verification and rolls back a good deploy). createDb() is lazy, so nothing
// has touched the database before this point.
//
// The bound MUST exceed deploy.sh's HEALTH_TIMEOUT (180s) — see
// WORKER_SCHEMA_WAIT_MS below.
await awaitSchema(db, {
  timeoutMs: WORKER_SCHEMA_WAIT_MS,
  log: (msg) => console.log(`[worker] ${msg}`),
});

// Executor construction is DB-free (the codex probe runs a CLI, nothing
// else), so it happens before the first heartbeat write: boot-start carries
// the capability advertisement the API's submit gating and fleet page read.
const executors: Record<string, Executor> = {
  "claude-agent-sdk": createClaudeExecutor(),
  fake: new DemoExecutor(),
};
// codex registers only when the CLI is actually usable on this host — which
// includes supporting the config-isolation flags every step passes. Env auth
// is no longer required at boot: a project provider credential can arrive
// per-step, so a keyless worker is still a valid codex host.
const codexProbe = probeCodexCli();
if (codexProbe.ok) {
  executors["codex-cli"] = createCodexExecutor();
  const authMode =
    process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.CODEX_HOME
      ? "env auth"
      : "project credentials only";
  console.log(`[worker] codex executor registered (${codexProbe.version}, ${authMode})`);
} else {
  console.log(`[worker] codex executor not registered (${codexProbe.reason})`);
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

const workerAd = {
  executors: Object.entries(executors).map(([id, executor]) => ({
    id,
    envAuthProviders: executor.envAuthProviders ? [...executor.envAuthProviders] : undefined,
  })),
  version: process.env.AGRIPPA_VERSION ?? null,
};

await markBootStarted(db, containerId, workerAd);
const bus = process.env.REDIS_URL
  ? new RedisEventBus(process.env.REDIS_URL)
  : new InProcessEventBus();
const queue = await createRunQueue(process.env.DATABASE_URL as string, {
  resolveRunExecutors: dbRunExecutorResolver(db),
});

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
  // execution-lease identity: claims, renewals, and releases all key on it
  lease: { owner: containerId },
};

const SLOTS = Number(process.env.WORKER_SLOTS ?? 2);

const consumer = createRunConsumer(db, deps, queue);

/**
 * The queues this worker polls (see selectRunQueues for the selection rules):
 * its own executor-set subsets, runtime-covered sets no live central worker
 * can serve (the engine runs centrally even when the executor is remote, so
 * daemon-only sets need SOME worker fetching their jobs — but sets a capable
 * central worker covers are left to that worker, or an incapable fetcher
 * would route central and decline in a steal loop).
 * Recomputed on the sweeper tick because runtimes and workers come and go.
 */
const knownQueues = new Set<string>();
async function computeRunQueues(): Promise<string[]> {
  const liveRuntimes = await db
    .select({ name: runtimes.name, executors: runtimes.executors })
    .from(runtimes)
    .where(
      and(
        eq(runtimes.status, "active"),
        gte(runtimes.lastSeenAt, sql`now() - interval '15 minutes'`),
      ),
    );
  // the SAME live-and-ready predicate routing's central-coverage check uses
  // (150s + consumers ready) — a dead or boot-wedged sole-capable worker must
  // not suppress a live daemon's queues for the old 15-minute window
  const liveWorkers = await liveCentralWorkerSets(db);
  const list = selectRunQueues({
    localExecutorIds: Object.keys(executors),
    centralWorkerSets: liveWorkers.map((ads) => ads.map((e) => e.id)),
    runtimeAds: liveRuntimes.map((r) => ({
      name: r.name,
      ids: (r.executors ?? []).map((e) => e.id),
    })),
    logger: { warn: (msg) => deps.logger.warn(msg) },
  });
  // queues must exist before the first fetch (createQueue is idempotent)
  for (const name of list) {
    if (knownQueues.has(name)) continue;
    await queue.boss.createQueue(name);
    knownQueues.add(name);
  }
  return list;
}

const fetchLoop = startRunFetchLoop({
  boss: queue.boss,
  queues: await computeRunQueues(),
  slots: SLOTS,
  handler: consumer.handleRunJob,
  logger: deps.logger,
});

// Lease renewal on its own cadence (TTL/3): the 60s sweeper is too coarse for
// a 90s TTL — one delayed tick would expire every lease this worker holds.
const leaseRenewal = setInterval(() => {
  consumer.renewLeases().catch((err) => {
    deps.logger.warn("lease renewal failed", { err: String(err) });
  });
}, 30_000);

await queue.boss.work(QUEUE_APPROVAL_EXPIRE, async (jobs: Job<ApprovalExpirePayload>[]) => {
  for (const job of jobs) {
    // CAS pending → expired and its timeline event commit TOGETHER: the CAS
    // makes this job's retry a no-op, so a crash between the two would leave
    // an expired checkpoint that event-derived notifications can never see.
    // null means a user already decided it (or a prior run of this job did).
    const expired = await db.transaction(async (tx) => {
      const row = await decideCheckpoint(tx, job.data.approvalId, { status: "expired" });
      if (!row) return null;
      // the expiry previously left no trace until the engine resumed — one
      // timeline event so the timeline (and notifications) can show it
      await appendRunEvent(tx, {
        runId: job.data.runId,
        type: "checkpoint.expired",
        payload: {
          checkpointRowId: row.id,
          checkpointId: row.checkpointId,
          kind: row.kind,
          iteration: row.iteration,
          title: (row.payload as { title?: unknown }).title,
        },
      });
      return row;
    });
    if (!expired) continue;
    deps.logger.warn(`approval ${expired.id} expired — resuming run for onTimeout handling`);
    // the onTimeout resume must never wait on delivery bookkeeping
    await queue.enqueueRun(job.data.runId); // engine applies the template's onTimeout
    await consumer.syncNotificationsBestEffort(job.data.runId);
  }
});

await queue.boss.work(
  QUEUE_NOTIFICATION_DELIVER,
  { includeMetadata: true, pollingIntervalSeconds: 1 } as const,
  async (jobs: JobWithMetadata<NotificationDeliverPayload>[]) => {
    for (const job of jobs) {
      const meta = job as unknown as { retryCount?: number; retryLimit?: number };
      try {
        await deliverNotification(db, job.data.deliveryId);
      } catch (err) {
        deps.logger.warn(`notification ${job.data.deliveryId} attempt failed`, {
          err: String(err),
        });
        if ((meta.retryCount ?? 0) >= (meta.retryLimit ?? 0)) {
          // terminal bookkeeping mirrors markRunFailed: the attempt itself was
          // already recorded by deliverNotification; only the status flips here
          await db
            .update(notificationDeliveries)
            .set({ status: "failed" })
            .where(
              and(
                eq(notificationDeliveries.id, job.data.deliveryId),
                eq(notificationDeliveries.status, "pending"),
              ),
            );
          continue; // retries exhausted — completing the job ends the churn
        }
        throw err; // pg-boss retries with backoff
      }
    }
  },
);

await queue.boss.work(QUEUE_SCHEDULE_FIRE, async (jobs: Job<ScheduleFirePayload>[]) => {
  for (const job of jobs) {
    // fireSchedule never throws for a schedule-level problem: it records the
    // outcome on the row and announces it. A throw here would mean an
    // infrastructure fault, which pg-boss should retry.
    const outcome = await fireSchedule(db, queue, job.data.scheduleId);
    deps.logger.info(`schedule ${job.data.scheduleId} fired`, { outcome: outcome.kind });
  }
});

// Reconcile pg-boss's cron calendar with the schedule rows. The two are
// written separately (row first, registration second), so a crash in between —
// or a database restored from a backup taken mid-edit — can leave a schedule
// that never fires, which is invisible by nature. Re-registering every enabled
// schedule at boot is idempotent (`key` replaces the entry) and cheap.
try {
  const enabled = await db
    .select({ id: taskSchedules.id, cron: taskSchedules.cron, timezone: taskSchedules.timezone })
    .from(taskSchedules)
    .where(eq(taskSchedules.enabled, true));
  for (const row of enabled) await queue.registerSchedule(row.id, row.cron, row.timezone);
  deps.logger.info(`reconciled ${enabled.length} schedule(s)`);
} catch (err) {
  deps.logger.warn("schedule reconciliation failed", { err: String(err) });
}

// every consumer above is live — the boss.work() calls returned and the
// run fetch loop is ticking — which is the signal deploy verification counts
// (issue #15)
await markConsumersReady(db, containerId);

/**
 * Reconciliation sweeper: re-enqueues queued runs whose job got lost (e.g.
 * the API crashed between commit and send). Singleton keys make this safe.
 */
setInterval(async () => {
  try {
    // liveness beat FIRST: deploy verification reads it through a sliding
    // window, so a transient error in the sweep work below must not skip it
    await touchWorkerHeartbeat(db, containerId, workerAd);

    const stragglers = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.status, "queued"), lt(runs.queuedAt, sql`now() - interval '30 seconds'`)));
    for (const run of stragglers) await queue.enqueueRun(run.id);

    // execution-lease sweep (ADR-0017 Decision 4): expire dead leases (each
    // gets one run.lease_expired event, CAS-safe across replicas) and
    // re-enqueue every leaseless running run — the recovery path crashed
    // `running` runs never had. Singleton keys dedupe repeat enqueues.
    const { expired, orphaned } = await sweepRunLeases(db);
    for (const { id, previousOwner } of expired) {
      deps.logger.warn(`run ${id}: lease expired (owner ${previousOwner ?? "unknown"})`);
    }
    for (const runId of orphaned) await queue.enqueueRun(runId);

    // runtime-offline notifications (ADR-0017): a silent daemon flags its
    // pinned running runs with a runtime.offline event; deliveries derive
    // from the event, deduped per endpoint like every other notification
    for (const runId of await sweepOfflineRuntimes(db)) {
      await consumer.syncNotificationsBestEffort(runId);
    }

    // queue coverage tracks the live fleet: a runtime registering a new
    // executor set needs a worker polling that set's queue within a tick
    fetchLoop.updateQueues(await computeRunQueues());

    // runs paused on an approval that has since been decided but whose resume
    // enqueue was lost (e.g. the API/worker died between the decision and the
    // send) — re-enqueue so the decision actually takes effect
    for (const runId of await findStrandedCheckpointRuns(db)) await queue.enqueueRun(runId);

    // notification backstop: backfill missed events, re-enqueue stale rows
    await sweepNotificationDeliveries(db, queue);
  } catch (err) {
    deps.logger.warn("sweeper failed", { err: String(err) });
  }
}, 60_000);

console.log(
  `[worker] up — container=${containerId} slots=${SLOTS} redis=${Boolean(process.env.REDIS_URL)}`,
);

process.on("SIGTERM", async () => {
  deps.logger.info("draining…");
  clearInterval(leaseRenewal);
  // 1. stop fetching (no new runs land mid-shutdown); 2. abort in-flight
  // engines — each exits `drained`, releases its lease, and re-enqueues so a
  // healthy worker resumes step-granularly without burning retries; 3. wait
  // for the jobs to settle, bounded so a wedged step cannot outlive the
  // compose stop_grace_period (60s).
  const settled = fetchLoop.stop();
  consumer.drainActive();
  await Promise.race([settled, Bun.sleep(15_000)]);
  await queue.stop();
  process.exit(0);
});
