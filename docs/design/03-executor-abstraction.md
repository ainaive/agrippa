# 03 — Executor Abstraction

> Status: draft for review · Last updated: 2026-07-17

The `Executor` interface (`@agrippa/executor-core`) is the hinge of the architecture: everything above it (templates, engine, API, UI) is engine-agnostic; everything below it is engine-specific. First implementation: **Claude Agent SDK** (`@agrippa/executor-claude`). Granularity decision: **one step = one executor invocation** ([ADR-0005](../adr/0005-executor-step-granularity.md)).

## Interface

```ts
export interface Executor {
  readonly id: string;                          // "claude-agent-sdk"
  readonly capabilities: ExecutorCapabilities;  // { subagents, mcp, skills, resume, streaming }

  executeStep(
    req: StepExecutionRequest,
    ctx: ExecutionContext,
  ): AsyncIterable<ExecutorEvent>;              // must end with step.completed | step.failed
}

export interface StepExecutionRequest {
  runId: string;
  stepId: string;
  instructions: string;             // interpolated step prompt
  systemPrompt: string;             // Faber persona + platform preamble
  model: ResolvedModel;             // { provider, providerModelId, params }
  subagents: SubagentSpec[];        // { id, description, prompt, tools, model: ResolvedModel }
  skills: ResolvedSkill[];          // { slug, version, localPath } — materialized on disk by the worker
  mcpServers: ResolvedMcpServer[];  // { slug, transport, command|url, env/headers } — secrets resolved
  toolPolicy: ToolPolicy;           // allow/deny tool lists + path constraints
  limits: { maxTurns: number; maxOutputTokens?: number };
  workspaceDir: string;             // per-run isolated checkout / scratch dir
  resumeSessionId?: string;         // from run_steps.executor_session_id
  priorContext: PriorStepSummary[]; // outputs of earlier steps (summaries + artifact refs)
}

export interface ExecutionContext {
  signal: AbortSignal;              // cancellation ∪ timeout ∪ budget-abort (composed)
  budget: BudgetMeter;              // record(usage) — throws BudgetExceededError at the cap
  secrets: SecretResolver;          // lazy resolution; executor never sees the vault
  logger: Logger;
}
```

Contract rules:

1. The returned stream **must** terminate with exactly one `step.completed` or `step.failed`.
2. The executor **must** stop promptly when `ctx.signal` aborts, emitting `step.failed` with `error.code = "aborted"`.
3. The executor **must** emit `usage` events as they become known (not only at the end) — budget enforcement depends on it.
4. The executor **must not** write outside `workspaceDir` (tool policy enforces; the executor also self-constrains).
5. The executor **must not** import `@agrippa/db` or reach the database — all inputs arrive in the request; all outputs leave as events.
6. If `capabilities.resume` is true, `step.started.sessionId` must be a handle that `resumeSessionId` can later restore.

## Normalized Event Schema

```ts
export type ExecutorEvent =
  | { type: "step.started"; sessionId?: string }
  | { type: "message.delta"; text: string }
  | { type: "message.completed"; role: "assistant"; text: string }
  | { type: "tool.started"; toolName: string; input: unknown; toolUseId: string }
  | { type: "tool.completed"; toolUseId: string; output: unknown; isError: boolean }
  | { type: "subagent.started"; subagentId: string }
  | { type: "subagent.completed"; subagentId: string }
  | { type: "usage"; model: string; inputTokens: number; outputTokens: number;
      cacheReadTokens: number; cacheWriteTokens: number }
  | { type: "artifact"; key: string; kind: ArtifactKind; path?: string; inline?: unknown }
  | { type: "permission.request"; toolName: string; input: unknown; requestId: string }
  | { type: "step.completed"; output: string }
  | { type: "step.failed"; error: NormalizedError };
```

The engine consumes this stream and: appends each event to `run_events` (assigning per-run `seq`), publishes it to Redis for live SSE, updates the `run_steps` projection, records `token_usage` rows, and feeds `usage` into the `BudgetMeter`. Executors know nothing about persistence or transport.

`NormalizedError` carries a stable `code` (`aborted` | `budget_exceeded` | `timeout` | `model_error` | `tool_error` | `contract_violation` | `internal`), an en/zh-localizable message key, and provider detail for debugging.

## Claude Agent SDK Mapping

`@agrippa/executor-claude` maps the request onto `query()` options:

