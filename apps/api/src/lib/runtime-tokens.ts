import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Daemon runtime tokens (ADR-0017): `agrd_` + 32 random bytes base64url,
 * stored hash-only — the same generate/hash/constant-time-compare trio as
 * invitation tokens, and deliberately the same shape as `api_keys`
 * (prefix + hash) so Track T's bearer middleware can generalize from this.
 */
const TOKEN_BYTES = 32;
export const RUNTIME_TOKEN_PREFIX = "agrd_";
/** Chars of the issued token stored in clear for indexed lookup + UI display. */
const DISPLAY_PREFIX_LENGTH = 12;

export type IssuedRuntimeToken = { token: string; tokenPrefix: string; tokenHash: string };

export function issueRuntimeToken(): IssuedRuntimeToken {
  const token = RUNTIME_TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString("base64url");
  return {
    token,
    tokenPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
    tokenHash: hashRuntimeToken(token),
  };
}

export function hashRuntimeToken(token: string): string {
  return createHash("sha256").update(token).digest("base64");
}

export function runtimeTokenPrefix(token: string): string {
  return token.slice(0, DISPLAY_PREFIX_LENGTH);
}

/** Constant-time compare — defence in depth after the prefix-indexed lookup. */
export function runtimeTokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashRuntimeToken(token));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}
