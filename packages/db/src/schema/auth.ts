import { boolean, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAtCol, tstz } from "./_helpers";
import { orgs } from "./orgs";

/**
 * better-auth core tables (usePlural), extended with Agrippa's org fields.
 * IDs are UUIDv7 supplied by better-auth's generateId hook.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id),
  locale: text("locale").notNull().default("en"),
  orgRole: text("org_role", { enum: ["org_admin", "org_member"] })
    .notNull()
    .default("org_member"),
  createdAt: createdAtCol(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: tstz("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: createdAtCol(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: tstz("access_token_expires_at"),
  refreshTokenExpiresAt: tstz("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: createdAtCol(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

export const verifications = pgTable("verifications", {
  id: uuid("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: tstz("expires_at").notNull(),
  createdAt: createdAtCol(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});
