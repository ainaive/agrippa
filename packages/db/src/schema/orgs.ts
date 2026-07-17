import { pgTable, text } from "drizzle-orm/pg-core";
import { createdAtCol, idCol } from "./_helpers";

/**
 * M1 seeds exactly one org, but org_id is carried on every top-level table
 * so SaaS tenancy can layer on without schema rewrites (see 01-domain-model).
 */
export const orgs = pgTable("orgs", {
  id: idCol(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: createdAtCol(),
});
