/** CI gate: every builtin template must compile. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { compileTemplate, TemplateValidationError } from "@agrippa/orchestration";

const templatesDir = path.resolve(import.meta.dirname, "../templates");
const resolveFile = (p: string): string | undefined => {
  const full = path.join(templatesDir, p);
  return existsSync(full) ? readFileSync(full, "utf8") : undefined;
};

let failed = false;
for (const entry of readdirSync(templatesDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
  for (const file of readdirSync(path.join(templatesDir, entry.name))) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    const full = path.join(templatesDir, entry.name, file);
    try {
      const { compiled } = compileTemplate(readFileSync(full, "utf8"), { resolveFile });
      console.log(`✓ ${compiled.metadata.slug} (${entry.name}/${file})`);
    } catch (err) {
      failed = true;
      if (err instanceof TemplateValidationError) {
        console.error(`✗ ${entry.name}/${file}:`);
        for (const issue of err.issues) console.error(`    ${issue}`);
      } else {
        console.error(`✗ ${entry.name}/${file}: ${(err as Error).message}`);
      }
    }
  }
}
if (failed) process.exit(1);
console.log("all builtin templates valid");
