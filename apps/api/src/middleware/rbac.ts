import { AppError, type ProjectRole, projectRoleAtLeast } from "@agrippa/core";
import { projectMembers, projects } from "@agrippa/db";
import { and, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../context";

/** Org-level gate: resource-layer writes and org settings. */
export const requireOrgAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.user.orgRole !== "org_admin") throw AppError.forbidden("Requires org admin");
  await next();
});

/**
 * Project-level gate. Resolves :projectId, verifies the project exists and
 * the caller is a member with at least `min` role, and exposes the role as
 * c.var.projectRole. Org admins get no implicit project access — membership
 * is explicit (docs/design/05-api-and-auth.md).
 */
export function requireProjectRole(min: ProjectRole) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new AppError("internal", 500, "route missing :projectId");

    const db = c.var.db;
    const [project] = await db
      .select({ id: projects.id, status: projects.status })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw AppError.notFound("Project");

    const [membership] = await db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(
        and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, c.var.user.id)),
      );
    if (!membership) throw AppError.forbidden("Not a member of this project");
    if (!projectRoleAtLeast(membership.role, min)) {
      throw AppError.forbidden(`Requires project ${min} role`);
    }

    c.set("projectRole", membership.role);
    await next();
  });
}
