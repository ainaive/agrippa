# Changelog

All notable changes to Agrippa are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security

- **Executor isolation seam** — one enforceable place (`packages/executor-core/isolation.ts`) decides every tool call and scrubs the subprocess environment. Read-only workspaces now actually deny shell and confine writes to the artifact directory; read-write workspaces confine writes to the workspace with a boundary-safe check (the previous `startsWith` let a sibling `<workspace>-evil` path through, and `Bash` bypassed the check entirely). The SDK subprocess runs with the platform secrets (`AGRIPPA_SECRET_KEY`, datastore URLs) stripped from its environment, the OS `sandbox` enabled where available, `strictMcpConfig`, and repo-supplied `.claude`/`.mcp.json` removed after checkout so a checked-out repository can't inject hooks or permission overrides. The worker image runs as a non-root user.
- **Artifact path containment** — artifact ingestion resolves sources through `realpath` and rejects any that escape the workspace, closing a symlink disclosure (e.g. `ln -s /proc/self/environ`) that could exfiltrate secrets or other runs' files through the download endpoint.
- **Cross-tenant resource authorization** — submission rejects a `repoConnectionId` that isn't owned by the project, and the worker loads repo connections scoped to the run's project. Optional skills/MCP servers are now grant-checked: an authorized-resource manifest is pinned onto the run at submit (required grants enforced, optional resources included only when granted) and the worker resolves resources only from it, so a project without a grant can no longer receive the platform's global credential (e.g. the shared GitHub token).

### Fixed

- **Crash recovery for no-retry steps** — a worker that died mid-step no longer silently skips (or spuriously fails) a step without template retries; the crashed attempt no longer consumes the retry budget, and the executor session is carried onto the recovery attempt so resume works.
- **Atomic run lifecycle** — run status transitions are compare-and-swap on the expected status (a late finalize can't overwrite a cancellation), event sequence numbers are allocated by the database (no `max+1` collisions), and approval decisions are CAS on `pending` with the sweeper re-enqueuing any run left paused by a lost resume enqueue.
- **Quota accounting** — the engine now counts the same monthly window as the submit gate, excludes the run's own spend from the headroom it checks (no double-count on resume), and re-reads project usage at each step boundary so concurrent runs can't jointly overspend.
- **Artifact output contract** — patch steps no longer hand-write the diff (the engine generates it from `git diff` as intended), collected artifacts are validated against the step's declared keys/kinds, files from earlier steps aren't re-emitted, and missing/empty sources don't create zero-byte artifact rows.
- **SSE live gap** — the events stream subscribes before replaying history, so an event committed in the replay/subscribe window is delivered live instead of only at the terminal replay (ADR-0007).

## [0.1.0] — 2026-07-17

The M1 milestone: all three layers of the platform, working end to end.

### Added

- **Scenario layer** — three scenarios (project management, software development, test & verification) with six builtin task types; submission forms auto-generated from compiled template input schemas; bilingual (en / zh-CN) SPA with live run detail, approvals inbox, project settings, admin registries, and a template editor with dry-run validation.
- **Orchestration layer** — the `agrippa/v1` template format (YAML → zod-validated compiled JSON, immutable published versions, non-Turing-complete expression language); an engine with phases/steps, human-approval checkpoints that free worker slots, per-step retries, budget/quota enforcement, output contracts, and step-granular crash resume; pg-boss queueing with singleton-keyed sends and a reconciliation sweeper; SSE progress with gap-free `Last-Event-ID` replay (Redis optional).
- **Resource layer** — registries for models (tiered, priced), Fabri, skills, and MCP servers; head + immutable-version pattern; project-level resource grants gating submission; monthly quotas with hard-stop enforcement at submit time and mid-run.
- **Executors** — the pluggable `Executor` contract (ADR-0005) with a FakeExecutor compliance suite; the Claude Agent SDK executor (subagents, skills, MCP, resume, workspace-scoped tool policy, artifact convention); a token-free demo executor.
- **Platform** — better-auth with org/project RBAC and audit on every mutation, AES-256-GCM secrets store with write-only credentials, localized API errors, usage reporting, git workspaces with credential scrubbing, production Docker images + compose stack + GHCR release workflow.

[Unreleased]: https://github.com/ainaive/agrippa/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ainaive/agrippa/releases/tag/v0.1.0
