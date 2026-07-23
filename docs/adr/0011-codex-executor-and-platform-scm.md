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

## Addendum (2026-07-23, post-review)

- Every `codex exec` invocation passes `--ignore-user-config` and `--ignore-rules`: without them, `~/.codex/config.toml` could add MCP servers and repo-shipped execpolicy rules could alter command policy, bypassing the governance the catalog's `mcp: false` claims. Auth still resolves from `CODEX_HOME` per the CLI docs, and the boot probe checks `codex exec --help` for the flags — an older CLI is refused registration rather than failing every step (or worse, silently running unisolated).
- `pr.open` recovers duplicates: on GitHub 422 / GitLab 409 the service looks up the existing open PR by head/base and returns its URL — safe because work branches are unique per run (`agrippa/run-<n>-<shortId>`).

## Consequences

- A third registered executor id (`codex-cli`), registered only when the CLI probe and auth succeed; templates referencing it still validate everywhere.
- Reviewer steps in the delivery template run with the workspace's `readWrite` access today (access is per-workspace, not per-step); the reviewer is instructed not to modify code, and per-step access modes are future hardening.
- `pr.open` supports github and gitlab providers; `generic-git` pushes but fails PR creation with an actionable error.
- OpenAI model rows join the seed (ids/pricing to be verified per deployment; registry rows are admin-editable), and per-slot model resolution filters by the executor's provider list so a codex slot without a granted openai model fails at submit, not mid-run.

## Addendum (2026-07-23, review round 3)

- **Per-step access shipped; the reviewer is read-only.** The Consequences bullet below ("per-step access modes are future hardening") is superseded: v2 agent steps take an optional `access:` override and the delivery template's review step declares `readOnly`. This is an evidence-integrity decision as much as a containment one — whatever a reviewer writes can never be re-reviewed before publish, so the only sound modes are "reviewer cannot write" plus a publish-time guard: `git.push` fails the run (`contract_violation`) when the workspace no longer matches the stored patch evidence. Drift is never silently refreshed or republished; refreshed evidence is not approved evidence.
- **Platform git distrusts the workspace.** Platform-side git (diff, finalizing commit, credentialed push) executes in a directory the agent could write — including `.git/**` — so it runs with the executor allow-list env scrub (no platform secrets in any hook/filter's environment), never loads global/system gitconfig, neutralizes `core.hooksPath`/`core.fsmonitor` on every invocation, and restores repo-local `.git/config` from a provision-time snapshot before diff/push. The snapshot and the clone-base SHA live in a per-run **platform sidecar** outside the agent-writable tree, which also makes the base SHA immune to agent ref tampering. Residual risk (shell escaping a degraded OS sandbox reaching the sidecar) remains the container-layer boundary of ADR-0009.
- **Lost workspaces fail fast.** Workspaces are host-local; a resume landing on a host without the checkout fails with `workspace_lost` instead of running against an empty directory. Cross-host workspace migration / host-affinity routing is future work.
