import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError, acceptInviteSchema, invitationCreateSchema } from "@agrippa/core";
import { accounts, auditLogs, type DbOrTx, invitations, users, uuidv7 } from "@agrippa/db";
import { hashPassword } from "better-auth/crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { audit } from "../lib/audit";
import { validate } from "../lib/validate";
import { requireOrgAdmin } from "../middleware/rbac";

const TOKEN_BYTES = 32;
const DEFAULT_EXPIRY_DAYS = 7;

const generateToken = () => randomBytes(TOKEN_BYTES).toString("base64url");
const hashToken = (token: string) => createHash("sha256").update(token).digest("base64");

/** Constant-time compare for token hashes. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Invitations are org-scoped and org_admin-gated. An invite token is stored
 * hashed; the plaintext is returned to the admin exactly once to share
 * out-of-band (no email infra — docs/design/05). Accepting creates the user +
 * credential account directly (free sign-up is closed in app.ts); the invitee
 * then signs in via the normal /api/auth/sign-in/email flow.
 */

// ── Org-admin-gated management ────────────────────────────────────────────────

export const invitationRoutes = new Hono<AppEnv>()
  .post("/", requireOrgAdmin, validate("json", invitationCreateSchema), async (c) => {
    const input = c.req.valid("json");
    const db = c.var.db;
    const actor = c.var.user;

    if (actor.email.toLowerCase() === input.email.toLowerCase()) {
      throw new AppError("invite_self", 409, "Cannot invite yourself");
    }

    // already a member of this org?
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, input.email), eq(users.orgId, actor.orgId)));
    if (existing) throw AppError.conflict("already_member", "User is already a member");

    // revoke any prior pending invite for this email so only the newest is live
    await db
      .delete(invitations)
      .where(
        and(
          eq(invitations.email, input.email),
          eq(invitations.orgId, actor.orgId),
          isNull(invitations.acceptedAt),
        ),
      );

    const token = generateToken();
    const expiresAt = new Date(
      Date.now() + (input.expiresDays ?? DEFAULT_EXPIRY_DAYS) * 24 * 60 * 60 * 1000,
    );
    const [inv] = await db
      .insert(invitations)
      .values({
        orgId: actor.orgId,
        email: input.email,
        tokenHash: hashToken(token),
        createdBy: actor.id,
        expiresAt,
      })
      .returning({
        id: invitations.id,
        email: invitations.email,
        expiresAt: invitations.expiresAt,
      });
    if (!inv) throw new Error("insert returned no row");

    await audit(c, {
      action: "org.invite.create",
      resourceType: "invitation",
      resourceId: inv.id,
      payload: { email: inv.email, expiresAt: inv.expiresAt.toISOString() },
    });

    const base = process.env.AGRIPPA_BASE_URL ?? "http://localhost:3000";
    const inviteUrl = `${base}/accept-invite?token=${token}`;
    return c.json(
      { id: inv.id, email: inv.email, expiresAt: inv.expiresAt, inviteUrl, token },
      201,
    );
  })

  .get("/", requireOrgAdmin, async (c) => {
    const rows = await c.var.db
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        expiresAt: invitations.expiresAt,
        acceptedAt: invitations.acceptedAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .where(eq(invitations.orgId, c.var.user.orgId))
      .orderBy(desc(invitations.createdAt))
      .limit(200);
    return c.json(rows);
  })

  .delete("/:id", requireOrgAdmin, async (c) => {
    const id = c.req.param("id");
    const [row] = await c.var.db
      .delete(invitations)
      .where(and(eq(invitations.id, id), eq(invitations.orgId, c.var.user.orgId)))
      .returning({ id: invitations.id, email: invitations.email });
    if (!row) throw AppError.notFound("Invitation");
    await audit(c, {
      action: "org.invite.revoke",
      resourceType: "invitation",
      resourceId: row.id,
      payload: { email: row.email },
    });
    return c.json({ ok: true });
  });

// ── Public accept flow (no session) ───────────────────────────────────────────
//
// Mounted under /api/auth/accept-invite in app.ts, before the better-auth
// wildcard, so it stays unauthenticated. c.var.db is set by the global
// * middleware; c.var.user is intentionally not used (no session) — audit is
// written with actorUserId = invitation.createdBy.

export const acceptInviteRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const token = c.req.query("token");
    if (!token) throw new AppError("invite_invalid", 400, "Missing token");
    const [inv] = await c.var.db
      .select({
        email: invitations.email,
        expiresAt: invitations.expiresAt,
        acceptedAt: invitations.acceptedAt,
      })
      .from(invitations)
      .where(eq(invitations.tokenHash, hashToken(token)));
    if (!inv) throw new AppError("invite_invalid", 404, "Invalid invite");
    if (inv.acceptedAt) throw new AppError("invite_already_accepted", 410, "Invite already used");
    if (inv.expiresAt.getTime() < Date.now())
      throw new AppError("invite_expired", 410, "Invite expired");
    return c.json({ email: inv.email, expiresAt: inv.expiresAt });
  })

  .post("/", validate("json", acceptInviteSchema), async (c) => {
    const { token, name, password } = c.req.valid("json");
    const db = c.var.db;
    const tokenHash = hashToken(token);

    const [inv] = await db.select().from(invitations).where(eq(invitations.tokenHash, tokenHash));
    if (!inv) throw new AppError("invite_invalid", 404, "Invalid invite");
    if (inv.acceptedAt) throw new AppError("invite_already_accepted", 409, "Invite already used");
    if (inv.expiresAt.getTime() < Date.now())
      throw new AppError("invite_expired", 410, "Invite expired");

    // safety: a token mismatch shouldn't happen (we looked up by hash), but
    // keep the constant-time compare as a guard against future storage changes.
    if (!safeEqual(inv.tokenHash, tokenHash))
      throw new AppError("invite_invalid", 404, "Invalid invite");

    const hash = await hashPassword(password);

    const created = await db.transaction(async (tx: DbOrTx) => {
      const userId = uuidv7();
      await tx.insert(users).values({
        id: userId,
        name,
        email: inv.email,
        orgId: inv.orgId,
        orgRole: inv.role,
        locale: "en",
      });
      await tx.insert(accounts).values({
        id: uuidv7(),
        userId,
        providerId: "credential",
        accountId: userId,
        password: hash,
      });
      await tx
        .update(invitations)
        .set({ acceptedAt: new Date(), acceptedUserId: userId })
        .where(and(eq(invitations.id, inv.id), isNull(invitations.acceptedAt)));
      await tx.insert(auditLogs).values({
        orgId: inv.orgId,
        actorUserId: inv.createdBy,
        action: "org.invite.accept",
        resourceType: "invitation",
        resourceId: inv.id,
        payload: { email: inv.email, acceptedUserId: userId },
        ip: c.req.header("x-forwarded-for") ?? null,
      });
      return { userId };
    });

    return c.json({ ok: true, userId: created.userId });
  });
