import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAtCol, idCol, tstz } from "./_helpers";
import { users } from "./auth";
import { orgs } from "./orgs";

/**
 * Org-scoped invitations. An org_admin invites by email; the invitee accepts
 * at /accept-invite?token=... and sets a password. The one-time token is stored
 * hashed (sha256) so a DB read can't be replayed. Free self-sign-up is closed
 * (apps/api/src/app.ts guards /api/auth/sign-up/*); this is the only way a new
 * user joins the org. See docs/design/05.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: idCol(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    email: text("email").notNull(),
    /** sha256 of the one-time token, base64url. Never store the plaintext token. */
    tokenHash: text("token_hash").notNull().unique(),
    role: text("role", { enum: ["org_member"] })
      .notNull()
      .default("org_member"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    expiresAt: tstz("expires_at").notNull(),
    acceptedAt: tstz("accepted_at"),
    acceptedUserId: uuid("accepted_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAtCol(),
  },
  (t) => [index("invitations_org_idx").on(t.orgId), index("invitations_token_idx").on(t.tokenHash)],
);
