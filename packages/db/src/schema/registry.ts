import { type LocalizedText, MODEL_TIERS } from "@agrippa/core";
import {
  type AnyPgColumn,
  boolean,
  integer,
  jsonb,
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
  /**
   * Selection preference within a tier, lower first (ties break by
   * provider_model_id). Replaces the price columns that used to order
   * resolution — the registry no longer stores money (ADR-0015).
   */
  rank: integer("rank").notNull().default(100),
  status: text("status", { enum: ["active", "disabled"] })
    .notNull()
    .default("active"),
  createdAt: createdAtCol(),
});

// ── Provider catalog ──────────────────────────────────────────────────────────
// The resolvable set of model providers (label, per-wire-protocol default
// endpoints, auth policy, host allowlist pins). Replaces the code constant
// PROVIDER_CATALOG for the variable part: builtins are seeded as org_id NULL
// rows; custom providers (DeepSeek, self-hosted gateways, …) are org-scoped
// and org_admin-created. models.provider / provider_credentials.provider match
// provider_id. See docs/superpowers/specs/2026-07-28-…-slice2-design.md.
export const PROVIDER_AUTH = ["project", "env"] as const;
export type ProviderAuth = (typeof PROVIDER_AUTH)[number];

/** { anthropic?: "https://…", openai?: "https://…" } — a base URL per wire protocol. */
export type ProviderBaseUrls = Partial<Record<"anthropic" | "openai", string>>;

export const providerCatalog = pgTable("provider_catalog", {
  id: idCol(),
  orgId: uuid("org_id").references(() => orgs.id), // null = builtin/deployment-level
  providerId: text("provider_id").notNull().unique(),
  label: text("label").notNull(),
  baseUrls: jsonb("base_urls").$type<ProviderBaseUrls>().notNull().default({}),
  auth: text("auth", { enum: PROVIDER_AUTH }).notNull(),
  /** Host allowlist pins (".maas.aliyuncs.com" suffix or exact host); null = any https host. */
  baseUrlHosts: jsonb("base_url_hosts").$type<string[] | null>(),
  status: text("status", { enum: ["active", "disabled"] })
    .notNull()
    .default("active"),
  createdAt: createdAtCol(),
});

// ── Executor registrations ────────────────────────────────────────────────────

/**
 * Which executors this deployment's workers actually registered (codex, for
 * example, registers only when its CLI and auth are present). Workers upsert
 * at boot and heartbeat on the sweeper interval; the API treats recent rows
 * as the live set and rejects submissions that bind an unavailable executor —
 * the static core catalog says what CAN exist, this table says what DOES.
 */
export const executorRegistrations = pgTable("executor_registrations", {
  executorId: text("executor_id").primaryKey(),
  registeredAt: tstz("registered_at").notNull().defaultNow(),
});
