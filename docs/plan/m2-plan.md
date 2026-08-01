# M2 Plan — Living Checklist

> Theme: **distributed runtimes + automation** — *execution goes to where the code and credentials live; governance stays on the platform.* Motivated by the [Multica analysis](multica-analysis.md). Tracks T and N are independently shippable on their own `feat/*` branches; **Phases A and B ship together as one branch + PR** (`feat/m2-remote-runtimes` — A is B's prerequisite and they tell one story; decided 2026-08-01, superseding the per-phase-branch plan). Each lands only when the full verify gate (`bun run check` + `bun test` + `templates:validate` + `build`) is green **and** the phase's verify criterion passes. Status legend: ☐ todo · ◐ in progress · ☑ done

Ordering: Track T and Track N are cheap and independent — they can land while the Phase B ADR is being designed. Phase A unblocks B; C builds on B.

## Phase A — capability routing + fleet visibility ☑

Small; removes the known routing wart and gives operators eyes on the fleet.

- [x] Route jobs by required executor — **executor-set pg-boss queues** (`run.execute.<sorted ids>`; workers fetch only subsets of their own set via a manual fetch loop), replacing the bounce-until-capable-worker behavior; per-worker capability advertisements live on `worker_heartbeats` (`executor_registrations` is a deploy-skew dual-write until its post-merge drop), and submit gating adds a coverage check (a run's whole set must fit one worker)
- [x] Admin UI: worker fleet health — **Admin → Workers** from `worker_heartbeats` advertisements (live/stale at 150 s on the database clock, executors + env-auth + version, 10 s polling)
- Verify: ☑ heterogeneous-fleet integration test (`apps/worker/src/heterogeneous-fleet.integration.test.ts` — a claude-requiring run executes only on the worker registering it, zero `run.deferred` events); admin page shows live/stale workers and their executors

## Phase B — remote runtime daemon (the headline) ☐

BYO compute: a daemon on a user/team machine registers, reports which executors it has, and claims work over HTTP — while quotas, audit, and the git write-path stay server-side.

- [ ] **ADR first**: daemon protocol + execution-surface split (register / heartbeat / long-poll claim / report events·usage·artifacts / complete·fail); resolves the ADR-0009 execution lease; defines the trust model (daemon reports, server enforces)
- [ ] Daemon token scheme + per-run scoped tokens (also the groundwork for a future agent-facing CLI)
- [ ] `/api/daemon/*` HTTP surface in `apps/api` (note: api must not import executors — the daemon executes; the api only brokers, consistent with `scripts/check-deps.ts`)
- [ ] Daemon binary (Bun `--compile`) embedding the existing executor packages; detected-CLI capability reporting on register/heartbeat
- [ ] Runtime registration + status in admin UI (extends Phase A's fleet page)
- [ ] **Central publication preserved**: daemon uploads sha256'd patch evidence artifacts (patch only — agent commit history is intentionally not preserved, per ADR-0012); server-side SCM (ADR-0011/0012) applies and pushes — no platform git credentials on the daemon
- Verify: FakeExecutor compliance suite green when driven through the daemon path; a live run executes on a laptop-hosted daemon while quota enforcement, audit rows, and `pr.open` all happen server-side

## Phase C — affinity + steering ☐

- [ ] Workspace/session affinity: runs pin to the runtime that owns the workspace — fixes `workspace_lost` by ownership rather than cross-host migration
- [ ] Follow-up steering runs: a "follow-up" action on a finished run resumes the executor session in the same workspace with a user message; burst coalescing; fresh-session fallback prepends a context-loss disclosure to the prompt (Multica's pattern); executors that can't detect resume rejection fail closed
- Verify: follow-up on a completed `swdev` run continues in the same branch/workspace with prior context; a forced resume failure produces a fresh session whose transcript opens with the disclosure

## Track T — triggers + API keys ☐ *(parallel, independent)*

- [ ] API-key auth middleware (`Bearer agr_…`; schema already at `packages/db/src/schema/api-keys.ts`; design at [05-api-and-auth](../design/05-api-and-auth.md)); scoped to project; audit on use
- [ ] Cron-scheduled task submission (pg-boss cron): timezone-aware schedules, per-schedule concurrency policy (skip / queue / replace)
- [ ] Webhook triggers: per-trigger token + signing secret, durable delivery log with payload inspection + replay
- Verify: `pm.weekly-report` runs weekly unattended; a signed webhook submits a run; a revoked key gets 401 and an audit row

## Track N — checkpoint notifications ☑ *(parallel, independent)*

- [x] Outbound webhook on `waiting_approval` (+ new `checkpoint.expired` event) and terminal states; per-project endpoint config, secret-signed payloads, durable retryable delivery log
- [x] Feishu/DingTalk card formatters (CN deployment; no email infrastructure)
- [ ] Runtime-offline notifications — deferred to Phase B's fleet slice: "offline" is only well-defined once daemons have durable identity in the `runtimes` registry (a Phase A heartbeat-based version would false-alarm on every scale-down)
- Verify: an approval checkpoint posts a card with a deep link to the run within seconds; delivery failures are visible and retryable *(covered in tests; the live Feishu smoke on the deployed stack is still outstanding)*

## Craft checklist (adopt opportunistically, any branch)

- [ ] Typed failure-reason taxonomy: platform vs agent-error classes; auto-retry only transient classes
- [ ] Idle/semantic-inactivity watchdogs + orphaned-run sweeper
- [ ] Stable-brief prompt-cache discipline: workspace context files byte-identical across runs; volatile context in the step prompt only

## Exit

- [ ] All phases/tracks merged to `main`; docs (`docs/design/`, manual en+zh-CN, CHANGELOG) updated per slice as they land — not at the end
