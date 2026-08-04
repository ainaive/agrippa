import { jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAtCol, idCol, tstz } from "./_helpers";
import { users } from "./auth";
import { orgs } from "./orgs";
import { projects } from "./projects";

export const apiKeys = pgTable(
  "api_keys",
  {
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
  },
  // auth resolves a key by its clear prefix before the constant-time hash
  // compare — indexed so that lookup never degrades into a table scan, and
  // unique so a collision can't make it ambiguous (mirrors runtimes).
  (t) => [uniqueIndex("api_keys_prefix_uq").on(t.prefix)],
);