| Template / request concept | Claude Agent SDK |
|---|---|
| `instructions` | `prompt` |
| `systemPrompt` (Faber persona) | `systemPrompt` in append mode over a minimal preset |
| `subagents` | `agents: { [id]: { description, prompt, tools, model } }` |
| `skills` | Materialized by the worker into `<workspace>/.claude/skills/<slug>/`; loaded via `settingSources: ["project"]` |
| `mcpServers` | `mcpServers` — stdio: `{command, args, env}`; http/sse: `{url, headers}` (headers via `SecretResolver` at spawn) |
| `model` | `model` per step; sub-agent `model` per agent definition |
| `toolPolicy` | `allowedTools` / `disallowedTools` + `canUseTool` callback (deny writes outside workspace, or emit `permission.request`) |
| Streaming | `includePartialMessages: true` → `message.delta` |
| Usage | per-message + result usage → `usage` events |
| Resume | capture `session_id` from init → `step.started.sessionId`; restore via `resume` option |
| `limits.maxTurns` | `maxTurns`; duration via `AbortSignal.timeout` composed into `ctx.signal` |

**Artifacts convention**: the step prompt instructs the agent to write declared artifacts to `<workspace>/.agrippa/artifacts/<key>`. The executor scans that directory after a successful step and emits an `artifact` event **only for the keys the step contracted to produce**, using the declared kind — so files left by earlier steps aren't re-emitted, and an uncontracted or mismatched artifact can't slip through. `patch`-kind artifacts are excluded from both the prompt and the scan: they are generated by the *engine* (not the executor) via `git diff` against the checkout base after the step completes — uniform across executors. The engine additionally refuses to store a source that produced no bytes, so a required-but-missing artifact fails the output contract rather than becoming an empty row.

**`priorContext`**: each completed step's final output (plus artifact keys) is summarized and prepended to subsequent steps' prompts by the engine. Steps are separate SDK sessions by default; `resumeSessionId` exists for crash-recovery resume (the engine carries a crashed attempt's session onto its recovery attempt), not for cross-step continuity (a deliberate v1 simplification — revisit if prompt-cache economics or context continuity demand same-session phases).

## Where Execution Runs & Sandboxing (M1 posture)

All executor work happens in the **worker container** (`apps/worker`), one run per worker slot. Containment lives behind one **isolation seam** (`packages/executor-core/isolation.ts` — `evaluateToolCall`, `isWithin`, `buildScrubbedEnv`); the SDK adapter must route every tool decision and the subprocess environment through it rather than reimplementing checks inline (ADR-0009):

- Each run gets a throwaway workspace `/work/runs/<runId>`, deleted after terminal state (configurable retention for debugging).
- Git credentials are injected per-run into the clone URL and scrubbed from the remote immediately afterward; they never persist in `.git/config`. They are still passed as a clone argument today — moving to a workspace-scoped credential helper is follow-up work.
- Tool policy is enforced for **every** file-touching tool — writes (Write/Edit/NotebookEdit) *and* reads (Read/Grep/Glob) — with a boundary-safe containment check (not a `startsWith` prefix) plus a symlink-real check: `readOnly` workspaces deny shell and confine writes to `.agrippa/artifacts`; reads and writes are confined to the workspace, so the agent can't `Read /proc/self/environ`, another run's `/work/runs/<id>`, or the shared artifact store. The static layer cannot bound what a shell command reads or writes in a read-write workspace — that is the OS sandbox's job (below).
- The agent subprocess runs with a **scrubbed environment** (`buildScrubbedEnv`): the master `AGRIPPA_SECRET_KEY` and datastore URLs are removed while the Anthropic auth vars the SDK needs are kept. The SDK `sandbox` (bubblewrap) is enabled where the host supports it, `strictMcpConfig` ignores repo `.mcp.json`, and the worker strips repo-supplied `.claude` settings/hooks at checkout so a checked-out repository can't inject hooks or permission overrides. The worker image runs as a non-root user.
- MCP secrets resolve lazily at server spawn and are not logged; `run_events` payloads are redacted against known secret values (the provider key, resolved MCP tokens) before they are persisted or streamed (`SecretRedactor`). Note: the provider `ANTHROPIC_API_KEY` still lives in the agent subprocess env (the SDK needs it) and one worker UID is shared across runs — keeping the key out of the subprocess and isolating runs from each other require the container layer below.

**Explicitly deferred**: per-run container/micro-VM isolation and a fully non-root, network-egress-restricted sandbox. The isolation seam localizes this — the engine hands the executor a `workspaceDir`, an `access` mode, and a signal; whether that directory lives in the worker's filesystem or a jailed container is invisible above the interface. The static containment plus env-scrub plus OS sandbox is adequate for a trusted org running semi-trusted repositories; hostile multi-tenant inputs need the container layer, which is risk #2 in [00-overview](00-overview.md).

## FakeExecutor — the Compliance Contract

`@agrippa/executor-core` ships a `FakeExecutor` that replays a scripted `ExecutorEvent[]` with configurable delays, mid-stream failures, abort latency, and usage patterns. The **engine integration suite runs entirely against it** (approval pause/resume, budget abort, crash-resume, cancellation mid-step) and doubles as the compliance spec any future executor must satisfy. It is built **before** the Claude executor — the SDK executor then has a contract to conform to, not the other way around.
