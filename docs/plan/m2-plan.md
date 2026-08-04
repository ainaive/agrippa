# M2 Plan — Living Checklist

> Theme: **distributed runtimes + automation** — *execution goes to where the code and credentials live; governance stays on the platform.* Motivated by the [Multica analysis](multica-analysis.md). Tracks T and N are independently shippable on their own `feat/*` branches; **Phases A and B ship together as one branch + PR** (`feat/m2-remote-runtimes` — A is B's prerequisite and they tell one story; decided 2026-08-01, superseding the per-phase-branch plan). Each lands only when the full verify gate (`bun run check` + `bun test` + `templates:validate` + `build`) is green **and** the phase's verify criterion passes. Status legend: ☐ todo · ◐ in progress · ☑ done

Ordering: Track T and Track N are cheap and independent — they can land while the Phase B ADR is being designed. Phase A unblocks B; C builds on B.

## Phase A — capability routing + fleet visibility ☑

Small; removes the known routing wart and gives operators eyes on the fleet.

- [x] Route jobs by required executor — **executor-set pg-boss queues** (`run.execute.<sorted ids>`; workers fetch only subsets of their own set via a manual fetch loop), replacing the bounce-until-capable-worker behavior; per-worker capability advertisements live on `worker_heartbeats` (`executor_registrations` is a deploy-skew dual-write until its post-merge drop), and submit gating adds a coverage check (a run's whole set must fit one worker)
- [x] Admin UI: worker fleet health — **Admin → Workers** from `worker_heartbeats` advertisements (live/stale at 150 s on the database clock, executors + env-auth + version, 10 s polling)
- Verify: ☑ heterogeneous-fleet integration test (`apps/worker/src/heterogeneous-fleet.integration.test.ts` — a claude-requiring run executes only on the worker registering it, zero `run.deferred` events); admin page shows live/stale workers and their executors

## Phase B — remote runtime daemon (the headline) ☑

BYO compute: a daemon on a user/team machine registers, reports which executors it has, and claims work over HTTP — while quotas, audit, and the git write-path stay server-side.

- [x] **ADR first**: [ADR-0017](../adr/0017-remote-runtime-daemons.md) (revised pre-implementation after cross-ADR review — amendment scope 0011+0012, strict secret routing, abort keepalive bound, lease/affinity carve-out); resolves the ADR-0009 execution lease (landed for central workers first, with real SIGTERM drain-abort)
- [x] Daemon token scheme (`agrd_` prefix + hash + constant-time verify; the api-keys shape so Track T generalizes) — per-run scoped tokens deferred to the agent-facing-CLI track
- [x] `/api/daemon/*` HTTP surface in `apps/api` (register / heartbeat / long-poll claim / event batches with abort piggyback / staged artifact upload hashed at receipt / complete·fail CAS)
- [x] Daemon binary (`bun run build:daemon` → `dist/agrippa-daemon`) embedding the executor packages + shared `@agrippa/workspace` git core; detected-CLI capability reporting on register
- [x] Runtime registration + status in admin UI (Remote runtimes section on the Workers page, one-time token display, revoke) + runtime-offline notifications (the Track N deferral)
- [x] **Central publication preserved — and inverted**: the daemon uploads the sha256'd evidence patch; `git.push` now applies the *approved bytes* to a pristine server-side clone (ADR-0011/0012 amended) — platform git credentials never reach the daemon, which clones with its machine's own git auth
- Verify: ☑ FakeExecutor compliance suite green through the remote transport (the suite runs twice, in-process and remote — the ADR acceptance gate); laptop smoke: issue a token in Admin → Workers, `bun run build:daemon`, run `./dist/agrippa-daemon --server <url> --token agrd_…` on a machine with a Claude login, submit a run needing an executor no central worker has — it dispatches to the daemon while quota rows, audit rows, and `pr.open` happen server-side. ☑ **Local binary smoke passed 2026-08-03**: keyless central worker + OAuth-authed daemon, `pm.weekly-report` routed remote, both legs (draft → approval → finalize) executed by `dist/agrippa-daemon` with resume honoring the pin. It surfaced and fixed three field bugs: the compiled binary cannot bundle the SDK's native `claude` executable (now discovered from the machine's Claude Code install), Bun.serve's 10s default idleTimeout killed the 25s claim long-poll, and a claim whose response is lost stranded the dispatch until the deadman (now re-offered to its own runtime). ☑ **Deployed-stack smoke passed 2026-08-03**: laptop daemon (OAuth Claude login) against https://agrippa.ainaive.com:3000 — the production workers are keyless for anthropic (Bailian project credentials serve central runs), so routing sent the anthropic-only weekly-report to the daemon; both legs executed on the laptop, approval and usage accounting stayed server-side. *(Track N's live Feishu smoke is still outstanding.)*

