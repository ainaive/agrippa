/**
 * Static executor catalog — the API/SPA-visible registry of agent engines.
 *
 * The API must never import executor packages (dependency direction), so the
 * catalog lives here. The worker asserts at boot that every executor it
 * registers matches its catalog entry, keeping this file honest.
 */

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
  /** Model providers this executor can drive; "*" = any granted model. */
  providers: readonly string[] | "*";
  capabilities: ExecutorCapabilityFlags;
};

export const EXECUTOR_CATALOG = {
  "claude-agent-sdk": {
    label: "Claude Code",
    providers: ["anthropic", "dashscope"],
    capabilities: { subagents: true, mcp: true, skills: true, resume: true, streaming: true },
  },
  "codex-cli": {
    label: "OpenAI Codex",
    // dashscope is claude-only for now: Codex CLI ≥0.122 removed wire_api
    // "chat", and Bailian's Responses API doesn't yet cover the seeded Qwen
    // models (ADR-0013 amendment).
    providers: ["openai"],
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

/** True when the executor can serve models from the given provider. */
export function executorSupportsProvider(entry: ExecutorCatalogEntry, provider: string): boolean {
  return entry.providers === "*" || entry.providers.includes(provider);
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
