/**
 * Static executor catalog — the API/SPA-visible registry of agent engines.
 *
 * The API must never import executor packages (dependency direction), so the
 * catalog lives here. The worker asserts at boot that every executor it
 * registers matches its catalog entry, keeping this file honest.
 */
import { executorResolvableProviders, type ProviderCatalog, type WireProtocol } from "./providers";

/**
 * What an executor's resume support is actually worth (ADR-0018 Decision 5).
 * "Accepts a resume argument" and "can prove the context loaded" are different
 * properties, and only the second is worth anything to the engine:
 *
 * - `none` — cannot continue a conversation. Never handed a session id.
 * - `unverified` — takes a session id but cannot tell a continued session from
 *   a fresh one. Also never handed one: an unprovable resume presents a silent
 *   fresh start as continuity, which is strictly worse than an honest restart.
 * - `verified` — reports, per invocation, whether the session really resumed.
 *   Only this one is trusted with a session id.
 *
 * The values are ORDERED, and that ordering is load-bearing: the worker's
 * boot-time parity check asks whether an executor delivers at least what the
 * catalog promises, and a boolean implication would read `none` as satisfying
 * a promise of `verified` because both are truthy.
 */
export const RESUME_CAPABILITIES = ["none", "unverified", "verified"] as const;
export type ResumeCapability = (typeof RESUME_CAPABILITIES)[number];

/** Position in RESUME_CAPABILITIES — higher delivers everything below it. */
export function resumeRank(capability: ResumeCapability): number {
  return RESUME_CAPABILITIES.indexOf(capability);
}

export type ExecutorCapabilityFlags = {
  subagents: boolean;
  mcp: boolean;
  skills: boolean;
  /** Three-valued, deliberately not a boolean — see ResumeCapability. */
  resume: ResumeCapability;
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
    // verified: the SDK's init message carries the session id it actually
    // opened, so "is this the session we asked for?" is a comparison
    capabilities: { subagents: true, mcp: true, skills: true, resume: "verified", streaming: true },
  },
  "codex-cli": {
    label: "OpenAI Codex",
    // dashscope is claude-only for now: Codex CLI ≥0.122 removed wire_api
    // "chat", and Bailian's Responses API doesn't yet cover the seeded Qwen
    // models (ADR-0013 amendment).
    protocol: "openai",
    // verified: the thread_started event announces the thread the CLI opened
    capabilities: {
      subagents: false,
      mcp: false,
      skills: false,
      resume: "verified",
      streaming: true,
    },
  },
  fake: {
    label: "Demo",
    providers: "*",
    // the demo executor holds no conversation at all; compliance fixtures bind
    // FakeExecutor instances that deliver more, which the parity rule allows
    capabilities: { subagents: true, mcp: true, skills: true, resume: "none", streaming: true },
  },
} as const satisfies Record<string, ExecutorCatalogEntry>;

export type ExecutorId = keyof typeof EXECUTOR_CATALOG;

export function isExecutorId(id: string): id is ExecutorId {
  // hasOwn, not `in`: the prototype chain would admit "constructor" etc. —
  // ids that pass every downstream charset check but have no catalog entry
  return Object.hasOwn(EXECUTOR_CATALOG, id);
}

/**
 * The first capability an executor delivers less of than its catalog entry
 * promises, or null when it delivers at least everything promised. The worker
 * runs this at boot over every executor it registers: the catalog is what the
 * API and SPA trust when they validate a template, so an executor drifting
 * BELOW it lets a template pass validation and fail at runtime. Delivering
 * MORE is fine and deliberate — compliance fixtures bind fakes that do.
 *
 * `resume` is compared by rank, not truthiness (ADR-0018 Decision 5). Written
 * as a boolean implication — as this was, when the flag was one — it reads
 * `"none"` as satisfying a promise of `"verified"`, because both are truthy:
 * capability drift sailing through the check built to stop it.
 */
export function catalogCapabilityShortfall(
  promised: ExecutorCapabilityFlags,
  delivered: ExecutorCapabilityFlags,
): keyof ExecutorCapabilityFlags | null {
  for (const flag of Object.keys(promised) as Array<keyof ExecutorCapabilityFlags>) {
    const ok =
      flag === "resume"
        ? resumeRank(delivered.resume) >= resumeRank(promised.resume)
        : !promised[flag] || Boolean(delivered[flag]);
    if (!ok) return flag;
  }
  return null;
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
