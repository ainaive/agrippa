import { type LocalizedText, MODEL_TIERS } from "@agrippa/core";
import {
  type AnyPgColumn,
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAtCol, idCol, tstz } from "./_helpers";
import { users } from "./auth";
import { orgs } from "./orgs";
import { secrets } from "./secrets";

// ── Scenario layer ────────────────────────────────────────────────────────────

export const scenarios = pgTable("scenarios", {
  id: idCol(),
  orgId: uuid("org_id").references(() => orgs.id), // null = builtin
  slug: text("slug").notNull().unique(),
  nameI18n: jsonb("name_i18n").$type<LocalizedText>().notNull(),
  descriptionI18n: jsonb("description_i18n").$type<LocalizedText>().notNull(),
  icon: text("icon"),
  sortOrder: integer("sort_order").notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAtCol(),
});

// ── Fabri (preset agents, 硅基人) ──────────────────────────────────────────────

export const fabri = pgTable("fabri", {
  id: idCol(),
  orgId: uuid("org_id").references(() => orgs.id),
  slug: text("slug").notNull().unique(),
  nameI18n: jsonb("name_i18n").$type<LocalizedText>().notNull(),
  personaI18n: jsonb("persona_i18n").$type<LocalizedText>().notNull(),
  systemPrompt: text("system_prompt").notNull(),
  avatar: text("avatar"),
  defaultModelRolePolicy: jsonb("default_model_role_policy").$type<Record<string, unknown>>(),
  status: text("status", { enum: ["active", "disabled"] })
    .notNull()
    .default("active"),
  createdAt: createdAtCol(),
});

// ── Orchestration templates (head + immutable versions) ──────────────────────

export const orchestrationTemplates = pgTable("orchestration_templates", {
  id: idCol(),
  orgId: uuid("org_id").references(() => orgs.id),
  slug: text("slug").notNull().unique(),
  scenarioId: uuid("scenario_id")
    .notNull()
    .references(() => scenarios.id),
  nameI18n: jsonb("name_i18n").$type<LocalizedText>().notNull(),
  latestPublishedVersionId: uuid("latest_published_version_id").references(
    (): AnyPgColumn => templateVersions.id,
  ),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAtCol(),
});

export const templateVersions = pgTable(
  "template_versions",
  {
    id: idCol(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => orchestrationTemplates.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status", { enum: ["draft", "published", "deprecated"] })
      .notNull()
      .default("draft"),
    sourceYaml: text("source_yaml").notNull(),
    compiled: jsonb("compiled").$type<Record<string, unknown>>().notNull(),
    checksum: text("checksum").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAtCol(),
    publishedAt: tstz("published_at"),
  },
  (t) => [uniqueIndex("template_versions_uq").on(t.templateId, t.version)],
);

// ── Task types (bind scenario → template + default Faber) ────────────────────

export const taskTypes = pgTable(
  "task_types",
  {
    id: idCol(),
    scenarioId: uuid("scenario_id")
      .notNull()
      .references(() => scenarios.id),
    slug: text("slug").notNull(),
    nameI18n: jsonb("name_i18n").$type<LocalizedText>().notNull(),
    descriptionI18n: jsonb("description_i18n").$type<LocalizedText>().notNull(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => orchestrationTemplates.id),
    defaultFaberId: uuid("default_faber_id")
      .notNull()
      .references(() => fabri.id),
    enabled: boolean("enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAtCol(),
  },
  (t) => [uniqueIndex("task_types_uq").on(t.scenarioId, t.slug)],
);

// ── Skills (head + immutable versions) ────────────────────────────────────────

export const skills = pgTable("skills", {
  id: idCol(),
  orgId: uuid("org_id").references(() => orgs.id),
  slug: text("slug").notNull().unique(),
  nameI18n: jsonb("name_i18n").$type<LocalizedText>().notNull(),
  descriptionI18n: jsonb("description_i18n").$type<LocalizedText>().notNull(),
  source: text("source", { enum: ["builtin", "git", "upload"] }).notNull(),
  latestVersionId: uuid("latest_version_id").references((): AnyPgColumn => skillVersions.id),
  createdAt: createdAtCol(),
});

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: idCol(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    version: text("version").notNull(), // semver
    contentRef: text("content_ref").notNull(), // storage path to the skill bundle
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: ["active", "deprecated"] })
      .notNull()
      .default("active"),
    createdAt: createdAtCol(),
  },
  (t) => [uniqueIndex("skill_versions_uq").on(t.skillId, t.version)],
);

// ── MCP servers ───────────────────────────────────────────────────────────────

export const mcpServers = pgTable("mcp_servers", {
  id: idCol(),
  orgId: uuid("org_id").references(() => orgs.id),
  slug: text("slug").notNull().unique(),
  nameI18n: jsonb("name_i18n").$type<LocalizedText>().notNull(),
  transport: text("transport", { enum: ["stdio", "http", "sse"] }).notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull(), // {command,args,env} | {url,headers}
  authSecretRef: uuid("auth_secret_ref").references(() => secrets.id),
  configRevision: integer("config_revision").notNull().default(1),
  status: text("status", { enum: ["active", "disabled"] })
    .notNull()
    .default("active"),
  createdAt: createdAtCol(),
});

// ── Models ────────────────────────────────────────────────────────────────────

export const models = pgTable("models", {
  id: idCol(),
  orgId: uuid("org_id").references(() => orgs.id),
  provider: text("provider").notNull(), // 'anthropic' | ...
  providerModelId: text("provider_model_id").notNull().unique(),
  displayName: text("display_name").notNull(),
  tier: text("tier", { enum: MODEL_TIERS }).notNull(),
  capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
  contextWindow: integer("context_window"),
  inputCostPerMtok: numeric("input_cost_per_mtok", { precision: 12, scale: 4 }),
  outputCostPerMtok: numeric("output_cost_per_mtok", { precision: 12, scale: 4 }),
  status: text("status", { enum: ["active", "disabled"] })
    .notNull()
    .default("active"),
  createdAt: createdAtCol(),
});
