# ADR-0011: Codex CLI Executor and the Platform-Side Git Write-Path

- Status: accepted · Date: 2026-07-23

## Context

The requirement-delivery workflow (ADR-0010) puts two agents in one run: an implementer and a reviewer, on different engines. That requires (a) a second real executor behind the ADR-0005 interface, and (b) a decision about who pushes the branch and opens the pull request — the PR link is a **contract-required** artifact, so "the agent does it via an optional github MCP server" (the bug-localize-fix pattern) is not reliable enough.

## Decision

1. **`packages/executor-codex`** wraps the OpenAI Codex CLI's non-interactive mode (`codex exec --json`, JSONL event shapes pinned against codex-cli 0.145.0 by live probes; samples in the package README). One step = one invocation; `thread_id` is the same-step resume handle; the cached-inclusive `input_tokens` is split so pricing never double-charges cache reads. Capabilities: `{ subagents: false, mcp: false, skills: false, resume: true, streaming: true }` — the compiler and submit-time `resolveAgentBindings` reject steps that assign unsupported resources to a codex-bound slot, against the static `EXECUTOR_CATALOG` in core (the API never imports executor packages; the worker asserts its registrations against the catalog at boot).
2. **Containment via the existing seams where possible, documented gaps where not.** The subprocess environment goes through `executor-core`'s allow-list scrubber (OPENAI_API_KEY/CODEX_API_KEY join the provider-auth allow-list and the redaction set). File containment maps `toolPolicy.access` onto Codex's native OS sandbox (macOS Seatbelt / Linux Landlock): `read-only` for reviewer-style steps, `workspace-write` with command network access disabled otherwise, `approval_policy=never` so nothing can escalate interactively. **Not enforceable:** the per-tool-call `evaluateToolCall` hook — `codex exec` exposes no callback surface, so per-tool allow/deny lists do not apply to this executor. Read-only steps cannot write artifact files; a declared json artifact is synthesized from the final message's fenced json block and validated downstream by the shared interaction schemas.
3. **Platform-side SCM.** Three system actions — `git.branch`, `git.push`, `pr.open` — run through a new `EngineDeps.scm` seam (`GitScmService` in the worker): branch creation with `checkout -B` (idempotent across retries), push against a credential-injected URL that never lands in `.git/config`, PR/MR creation via the GitHub/GitLab REST API from the project-scoped repo connection. The engine composes the PR body and appends an explicit **waiver section** — review findings the team accepted instead of fixing, with who accepted them, accumulated across review rounds (a later fix decision supersedes an earlier acceptance of the same finding). The work branch is platform-named (`agrippa/run-<n>`) and persisted (`runs.work_branch`), so agents are told to commit to the current branch and never branch themselves.

## Alternatives considered

- **Agent-driven PR via github MCP** (status quo for bug-localize-fix): zero new infra, but depends on an admin-registered optional server and on agent behavior — unacceptable for a contract-required output. Kept for that template; migrating it is a noted follow-up.
- **A codex "API executor"** (drive the Responses API directly): re-implements the agent loop the CLI already provides — the exact trade ADR-0005 declined for Claude.
- **Reimplementing containment in the adapter** instead of using Codex's sandbox: ADR-0009 exists because scattered enforcement rots; where the seam cannot reach, we document the boundary rather than fake it.

## Consequences

- A third registered executor id (`codex-cli`), registered only when the CLI probe and auth succeed; templates referencing it still validate everywhere.
- Reviewer steps in the delivery template run with the workspace's `readWrite` access today (access is per-workspace, not per-step); the reviewer is instructed not to modify code, and per-step access modes are future hardening.
- `pr.open` supports github and gitlab providers; `generic-git` pushes but fails PR creation with an actionable error.
- OpenAI model rows join the seed (ids/pricing to be verified per deployment; registry rows are admin-editable), and per-slot model resolution filters by the executor's provider list so a codex slot without a granted openai model fails at submit, not mid-run.
