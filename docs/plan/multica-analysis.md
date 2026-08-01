# Multica — competitive analysis and what Agrippa takes from it

> Analyzed 2026-08-01 from a local checkout (`~/workspace/github/multica`, HEAD `8df7549d8`, v0.4.16). File references below point into that repo unless prefixed with a path in this one. Conclusions feed [m2-plan.md](m2-plan.md).

## What Multica is

Multica ("multica.ai", source-available under Apache-2.0 plus commercial/branding conditions) is a **Linear-style issue tracker where coding agents are first-class assignees**. You assign an issue to an agent the way you assign a colleague; a daemon on the *user's* machine detects installed agent CLIs — 18 of them (Claude Code, Codex, Copilot, Cursor, OpenCode, Qwen, several ACP-protocol CLIs) — wraps them behind one Go interface (`server/pkg/agent/agent.go`), runs the task in a per-task git worktree, streams the transcript back, comments on the issue, and opens PRs. The server **never calls LLMs for agent work**; it only orchestrates, persists, and broadcasts.

Maturity signals: 4,470 commits (611 in the 30 days before analysis), ~50 % test-file ratio in both Go and TS, 4 UI locales, Helm chart + Compose + Homebrew, Electron desktop + Expo mobile, a 164-page docs site, and it self-hosts its own issue tracking (commit subjects carry `MUL-####` references).

## The core contrast

The two products are near-complements: each is strong exactly where the other is silent.

| | Multica | Agrippa |
|---|---|---|
| Unit of work | Issue, assigned conversationally | Typed task from a scenario catalog |
| Coordination | Emergent — comments wake agents; squads route to a leader agent that delegates via sub-issues with stage barriers | Explicit — versioned templates: phases, steps, checkpoints, bounded loops (ADR-0010) |
| Human-in-the-loop | Issue-level (comment / stop / review the PR); agents run fully autonomous (`--permission-mode bypassPermissions`, `--yolo`) | Structured checkpoints: approvals, input forms, review-gate findings |
| Governance | Usage *reporting* only — no limits, no gates, no audit trail | Enforced token quotas, RBAC, audit log, pinned resource manifests |
| Compute & trust | BYO — daemon on the user's machine with the user's credentials (sidesteps sandboxing) | Central workers (hardened isolation is the open M2 gap, [08-deployment](../design/08-deployment.md)) |
| Code review | None in-app; delegates to the PR and mirrors CI status | Review-gate findings + verified snapshot publication (ADR-0012) |

