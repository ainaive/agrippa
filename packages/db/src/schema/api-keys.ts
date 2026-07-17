import { jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAtCol, idCol, tstz } from "./_helpers";
import { users } from "./auth";
import { orgs } from "./orgs";
import { projects } from "./projects";

export const apiKeys = pgTable("api_keys", {
  id: idCol(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id),
  projectId: uuid("project_id").references(() => projects.id), // null = org-wide
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull(),
  prefix: text("prefix").notNull(), // 'agr_' + short prefix shown in the UI
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: createdAtCol(),
  expiresAt: tstz("expires_at"),
  revokedAt: tstz("revoked_at"),
  lastUsedAt: tstz("last_used_at"),
});
