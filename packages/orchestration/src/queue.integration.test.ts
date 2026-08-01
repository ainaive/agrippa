import { afterAll, describe, expect, it } from "bun:test";
import { QUEUE_NOTIFICATION_DELIVER } from "@agrippa/core";
import { createDb } from "@agrippa/db";
import { sql } from "drizzle-orm";
import { type BossQueue, createRunQueue } from "./queue";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/agrippa_test";

// one pool for the whole suite — a pool per fixture exhausts max_connections
const db = createDb(TEST_DATABASE_URL);
let dbUp = true;
try {
  await db.execute(sql`select 1`);
} catch {
  dbUp = false;
  console.warn("[test] postgres unreachable — skipping queue dedupe suite");
}

describe.skipIf(!dbUp)("notification queue dedupe (exclusive policy)", () => {
  let queue: BossQueue | undefined;

  afterAll(async () => {
    await queue?.stop();
  });

  const liveJobCount = async (deliveryId: string): Promise<number> => {
    const [row] = (await db.execute(
      sql`select count(*)::int as count from pgboss.job
          where name = ${QUEUE_NOTIFICATION_DELIVER}
            and singleton_key = ${deliveryId}
            and state <= 'active'`,
    )) as unknown as Array<{ count: number }>;
    return row?.count ?? -1;
  };

  it("converges the queue to exclusive and keeps one live job per delivery", async () => {
    queue = await createRunQueue(TEST_DATABASE_URL);

    const [queueRow] = (await db.execute(
      sql`select policy from pgboss.queue where name = ${QUEUE_NOTIFICATION_DELIVER}`,
    )) as unknown as Array<{ policy: string }>;
    expect(queueRow?.policy).toBe("exclusive");

    // the sweeper's repeated re-enqueue of a stuck pending row must collapse
    // into one job — on a standard queue singletonKey enforces nothing
    const deliveryId = Bun.randomUUIDv7();
    await queue.enqueueNotificationDelivery(deliveryId);
    await queue.enqueueNotificationDelivery(deliveryId);
    await queue.enqueueNotificationDelivery(deliveryId);
    expect(await liveJobCount(deliveryId)).toBe(1);
  });

  it("dedupes against jobs waiting in retry or running active — not just created", async () => {
    if (!queue) throw new Error("queue not initialized");
    // 'stately' passed the created-only test above but keys its unique index
    // BY STATE, so a retry-state job plus a fresh created job could coexist
    // and the sweeper would bypass the retry backoff. 'exclusive' must not.
    const deliveryId = Bun.randomUUIDv7();
    await queue.enqueueNotificationDelivery(deliveryId);

    for (const state of ["retry", "active"] as const) {
      await db.execute(
        sql`update pgboss.job set state = ${state}::pgboss.job_state
            where name = ${QUEUE_NOTIFICATION_DELIVER} and singleton_key = ${deliveryId}`,
      );
      await queue.enqueueNotificationDelivery(deliveryId);
      expect(await liveJobCount(deliveryId)).toBe(1);
    }
  });
});
