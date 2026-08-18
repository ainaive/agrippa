# ADR-0020: Failure Taxonomy, Retry Policy, and the Watchdogs That Feed It

- Status: accepted · Date: 2026-08-17
- Amends the engine error semantics ADR-0005/AGENTS.md record ("`RunFailure` finalizes; unexpected errors rethrow so pg-boss retries") by adding a class-driven layer *between* those two — the rethrow rule itself is untouched. Charted as the `feat/m3-craft` half of [docs/plan/m3-plan.md](../plan/m3-plan.md); motivated by [docs/plan/multica-analysis.md](../plan/multica-analysis.md) §Craft.

## Context

Every run failure today lands as an untyped `{code, message}` and every step failure draws the same treatment: the template's `retry` budget, sized by the author for "the agent might do better on a second try". That one treatment is wrong in both directions. A rate-limited provider burns the agent's budget on a fault the agent never caused; a `workspace_lost` retries toward the identical refusal; a rejected approval must never retry at all, and nothing in the type system says so. Operators reading `internal: runtime stopped reporting` cannot tell a platform outage from an agent defect, and the deadman deliberately hid one behind the other.

Meanwhile two silences have no failure at all: an executor that dies without its transport noticing (the daemon's keepalive is an *empty* batch — the 2-minute dispatch deadman proves the transport lives, not that the executor does), and an agent that streams plausible tokens forever without completing a tool call or an artifact. Both need codes before they can need policy.

## Decision

**1. Codes stay flat strings; the class is derived, not stored.** `@agrippa/core` `failure-reasons.ts` maps each code to `{class: platform | agent | user_policy, transient}` with `failureClassOf` deriving unknown codes to the conservative corner — platform, non-transient: never auto-retried (an unknown fault may not be safe to repeat), never blamed on the agent. Deriving rather than storing (`runtime_offline`, never `platform.runtime_offline`) classifies every `runs.error` row ever written with zero migration, keeps the wire shape untouched, and makes the class a pure function reviewers can read in one file. The SPA derives the class badge from the same map; the API schema does not change.

**2. The classes are about who gets the next move.**
- **`user_policy`** — a human or a configured bound stopped the run on purpose (`cancelled`, `approval_rejected`, `approval_expired`, `usage_limit_exceeded`, `timeout`, `aborted`, `superseded`). Retrying would override a decision; nothing ever does.
- **`agent`** — the work fell short (`model_error`, `tool_error`, `contract_violation`, `loop_exhausted`, `max_turns_exceeded`, `no_progress`). Whether to retry is a judgment the template author already made: the step's `retry` budget, exactly as today.
- **`platform`** — the platform or its surroundings failed the run. The `transient` subset (`crashed`, `runtime_offline`, `provider_rate_limited`, `provider_unavailable`, `executor_stalled`) is worth an automatic retry that costs the agent nothing; the rest (`workspace_lost`, `publish_conflict`, `provider_credential_required`, `base_url_invalid`, `no_capable_runtime`, `internal`, …) reproduce their refusal until an operator changes something.

**3. Collapsed signals get their own codes at the source.** The dispatch deadman reports `runtime_offline` instead of `internal`; the Claude adapter splits `max_turns_exceeded` out of `model_error` (the agent's exhaustion is not a provider fault) and both adapters report `provider_rate_limited` / `provider_unavailable` where the error text is unambiguous (429/rate-limit; 5xx/overloaded/unavailable). Anything ambiguous keeps its old code — a mis-classified transient would auto-retry a fault that deserved the agent's budget, so the split is deliberately conservative.

**4. The retry policy branches on the class, in one place.** In the engine's step attempt loop: **agent** failures consume the template budget (today's behavior, unchanged meaning); **platform-transient** failures get their own bounded in-process retry — cap 2 with short backoff, mirroring the crash-recovery extra-attempt mechanics — that does NOT consume the template budget, and when the cap exhausts the failure proceeds as if the class were permanent; **platform-permanent** failures short-circuit any remaining budget (retrying reproduces the refusal) and fail the step typed; **user_policy** never retries. pg-boss's `retryLimit` and the rethrow-on-unexpected rule are untouched — they remain the crash/infra redelivery layer underneath this one.

**5. Two watchdogs give the silences their codes.** A combinator wraps the executor event stream in `invokeExecutor` (both transports, one seam): **hard idle** — no events at all for the window (default 10 min) — aborts the invocation and fails the step `executor_stalled`, platform-transient, because the deadman only proves the transport is alive; **semantic inactivity** — no *meaningful* event (`tool.completed`, `message.completed`, `artifact`) for a longer window (default 30 min) — fails `no_progress`, agent-class. `message.delta` is deliberately not meaningful: a model can stream tokens in a loop forever, and a long single-message writing step is exactly what the wider window is sized for. Thresholds are engine-dep-injectable and env-tunable (`AGRIPPA_STEP_IDLE_MINUTES`, `AGRIPPA_STEP_NO_PROGRESS_MINUTES`); there is no template-author knob this milestone.

**6. Three sweeper stages close the orphan classes nothing bounds today.** `stuck-checkpoints` re-arms the singleton-keyed approval-expiry job for pending checkpoints past their timeout plus slack (the one send in `scheduleApprovalExpiry` had no backstop; re-arming is idempotent by the singleton key). `orphaned-dispatches` settles dispatches whose run is terminal or whose step row has settled — pending rows fail `superseded`, claimed rows get an abort flag and fail after a grace. `deferred-runs` finalizes runs `queued` past a deadline (default 24 h, `AGRIPPA_RUN_QUEUED_DEADLINE_HOURS`) as `no_capable_runtime` with a notification — **deliberately reversing** M2's "a runtime-upgrade deferral proceeds by itself once the machine upgrades": a run nobody can execute should say so within a day rather than emit `run.deferred` every thirty seconds forever (decided 2026-08-16 with the M3 charter). Runtimes themselves are not swept — liveness exclusion and `runtime.offline` notifications already cover them, and revocation is an operator act.

## Alternatives considered

- **Namespaced stored codes** (`agent_error.*`, the Multica shape): self-describing rows, but a data migration, a wire change, and two places that can disagree. Derivation gives the same read at zero migration cost.
- **Retry policy in queue configuration**: pg-boss retries redeliver a *job*; the class decides whether an *attempt* was the agent's to spend. Only the engine knows which step, which class, and what the template budgeted — the policy belongs where the budget lives.
- **A template-author watchdog knob** (`limits.stepIdleMinutes`): a compiler/format change for a tuning nobody has asked to tune; env defaults first, a knob when someone does.
- **Sweeping runtimes**: rejected — see Decision 6.

## Consequences

- Stored failure rows classify retroactively; the run-detail page grows a class badge with no API change; every new code exists in both locales (the parity test enforces it).
- A template's `retry.max` stops being spent on rate limits and dead daemons — authors sized it for agent judgment, and now it means exactly that.
- The compliance suite gains the class dimension through both transports: platform-transient auto-retries without burning budget, agent failures burn it, permanent short-circuits, `user_policy` never retries, the deadman surfaces typed, and each watchdog trips its own code on a scripted-silent FakeExecutor.
- The guard lesson from the steering reviews applies forward: every classification here names an exact identity (a code), never a widened one ("any failure of a run that later succeeded") — the review rounds proved widened identities are where these designs break.
