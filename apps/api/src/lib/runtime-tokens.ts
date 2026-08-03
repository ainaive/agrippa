import {
  hashToken,
  type IssuedToken,
  issueToken,
  tokenMatches,
  tokenPrefixOf,
} from "./bearer-tokens";

/**
 * Daemon runtime tokens (ADR-0017): `agrd_` + 32 random bytes base64url,
 * stored hash-only. The generate/hash/constant-time-compare trio itself lives
 * in `bearer-tokens.ts`, shared with `agr_` project API keys and invitation
 * tokens; this module is just the `agrd_` binding of it.
 */
export const RUNTIME_TOKEN_PREFIX = "agrd_";

export type IssuedRuntimeToken = IssuedToken;

export function issueRuntimeToken(): IssuedRuntimeToken {
  return issueToken(RUNTIME_TOKEN_PREFIX);
}

export function hashRuntimeToken(token: string): string {
  return hashToken(token);
}

export function runtimeTokenPrefix(token: string): string {
  return tokenPrefixOf(token);
}

export function runtimeTokenMatches(token: string, storedHash: string): boolean {
  return tokenMatches(token, storedHash);
}
