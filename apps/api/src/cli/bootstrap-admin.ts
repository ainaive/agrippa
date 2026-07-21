/**
 * Bootstraps the first org_admin for a self-hosted install. Free self-sign-up
 * is closed (apps/api/src/app.ts); this is the one-time way to create the
 * administrator. Idempotent on email.
 *
 *   AGRIPPA_BOOTSTRAP_EMAIL=you@example.com \
 *   AGRIPPA_BOOTSTRAP_PASSWORD='...' \
 *   bun --env-file=../../.env.local apps/api/src/cli/bootstrap-admin.ts
 *
 * The password is hashed with better-auth's hashPassword, so the resulting
 * account signs in via the normal /api/auth/sign-in/email flow.
 */
import { accounts, auditLogs, createDb, type DbOrTx, orgs, users, uuidv7 } from "@agrippa/db";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";

const email = process.env.AGRIPPA_BOOTSTRAP_EMAIL;
const password = process.env.AGRIPPA_BOOTSTRAP_PASSWORD;

if (!email || !password) {
  console.error("[bootstrap] AGRIPPA_BOOTSTRAP_EMAIL and AGRIPPA_BOOTSTRAP_PASSWORD must be set");
  process.exit(1);
}
if (password.length < 8) {
  console.error("[bootstrap] password must be at least 8 characters");
  process.exit(1);
}

const db = createDb();

const [org] = await db.select().from(orgs).where(eq(orgs.slug, "default"));
if (!org) {
  console.error("[bootstrap] default org missing — run `bun run db:seed` first");
  process.exit(1);
}

const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
if (existing) {
  const [u] = await db
    .select({ orgRole: users.orgRole })
    .from(users)
    .where(eq(users.id, existing.id));
  console.log(`[bootstrap] user already exists: ${email} (orgRole=${u?.orgRole}) — nothing to do`);
  process.exit(0);
}

const userId = uuidv7();
const hash = await hashPassword(password);

await db.transaction(async (tx: DbOrTx) => {
  await tx.insert(users).values({
    id: userId,
    name: email.split("@")[0],
    email,
    orgId: org.id,
    orgRole: "org_admin",
    locale: "en",
  } as typeof users.$inferInsert);
  await tx.insert(accounts).values({
    id: uuidv7(),
    userId,
    providerId: "credential",
    accountId: userId,
    password: hash,
  } as typeof accounts.$inferInsert);
  await tx.insert(auditLogs).values({
    orgId: org.id,
    actorUserId: userId,
    action: "org.bootstrap_admin",
    resourceType: "user",
    resourceId: userId,
    payload: { email },
  });
});

console.log(`[bootstrap] org_admin created: ${email}`);
console.log("[bootstrap] sign in at the login page with this account.");
process.exit(0);
