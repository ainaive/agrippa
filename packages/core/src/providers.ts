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
   * endpoint. A project credential's baseUrl overrides these for all
   * protocols (regional endpoints, e.g. dashscope-intl).
   */
  baseUrls: Partial<Record<WireProtocol, string>>;
  /**
   * "project": the provider only works with a per-project credential — a slot
   * cannot resolve to it without one (submit fails actionably). "env": the
   * worker's process env is a legitimate deployment-wide fallback.
   */
  auth: "project" | "env";
};

export const PROVIDER_CATALOG = {
  anthropic: { label: "Anthropic", baseUrls: {}, auth: "env" },
  openai: { label: "OpenAI", baseUrls: {}, auth: "env" },
  dashscope: {
    label: "Aliyun Bailian (DashScope)",
    baseUrls: {
      // Beijing-region endpoints; international deployments override via the
      // credential's baseUrl (Singapore uses a workspace-scoped host).
      anthropic: "https://dashscope.aliyuncs.com/apps/anthropic",
      openai: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    },
    auth: "project",
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
