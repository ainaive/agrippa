/**
 * Static executor catalog — the API/SPA-visible registry of agent engines.
 *
 * The API must never import executor packages (dependency direction), so the
 * catalog lives here. The worker asserts at boot that every executor it
 * registers matches its catalog entry, keeping this file honest.
 */
import { executorResolvableProviders, type ProviderCatalog, type WireProtocol } from "./providers";

export type ExecutorCapabilityFlags = {
  subagents: boolean;
  mcp: boolean;
  skills: boolean;
  resume: boolean;
  streaming: boolean;
};

export type ExecutorCatalogEntry = {
  /** Display name, not localized — executors are product names. */
  label: string;
  /**
   * The wire protocol this executor speaks. Resolvable providers are derived
   * from the provider catalog (providers that serve this protocol), not a
   * hardcoded list — so an org-admin-registered Anthropic-compatible provider
   * is resolvable by the claude executor. Absent for `providers: "*"` (demo).
   */
  protocol?: WireProtocol;
  /** Model providers this executor can drive; "*" = any granted model (demo). */
  providers?: readonly string[] | "*";
  capabilities: ExecutorCapabilityFlags;
};

export const EXECUTOR_CATALOG = {
  "claude-agent-sdk": {
    label: "Claude Code",
    protocol: "anthropic",
    capabilities: { subagents: true, mcp: true, skills: true, resume: true, streaming: true },
  },
  "codex-cli": {
    label: "OpenAI Codex",
    // dashscope is claude-only for now: Codex CLI ≥0.122 removed wire_api
    // "chat", and Bailian's Responses API doesn't yet cover the seeded Qwen
    // models (ADR-0013 amendment).
    protocol: "openai",
    capabilities: { subagents: false, mcp: false, skills: false, resume: true, streaming: true },
  },
  fake: {
    label: "Demo",
    providers: "*",
    capabilities: { subagents: true, mcp: true, skills: true, resume: false, streaming: true },
  },
} as const satisfies Record<string, ExecutorCatalogEntry>;

export type ExecutorId = keyof typeof EXECUTOR_CATALOG;

export function isExecutorId(id: string): id is ExecutorId {
  return id in EXECUTOR_CATALOG;
}

/**
 * Sentinel executor id compiled into templates upgraded from agrippa/v1
 * (which had no executor concept). Resolved to the deployment default
 * (AGRIPPA_EXECUTOR) at task submit — never stored on a run.
 */
export const EXECUTOR_DEFAULT_SENTINEL = "__default__";

/**
 * The providers an executor can drive. For cataloged executors this is derived
 * from the provider catalog by `protocol` (see executorResolvableProviders); for
 * demo/uncataloged executors it stays `"*"` (mixed-provider, no gating) so
 * token-free demos keep working. Returns `"*"` when neither path applies.
 */
export function executorProviders(
  entry: ExecutorCatalogEntry | undefined,
  catalog: ProviderCatalog,
): readonly string[] | "*" {
  if (!entry) return "*";
  if (entry.providers === "*") return "*";
  if (entry.protocol) return executorResolvableProviders(catalog, entry.protocol);
  return "*";
}

/**
 * Whether provider-credential requirements apply to runs on this executor.
 * The fake executor calls no provider API, and uncataloged custom executors
 * resolved with no gating at submit — both stay exempt everywhere (submit,
 * retry, and the engine's per-step check) so token-free demos keep working.
 */
export function isCredentialGatedExecutor(id: string): boolean {
  return id !== "fake" && isExecutorId(id);
}
