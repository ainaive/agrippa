import { type DbOrTx, mcpServers, projects, skills } from "@agrippa/db";
import { eq } from "drizzle-orm";
import { authorizeResources, resolveAgentBindings } from "./resolve";
import type { CompiledTemplate } from "./template-schema";
import { liveWorkerExecutors } from "./worker-executors";

export const DEFAULT_EXECUTOR = process.env.AGRIPPA_EXECUTOR ?? "claude-agent-sdk";

/**
 * Everything a new run derives from CURRENT project configuration: the
 * resource manifest, and per-slot agent bindings and model resolution. Shared
 * by submit and retry so the two paths cannot drift — a retry is a
 * re-submission of the pinned task (ADR-0014); only the template version and
 * params snapshot stay pinned. Run limits are NOT here: the engine reads them
 * from the pinned template_versions.compiled row, never from a copy.
 */
export async function resolveRunPlan(
  db: DbOrTx,
  projectId: string,
  taskType: { defaultFaberId: string },
  compiled: CompiledTemplate,
  overrides: Record<string, { executorId?: string; faberId?: string }>,
) {
  const skillRows = await db.select({ id: skills.id, slug: skills.slug }).from(skills);
  // a disabled server is not "registered" — pinning it would only defer the
  // failure to worker materialization (skill versions are checked downstream
  // in authorizeResources; the skills head table has no status column)
  const mcpRows = await db
    .select({ id: mcpServers.id, slug: mcpServers.slug })
    .from(mcpServers)
    .where(eq(mcpServers.status, "active"));
  // required grants enforced; optional resources pinned only when granted
  const resourceManifest = await authorizeResources(db, projectId, compiled, {
    skillIdBySlug: new Map(skillRows.map((s) => [s.slug, s.id])),
    mcpIdBySlug: new Map(mcpRows.map((m) => [m.slug, m.id])),
  });
  // every agent slot resolves to a concrete faber + executor (per-slot
  // provider-filtered models, checked against the executors the deployment's
  // workers actually registered) and freezes onto the run
  const [projectRow] = await db
    .select({ orgId: projects.orgId })
    .from(projects)
    .where(eq(projects.id, projectId));
  const live = await liveWorkerExecutors(db, { orgId: projectRow?.orgId });
  const agentResolution = await resolveAgentBindings(
    db,
    projectId,
    compiled,
    { faberId: taskType.defaultFaberId, executorId: DEFAULT_EXECUTOR },
    overrides,
    { registeredExecutors: live.union, workerExecutorSets: live.sets },
  );
  return { resourceManifest, agentResolution };
}
