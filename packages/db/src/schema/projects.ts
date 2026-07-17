import { PROJECT_ROLES, RESOURCE_TYPES } from "@agrippa/core";
import {
  bigint,
  boolean,
  date,
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

export const projects = pgTable(
  "projects",
  {
    id: idCol(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAtCol(),
    archivedAt: tstz("archived_at"),
  },
  (t) => [uniqueIndex("projects_org_slug_uq").on(t.orgId, t.slug)],
);

export const projectMembers = pgTable(
  "project_members",
  {
    id: idCol(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: PROJECT_ROLES }).notNull(),
    createdAt: createdAtCol(),
  },
  (t) => [uniqueIndex("project_members_uq").on(t.projectId, t.userId)],
);

export const repoConnections = pgTable("repo_connections", {
  id: idCol(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["github", "gitlab", "generic-git"] }).notNull(),
  url: text("url").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  credentialSecretRef: uuid("credential_secret_ref").references(() => secrets.id),
  status: text("status", { enum: ["active", "disabled"] })
    .notNull()
    .default("active"),
  createdAt: createdAtCol(),
});

export const projectResourceGrants = pgTable(
  "project_resource_grants",
  {
    id: idCol(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    resourceType: text("resource_type", { enum: RESOURCE_TYPES }).notNull(),
    resourceId: uuid("resource_id").notNull(),
    configOverride: jsonb("config_override").$type<Record<string, unknown>>(),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAtCol(),
  },
  (t) => [uniqueIndex("project_grants_uq").on(t.projectId, t.resourceType, t.resourceId)],
);

export const projectQuotas = pgTable("project_quotas", {
  id: idCol(),
  projectId: uuid("project_id")
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: "cascade" }),
  period: text("period", { enum: ["monthly"] })
    .notNull()
    .default("monthly"),
  tokenLimit: bigint("token_limit", { mode: "number" }),
  costLimitUsd: numeric("cost_limit_usd", { precision: 12, scale: 2 }),
  hardStop: boolean("hard_stop").notNull().default(true),
  currentPeriodStart: date("current_period_start"),
  createdAt: createdAtCol(),
});
