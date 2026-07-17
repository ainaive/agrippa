import path from "node:path";
import { createDb } from "@agrippa/db";
import { seedBuiltinTemplates } from "@agrippa/orchestration";

const templatesDir =
  process.env.AGRIPPA_TEMPLATES_DIR ?? path.resolve(import.meta.dirname, "../templates");
const db = createDb();
const result = await seedBuiltinTemplates(db, templatesDir);
console.log(`[templates] published: ${result.published.join(", ") || "(none)"}`);
console.log(`[templates] unchanged: ${result.unchanged.join(", ") || "(none)"}`);
process.exit(0);
