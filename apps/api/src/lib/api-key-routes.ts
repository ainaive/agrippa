import type { ApiKeyScope } from "@agrippa/core";

/**
 * The complete set of routes an `agr_` API key may reach, and the scope each
 * one costs.
 *
 * This is an allow-list on purpose. The alternative — "a key can do whatever
 * its owner can, minus a denylist" — fails open every time a route is added:
 * a new admin endpoint would be reachable by every key issued before it
 * existed. Here the default for anything unlisted is 403, so widening the
 * programmatic surface is always a deliberate edit to this file.
 *
 * Scope is therefore about *intent* ("this key only reads"), while reach is
 * bounded by this table plus the owner's project membership. Administration —
 * registries, template publish, members, quota, settings, notification
 * endpoints, checkpoint decisions — is deliberately absent: those are decisions
 * a human makes in the UI, not things a script should do with a stolen token.
 */
/**
 * **Before adding a route here**: confirm it reaches project data through
 * `assertProjectRole`. That function is where a key's `boundProjectId` is
 * enforced, so a handler that scopes some other way — `GET /checkpoints/pending`
 * joins `project_members` directly, for instance — would serve a bound key rows
 * from *every* project its owner belongs to. Such a handler is safe only while
 * it stays off this list, which is a property of this file rather than of the
 * handler, and therefore worth stating here rather than hoping it is noticed.
 */
export type ApiKeyRouteRule = {
  method: string;
  pattern: RegExp;
  scope: ApiKeyScope;
};

/** Matches a uuid path segment; ids in this codebase are uuidv7. */
const ID = "[0-9a-fA-F-]{36}";
/** Sub-resources of a run that are all plain reads of the same run. */
const RUN_READS = "(?:steps|checkpoints|comments|artifacts|events)";

export const API_KEY_ROUTES: readonly ApiKeyRouteRule[] = [
  // ── submit and steer work ──────────────────────────────────────────────────
  { method: "POST", pattern: new RegExp(`^/api/v1/projects/${ID}/tasks$`), scope: "tasks:write" },
  { method: "POST", pattern: new RegExp(`^/api/v1/tasks/${ID}/retry$`), scope: "tasks:write" },
  { method: "POST", pattern: new RegExp(`^/api/v1/runs/${ID}/cancel$`), scope: "tasks:write" },

  // ── read the work back ─────────────────────────────────────────────────────
  { method: "GET", pattern: new RegExp(`^/api/v1/projects/${ID}/tasks$`), scope: "runs:read" },
  { method: "GET", pattern: new RegExp(`^/api/v1/tasks/${ID}$`), scope: "runs:read" },
  {
    method: "GET",
    pattern: new RegExp(`^/api/v1/runs/${ID}(?:/${RUN_READS})?$`),
    scope: "runs:read",
  },
  { method: "GET", pattern: new RegExp(`^/api/v1/artifacts/${ID}/download$`), scope: "runs:read" },

  // ── the catalog a caller needs in order to build a submission ──────────────
  { method: "GET", pattern: /^\/api\/v1\/scenarios$/, scope: "resources:read" },
  { method: "GET", pattern: /^\/api\/v1\/scenarios\/[^/]+\/task-types$/, scope: "resources:read" },
  { method: "GET", pattern: new RegExp(`^/api/v1/task-types/${ID}$`), scope: "resources:read" },
];

/**
 * The scope a request costs, or null when API keys may not reach it at all.
 * `HEAD` is treated as `GET` so a reachability probe can't bypass the table.
 */
export function requiredScopeFor(method: string, path: string): ApiKeyScope | null {
  const verb = method === "HEAD" ? "GET" : method;
  return API_KEY_ROUTES.find((r) => r.method === verb && r.pattern.test(path))?.scope ?? null;
}
