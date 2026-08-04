import { projectRoleAtLeast } from "@agrippa/core";
import { type Db, projectMembers, projects, taskTypes } from "@agrippa/db";
import { and, eq } from "drizzle-orm";

/**
 * The three ways unattended work becomes permanently impossible. Schedules and
 * webhook triggers both need exactly this check, at exactly the same moment —
 * the point of use — so it lives in one place rather than being written twice
 * and drifting apart.
 *
 * Every one of these is a condition a human has to resolve; none heals on its
 * own. That is what earns them a disable rather than a retry, and the callers
 * turn a non-null answer into a disabled row plus a notification.
 */
export type WorkAuthorityFailure = "project_archived" | "task_type_gone" | "owner_lost_access";

/**
 * Null when this owner may submit this task type in this project right now.
 *
 * Checked at the point of use rather than eagerly revoked when someone loses
 * access: eager revocation means hooking every path that can remove authority
 * — membership removal, role downgrade, project archive, org-role change — and
 * missing one leaves automation running with authority its owner no longer has.
 * The role gate is the same `member` one `POST /projects/:id/tasks` applies, so
 * automation can do exactly what its owner could do at that moment.
 */
export async function checkWorkAuthority(
  db: Db,
  input: { projectId: string; taskTypeId: string; ownerId: string },
): Promise<WorkAuthorityFailure | null> {
  const [project] = await db
    .select({ status: projects.status })
    .from(projects)
    .where(eq(projects.id, input.projectId));
  if (project?.status !== "active") return "project_archived";

  const [taskType] = await db
    .select({ enabled: taskTypes.enabled })
    .from(taskTypes)
    .where(eq(taskTypes.id, input.taskTypeId));
  if (!taskType?.enabled) return "task_type_gone";

  const [membership] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(eq(projectMembers.projectId, input.projectId), eq(projectMembers.userId, input.ownerId)),
    );
  if (!membership || !projectRoleAtLeast(membership.role, "member")) return "owner_lost_access";

  return null;
}
