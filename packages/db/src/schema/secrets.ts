import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAtCol, idCol, tstz } from "./_helpers";
import { users } from "./auth";
import { orgs } from "./orgs";

/**
 * Encrypted credential store (AES-256-GCM, key from AGRIPPA_SECRET_KEY).
 * Everything else references rows here via *_secret_ref — secrets never
 * live in plain jsonb config.
 */
export const secrets = pgTable("secrets", {
  id: idCol(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id),
  kind: text("kind", {
    enum: ["mcp_auth", "git_credential", "provider_api_key", "generic"],
  }).notNull(),
  ciphertext: text("ciphertext").notNull(), // base64: iv ∥ authTag ∥ data
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAtCol(),
  rotatedAt: tstz("rotated_at"),
});
