/**
 * Project API keys (`Authorization: Bearer agr_…`) — the programmatic surface
 * described in docs/design/05-api-and-auth.md.
 *
 * Keys are for *automation*, not administration. The scope vocabulary is
 * deliberately small and the routes a key may reach are an explicit allow-list
 * (`apps/api/src/lib/api-key-routes.ts`), not "everything the owning user can
 * do minus a denylist" — so a route added tomorrow is unreachable by every
 * existing key until someone deliberately lists it.
 */
export const API_KEY_PREFIX = "agr_";

export const API_KEY_SCOPES = ["tasks:write", "runs:read", "resources:read"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export function isApiKeyScope(value: string): value is ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(value);
}

/** What each scope grants, for the UI and the manual. */
export const API_KEY_SCOPE_DESCRIPTIONS: Record<ApiKeyScope, string> = {
  "tasks:write": "Submit tasks, retry them, and cancel runs",
  "runs:read": "Read tasks, runs, steps, checkpoints, comments, and artifacts",
  "resources:read": "Read the scenario catalog and task types",
};
