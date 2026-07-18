import { AppError, templateCreateSchema, templateVersionCreateSchema } from "@agrippa/core";
import { orchestrationTemplates, scenarios, templateVersions } from "@agrippa/db";
import { compileTemplate, TemplateValidationError } from "@agrippa/orchestration";
import { and, asc, desc, eq, max } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { audit } from "../lib/audit";
import { validate } from "../lib/validate";
import { requireOrgAdmin } from "../middleware/rbac";

export const templateRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const rows = await c.var.db
      .select({
        id: orchestrationTemplates.id,
        slug: orchestrationTemplates.slug,
        nameI18n: orchestrationTemplates.nameI18n,
        scenarioSlug: scenarios.slug,
        latestPublishedVersionId: orchestrationTemplates.latestPublishedVersionId,
      })
      .from(orchestrationTemplates)
      .innerJoin(scenarios, eq(orchestrationTemplates.scenarioId, scenarios.id))
      .orderBy(asc(orchestrationTemplates.slug));
    return c.json(rows);
  })
  .post("/", requireOrgAdmin, validate("json", templateCreateSchema), async (c) => {
    const input = c.req.valid("json");
    const db = c.var.db;
    const [existing] = await db
      .select()
      .from(orchestrationTemplates)
      .where(eq(orchestrationTemplates.slug, input.slug));
    if (existing) throw AppError.conflict("slug_taken", "Template slug already exists");
    const [scenario] = await db
      .select()
      .from(scenarios)
      .where(eq(scenarios.slug, input.scenarioSlug));
    if (!scenario) throw AppError.notFound("Scenario");
    const [created] = await db
      .insert(orchestrationTemplates)
      .values({
        slug: input.slug,
        scenarioId: scenario.id,
        nameI18n: input.nameI18n,
        orgId: c.var.user.orgId,
        createdBy: c.var.user.id,
      })
      .returning();
    await audit(c, {
      action: "template.create",
      resourceType: "template",
      resourceId: created?.id,
    });
    return c.json(created, 201);
  })
  .get("/:id", async (c) => {
    const db = c.var.db;
    const [head] = await db
      .select()
      .from(orchestrationTemplates)
      .where(eq(orchestrationTemplates.id, c.req.param("id")));
    if (!head) throw AppError.notFound("Template");
    const versions = await db
      .select({
        id: templateVersions.id,
        version: templateVersions.version,
        status: templateVersions.status,
        checksum: templateVersions.checksum,
        createdAt: templateVersions.createdAt,
        publishedAt: templateVersions.publishedAt,
      })
      .from(templateVersions)
      .where(eq(templateVersions.templateId, head.id))
      .orderBy(desc(templateVersions.version));
    return c.json({ ...head, versions });
  })
  .get("/:id/versions/:version", async (c) => {
    const [row] = await c.var.db
      .select()
      .from(templateVersions)
      .where(
        and(
          eq(templateVersions.templateId, c.req.param("id")),
          eq(templateVersions.version, Number(c.req.param("version"))),
        ),
      );
    if (!row) throw AppError.notFound("Template version");
    return c.json(row);
  })
  .post(
    "/:id/versions",
    requireOrgAdmin,
    validate("json", templateVersionCreateSchema),
    async (c) => {
      const db = c.var.db;
      const [head] = await db
        .select({
          id: orchestrationTemplates.id,
          slug: orchestrationTemplates.slug,
          scenarioSlug: scenarios.slug,
        })
        .from(orchestrationTemplates)
        .innerJoin(scenarios, eq(orchestrationTemplates.scenarioId, scenarios.id))
        .where(eq(orchestrationTemplates.id, c.req.param("id")));
      if (!head) throw AppError.notFound("Template");

      const { sourceYaml } = c.req.valid("json");
      let compiled: ReturnType<typeof compileTemplate>;
      try {
        compiled = compileTemplate(sourceYaml);
      } catch (err) {
        if (err instanceof TemplateValidationError) {
          throw new AppError("template_invalid", 400, "Template validation failed", err.issues);
        }
        throw err;
      }
      if (compiled.compiled.metadata.slug !== head.slug) {
        throw new AppError(
          "slug_mismatch",
          400,
          `YAML metadata.slug '${compiled.compiled.metadata.slug}' must match template slug '${head.slug}'`,
        );
      }
      if (compiled.compiled.metadata.scenario !== head.scenarioSlug) {
        throw new AppError(
          "scenario_mismatch",
          400,
          `YAML metadata.scenario must match template scenario '${head.scenarioSlug}'`,
        );
      }

      const [maxRow] = await db
        .select({ v: max(templateVersions.version) })
        .from(templateVersions)
        .where(eq(templateVersions.templateId, head.id));
      const [created] = await db
        .insert(templateVersions)
        .values({
          templateId: head.id,
          version: (maxRow?.v ?? 0) + 1,
          status: "draft",
          sourceYaml,
          compiled: compiled.compiled as unknown as Record<string, unknown>,
          checksum: compiled.checksum,
          createdBy: c.var.user.id,
        })
        .returning();
      await audit(c, {
        action: "template.version.create",
        resourceType: "template_version",
        resourceId: created?.id,
      });
      return c.json(created, 201);
    },
  )
  .post("/:id/versions/:version/publish", requireOrgAdmin, async (c) => {
    const db = c.var.db;
    const [row] = await db
      .select()
      .from(templateVersions)
      .where(
        and(
          eq(templateVersions.templateId, c.req.param("id")),
          eq(templateVersions.version, Number(c.req.param("version"))),
        ),
      );
    if (!row) throw AppError.notFound("Template version");
    if (row.status !== "draft") {
      throw AppError.conflict(
        "not_draft",
        `Version is ${row.status}; only drafts can be published`,
      );
    }
    const [published] = await db
      .update(templateVersions)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(templateVersions.id, row.id))
      .returning();
    await db
      .update(orchestrationTemplates)
      .set({ latestPublishedVersionId: row.id })
      .where(eq(orchestrationTemplates.id, row.templateId));
    await audit(c, {
      action: "template.version.publish",
      resourceType: "template_version",
      resourceId: row.id,
    });
    return c.json(published);
  })
  .post("/:id/versions/:version/deprecate", requireOrgAdmin, async (c) => {
    const db = c.var.db;
    const [row] = await db
      .select()
      .from(templateVersions)
      .where(
        and(
          eq(templateVersions.templateId, c.req.param("id")),
          eq(templateVersions.version, Number(c.req.param("version"))),
        ),
      );
    if (!row) throw AppError.notFound("Template version");
    if (row.status !== "published") {
      throw AppError.conflict(
        "not_published",
        `Version is ${row.status}; only published versions can be deprecated`,
      );
    }
    // never break submissions: the version new runs pin must stay published
    const [head] = await db
      .select({ latestPublishedVersionId: orchestrationTemplates.latestPublishedVersionId })
      .from(orchestrationTemplates)
      .where(eq(orchestrationTemplates.id, row.templateId));
    if (head?.latestPublishedVersionId === row.id) {
      throw AppError.conflict(
        "version_is_latest",
        "The latest published version cannot be deprecated; publish a newer version first",
      );
    }
    // conditional on status so a concurrent transition can't be clobbered
    const [deprecated] = await db
      .update(templateVersions)
      .set({ status: "deprecated" })
      .where(and(eq(templateVersions.id, row.id), eq(templateVersions.status, "published")))
      .returning();
    if (!deprecated) {
      throw AppError.conflict("not_published", "Version changed state concurrently");
    }
    await audit(c, {
      action: "template.version.deprecate",
      resourceType: "template_version",
      resourceId: row.id,
    });
    return c.json(deprecated);
  });

/** Dry-run compile — used by the template editor's validate button. */
export const templateValidateRoute = new Hono<AppEnv>().post(
  "/validate",
  validate("json", templateVersionCreateSchema),
  async (c) => {
    try {
      const { compiled, checksum } = compileTemplate(c.req.valid("json").sourceYaml);
      return c.json({ valid: true, checksum, compiled });
    } catch (err) {
      if (err instanceof TemplateValidationError) {
        return c.json({ valid: false, issues: err.issues });
      }
      throw err;
    }
  },
);