## Phase C — affinity + steering ☐

- [x] **ADR first**: [ADR-0018](../adr/0018-followup-steering.md) — a follow-up is a new run inheriting a workspace and a session, not a reopened one; amends ADR-0014 (a follow-up deliberately does *not* re-resolve configuration) and defers a publication amendment to ADR-0012 (a follow-up advancing a published tip needs an expected-tip CAS)
- [ ] Workspace/session affinity: runs pin to the runtime that owns the workspace — fixes `workspace_lost` by ownership rather than cross-host migration. *Remote affinity landed with ADR-0017 (`runs.runtime_id` is absolute); what remains is the central side, which has no host pin — a follow-up on a centrally-executed run can be claimed by a worker that does not hold the directory. Claim-time decline first, per-host queue as the real fix, dead pin fails `workspace_lost` and is never re-routed.*
- [ ] Follow-up steering runs: a "follow-up" action on a finished run resumes the executor session in the same workspace with a user message; burst coalescing; fresh-session fallback prepends a context-loss disclosure to the prompt (Multica's pattern); executors that can't detect resume rejection fail closed
- Verify: follow-up on a completed `swdev` run continues in the same branch/workspace with prior context; a forced resume failure produces a fresh session whose transcript opens with the disclosure

## Track T — triggers + API keys ☑ *(parallel, independent)*

- [x] API-key auth middleware (`Bearer agr_…`) — project-scoped, issued/revoked by project admins, reach bounded by an explicit (method, path) → scope allow-list rather than a denylist, audit on use via `audit_logs.actor_api_key_id`
- [x] Cron-scheduled task submission (pg-boss cron): timezone-aware schedules, concurrency policy (skip / queue / replace), plus **fire-time date tokens** — a frozen `dateRange` would have made a weekly report cover the same week forever
- [x] Webhook triggers: per-trigger token + **mandatory** signing secret, durable delivery log with payload inspection + replay, delivery-id idempotency
- Verify: ☑ covered by integration suites (`schedules`, `triggers`, `api-keys`) and a live browser + signed-`curl` smoke against the dev stack — a trigger produced a run whose date tokens resolved; a revoked key gets 401 and an audit row *(the unattended weekly `pm.weekly-report` firing on the deployed stack is still outstanding — it needs a week to elapse)*

## Track N — checkpoint notifications ☑ *(parallel, independent)*

- [x] Outbound webhook on `waiting_approval` (+ new `checkpoint.expired` event) and terminal states; per-project endpoint config, secret-signed payloads, durable retryable delivery log
- [x] Feishu/DingTalk card formatters (CN deployment; no email infrastructure)
- [x] Runtime-offline notifications — landed with Phase B's fleet slice: a runtime silent past 5 min appends `runtime.offline` to its pinned running runs (once per outage via the `notified_offline_at` watermark), flowing through the standard delivery pipeline
- Verify: an approval checkpoint posts a card with a deep link to the run within seconds; delivery failures are visible and retryable *(covered in tests; the live Feishu smoke on the deployed stack is still outstanding)*

## Craft checklist (adopt opportunistically, any branch)

- [ ] Typed failure-reason taxonomy: platform vs agent-error classes; auto-retry only transient classes
- [ ] Idle/semantic-inactivity watchdogs + orphaned-run sweeper
- [ ] Stable-brief prompt-cache discipline: workspace context files byte-identical across runs; volatile context in the step prompt only

## Exit

- [ ] All phases/tracks merged to `main`; docs (`docs/design/`, manual en+zh-CN, CHANGELOG) updated per slice as they land — not at the end
