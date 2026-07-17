import { isTerminalRunStatus, type RunStatus } from "@agrippa/core";
import { createDb, mcpServers, runs, skills, templateVersions } from "@agrippa/db";
import { authorizeResources, SubmitError, type TemplateDoc } from "@agrippa/orchestration";
import { eq } from "drizzle-orm";

/**
 * Backfill runs.resource_manifest for runs that predate migration 0002.
 *
 * Migration 0002 defaults the manifest to `{}`; because the engine resolves
 * skills/MCP only from the manifest, a run queued or in flight before the
 * migration would silently lose its resources. This recomputes each such
 * (non-terminal) run's manifest **from the project's grants** — exactly what
 * `authorizeResources` produces at submit — rather than granting every template
 * resource. That makes it correct for a legacy row and idempotent for a valid
 * new run that legitimately has an empty manifest (it recomputes empty).
 *
 * Run once during any upgrade of an instance that has live runs:
 *   bun scripts/backfill-manifest.ts
 */
const db = createDb();

const skillRows = await db.select({ id: skills.id, slug: skills.slug }).from(skills);
const mcpRows = await db.select({ id: mcpServers.id, slug: mcpServers.slug }).from(mcpServers);
const registry = {
  skillIdBySlug: new Map(skillRows.map((s) => [s.slug, s.id])),
  mcpIdBySlug: new Map(mcpRows.map((m) => [m.slug, m.id])),
};

const rows = await db
  .select({
    id: runs.id,
    status: runs.status,
    projectId: runs.projectId,
    resourceManifest: runs.resourceManifest,
    templateVersionId: runs.templateVersionId,
  })
  .from(runs);

let backfilled = 0;
let skipped = 0;
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

  try {
    const manifest = await authorizeResources(db, run.projectId, template, registry);
    await db.update(runs).set({ resourceManifest: manifest }).where(eq(runs.id, run.id));
    backfilled += 1;
  } catch (err) {
    // a required grant was revoked since submit — leave the run's manifest empty
    // and report it rather than fabricating an authorization it no longer has
    if (err instanceof SubmitError) {
      console.warn(`[backfill-manifest] run ${run.id}: ${err.code} — left empty`);
      skipped += 1;
    } else {
      throw err;
    }
  }
}

console.log(`[backfill-manifest] updated ${backfilled} run(s), skipped ${skipped}`);
process.exit(0);
