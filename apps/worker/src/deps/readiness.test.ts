import { beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";
import { awaitSchema, createDb, expectedSchema, migrateDb, workerHeartbeats } from "@agrippa/db";
import { eq, sql } from "drizzle-orm";
import {
  markBootStarted,
  markConsumersReady,
  touchWorkerHeartbeat,
  WORKER_SCHEMA_WAIT_MS,
} from "./readiness";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/agrippa_test";

// one pool for the whole suite — a pool per fixture exhausts max_connections
const db = createDb(TEST_DATABASE_URL);
let dbUp = true;
try {
  await db.execute(sql`select 1`);
} catch {
  dbUp = false;
  console.warn("[test] postgres unreachable — skipping worker readiness suite");
}

const rowFor = async (containerId: string) => {
  const [row] = await db
    .select()
    .from(workerHeartbeats)
    .where(eq(workerHeartbeats.containerId, containerId));
  return row;
};

describe.skipIf(!dbUp)("worker readiness heartbeats", () => {
  beforeAll(async () => {
    // drop the drizzle schema too — the migrator journals there, and dropping
    // only public makes the migrations silently no-op on the next run
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`create schema public`);
    await db.execute(sql`drop schema if exists drizzle cascade`);
    await migrateDb(db);
  });

  it("writes a consumers-ready row for this container", async () => {
    await markConsumersReady(db, "ctr-ready");
    const row = await rowFor("ctr-ready");
    expect(row?.consumersReadyAt).not.toBeNull();
    expect(row?.heartbeatAt).not.toBeNull();
  });

  it("re-freshens readiness on restart of the same container", async () => {
    await markConsumersReady(db, "ctr-restart");
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    await db
      .update(workerHeartbeats)
      .set({ consumersReadyAt: stale, heartbeatAt: stale })
      .where(eq(workerHeartbeats.containerId, "ctr-restart"));

    // same container id boots again (restart: unless-stopped) — the deploy
    // freshness window must see the NEW boot, not the old one
    await markConsumersReady(db, "ctr-restart");
    const row = await rowFor("ctr-restart");
    expect(row?.consumersReadyAt?.getTime()).toBeGreaterThan(stale.getTime());
    expect(row?.heartbeatAt?.getTime()).toBeGreaterThan(stale.getTime());
  });

  it("touch bumps liveness without ever granting readiness", async () => {
    // a fresh row via touch alone (e.g. after an out-of-band delete) must not
    // count as ready — readiness is written only after boss.work() returns
    await touchWorkerHeartbeat(db, "ctr-touch-only");
    expect((await rowFor("ctr-touch-only"))?.consumersReadyAt).toBeNull();

    // and on a ready row, touch must preserve the boot-time readiness stamp
    await markConsumersReady(db, "ctr-touch-ready");
    const before = (await rowFor("ctr-touch-ready"))?.consumersReadyAt;
    await touchWorkerHeartbeat(db, "ctr-touch-ready");
    expect((await rowFor("ctr-touch-ready"))?.consumersReadyAt?.getTime()).toBe(before?.getTime());
  });

  it("boot start surrenders the previous boot's readiness", async () => {
    // restart-then-wedge: without the boot-start clear, this boot would coast
    // on the stamp its previous life earned
    await markConsumersReady(db, "ctr-reboot");
    expect((await rowFor("ctr-reboot"))?.consumersReadyAt).not.toBeNull();

    await markBootStarted(db, "ctr-reboot");
    const row = await rowFor("ctr-reboot");
    expect(row?.consumersReadyAt).toBeNull();
    expect(row?.heartbeatAt).not.toBeNull();
  });

  it("deploy verification counts exactly the ready-AND-alive containers of THIS fleet", async () => {
    // the literal worker_ok() predicate from infra/deploy.sh — fleet-scoped id
    // list, readiness non-null, heartbeat inside both freshness windows —
    // against every row state a deploy can encounter
    const fresh = new Date();
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    await db.delete(workerHeartbeats);
    await db.insert(workerHeartbeats).values([
      // reused healthy container: old ready stamp, sweeper keeps it alive → counts
      { containerId: "p-reused", startedAt: stale, consumersReadyAt: stale, heartbeatAt: fresh },
      // fresh boot that completed consumer setup → counts
      { containerId: "p-fresh", startedAt: fresh, consumersReadyAt: fresh, heartbeatAt: fresh },
      // rebooted and wedged in consumer setup: boot-start cleared readiness → excluded
      { containerId: "p-wedged", startedAt: fresh, consumersReadyAt: null, heartbeatAt: fresh },
      // dead container from a previous deploy: ready but heartbeat stale → excluded
      { containerId: "p-dead", startedAt: stale, consumersReadyAt: stale, heartbeatAt: stale },
      // ready and beating, but NOT one of this fleet's containers (debug
      // docker run, out-of-band scale leftover, second stack) → excluded
      { containerId: "p-orphan", startedAt: fresh, consumersReadyAt: fresh, heartbeatAt: fresh },
    ]);

    const since = new Date(Date.now() - 60 * 1000);
    const [row] = (await db.execute(
      sql`select count(distinct container_id)::int as n from worker_heartbeats
          where container_id in ('p-reused', 'p-fresh', 'p-wedged', 'p-dead')
            and consumers_ready_at is not null
            and heartbeat_at > greatest(${since}::timestamptz, now() - interval '90 seconds')`,
    )) as Array<{ n: number }>;
    expect(row?.n).toBe(2);
  });

  it("waits for the schema this build expects, and proceeds once it is applied", async () => {
    // an un-migrated database is exactly the boot the wait exists for: the api
    // has not finished migrating, so the worker must not start writing
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`create schema public`);
    await db.execute(sql`drop schema if exists drizzle cascade`);
    const logs: string[] = [];
    expect(
      await awaitSchema(db, {
        timeoutMs: 300,
        pollMs: 50,
        logEveryMs: 0,
        log: (m) => logs.push(m),
      }),
    ).toBe(false);
    // the diagnosis line names the migration the image expects
    const expected = await expectedSchema();
    expect(logs.join("\n")).toContain(expected?.tag as string);

    await migrateDb(db);
    expect(await awaitSchema(db, { timeoutMs: 300, pollMs: 50 })).toBe(true);
  });

  it("waits longer than deploy verification does", async () => {
    // If the schema never arrives the worker must still be WAITING (running,
    // restart-steady) for all of deploy.sh's HEALTH_TIMEOUT, so the deploy
    // fails as "worker never became ready" rather than as a restart-count
    // mismatch that reads like a crash loop. Cross-file so raising
    // HEALTH_TIMEOUT later cannot silently re-arm the bad signal.
    const deploySh = await Bun.file(
      path.resolve(import.meta.dirname, "../../../../infra/deploy.sh"),
    ).text();
    const healthTimeout = deploySh.match(/HEALTH_TIMEOUT="\$\{HEALTH_TIMEOUT:-(\d+)\}"/)?.[1];
    expect(healthTimeout).toBeDefined();
    expect(WORKER_SCHEMA_WAIT_MS).toBeGreaterThan(Number(healthTimeout) * 1000);
  });

  it("prunes containers silent for over a week", async () => {
    const ancient = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await db.insert(workerHeartbeats).values({
      containerId: "ctr-gone",
      startedAt: ancient,
      consumersReadyAt: ancient,
      heartbeatAt: ancient,
    });

    await markConsumersReady(db, "ctr-alive");
    expect(await rowFor("ctr-gone")).toBeUndefined();
    expect(await rowFor("ctr-alive")).toBeDefined();
  });
});
