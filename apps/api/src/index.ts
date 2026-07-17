import { createDb, migrateDb, seed } from "@agrippa/db";
import { createApp } from "./app";

const db = createDb();

if (process.env.AGRIPPA_MIGRATE_ON_BOOT !== "0") {
  await migrateDb(db);
  await seed(db);
  console.log("[api] migrations + seed applied");
}

const app = createApp({ db });
const port = Number(process.env.PORT ?? 3000);

console.log(`[api] listening on :${port}`);

export default {
  port,
  fetch: app.fetch,
};
