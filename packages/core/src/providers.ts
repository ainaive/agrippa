/**
 * Static provider catalog — the model providers the platform knows how to
 * authenticate against. Providers are wire-protocol-agnostic: one provider
 * (e.g. dashscope) can expose an Anthropic-compatible endpoint for the claude
 * executor and an OpenAI-compatible one for codex, so default base URLs are
 * keyed by protocol. `models.provider` stays free text — a provider outside
 * this catalog simply falls back to worker-env auth with no base-URL default.
 */

/** The API wire protocol an executor speaks to its provider. */
export type WireProtocol = "anthropic" | "openai";

export type ProviderCatalogEntry = {
  /** Display name, not localized — providers are product names. */
  label: string;
  /**
   * Default base URL per wire protocol. Absent = the executor's native
   * endpoint. A project credential's baseUrl overrides these — but only for
   * protocols the provider is known to serve (see effectiveBaseUrl in
   * executor-core) — e.g. regional endpoints like dashscope-intl.
   */
  baseUrls: Partial<Record<WireProtocol, string>>;
  /**
   * "project": the provider only works with a per-project credential — a slot
   * cannot resolve to it without one (submit fails actionably). "env": the
   * worker's process env is a legitimate deployment-wide fallback.
   */
  auth: "project" | "env";
  /**
   * Allowed hostnames for a credential's baseUrl override — a leading dot
   * means suffix match, otherwise exact host. Absent = any public https
   * host. The worker sends the decrypted key to this URL, so providers with
   * a known host family pin it (SSRF/exfiltration guard). Pins must exclude
   * customer-controlled neighbors — e.g. Aliyun OSS bucket domains live
   * under .aliyuncs.com and can log request headers, so dashscope pins the
   * exact API hosts plus the workspace-gateway suffix, not the whole zone.
   */
  baseUrlHosts?: readonly string[];
};

/**
 * A resolvable provider catalog: providerId → entry. The code `PROVIDER_CATALOG`
 * is the builtin baseline; `buildProviderCatalog` merges DB rows (builtins +
 * org-admin-registered customs) into the same shape for resolution/runtime.
 */
export type ProviderCatalog = Record<string, ProviderCatalogEntry>;

/** A DB provider_catalog row in the shape `buildProviderCatalog` consumes. */
export type ProviderCatalogRow = {
  providerId: string;
  label: string;
  baseUrls: ProviderCatalogEntry["baseUrls"];
  auth: ProviderCatalogEntry["auth"];
  baseUrlHosts?: readonly string[] | null;
  status?: string;
};

/**
 * Build a resolvable catalog from DB rows (active only). The code
 * `PROVIDER_CATALOG` stays the seed source + the executor-runtime fallback;
 * this merges builtins (seeded as org_id NULL) and org-scoped customs into one
 * Record for resolution and auth-policy lookups.
 */
export function buildProviderCatalog(rows: ProviderCatalogRow[]): ProviderCatalog {
  const catalog: ProviderCatalog = {};
  for (const row of rows) {
    if (row.status === "disabled") continue;
    catalog[row.providerId] = {
      label: row.label,
      baseUrls: row.baseUrls,
      auth: row.auth,
      baseUrlHosts: row.baseUrlHosts ?? undefined,
    };
  }
  return catalog;
}

export const PROVIDER_CATALOG = {
  anthropic: { label: "Anthropic", baseUrls: {}, auth: "env" },
  openai: { label: "OpenAI", baseUrls: {}, auth: "env" },
  dashscope: {
    label: "Aliyun Bailian (DashScope)",
    baseUrls: {
      // Beijing-region endpoint; international deployments override via the
      // credential's baseUrl (Singapore uses a workspace-scoped host).
      // claude executor only for now — Codex CLI ≥0.122 removed wire_api
      // "chat" and Bailian's OpenAI-compatible mode is chat-completions
      // (Responses support is per-model; ADR-0013 amendment).
      anthropic: "https://dashscope.aliyuncs.com/apps/anthropic",
    },
    auth: "project",
    baseUrlHosts: ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", ".maas.aliyuncs.com"],
  },
} as const satisfies Record<string, ProviderCatalogEntry>;

