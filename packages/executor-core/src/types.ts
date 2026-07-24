import type { ArtifactKind } from "@agrippa/core";
import type { WorkspaceAccess } from "./isolation";

/**
 * The Executor contract (docs/design/03-executor-abstraction.md, ADR-0005).
 * One step = one executor invocation. Executors never touch the database —
 * everything arrives in the request, everything leaves as events.
 */

export type ResolvedModel = {
  provider: string;
  providerModelId: string;
  /** Registry id, carried through for usage attribution. */
  modelId?: string;
  params?: Record<string, unknown>;
};

export type SubagentSpec = {
  id: string;
  description: string;
  prompt: string;
  tools: string[];
  model: ResolvedModel;
};

export type ResolvedSkill = {
  slug: string;
  version: string;
  /** Directory on disk, materialized by the worker before the step runs. */
  localPath: string;
};

export type ResolvedMcpServer =
  | {
      slug: string;
      transport: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
    }
  | { slug: string; transport: "http" | "sse"; url: string; headers: Record<string, string> };

export type ToolPolicy = {
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Absolute path writes must stay within (the run workspace). */
  writeRoot: string;
  /**
   * Repo access declared by the template workspace. `readOnly` confines writes
   * to the artifact directory and forbids shell; `readWrite` allows both within
   * the workspace. Enforced by evaluateToolCall in ./isolation.
   */
  access: WorkspaceAccess;
};

export type PriorStepSummary = {
  stepId: string;
  output: string;
  artifactKeys: string[];
};

/**
 * Project-scoped provider credential, resolved by the engine at step build.
 * Absent = the worker's env auth applies. Executors map this onto their own
 * auth variables via overlayProviderAuth (./isolation) — the request stays
 * executor-agnostic.
 */
export type ProviderAuth = {
  provider: string;
  apiKey: string;
  /** Explicit endpoint override; absent = the provider catalog default. */
  baseUrl?: string;
};

export type StepExecutionRequest = {
  runId: string;
  stepId: string;
  /** Loop iteration this step belongs to; 1 outside loops. */
  iteration?: number;
  /** Agent slot the step is bound to (agrippa/v2 templates). */
  agentSlot?: string;
  instructions: string;
  systemPrompt: string;
  model: ResolvedModel;
  /** Per-project provider credential; absent = worker env fallback. */
  providerAuth?: ProviderAuth;
  subagents: SubagentSpec[];
  skills: ResolvedSkill[];
  mcpServers: ResolvedMcpServer[];
  toolPolicy: ToolPolicy;
  limits: { maxTurns: number; maxOutputTokens?: number };
  workspaceDir: string;
  resumeSessionId?: string;
  priorContext: PriorStepSummary[];
  /** Artifact keys this step must produce (from the template contract). */
  expectedArtifacts: Array<{ key: string; kind: ArtifactKind }>;
};

export type NormalizedErrorCode =
  | "aborted"
  | "budget_exceeded"
  | "timeout"
  | "model_error"
  | "tool_error"
  | "contract_violation"
  | "approval_rejected"
  | "internal";

export type NormalizedError = {
  code: NormalizedErrorCode;
  message: string;
  detail?: unknown;
};

export type UsageDelta = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type ExecutorEvent =
  | { type: "step.started"; sessionId?: string }
  | { type: "message.delta"; text: string }
  | { type: "message.completed"; role: "assistant"; text: string }
  | { type: "tool.started"; toolName: string; input: unknown; toolUseId: string }
  | { type: "tool.completed"; toolUseId: string; output: unknown; isError: boolean }
  | { type: "subagent.started"; subagentId: string }
  | { type: "subagent.completed"; subagentId: string }
  | ({ type: "usage" } & UsageDelta)
  | { type: "artifact"; key: string; kind: ArtifactKind; path?: string; inline?: unknown }
  | { type: "permission.request"; toolName: string; input: unknown; requestId: string }
  | { type: "step.completed"; output: string }
  | { type: "step.failed"; error: NormalizedError };

export type SecretResolver = (ref: string) => Promise<string>;

export type Logger = {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
};

export type ExecutionContext = {
  /** Cancellation ∪ timeout ∪ budget-abort, composed by the engine. */
  signal: AbortSignal;
  budget: BudgetRecorder;
  secrets: SecretResolver;
  logger: Logger;
};

/** The slice of BudgetMeter executors see. */
export type BudgetRecorder = {
  record(usage: UsageDelta & { costUsd: number }): void;
};

export type ExecutorCapabilities = {
  subagents: boolean;
  mcp: boolean;
  skills: boolean;
  resume: boolean;
  streaming: boolean;
};

export interface Executor {
  readonly id: string;
  readonly capabilities: ExecutorCapabilities;
  /**
   * Providers this executor instance can authenticate from the worker's own
   * env (captured at construction). When defined, the engine defers a run —
   * before claiming it — whose resolution needs an env-policy provider that
   * is neither listed here nor covered by a project credential, so a keyless
   * worker never claims work it would fail mid-run. undefined = no gating
   * (fake/demo/custom executors).
   */
  readonly envAuthProviders?: readonly string[];
  /** Must terminate with exactly one step.completed | step.failed. */
  executeStep(req: StepExecutionRequest, ctx: ExecutionContext): AsyncIterable<ExecutorEvent>;
}
