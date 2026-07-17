import { createDb } from "../client";
import { migrateDb } from "../migrate";

const db = createDb();
await migrateDb(db);
console.log("[db] migrations applied");
process.exit(0);
