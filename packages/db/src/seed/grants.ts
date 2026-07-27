import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { DbOrTx } from "../client";
import { fabri, models, projectMembers, projectResourceGrants, projects, skills } from "../schema";

export type BuiltinGrantCounts = {
  models: number;
  skills: number;
  fabri: number;
  /** rows actually inserted this call (onConflictDoNothing skips pre-existing). */
  inserted: number;
};

/** Ids of built-in (orgId IS NULL) resources a new project defaults to. */
async function builtinResourceIds(
  db: DbOrTx,
): Promise<{ models: string[]; skills: string[]; fabri: string[] }> {
  const modelRows = await db
    .select({ id: models.id })
    .from(models)
    .where(and(isNull(models.orgId), eq(models.status, "active")));
  // a skill is only usable once it has a published version
  const skillRows = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(isNull(skills.orgId), isNotNull(skills.latestVersionId)));
  const faberRows = await db
    .select({ id: fabri.id })
    .from(fabri)
    .where(and(isNull(fabri.orgId), eq(fabri.status, "active")));
  return {
    models: modelRows.map((r) => r.id),
    skills: skillRows.map((r) => r.id),
    fabri: faberRows.map((r) => r.id),
  };
}

/**
 * Grant a project every built-in resource (active models, published skills,
 * active fabri). Idempotent via the project_grants_uq unique index
 * (onConflictDoNothing), so re-running on an existing project only fills gaps.
 * Returns counts per source plus how many rows were newly inserted.
 *
 * Run inside the project-create transaction so a project never exists in a
 * "zero grants" state, and from the seed backfill for parity on existing
 * default-org projects.
 */
export async function grantBuiltinResources(
  db: DbOrTx,
  projectId: string,
  grantedBy: string,
): Promise<BuiltinGrantCounts> {
  const { models: modelIds, skills: skillIds, fabri: faberIds } = await builtinResourceIds(db);
  const rows: Array<{ resourceType: "model" | "skill" | "faber"; resourceId: string }> = [
    ...modelIds.map((resourceId) => ({ resourceType: "model" as const, resourceId })),
    ...skillIds.map((resourceId) => ({ resourceType: "skill" as const, resourceId })),
    ...faberIds.map((resourceId) => ({ resourceType: "faber" as const, resourceId })),
  ];
  if (rows.length === 0) return { models: 0, skills: 0, fabri: 0, inserted: 0 };
  const inserted = await db
    .insert(projectResourceGrants)
    .values(
      rows.map((r) => ({
        projectId,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        grantedBy,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: projectResourceGrants.id });
  return {
    models: modelIds.length,
    skills: skillIds.length,
    fabri: faberIds.length,
    inserted: inserted.length,
  };
}

/**
 * Grant a project every active built-in model for a single provider — used
 * when a project adds a provider credential, coupling the credential to the
 * model grants it enables. Org-scoped (admin-registered) models of that
 * provider are excluded: their registration is an explicit opt-in. Idempotent.
 * Returns the number of rows newly inserted this call.
 */
export async function grantProviderBuiltinModels(
  db: DbOrTx,
  projectId: string,
  provider: string,
  grantedBy: string,
): Promise<number> {
  const rows = await db
    .select({ id: models.id })
    .from(models)
    .where(and(isNull(models.orgId), eq(models.provider, provider), eq(models.status, "active")));
  if (rows.length === 0) return 0;
  const inserted = await db
    .insert(projectResourceGrants)
    .values(
      rows.map((r) => ({
        projectId,
        resourceType: "model" as const,
        resourceId: r.id,
        grantedBy,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: projectResourceGrants.id });
  return inserted.length;
}

/**
 * Seed-time backfill: ensure every existing project in the default org has the
 * built-in grants a newly-created project would get. Idempotent — only fills
 * gaps. Brings pre-existing dev projects to parity with the new auto-grant
 * behavior on the next boot/seed.
 */
export async function seedDefaultGrants(db: DbOrTx, defaultOrgId: string): Promise<void> {
  const projectRows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.orgId, defaultOrgId));
  for (const p of projectRows) {
    const [admin] = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, p.id));
    // a project's earliest member (always an admin at create time) is the
    // natural grant actor for the backfill
    await grantBuiltinResources(db, p.id, admin?.userId ?? defaultOrgId);
  }
}
