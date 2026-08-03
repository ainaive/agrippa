import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The one implementation of the platform's bearer-credential scheme, shared by
 * every kind of token the api issues: `agrd_` runtime tokens (ADR-0017), `agr_`
 * project API keys, and invitation tokens. All of them generate the same random
 * secret, store only its sha256, and compare in constant time — this module
 * exists so that stays true, rather than being true three times by coincidence.
 *
 * Prefixed tokens additionally keep their first `DISPLAY_PREFIX_LENGTH` chars in
 * clear, which serves two purposes: an indexed lookup that avoids scanning every
 * row, and something recognizable to show in the UI next to a credential whose
 * plaintext was displayed exactly once.
 */
const TOKEN_BYTES = 32;

/** Chars of an issued token stored in clear for indexed lookup + UI display. */
export const DISPLAY_PREFIX_LENGTH = 12;

export type IssuedToken = { token: string; tokenPrefix: string; tokenHash: string };

/** Random secret material, no prefix — the invitation-token shape. */
export function generateSecret(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64");
}

/** Constant-time compare of two already-hashed values. */
export function hashesMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Constant-time verify — defence in depth after the prefix-indexed lookup. */
export function tokenMatches(token: string, storedHash: string): boolean {
  return hashesMatch(hashToken(token), storedHash);
}

export function tokenPrefixOf(token: string): string {
  return token.slice(0, DISPLAY_PREFIX_LENGTH);
}

/** Mint a prefixed credential: plaintext (shown once), lookup prefix, stored hash. */
export function issueToken(prefix: string): IssuedToken {
  const token = prefix + generateSecret();
  return { token, tokenPrefix: tokenPrefixOf(token), tokenHash: hashToken(token) };
}

/** The bearer credential on a request, or null when the header is absent/other. */
export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token === "" ? null : token;
}
