import { createDb } from "../client";
import { seed } from "../seed";

const db = createDb();
await seed(db);
console.log("[db] seed complete");
process.exit(0);
