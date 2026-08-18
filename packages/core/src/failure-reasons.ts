/**
 * The typed failure-reason taxonomy (ADR-0020). Codes stay FLAT strings —
 * `runtime_offline`, never `platform.runtime_offline` — because the class is
 * DERIVED here, which classifies every already-stored `runs.error` row
 * retroactively with zero migration and leaves the wire shape untouched.
 *
 * - `platform`: the platform or its surroundings failed the run — the agent
 *   was never given a fair chance. `transient: true` marks the subset worth
 *   an automatic non-budget retry (the engine's retry policy consumes this);
 *   the rest are permanent until an operator changes something.
 * - `agent`: the agent had its chance and the outcome is on it. Retrying is
 *   a judgment the template author already made — the step's `retry` budget.
 * - `user_policy`: a human or a configured bound stopped the run on purpose.
 *   Retrying would override a decision; nothing ever should.
 */
export type FailureClass = "platform" | "agent" | "user_policy";

export type FailureReason = { class: FailureClass; transient: boolean };

export const FAILURE_REASONS: Record<string, FailureReason> = {
  // ── user policy: a decision, not a defect ─────────────────────────────────
  cancelled: { class: "user_policy", transient: false },
  aborted: { class: "user_policy", transient: false },
  approval_rejected: { class: "user_policy", transient: false },
  approval_expired: { class: "user_policy", transient: false },
  usage_limit_exceeded: { class: "user_policy", transient: false },
  timeout: { class: "user_policy", transient: false },
  superseded: { class: "user_policy", transient: false },

  // ── agent: the work itself fell short; the template retry budget applies ──
  model_error: { class: "agent", transient: false },
  tool_error: { class: "agent", transient: false },
  contract_violation: { class: "agent", transient: false },
  loop_exhausted: { class: "agent", transient: false },
  max_turns_exceeded: { class: "agent", transient: false },
  no_progress: { class: "agent", transient: false },

  // ── platform, transient: the surroundings hiccupped — retry costs nothing
  //    the agent did wrong, so it never burns the template budget ────────────
  crashed: { class: "platform", transient: true },
  runtime_offline: { class: "platform", transient: true },
  provider_rate_limited: { class: "platform", transient: true },
  provider_unavailable: { class: "platform", transient: true },
  executor_stalled: { class: "platform", transient: true },

  // ── platform, permanent: retrying reproduces the refusal until an operator
  //    changes something ─────────────────────────────────────────────────────
  internal: { class: "platform", transient: false },
  workspace_lost: { class: "platform", transient: false },
  publish_conflict: { class: "platform", transient: false },
  provider_credential_required: { class: "platform", transient: false },
  provider_credential_unroutable: { class: "platform", transient: false },
  base_url_invalid: { class: "platform", transient: false },
  no_capable_runtime: { class: "platform", transient: false },
};

/**
 * Classify a failure code. Unknown codes are PLATFORM and NON-TRANSIENT: the
 * conservative corner — never auto-retried (an unknown fault may not be safe
 * to repeat), never blamed on the agent, always surfaced as the platform's to
 * explain.
 */
export function failureClassOf(code: string | null | undefined): FailureReason {
  return FAILURE_REASONS[code ?? ""] ?? { class: "platform", transient: false };
}
