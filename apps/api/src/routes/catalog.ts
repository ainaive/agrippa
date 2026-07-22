import { AppError } from "@agrippa/core";
import { fabri, orchestrationTemplates, scenarios, taskTypes, templateVersions } from "@agrippa/db";
import { upgradeCompiledTemplate } from "@agrippa/orchestration";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../context";

export const catalogRoutes = new Hono<AppEnv>()
  .get("/scenarios", async (c) => {
    const rows = await c.var.db
      .select()
      .from(scenarios)
      .where(eq(scenarios.enabled, true))
      .orderBy(asc(scenarios.sortOrder));
    return c.json(rows);
  })
  .get("/scenarios/:slug/task-types", async (c) => {
    const [scenario] = await c.var.db
      .select()
      .from(scenarios)
      .where(eq(scenarios.slug, c.req.param("slug")));
    if (!scenario) throw AppError.notFound("Scenario");
    const rows = await c.var.db
      .select({
        id: taskTypes.id,
        slug: taskTypes.slug,
        nameI18n: taskTypes.nameI18n,
        descriptionI18n: taskTypes.descriptionI18n,
        enabled: taskTypes.enabled,
        sortOrder: taskTypes.sortOrder,
        templateSlug: orchestrationTemplates.slug,
        faberSlug: fabri.slug,
        faberNameI18n: fabri.nameI18n,
        faberAvatar: fabri.avatar,
      })
      .from(taskTypes)
      .innerJoin(orchestrationTemplates, eq(taskTypes.templateId, orchestrationTemplates.id))
      .innerJoin(fabri, eq(taskTypes.defaultFaberId, fabri.id))
      .where(eq(taskTypes.scenarioId, scenario.id))
      .orderBy(asc(taskTypes.sortOrder));
    return c.json(rows.filter((r) => r.enabled));
  })
  .get("/task-types/:id", async (c) => {
    const db = c.var.db;
    const [taskType] = await db
      .select()
      .from(taskTypes)
      .where(eq(taskTypes.id, c.req.param("id")));
    if (!taskType?.enabled) throw AppError.notFound("Task type");

    const [template] = await db
      .select()
      .from(orchestrationTemplates)
      .where(eq(orchestrationTemplates.id, taskType.templateId));
    const [faber] = await db.select().from(fabri).where(eq(fabri.id, taskType.defaultFaberId));

    let version: { id: string; version: number; compiled: unknown } | null = null;
    let inputs: unknown[] = [];
    let budgets: unknown = null;
    if (template?.latestPublishedVersionId) {
      const [row] = await db
        .select()
        .from(templateVersions)
        .where(eq(templateVersions.id, template.latestPublishedVersionId));
      if (row) {
        const compiled = upgradeCompiledTemplate(row.compiled);
        version = { id: row.id, version: row.version, compiled: row.compiled };
        inputs = compiled.spec.inputs;
        budgets = compiled.spec.budgets;
      }
    }

    return c.json({
      id: taskType.id,
      slug: taskType.slug,
      nameI18n: taskType.nameI18n,
      descriptionI18n: taskType.descriptionI18n,
      template: template ? { id: template.id, slug: template.slug } : null,
      templateVersion: version ? { id: version.id, version: version.version } : null,
      faber: faber
        ? { id: faber.id, slug: faber.slug, nameI18n: faber.nameI18n, avatar: faber.avatar }
        : null,
      inputs,
      budgets,
    });
  });