Multica has no workflow engine, no approval gates, no enforced limits, and no diff UI. Agrippa has no steering, no triggers, no notifications, and no working programmatic API (the `api_keys` schema exists; the middleware doesn't). Agrippa's differentiators are real and worth defending rather than trading for Multica's breadth.

## The headline steal: the runtime model

Multica's execution substrate: a daemon on each user machine registers with the server, reports which agent CLIs it has (`agent_runtime` rows per CLI × machine × workspace), heartbeats, long-polls a claim endpoint (plus WebSocket wakeups), and runs claimed tasks locally — per-task worktrees off a bare-clone cache, per-task scoped auth tokens, idle watchdogs, GC. The server routes work to runtimes by capability and ownership.

**Why this is the right steal for Agrippa** — it solves the two hardest open problems at once:

- **Sandboxing.** Agrippa's central workers currently mean "trusted orgs only" ([08-deployment](../design/08-deployment.md)). With BYO compute the blast radius moves to the machine of the team that owns the work — Multica's deliberate posture.
- **Credentials & cost.** Users' existing CLI logins and subscriptions just work; the platform no longer needs to hold provider API keys for those runs.

And it is an **evolution, not a rewrite**: the worker is already a claim-execute-report loop; executors are forbidden from importing `db` (`scripts/check-deps.ts`), so the executor packages are daemon-portable by construction; `executor_registrations` and `worker_heartbeats` already exist (`packages/db/src/schema/registry.ts:219,232`); per-executor routing and the ADR-0009 execution lease are already listed as future work in [03-executor-abstraction](../design/03-executor-abstraction.md).

**The one deliberate divergence: execution decentralizes, verification does not.** Multica gave up governance entirely to get autonomy. Agrippa keeps the server as the enforcement point: daemons *report* usage, the server *enforces* quotas at step boundaries (unchanged semantics); and the platform git write-path (ADR-0011/0012 — evidence == published tree) survives because daemons upload the sha256'd patch/bundle evidence artifacts that already exist, and the server-side SCM applies and pushes. Position: **execution goes to where the code and credentials live; governance stays on the platform.** Multica itself later bolted a closed-source cloud runtime fleet onto its BYO model — evidence the endgame is hybrid from either direction — so central workers remain one kind of runtime, not a casualty.

## Feature learnings

### Triggers / autopilots

Multica's autopilots (`autopilot` + `autopilot_trigger` tables) fire on cron (timezone-aware, with preview), inbound webhook (per-trigger token + signing secret + rotation), or manual API; a concurrency policy (skip / queue / replace) governs overlap, and a durable `webhook_delivery` queue gives dedupe, leases, payload inspection, and replay. Agrippa translation: cron-scheduled task submission (pg-boss already does cron) + webhook triggers + finishing API-key auth. `pm.weekly-report` is the obvious first consumer.

### Notifications

Multica has an inbox (recipients can be members *or agents*), severity levels, auto-subscription, email (Resend/SMTP), and Slack/Feishu channel bots. Agrippa's gap hurts more than Multica's would: runs *block* on checkpoints, and an unnoticed checkpoint just times out. Minimal translation: outbound webhook on `waiting_approval` + terminal states + runtime-offline, with a Feishu/DingTalk card formatter for the CN deployment — no email infrastructure needed.

### Follow-up steering

Multica stores `session_id` + `work_dir` per (agent, issue); a new comment wakes the agent and bursts **coalesce** into one run (`coalesced_comment_ids`); if session resume is rejected, it retries once fresh with a **context-loss disclosure prepended to the prompt** so the agent doesn't fake continuity (`server/internal/daemon/prompt.go`), and backends that can't detect rejection fail closed. Agrippa translation: a "follow-up" action on a finished run that resumes the executor session in the same workspace with a user message — the only conversational surface Agrippa needs, without becoming chat-first.

### Agent-facing platform surface

Multica agents talk back through the `multica` CLI (`issue get`, `comment add`, `attachment upload`, …) authenticated by a **per-task scoped token** minted at dispatch, guided by 8 built-in skills that teach the platform itself — each skill carrying a source-map doc that must be updated in the same PR as the behavior it describes. Agrippa translation (later): a per-run scoped token + tiny CLI/HTTP surface (post artifact, report progress, answer checkpoint) would make the platform executor-agnostic. The Phase-B daemon tokens lay the groundwork.

### Craft (cheap to adopt, no product surface)

- **Failure taxonomy**: ~24 typed failure reasons split platform vs `agent_error.*`; auto-retry only transient classes; idle watchdogs including "semantic inactivity"; a server-side sweeper for orphaned runs/runtimes.
- **Prompt-cache discipline**: the runtime brief written into the workdir is byte-identical every run; volatile per-turn context is appended to the user prompt, never the brief.
- **Docs-as-contract**: non-obvious code carries the ticket reference and a rationale paragraph; behavior changes must update the matching skill/source-map in the same PR.

## What not to copy

- **18-backend breadth.** Agrippa's compliance-suite depth (FakeExecutor as the contract) beats breadth; add executors on demand.
- **Full agent autonomy** (`bypassPermissions` everywhere) — contradicts the governance thesis that is Agrippa's reason to exist.
- **Chat-first UX wholesale**, desktop/mobile apps, marketplace — different product, different stage.
- **The no-FK schema convention** (all referential integrity application-level) — an operational choice for their migration velocity, not a virtue to import.

## Where Agrippa is ahead — defend these

- Versioned immutable orchestration templates with checkpoints and bounded loops (ADR-0006/0010).
- *Enforced* usage limits and quotas at step boundaries (Multica only measures).
- The verified git publication path + in-app review-gate findings (Multica has no diff UI at all).
- Audit log, RBAC, pinned resource manifests, retry-re-resolution semantics (ADR-0014).
