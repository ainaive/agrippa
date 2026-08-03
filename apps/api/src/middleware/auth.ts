import { API_KEY_PREFIX, AppError } from "@agrippa/core";
import { apiKeys, users } from "@agrippa/db";
import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { SessionUser } from "../auth";
import type { AppEnv, RequestPrincipal } from "../context";
import { requiredScopeFor } from "../lib/api-key-routes";
import { bearerToken, tokenMatches, tokenPrefixOf } from "../lib/bearer-tokens";

/**
 * `last_used_at` is a liveness signal for the admin UI, not an audit trail —
 * audit rows already name the key on every mutation. Writing it on literally
 * every request would put an UPDATE in front of every read, so it advances at
 * most once a minute.
 */
const LAST_USED_REFRESH_MS = 60_000;

/**
 * Every auth failure answers with this one code. Distinguishing "no such key"
 * from "revoked" from "expired" would let a probe mine the difference; the
 * daemon surface made the same choice (ADR-0017) and this matches it.
 */
function invalidKey(): AppError {
  return new AppError("api_key_invalid", 401, "Invalid API key");
}

/**
 * Resolve an `agr_` bearer token to a principal: prefix-indexed lookup,
 * constant-time hash compare, liveness checks, then the route allow-list.
 *
 * A key acts as its creating user, so project membership remains the single
 * source of who-can-touch-what and revoking someone's project access disables
 * their keys with it. Two things are deliberately narrower than that user:
 * the org role is pinned to `org_member` regardless of the owner's real role,
 * and reach is bounded by the allow-list — so an org admin's key still cannot
 * administer anything.
 */
async function authenticateApiKey(
  c: Parameters<Parameters<typeof createMiddleware<AppEnv>>[0]>[0],
  token: string,
): Promise<void> {
  const db = c.var.db;
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.prefix, tokenPrefixOf(token)));
  if (!row || !tokenMatches(token, row.keyHash)) throw invalidKey();
  if (row.revokedAt) throw invalidKey();
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) throw invalidKey();

  // scope + reach, before any work: an out-of-scope call never touches a row
  const needed = requiredScopeFor(c.req.method, c.req.path);
  if (!needed) {
    throw AppError.forbidden("This endpoint is not available to API keys");
  }
  if (!row.scopes.includes(needed)) {
    throw AppError.forbidden(`This API key lacks the ${needed} scope`);
  }

  const [owner] = await db.select().from(users).where(eq(users.id, row.createdBy));
  if (!owner || owner.orgId !== row.orgId) throw invalidKey();

  const principal: RequestPrincipal = {
    userId: owner.id,
    orgId: row.orgId,
    boundProjectId: row.projectId,
    apiKeyId: row.id,
  };
  c.set("principal", principal);
  c.set("user", {
    id: owner.id,
    email: owner.email,
    name: owner.name,
    orgId: row.orgId,
    locale: owner.locale,
    // never inherit the owner's org role: a key is automation, not an admin
    orgRole: "org_member",
  } as SessionUser);
  if (!c.req.query("lang") && owner.locale) c.set("locale", owner.locale);

  const lastUsed = row.lastUsedAt?.getTime() ?? 0;
  if (Date.now() - lastUsed > LAST_USED_REFRESH_MS) {
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
  }
}

/**
 * The v1 gate. Accepts a better-auth session (the browser) or an `agr_` bearer
 * token (automation), and sets `user` + `principal` either way so handlers
 * never branch on how the caller authenticated.
 */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const bearer = bearerToken(c.req.header("authorization"));
  if (bearer?.startsWith(API_KEY_PREFIX)) {
    await authenticateApiKey(c, bearer);
    await next();
    return;
  }

  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw AppError.unauthorized();
  const user = session.user as unknown as SessionUser;
  c.set("user", user);
  c.set("principal", {
    userId: user.id,
    orgId: user.orgId,
    boundProjectId: null,
    apiKeyId: null,
  });
  // profile locale wins unless the request pins ?lang explicitly
  if (!c.req.query("lang") && user.locale) c.set("locale", user.locale);
  await next();
});
