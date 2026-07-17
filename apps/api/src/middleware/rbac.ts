import { AppError, type ProjectRole, projectRoleAtLeast } from "@agrippa/core";
import { type Db, projectMembers, projects } from "@agrippa/db";
import { and, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../context";

/** Org-level gate: resource-layer writes and org settings. */
export const requireOrgAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.user.orgRole !== "org_admin") throw AppError.forbidden("Requires org admin");
  await next();
});

/**
 * Membership check shared by the middleware and by handlers whose project id
 * comes from a loaded resource (tasks, runs, artifacts). Org admins get no
 * implicit project access — membership is explicit (docs/design/05).
 */
export async function assertProjectRole(
  db: Db,
  userId: string,
  projectId: string,
  min: ProjectRole,
): Promise<ProjectRole> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) throw AppError.notFound("Project");

  const [membership] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  if (!membership) throw AppError.forbidden("Not a member of this project");
  if (!projectRoleAtLeast(membership.role, min)) {
    throw AppError.forbidden(`Requires project ${min} role`);
  }
  return membership.role;
}

/** Project-level gate resolving :projectId from the route. */
export function requireProjectRole(min: ProjectRole) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new AppError("internal", 500, "route missing :projectId");
    const role = await assertProjectRole(c.var.db, c.var.user.id, projectId, min);
    c.set("projectRole", role);
    await next();
  });
}
