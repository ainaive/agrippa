import path from "node:path";
import { createDb, migrateDb, seed } from "@agrippa/db";
import { createRunQueue, RedisEventBus, seedBuiltinTemplates } from "@agrippa/orchestration";
import { createApp } from "./app";

const db = createDb();

if (process.env.AGRIPPA_MIGRATE_ON_BOOT !== "0") {
  await migrateDb(db);
  await seed(db);
  const templatesDir =
    process.env.AGRIPPA_TEMPLATES_DIR ?? path.resolve(import.meta.dirname, "../../../templates");
  const { published } = await seedBuiltinTemplates(db, templatesDir);
  console.log(`[api] migrations + seed applied; templates published: ${published.length}`);
}

const queue = await createRunQueue(process.env.DATABASE_URL as string);
const bus = process.env.REDIS_URL ? new RedisEventBus(process.env.REDIS_URL) : null;
if (!bus) console.warn("[api] REDIS_URL not set — SSE falls back to DB polling");

const app = createApp({ db, queue, bus });
const port = Number(process.env.PORT ?? 3000);

console.log(`[api] listening on :${port}`);

export default {
  port,
  fetch: app.fetch,
};
