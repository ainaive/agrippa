# ADR-0010: agrippa/v2 — Agent Slots, Checkpoint Steps, and Bounded Loops

- Status: accepted · Date: 2026-07-23
- Amends ADR-0006 (which explicitly reserved loops for "an explicit agrippa/v2 decision" — this is that decision).

## Context

The requirement-delivery workflow — natural-language requirement → clarify with the user → plan → implement on a branch → cross-agent review-fix loop → pull request — cannot be expressed in `agrippa/v1`, for three structural reasons:

1. **The phase graph is strictly linear.** Review→fix "until clean" and multi-round clarification need repetition; v1 has only `when:`, `retry:`, and `onFailure: continue`.
2. **The executor is bound per run.** "Claude Code implements, Codex reviews" needs per-step agent routing; v1 has one `runs.executor_id` and one `spec.faber`.
3. **Approvals are binary.** Clarifying questions with answers, per-finding fix/accept decisions, and plan change-requests all need human decisions that carry **data back into the run**; the v1 approver's comment never re-entered the run context.

## Decision

Introduce `apiVersion: agrippa/v2` alongside v1. Both compile into one v2-shaped IR (`CompiledTemplate`); a pure `upgradeV1ToV2` runs at compile time and when loading stored compiled rows, so no data migration and no behavior change for existing templates.

1. **Agent slots.** `spec.agents` declares named slots (implementer, reviewer, …), each binding a default faber + executor; agent steps reference a slot. Submit resolves every slot to a concrete binding (user overrides on overridable slots, capability checks against the static `EXECUTOR_CATALOG` in core, per-slot provider-filtered model resolution) and freezes it into `runs.agent_bindings`. v1 upgrades to a single non-overridable `main` slot bound to the deployment-default executor.
2. **Checkpoint steps.** The v1 phase-level `approval:` becomes a *step kind* (`kind: checkpoint`), reusing the step idempotency/resume machinery and allowing mid-phase pauses. Three kinds: `approval` (approve / reject / — inside loops — request_changes with a comment), `input` (structured Q&A driven by an agent-produced questions artifact), and `review-gate` (per-finding fix/accept decisions driven by a review-report artifact). Auto-pass is deliberately **asymmetric**: `input` auto-passes when its source artifact is absent (nothing to ask) or present, valid, and empty; `review-gate` auto-passes **only** on a present, valid report with zero findings — an absent report fails the gate (a reviewer that produced nothing must not read as a clean review), and a malformed artifact of either kind fails the producing step. Decisions store a structured `response` on the checkpoint row, exposed to templates as a new `checkpoints.<id>` expression root; `artifacts.<key>` exposes latest inline artifact content. This deliberately loosens the v1 invariant that an approver's comment never re-enters the run — v2 templates opt in explicitly by interpolating it; upgraded v1 templates cannot reference the new roots, so their behavior is unchanged.
3. **Bounded loops.** A `kind: loop` node groups phases with a **static** `maxIterations` (1–10), an `until` condition evaluated after each iteration, and `onMaxIterations: fail | continue`. No nesting. The static bound preserves ADR-0006's totality property — the compiler still enumerates every reachable state. Loop identity is derived: `run_steps`, `checkpoints`, and `artifacts` carry an `iteration` column; resume re-derives the current iteration from persisted rows, so crash recovery needs no new state. Within a loop, a forward reference to a same-loop checkpoint resolves to the previous iteration's response (empty on iteration 1) — this is how a clarify round reads the answers given to the previous round's questions.

## Alternatives considered

- **Free-form chat into a running executor session** for clarification: feels like a terminal agent, but breaks ADR-0005's one-step-one-invocation boundary, holds a worker slot while a human types, and is unauditable. Structured Q&A rounds keep pauses durable and resumable.
- **Unbounded/data-driven loops**: rejected again for the ADR-0006 reason; every loop here is human-gated or bounded, and budgets cap it twice over.
- **Fixed unrolling in v1** (review1→fix1→review2→fix2 with `when:` guards): legal today but unreadable, caps rounds structurally, and triples every prompt edit.
- **Executor on the faber** instead of slots: conflates persona with engine; the same faber persona should be able to run on either engine.

## Consequences

- The engine executes per-slot bindings, checkpoint steps, and loops; the whole v1 compliance suite passes through the upgrade path, and new suites pin two-slot routing, Q&A/gate auto-pass, loop resume mid-iteration, and exhaustion semantics.
- `approvals` is renamed to `checkpoints` (kind, iteration, response); the approval expiry job, sweeper, and CAS decide logic carry over unchanged.
- `budgets.perPhase` caps a phase's **cumulative** spend across loop iterations; the run budget plus the static bound cap total loop cost.
- The review-fix loop's exit contract: reviewer reports zero findings (auto-pass), or the user accepts the remaining findings. Exhaustion right after an un-re-reviewed fix is guarded by a `when:`-gated publish approval in the template — expressible with existing constructs, no engine special case.
- Error-code vocabulary is kept (`approval_rejected`, `approval_expired`) plus `loop_exhausted`; run/step statuses are unchanged (`waiting_approval` now also covers input/review-gate pauses).
