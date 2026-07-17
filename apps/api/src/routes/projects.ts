import {
  AppError,
  memberAddSchema,
  memberUpdateSchema,
  projectCreateSchema,
  projectUpdateSchema,
  quotaUpdateSchema,
} from "@agrippa/core";
import { auditLogs, projectMembers, projectQuotas, projects, users } from "@agrippa/db";
import { and, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { audit } from "../lib/audit";
import { validate } from "../lib/validate";
import { requireProjectRole } from "../middleware/rbac";

async function assertNotLastAdmin(
  c: {
    var: { db: AppEnv["Variables"]["db"] };
  },
  projectId: string,
  userId: string,
): Promise<void> {
  const db = c.var.db;
  const [target] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  if (target?.role !== "admin") return;
  const [admins] = await db
    .select({ n: count() })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.role, "admin")));
  if ((admins?.n ?? 0) <= 1) {
    throw AppError.conflict("last_admin", "A project must keep at least one admin");
  }
}

export const projectRoutes = new Hono<AppEnv>()
  // ── Projects ────────────────────────────────────────────────────────────────
  .post("/", validate("json", projectCreateSchema), async (c) => {
    const input = c.req.valid("json");
    const user = c.var.user;
    const db = c.var.db;

    const [existing] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.orgId, user.orgId), eq(projects.slug, input.slug)));
    if (existing) throw AppError.conflict("slug_taken", "A project with this slug already exists");

    const project = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(projects)
        .values({
          orgId: user.orgId,
          slug: input.slug,
          name: input.name,
          description: input.description,
          createdBy: user.id,
        })
        .returning();
      if (!created) throw new Error("insert returned no row");
      await tx
        .insert(projectMembers)
        .values({ projectId: created.id, userId: user.id, role: "admin" });
      await tx.insert(auditLogs).values({
        orgId: user.orgId,
        projectId: created.id,
        actorUserId: user.id,
        action: "project.create",
        resourceType: "project",
        resourceId: created.id,
        payload: { slug: input.slug, name: input.name },
      });
      return created;
    });

    return c.json(project, 201);
  })
  .get("/", async (c) => {
    const rows = await c.var.db
      .select({
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        description: projects.description,
        status: projects.status,
        createdAt: projects.createdAt,
        role: projectMembers.role,
      })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(eq(projectMembers.userId, c.var.user.id));
    return c.json(rows);
  })
  .get("/:projectId", requireProjectRole("viewer"), async (c) => {
    const [project] = await c.var.db
      .select()
      .from(projects)
      .where(eq(projects.id, c.req.param("projectId")));
    return c.json({ ...project, role: c.var.projectRole });
  })
  .patch(
    "/:projectId",
    requireProjectRole("admin"),
    validate("json", projectUpdateSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const input = c.req.valid("json");
      const [updated] = await c.var.db
        .update(projects)
        .set(input)
        .where(eq(projects.id, projectId))
        .returning();
      await audit(c, {
        action: "project.update",
        resourceType: "project",
        resourceId: projectId,
        projectId,
        payload: input,
      });
      return c.json(updated);
    },
  )
  .delete("/:projectId", requireProjectRole("admin"), async (c) => {
    const projectId = c.req.param("projectId");
    await c.var.db
      .update(projects)
      .set({ status: "archived", archivedAt: new Date() })
      .where(eq(projects.id, projectId));
    await audit(c, {
      action: "project.archive",
      resourceType: "project",
      resourceId: projectId,
      projectId,
    });
    return c.json({ status: "archived" });
  })

  // ── Members ────────────────────────────────────────────────────────────────
  .get("/:projectId/members", requireProjectRole("viewer"), async (c) => {
    const rows = await c.var.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: projectMembers.role,
        createdAt: projectMembers.createdAt,
      })
      .from(projectMembers)
      .innerJoin(users, eq(projectMembers.userId, users.id))
      .where(eq(projectMembers.projectId, c.req.param("projectId")));
    return c.json(rows);
  })
  .post(
    "/:projectId/members",
    requireProjectRole("admin"),
    validate("json", memberAddSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const input = c.req.valid("json");
      const db = c.var.db;

      const [target] = await db.select().from(users).where(eq(users.email, input.email));
      if (!target) throw new AppError("user_not_found", 404, "No user with this email");

      const [existing] = await db
        .select({ id: projectMembers.id })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, target.id)));
      if (existing) throw AppError.conflict("already_member", "User is already a member");

      await db.insert(projectMembers).values({ projectId, userId: target.id, role: input.role });
      await audit(c, {
        action: "project.member.add",
        resourceType: "project_member",
        resourceId: target.id,
        projectId,
        payload: { email: input.email, role: input.role },
      });
      return c.json({ userId: target.id, role: input.role }, 201);
    },
  )
  .patch(
    "/:projectId/members/:userId",
    requireProjectRole("admin"),
    validate("json", memberUpdateSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const userId = c.req.param("userId");
      const input = c.req.valid("json");

      if (input.role !== "admin") await assertNotLastAdmin(c, projectId, userId);

      const [updated] = await c.var.db
        .update(projectMembers)
        .set({ role: input.role })
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
        .returning({ userId: projectMembers.userId, role: projectMembers.role });
      if (!updated) throw AppError.notFound("Membership");
      await audit(c, {
        action: "project.member.update",
        resourceType: "project_member",
        resourceId: userId,
        projectId,
        payload: { role: input.role },
      });
      return c.json(updated);
    },
  )
  .delete("/:projectId/members/:userId", requireProjectRole("admin"), async (c) => {
    const projectId = c.req.param("projectId");
    const userId = c.req.param("userId");

    await assertNotLastAdmin(c, projectId, userId);

    const deleted = await c.var.db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
      .returning({ id: projectMembers.id });
    if (deleted.length === 0) throw AppError.notFound("Membership");
    await audit(c, {
      action: "project.member.remove",
      resourceType: "project_member",
      resourceId: userId,
      projectId,
    });
    return c.json({ removed: true });
  })

  // ── Quota ──────────────────────────────────────────────────────────────────
  .get("/:projectId/quota", requireProjectRole("viewer"), async (c) => {
    const [quota] = await c.var.db
      .select()
      .from(projectQuotas)
      .where(eq(projectQuotas.projectId, c.req.param("projectId")));
    return c.json(quota ?? null);
  })
  .put(
    "/:projectId/quota",
    requireProjectRole("admin"),
    validate("json", quotaUpdateSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const input = c.req.valid("json");
      const values = {
        tokenLimit: input.tokenLimit ?? null,
        costLimitUsd: input.costLimitUsd != null ? String(input.costLimitUsd) : null,
        hardStop: input.hardStop ?? true,
      };
      const [quota] = await c.var.db
        .insert(projectQuotas)
        .values({ projectId, ...values })
        .onConflictDoUpdate({ target: projectQuotas.projectId, set: values })
        .returning();
      await audit(c, {
        action: "project.quota.update",
        resourceType: "project_quota",
        resourceId: projectId,
        projectId,
        payload: input,
      });
      return c.json(quota);
    },
  );
