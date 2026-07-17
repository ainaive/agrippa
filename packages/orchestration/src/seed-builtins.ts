import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type Db, orchestrationTemplates, scenarios, templateVersions } from "@agrippa/db";
import { and, desc, eq, max } from "drizzle-orm";
import { compileTemplate } from "./compile";

/**
 * Compiles every YAML under templatesDir (skipping _shared/) and publishes it
 * as an immutable template version. Checksum-guarded: re-seeding an unchanged
 * source is a no-op; a changed source publishes the next version. Runs at boot
 * (api entrypoint) and via `bun run templates:seed`.
 */
export async function seedBuiltinTemplates(
  db: Db,
  templatesDir: string,
): Promise<{ published: string[]; unchanged: string[] }> {
  const resolveFile = (p: string): string | undefined => {
    const full = path.join(templatesDir, p);
    return existsSync(full) ? readFileSync(full, "utf8") : undefined;
  };

  const files: string[] = [];
  for (const entry of readdirSync(templatesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const dir = path.join(templatesDir, entry.name);
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".yaml") || file.endsWith(".yml")) files.push(path.join(dir, file));
    }
  }

  const published: string[] = [];
  const unchanged: string[] = [];

  for (const file of files.sort()) {
    const source = readFileSync(file, "utf8");
    const { compiled, checksum } = compileTemplate(source, { resolveFile });
    const slug = compiled.metadata.slug;

    const [scenario] = await db
      .select()
      .from(scenarios)
      .where(eq(scenarios.slug, compiled.metadata.scenario));
    if (!scenario)
      throw new Error(`builtin template ${slug}: unknown scenario — run db seed first`);

    let [head] = await db
      .select()
      .from(orchestrationTemplates)
      .where(eq(orchestrationTemplates.slug, slug));
    if (!head) {
      [head] = await db
        .insert(orchestrationTemplates)
        .values({ slug, scenarioId: scenario.id, nameI18n: compiled.metadata.name })
        .returning();
    }
    if (!head) throw new Error(`builtin template ${slug}: head upsert failed`);

    const [latest] = await db
      .select()
      .from(templateVersions)
      .where(
        and(eq(templateVersions.templateId, head.id), eq(templateVersions.status, "published")),
      )
      .orderBy(desc(templateVersions.version))
      .limit(1);
    if (latest?.checksum === checksum) {
      unchanged.push(slug);
      continue;
    }

    const [maxRow] = await db
      .select({ v: max(templateVersions.version) })
      .from(templateVersions)
      .where(eq(templateVersions.templateId, head.id));
    const [version] = await db
      .insert(templateVersions)
      .values({
        templateId: head.id,
        version: (maxRow?.v ?? 0) + 1,
        status: "published",
        sourceYaml: source,
        compiled: compiled as unknown as Record<string, unknown>,
        checksum,
        publishedAt: new Date(),
      })
      .returning();
    await db
      .update(orchestrationTemplates)
      .set({ latestPublishedVersionId: version?.id, nameI18n: compiled.metadata.name })
      .where(eq(orchestrationTemplates.id, head.id));
    published.push(`${slug}@${version?.version}`);
  }

  return { published, unchanged };
}
