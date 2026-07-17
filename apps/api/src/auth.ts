import type { OrgRole } from "@agrippa/core";
import { type Db, orgs, users } from "@agrippa/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { count, eq } from "drizzle-orm";

/**
 * better-auth handles authentication only; Agrippa's own middleware handles
 * authorization (org/project RBAC). The user.create hook assigns every new
 * user to the single seeded org — and makes the very first user org_admin,
 * which is how a fresh self-hosted install bootstraps its administrator.
 */
export function createAuth(db: Db) {
  return betterAuth({
    baseURL: process.env.AGRIPPA_BASE_URL ?? "http://localhost:3000",
    secret: process.env.BETTER_AUTH_SECRET ?? "dev-only-secret-change-me",
    database: drizzleAdapter(db, { provider: "pg", usePlural: true }),
    emailAndPassword: { enabled: true },
    user: {
      additionalFields: {
        orgId: { type: "string", input: false },
        locale: { type: "string", defaultValue: "en", input: false },
        orgRole: { type: "string", defaultValue: "org_member", input: false },
      },
    },
    advanced: {
      database: { generateId: () => Bun.randomUUIDv7() },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const [org] = await db.select().from(orgs).where(eq(orgs.slug, "default"));
            if (!org) throw new Error("default org missing — run db:seed first");
            const [row] = await db.select({ n: count() }).from(users);
            const orgRole: OrgRole = (row?.n ?? 0) === 0 ? "org_admin" : "org_member";
            return { data: { ...user, orgId: org.id, orgRole } };
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  orgId: string;
  locale: string;
  orgRole: OrgRole;
};
