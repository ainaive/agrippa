import { isTerminalRunStatus, type RunStatus } from "@agrippa/core";
import { createDb, runs, templateVersions } from "@agrippa/db";
import type { TemplateDoc } from "@agrippa/orchestration";
import { eq } from "drizzle-orm";

/**
 * Backfill runs.resource_manifest for runs that predate migration 0002.
 *
 * Migration 0002 defaults the manifest to `{}`; because the engine resolves
 * skills/MCP only from the manifest, a run that was queued or in flight before
 * the migration would silently lose its resources. This authorizes each such
 * (non-terminal) run's template-declared skills/MCP, matching the pre-manifest
 * behavior. Terminal runs never re-execute, so their empty manifest is harmless
 * and left alone. Idempotent: runs with a non-empty manifest are skipped.
 *
 * Run this once during any upgrade of an instance that has live runs:
 *   bun scripts/backfill-manifest.ts
 */
const db = createDb();

const rows = await db
  .select({
    id: runs.id,
    status: runs.status,
    resourceManifest: runs.resourceManifest,
    templateVersionId: runs.templateVersionId,
  })
  .from(runs);

let backfilled = 0;
for (const run of rows) {
  if (isTerminalRunStatus(run.status as RunStatus)) continue;
  if (run.resourceManifest.mcpServers.length > 0 || run.resourceManifest.skills.length > 0)
    continue;

  const [version] = await db
    .select({ compiled: templateVersions.compiled })
    .from(templateVersions)
    .where(eq(templateVersions.id, run.templateVersionId));
  if (!version) continue;
  const template = version.compiled as unknown as TemplateDoc;

  await db
    .update(runs)
    .set({
      resourceManifest: {
        mcpServers: template.spec.resources.mcpServers.map((m) => m.ref),
        skills: template.spec.resources.skills.map((s) => s.ref.split("@")[0] as string),
      },
    })
    .where(eq(runs.id, run.id));
  backfilled += 1;
}

console.log(`[backfill-manifest] updated ${backfilled} non-terminal run(s)`);
process.exit(0);
