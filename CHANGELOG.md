# Changelog

All notable changes to Agrippa are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security

- **Executor isolation seam** — one enforceable place (`packages/executor-core/isolation.ts`) decides every tool call and scrubs the subprocess environment. Read-only workspaces now actually deny shell and confine writes to the artifact directory; read-write workspaces confine writes to the workspace with a boundary-safe check (the previous `startsWith` let a sibling `<workspace>-evil` path through, and `Bash` bypassed the check entirely). **Reads (Read/Grep/Glob) are confined to the workspace too**, so the agent can't read `/proc/self/environ`, another run's directory, or the shared artifact store. The SDK subprocess environment is **allow-listed** — only the SDK auth variables and a fixed set of system essentials pass through, so platform secrets, DSNs, and injection vectors like `NODE_OPTIONS` are all dropped — with the OS `sandbox` enabled where available (bubblewrap installed in the worker image), `strictMcpConfig`, and repo-supplied `.claude`/`.mcp.json` removed after checkout so a checked-out repository can't inject hooks or permission overrides. The worker image runs as a non-root user with `/app` kept root-owned.
- **Event-payload secret redaction** — known secret values (the provider key, resolved MCP tokens) are redacted from every event before it is persisted or streamed over SSE, so a secret the agent echoes into output can't leak through the timeline.
- **Artifact path containment** — artifact ingestion resolves sources through `realpath` and rejects any that escape the workspace, closing a symlink disclosure (e.g. `ln -s /proc/self/environ`) that could exfiltrate secrets or other runs' files through the download endpoint.
- **Cross-tenant resource authorization** — submission rejects a `repoConnectionId` that isn't owned by the project, and the worker loads repo connections scoped to the run's project. Optional skills/MCP servers are now grant-checked: an authorized-resource manifest is pinned onto the run at submit (required grants enforced, optional resources included only when granted) and the worker resolves resources only from it, so a project without a grant can no longer receive the platform's global credential (e.g. the shared GitHub token).

### Fixed

- **Crash recovery for no-retry steps** — a worker that died mid-step no longer silently skips (or spuriously fails) a step without template retries; the crashed attempt no longer consumes the retry budget, and the executor session is carried onto the recovery attempt so resume works.
- **Atomic run lifecycle** — one `finalizeRun` owns every terminal transition: a single transaction does the status CAS (requiring `cancel_requested = false` for a success, so a late cancel wins atomically), finishedAt/totals, and the terminal event. Both the engine and the worker's retry-exhaustion path use it, so a run is never half-finalized and a queued run whose setup threw transitions `queued → failed` (now legal) with a terminal event instead of stranding. Event sequence numbers come from an atomic per-run counter (`runs.next_event_seq`), and approval decisions are CAS on `pending` with the sweeper re-enqueuing any run left paused by a lost resume enqueue.
- **Quota accounting** — the engine now counts the same monthly window as the submit gate, excludes the run's own spend from the headroom it checks (no double-count on resume), re-reads project usage at each step boundary so concurrent runs can't jointly overspend, and restores per-phase spend on resume so per-phase budgets aren't reset by a crash.
- **Artifact output contract** — patch steps no longer hand-write the diff (the engine generates it from `git diff`); collected artifacts are validated against the step's declared keys/kinds and matched by exact filename; only the current step's own expected files are cleared before an attempt (never a recursive `rm` a `.agrippa -> /work` symlink could redirect at the shared store, and `.agrippa` is stripped at checkout); missing/empty sources don't create zero-byte rows; binary (`file`-kind) artifacts are stored byte-exact; and ingestion size-caps and streams files instead of buffering them whole.
- **Authorized resources** — `requires.skills` is validated by the compiler and enforced by the engine; `skills` resolution returns `{ resolved, missing }` like `mcpServers`, so an unavailable required skill fails the step and an unavailable optional one is skipped (rather than throwing). `scripts/backfill-manifest.ts` reconstructs the manifest for pre-migration runs from **project grants** (not the full template).
- **SSE live gap** — the events stream subscribes and *awaits* the subscription being live before replaying, and treats the bus purely as a **wake-up** that triggers an ordered Postgres replay — so the cursor advances contiguously and a dropped event can't be skipped past (even on `Last-Event-ID` reconnect) (ADR-0007).
- **Production Compose** — split into a worker-only `workspaces` volume and a shared `artifacts` volume; the `api` runs as the non-root `bun` user and mounts only `artifacts` (consistent ownership whichever service initializes it) and receives `AGRIPPA_EXECUTOR` (the API chooses the executor at submit).

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