export type ProviderId = keyof typeof PROVIDER_CATALOG;

export function isProviderId(id: string): id is ProviderId {
  return id in PROVIDER_CATALOG;
}

/**
 * Auth policy for a provider against a catalog. Unknown providers (not in the
 * catalog) fall back to worker env — but resolution never considers unknown
 * providers as candidates, so this branch is only the executor-runtime
 * back-compat path. Pass the merged catalog at submit/runtime for customs.
 */
export function providerAuthPolicy(
  id: string,
  catalog: ProviderCatalog = PROVIDER_CATALOG,
): "project" | "env" {
  return catalog[id]?.auth ?? "env";
}

/** Catalog default base URL for a provider on a given wire protocol. */
export function providerDefaultBaseUrl(
  id: string,
  protocol: WireProtocol,
  catalog: ProviderCatalog = PROVIDER_CATALOG,
): string | undefined {
  return catalog[id]?.baseUrls[protocol];
}

/**
 * Whether the provider is known to serve the given wire protocol. Providers
 * with catalog defaults serve exactly those protocols; a native provider (empty
 * baseUrls, e.g. the anthropic/openai builtins) serves its *own* protocol only
 * (so the claude executor won't pick the openai native provider and vice
 * versa). Unknown providers serve any — the executor-runtime back-compat path
 * (a custom provider with an explicit credential baseUrl resolves at runtime).
 */
export function providerServesProtocol(
  id: string,
  protocol: WireProtocol,
  catalog: ProviderCatalog = PROVIDER_CATALOG,
): boolean {
  const entry = catalog[id];
  if (!entry) return true;
  if (entry.baseUrls[protocol] !== undefined) return true;
  if (Object.keys(entry.baseUrls).length === 0) return id === protocol; // native → own protocol
  return false;
}

/**
 * The providers an executor speaking `protocol` may resolve against, derived
 * from the catalog (not a hardcoded list) — the change that lets an
 * org-admin-registered custom Anthropic-compatible provider be resolved by the
 * claude executor. Sorted for determinism.
 */
export function executorResolvableProviders(
  catalog: ProviderCatalog,
  protocol: WireProtocol,
): string[] {
  return Object.keys(catalog)
    .filter((id) => providerServesProtocol(id, protocol, catalog))
    .sort();
}

/**
 * Validate a credential's baseUrl override. The worker sends the decrypted
 * API key to this URL, so a lax value is a key-exfiltration/SSRF channel:
 * https only, no embedded credentials/query/fragment, a real public DNS name
 * (IP literals, localhost, and dotless internal names are rejected — WHATWG
 * URL parsing canonicalizes numeric IPv4 forms first), and, when the catalog
 * pins a host family (dashscope → .aliyuncs.com), the hostname must match.
 * The worker separately resolves the host before each step and requires every
 * address to be global-unicast. Rebind-after-check remains possible; deployments
 * that need an internal proxy configure it via worker env, which is operator-owned.
 * Returns null when valid, else a short reason.
 */
export function validateProviderBaseUrl(
  provider: string,
  raw: string,
  catalog: ProviderCatalog = PROVIDER_CATALOG,
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  if (url.protocol !== "https:") return "must use https";
  if (url.username !== "" || url.password !== "") return "must not embed credentials";
  if (url.search !== "" || url.hash !== "") return "must not carry a query or fragment";
  const host = url.hostname.replace(/\.$/, "");
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) {
    return "must be a DNS hostname, not an IP address";
  }
  if (host === "localhost" || !host.includes(".")) return "must be a public DNS hostname";
  const entry = catalog[provider];
  if (entry) {
    const allowed = entry.baseUrlHosts?.some((pin) =>
      pin.startsWith(".") ? host.endsWith(pin) : host === pin,
    );
    if (entry.baseUrlHosts && !allowed) {
      return `host must be ${entry.baseUrlHosts.join(" or ")}`;
    }
  }
  return null;
}
