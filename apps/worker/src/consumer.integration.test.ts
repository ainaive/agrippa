import { afterAll, describe, expect, it } from "bun:test";
import { runExecuteQueueName, runExecuteSubsetQueues } from "@agrippa/core";
import { createDb } from "@agrippa/db";
import { type BossQueue, createRunQueue } from "@agrippa/orchestration";
import { sql } from "drizzle-orm";
import { type RunFetchLoop, startRunFetchLoop } from "./consumer";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/agrippa_test";

// one pool for the whole suite — a pool per fixture exhausts max_connections
const db = createDb(TEST_DATABASE_URL);
let dbUp = true;
try {
  await db.execute(sql`select 1`);
} catch {
  dbUp = false;
  console.warn("[test] postgres unreachable — skipping consumer fetch-loop suite");
}

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

// executor ids unique per suite run so lingering jobs from a previous run
// cannot satisfy (or pollute) this run's assertions
const suite = Bun.randomUUIDv7().slice(-8);
const EXEC_A = `exec-a-${suite}`;
const EXEC_B = `exec-b-${suite}`;
// the failing-handler test gets its own executor id: the loops from earlier
// tests keep running until afterAll, and an overlapping subset queue would
// let a healthy loop complete the job before the failing one can park it
const EXEC_C = `exec-c-${suite}`;

const jobRow = async (runId: string): Promise<{ name: string; state: string } | undefined> => {
  const rows = (await db.execute(
    sql`select name, state::text as state from pgboss.job
        where data->>'runId' = ${runId}
        order by created_on desc limit 1`,
  )) as unknown as Array<{ name: string; state: string }>;
  return rows[0];
};

const waitFor = async (
  probe: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await Bun.sleep(50);
  }
  throw new Error("waitFor: condition not reached");
};

describe.skipIf(!dbUp)("executor-set queue routing + fetch loop", () => {
  const resolvers = new Map<string, string[]>();
  let queue: BossQueue | undefined;
  const loops: RunFetchLoop[] = [];

  afterAll(async () => {
    for (const loop of loops) await loop.stop({ awaitInFlight: false });
    await queue?.stop();
  });

  const setup = async (): Promise<BossQueue> => {
    queue ??= await createRunQueue(TEST_DATABASE_URL, {
      resolveRunExecutors: async (runId) => resolvers.get(runId) ?? [],
    });
    return queue;
  };

  it("enqueueRun routes to the executor-set queue derived from the run", async () => {
    const q = await setup();
    const runId = Bun.randomUUIDv7();
    resolvers.set(runId, [EXEC_B, EXEC_A, EXEC_B]); // unsorted + dup on purpose
    await q.enqueueRun(runId);
    const row = await jobRow(runId);
    expect(row?.name).toBe(runExecuteQueueName([EXEC_A, EXEC_B]));
  });

  it("an unresolvable run fails the enqueue loudly (no legacy fallback queue)", async () => {
    const q = await setup();
    const runId = Bun.randomUUIDv7(); // no resolver entry → []
    // post-M2-flush nothing consumes `run.execute` — parking the job there
    // would strand it silently, so the enqueue must throw instead
    await expect(q.enqueueRun(runId)).rejects.toThrow(/cannot derive an executor set/);
    expect(await jobRow(runId)).toBeUndefined();
  });

  it("a worker consumes only queues within its own executor set", async () => {
    const q = await setup();
    const seenByA: string[] = [];
    const seenByB: string[] = [];

    // worker A owns {EXEC_A}; worker B owns {EXEC_A, EXEC_B}
    for (const name of runExecuteSubsetQueues([EXEC_A, EXEC_B])) await q.boss.createQueue(name);
    loops.push(
      startRunFetchLoop({
        boss: q.boss,
        queues: runExecuteSubsetQueues([EXEC_A]),
        slots: 2,
        handler: async (job) => void seenByA.push(job.data.runId),
        logger: noopLogger,
        tickMs: 100,
      }),
      startRunFetchLoop({
        boss: q.boss,
        queues: runExecuteSubsetQueues([EXEC_A, EXEC_B]),
        slots: 2,
        handler: async (job) => void seenByB.push(job.data.runId),
        logger: noopLogger,
        tickMs: 100,
      }),
    );

    const needsBoth = Bun.randomUUIDv7();
    resolvers.set(needsBoth, [EXEC_A, EXEC_B]);
    await q.enqueueRun(needsBoth);
    await waitFor(() => seenByB.includes(needsBoth));
    expect(seenByA).not.toContain(needsBoth);
    await waitFor(async () => (await jobRow(needsBoth))?.state === "completed");

    // a single-executor run is eligible for either worker — assert it is
    // consumed exactly once by SOMEONE (set queues don't double-deliver)
    const needsA = Bun.randomUUIDv7();
    resolvers.set(needsA, [EXEC_A]);
    await q.enqueueRun(needsA);
    await waitFor(() => seenByA.includes(needsA) || seenByB.includes(needsA));
    await waitFor(async () => (await jobRow(needsA))?.state === "completed");
    const deliveries =
      seenByA.filter((id) => id === needsA).length + seenByB.filter((id) => id === needsA).length;
    expect(deliveries).toBe(1);
  });

  it("updateQueues extends a live loop to a daemon-covered set queue", async () => {
    const q = await setup();
    // fresh executor ids so the loops from earlier tests cannot consume these
    const execD = `exec-d-${suite}`;
    const execE = `exec-e-${suite}`;
    const seen: string[] = [];
    for (const name of [...runExecuteSubsetQueues([execD]), ...runExecuteSubsetQueues([execE])]) {
      await q.boss.createQueue(name);
    }
    const loop = startRunFetchLoop({
      boss: q.boss,
      queues: runExecuteSubsetQueues([execD]),
      slots: 1,
      handler: async (job) => void seen.push(job.data.runId),
      logger: noopLogger,
      tickMs: 100,
    });
    loops.push(loop);

    // a daemon-only run parks: nobody polls its set queue yet
    const runId = Bun.randomUUIDv7();
    resolvers.set(runId, [execE]);
    await q.enqueueRun(runId);
    await Bun.sleep(400);
    expect(seen).not.toContain(runId);

    // the sweeper notices the live runtime and widens coverage
    loop.updateQueues([...runExecuteSubsetQueues([execD]), ...runExecuteSubsetQueues([execE])]);
    await waitFor(() => seen.includes(runId));
    await waitFor(async () => (await jobRow(runId))?.state === "completed");
  });

  it("a throwing handler fails the job into pg-boss retry accounting", async () => {
    const q = await setup();
    const failing = Bun.randomUUIDv7();
    resolvers.set(failing, [EXEC_C]);

    let attempts = 0;
    loops.push(
      startRunFetchLoop({
        boss: q.boss,
        queues: runExecuteSubsetQueues([EXEC_C]),
        slots: 1,
        handler: async () => {
          attempts++;
          throw new Error("boom");
        },
        logger: noopLogger,
        tickMs: 100,
      }),
    );

    await q.enqueueRun(failing);
    await waitFor(() => attempts >= 1);
    // enqueueRun sends with retryLimit 2 — the first failure must park the
    // job in retry state (backoff), not complete it and not discard it
    await waitFor(async () => (await jobRow(failing))?.state === "retry");
  });
});
