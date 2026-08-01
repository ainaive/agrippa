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

describe.skipIf(!dbUp)("notification queue dedupe (stately policy)", () => {
  let queue: BossQueue | undefined;

  afterAll(async () => {
    await queue?.stop();
  });

  it("converges the queue to stately and keeps one queued-or-active job per delivery", async () => {
    queue = await createRunQueue(TEST_DATABASE_URL);

    const [queueRow] = (await db.execute(
      sql`select policy from pgboss.queue where name = ${QUEUE_NOTIFICATION_DELIVER}`,
    )) as unknown as Array<{ policy: string }>;
    expect(queueRow?.policy).toBe("stately");

    // the sweeper's repeated re-enqueue of a stuck pending row must collapse
    // into one job — on a standard queue singletonKey enforces nothing
    const deliveryId = Bun.randomUUIDv7();
    await queue.enqueueNotificationDelivery(deliveryId);
    await queue.enqueueNotificationDelivery(deliveryId);
    await queue.enqueueNotificationDelivery(deliveryId);

    const [jobs] = (await db.execute(
      sql`select count(*)::int as count from pgboss.job
          where name = ${QUEUE_NOTIFICATION_DELIVER}
            and singleton_key = ${deliveryId}
            and state <= 'active'`,
    )) as unknown as Array<{ count: number }>;
    expect(jobs?.count).toBe(1);
  });
});
