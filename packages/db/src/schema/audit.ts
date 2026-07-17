import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAtCol, idCol } from "./_helpers";
import { apiKeys } from "./api-keys";
import { users } from "./auth";
import { orgs } from "./orgs";
import { projects } from "./projects";

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: idCol(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: uuid("project_id").references(() => projects.id),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    actorApiKeyId: uuid("actor_api_key_id").references(() => apiKeys.id),
    action: text("action").notNull(), // 'project.member.add', 'template.publish', ...
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    createdAt: createdAtCol(),
  },
  (t) => [index("audit_logs_org_time_idx").on(t.orgId, t.createdAt)],
);
