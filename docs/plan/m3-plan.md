# M3 Plan — Living Checklist

> Theme: **steering completion + operational craft** — *follow-ups finish what they start; the platform notices when work stops.* M2 closed with two engineering deferrals named in [ADR-0018](../adr/0018-followup-steering.md)'s Consequences (follow-up publication, central host affinity) and three unchecked craft boxes in [the M2 plan](m2-plan.md); M3 promotes all of them. Ships as **two sequential PRs**: `feat/m3-steering-publication` (Tracks P + A + ride-along R), then `feat/m3-craft` (failure taxonomy, retry policy, watchdogs, sweeper, prompt-cache) — decided 2026-08-16, mirroring M2's #21 → #23 shape. Each slice lands only when the full verify gate (`bun run check` + `bun test` + `templates:validate` + `build`) is green; each PR additionally passes its live verify criterion. Status legend: ☐ todo · ◐ in progress · ☑ done

Design detail beyond this checklist: [ADR-0019](../adr/0019-followup-publication-expected-tip-cas.md) (publication), the Amendment on ADR-0018 (affinity), and ADR-0020 (taxonomy/retry — written as PR 2's first slice).

## Locked decisions (John, 2026-08-16)

1. **Two sequential PRs**, publication/affinity first.
2. **The publish tail is always approval-gated** — every follow-up publish presents the cumulative patch at a checkpoint; a steer never publishes bytes nobody reviewed, even when the base flow auto-published.
3. **Queued runs fail typed at 24 h** (`no_capable_runtime` + notification) — deliberately reverses M2's wait-forever stance for runtime-upgrade deferrals; a re-submit after fixing the fleet is the recovery.
4. **Initial-run resumes route via the per-host queue too**, not just follow-ups — fixes the latent cross-host `waiting_approval`-resume hazard; on a dead host they now fail typed via the sweeper instead of bouncing.

Defaults adopted with the plan (recorded here so nobody re-litigates): pre-M3 chains whose ancestor pushed before `published_sha` existed fail `publish_conflict` (window = one retention hour post-deploy; no recompute fallback) · scratch follow-ups stay non-host-routed this milestone · failure codes stay flat strings, class *derived* in code (no namespace migration) · platform-transient retry is in-process, cap 2, non-budget-consuming · watchdog thresholds env-only, no template knob yet · `message.delta` is not a "meaningful" event (semantic watchdog 30 min; hard idle 10 min) · SPA derives failure class from `@agrippa/core`, no API schema change · prompt-assembly reorder deferred until the cache-ratio metric argues.

## PR 1 — `feat/m3-steering-publication`

### Track P — follow-up publication (the expected-tip CAS)

A follow-up produces a patch today but can never push — publication "remains the ancestor's business" (ADR-0018). ADR-0019 generalizes ADR-0012's creation CAS to an expected-tip CAS so a chain can advance the branch it published.

- [ ] **ADR first**: [ADR-0019](../adr/0019-followup-publication-expected-tip-cas.md) + Amendment pointers appended in ADR-0012 and ADR-0018 (this plan's first commit)
- [ ] **P1** `applyApprovedPatch` learns `expectedTip`: parent selection (E if present, else base), branch-ref fetch for the parent object, no-op tree guard (tree == E's tree → return E, push nothing), `tip_conflict` on any other observed tip; real-git tests — create / advance / idempotent retry / conflict / no-op
- [ ] **P2** additive migration `runs.published_sha`, written by the engine in the `git.push` handler post-push (the `work_branch` pattern, crash-safe by determinism); `GitScmService` derives E from the `workspace_key` chain; `PushResult` gains `tip_conflict` and the engine maps it to `RunFailure("publish_conflict")`; `FakeScmService` learns to lie; `commitSha` on the `branch.pushed` event
- [ ] **P3** synthetic publish tail in `followupTemplate` — approval checkpoint presenting the cumulative patch (decision 2, `onTimeout: cancel`) → `git.push` → `pr.open` iff the base flow had one; engine-computed tail guard skips the tail when the steer's patch is empty or byte-identical to the chain's last approved patch; i18n error strings; manual en+zh-CN 03; CHANGELOG
- Verify: ☐ compliance suite through **both transports** — publish gated by approval, empty/no-change steers skip the tail, conflict fails typed, chained follow-ups advance E twice; ☐ live smoke on the deployed stack: steer a finished repo run → approve the presented patch → the branch/PR advances by exactly one deterministic commit; a push retry is a no-op; a manual push to the branch followed by a second steer fails `publish_conflict` typed

### Track A — central host affinity (the per-host queue)

ADR-0018 named the per-host queue as the real fix for "declines pre-claim for five minutes, then fails `workspace_lost`". Host identity is the identity of the *storage*, not the container — compose replicas sharing the workspaces volume share it. Recorded as an Amendment on ADR-0018.

- [ ] **A1** host-id helper in `@agrippa/workspace` (uuid persisted at `WORKSPACE_ROOT/.agrippa-host-id`); additive migration `runs.workspace_host` (stamped first-writer-wins at checkout, inherited by follow-up inserts, never for remote runs) + `worker_heartbeats.workspace_host`; heartbeat advertisement plumbing
- [ ] **A2** `runHostQueueName` (`run.host.<uuid>`) in core; the queue resolver routes `runtime_id IS NULL AND workspace_host IS NOT NULL` to the host queue (every enqueue path already funnels through `enqueueRun`/`enqueueRunAfter`, so follow-ups **and** initial-run resumes — decision 4 — become host-bound with no call-site changes); worker polls its own host queue via `computeRunQueues`; the 5-min `WorkspaceElsewhereError` decline stays as the deploy-skew fallback
- [ ] **A3** `dead-host-runs` sweeper stage: host unheartbeated > 5 min ∧ run waited > 5 min → `finalizeRun("workspace_lost")` + notification sync (ADR-0018's "a dead pin is never re-routed", made mechanical); design 04 + 08 (volume-identity note); manual en+zh-CN 06; CHANGELOG
- Verify: ☐ two-root fleet integration test — a follow-up is claimed only by the workspace holder, zero bounces; the skew fallback still declines when an old producer sends to a set queue; a dead host's parked run fails typed at the (test-shortened) deadline

### Ride-along

- [ ] **R1** Codex session home becomes a workspace sibling `<workspaceDir>.codex-home` (pure path math in `packages/executor-codex`, matching the `<key>.platform` sidecar convention); `removeWorkspace` also removes the sibling, so the worker collector and the daemon reap inherit cleanup for free. Closes the bug ADR-0018's Consequences recorded — M2 re-keyed the home by workspace but left it under OS tmpdir, reapable mid-chain and never collected. Migration note: pre-upgrade sessions resume `unverified` once → the engine's context-loss disclosure path (honest; window = one retention hour)

## PR 2 — `feat/m3-craft`

- [ ] **ADR first + taxonomy foundation**: ADR-0020; `packages/core/src/failure-reasons.ts` — `FAILURE_REASONS` map code → `{class: platform|agent|user_policy, transient}` with a conservative fallback (unknown → platform, non-transient); codes stay flat strings so stored rows classify retroactively. Split collapsed signals: deadman `internal` → `runtime_offline`, `max_turns_exceeded` out of `model_error`, `provider_rate_limited`/`provider_unavailable` where distinguishable; add `executor_stalled`, `no_progress`, `no_capable_runtime`. SPA class badge on run detail; i18n errors both locales
- [ ] **Retry policy on the taxonomy** — one place changes, the step attempt loop: agent-class burns the template `retry.max` budget (today's meaning); platform-transient gets a non-budget in-process auto-retry (cap 2, the crash-recovery extra-attempt pattern); platform-permanent short-circuits to a typed finalize; user_policy never retries. pg-boss retry and the rethrow-on-unexpected gotcha are untouched
- [ ] **Watchdogs** — `withInactivityWatchdog` combinator wrapping the executor event stream in `invokeExecutor`: hard idle (no events, default 10 min) → `executor_stalled` (platform-transient); semantic (no `tool.completed`/`message.completed`/`artifact`, default 30 min) → `no_progress` (agent-class). Composes with the 120 s dispatch deadman — deadman = transport dead, idle = transport alive but executor silent (the daemon's empty keepalive batches are exactly the gap). Thresholds injectable via `EngineDeps.watchdog`, env-overridable
- [ ] **Sweeper stages** (extending the existing per-stage worker sweeper; runtimes stay out of scope — liveness + `runtime.offline` already cover them): `stuck-checkpoints` re-arms the singleton-keyed approval-expiry job for pending checkpoints past timeout + slack; `orphaned-dispatches` (pending → `superseded`, claimed → abort then fail after grace); `deferred-runs` — 24 h queued → `no_capable_runtime` + notification (decision 3)
- [ ] **Prompt-cache discipline** — codify in design 03 + manual 05 (both locales): workspace context files byte-identical per (template version, resource versions), all volatile content in step instructions only; guard test runs the same template twice and asserts the `.claude` trees and `systemPrompt` byte-identical with only `runId`/`workspaceDir`/`instructions`/`priorContext` differing; optional cache-hit ratio on the usage page from stored `cacheReadTokens`/`cacheWriteTokens`
- Verify: ☐ compliance suite through both transports — platform-transient auto-retries without burning budget, agent failure burns budget, permanent short-circuits, the deadman surfaces `runtime_offline` typed; ☐ FakeExecutor-scripted silence trips each watchdog class correctly; ☐ a queued run with no capable fleet fails typed at the (test-shortened) deadline with a notification

## Exit

- [ ] Both PRs merged to `main`; docs (`docs/design/`, manual en+zh-CN, CHANGELOG) updated per slice as they land — not at the end. *(Carried from M2, still open there: Track N's live Feishu smoke — needs a Feishu group bot webhook created on the operator side; it is an M2 verify item, not M3 scope.)*
