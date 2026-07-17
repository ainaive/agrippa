import { meUpdateSchema } from "@agrippa/core";
import { projectMembers, projects, users } from "@agrippa/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { audit } from "../lib/audit";
import { validate } from "../lib/validate";

export const meRoutes = new Hono<AppEnv>()
  .get("/me", async (c) => {
    const user = c.var.user;
    const memberships = await c.var.db
      .select({
        projectId: projects.id,
        slug: projects.slug,
        name: projects.name,
        status: projects.status,
        role: projectMembers.role,
      })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(eq(projectMembers.userId, user.id));
    return c.json({
      id: user.id,
      email: user.email,
      name: user.name,
      locale: user.locale,
      orgRole: user.orgRole,
      projects: memberships,
    });
  })
  .patch("/me", validate("json", meUpdateSchema), async (c) => {
    const input = c.req.valid("json");
    const [updated] = await c.var.db
      .update(users)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(users.id, c.var.user.id))
      .returning({ id: users.id, name: users.name, locale: users.locale });
    await audit(c, {
      action: "me.update",
      resourceType: "user",
      resourceId: c.var.user.id,
      payload: input,
    });
    return c.json(updated);
  });
