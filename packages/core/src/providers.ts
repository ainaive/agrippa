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
   * Allowed hostname suffixes for a credential's baseUrl override. Absent =
   * any public https host. The worker sends the decrypted key to this URL,
   * so providers with a known host family pin it (SSRF/exfiltration guard).
   */
  baseUrlHosts?: readonly string[];
};

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
    baseUrlHosts: [".aliyuncs.com"],
  },
} as const satisfies Record<string, ProviderCatalogEntry>;

export type ProviderId = keyof typeof PROVIDER_CATALOG;

export function isProviderId(id: string): id is ProviderId {
  return id in PROVIDER_CATALOG;
}

/** Auth policy for a provider; unknown providers fall back to worker env. */
export function providerAuthPolicy(id: string): "project" | "env" {
  return isProviderId(id) ? PROVIDER_CATALOG[id].auth : "env";
}

/** Catalog default base URL for a provider on a given wire protocol. */
export function providerDefaultBaseUrl(id: string, protocol: WireProtocol): string | undefined {
  if (!isProviderId(id)) return undefined;
  const entry: ProviderCatalogEntry = PROVIDER_CATALOG[id];
  return entry.baseUrls[protocol];
}

/**
 * Whether the provider is known to serve the given wire protocol. Providers
 * with catalog defaults serve exactly those protocols; unknown providers and
 * catalog entries without defaults (anthropic, openai — native endpoints)
 * carry no restriction. Used to keep a credential's single baseUrl override
 * from leaking onto a protocol the provider does not speak.
 */
export function providerServesProtocol(id: string, protocol: WireProtocol): boolean {
  if (!isProviderId(id)) return true;
  const entry: ProviderCatalogEntry = PROVIDER_CATALOG[id];
  return Object.keys(entry.baseUrls).length === 0 || entry.baseUrls[protocol] !== undefined;
}

/**
 * Validate a credential's baseUrl override. The worker sends the decrypted
 * API key to this URL, so a lax value is a key-exfiltration/SSRF channel:
 * https only, no embedded credentials/query/fragment, a real public DNS name
 * (IP literals, localhost, and dotless internal names are rejected — WHATWG
 * URL parsing canonicalizes numeric IPv4 forms first), and, when the catalog
 * pins a host family (dashscope → .aliyuncs.com), the hostname must match.
 * DNS-rebinding/resolve-time checks are out of scope — deployments that need
 * an internal proxy configure it via worker env, which is operator-owned.
 * Returns null when valid, else a short reason.
 */
export function validateProviderBaseUrl(provider: string, raw: string): string | null {
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
  if (isProviderId(provider)) {
    const entry: ProviderCatalogEntry = PROVIDER_CATALOG[provider];
    if (entry.baseUrlHosts && !entry.baseUrlHosts.some((suffix) => host.endsWith(suffix))) {
      return `host must end with ${entry.baseUrlHosts.join(" or ")}`;
    }
  }
  return null;
}
