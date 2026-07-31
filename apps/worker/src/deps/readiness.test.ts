import { beforeAll, describe, expect, it } from "bun:test";
import { createDb, migrateDb, workerHeartbeats } from "@agrippa/db";
import { eq, sql } from "drizzle-orm";
import { markConsumersReady, touchWorkerHeartbeat } from "./readiness";

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
    await db.execute(sql`drop schema public cascade`);
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
