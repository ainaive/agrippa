import type { UsageDelta } from "./types";

export class UsageLimitExceededError extends Error {
  constructor(
    /** Which limit tripped: "run" | "phase" | "quota_tokens". */
    readonly scope: string,
    message: string,
  ) {
    super(message);
    this.name = "UsageLimitExceededError";
  }
}

export type UsageLimits = {
  /** Template limits.maxTokens. */
  maxTokens?: number;
  /** Template limits.perPhase — phaseId → maxTokens. */
  perPhaseTokens?: Record<string, number>;
  /** Project quota (hard stop) — remaining headroom at run start. */
  quotaTokens?: number;
};

export type UsageSnapshot = {
  tokens: number;
  perPhaseTokens: Record<string, number>;
};

/**
 * Accumulates token usage against run, phase, and quota limits; throws
 * UsageLimitExceededError at the cap. Initialized from persisted token_usage
 * totals on resume so a crash never resets consumption (docs/design/04).
 *
 * Tokens are counted as input + output, cache reads/writes excluded — the same
 * measure every SQL aggregate uses, so the meter and the submit-time quota gate
 * can never disagree.
 */
export class UsageMeter {
  private tokens: number;
  private limits: UsageLimits;
  private readonly perPhase: Record<string, number>;
  private currentPhase = "";

  constructor(limits: UsageLimits, initial: Partial<UsageSnapshot> = {}) {
    this.limits = limits;
    this.tokens = initial.tokens ?? 0;
    this.perPhase = { ...(initial.perPhaseTokens ?? {}) };
  }

  enterPhase(phaseId: string): void {
    this.currentPhase = phaseId;
    this.perPhase[phaseId] ??= 0;
  }

  /**
   * Refresh the project-quota headroom (leaving run/phase limits untouched).
   * Called at each step boundary so a run reacts to quota consumed by other
   * concurrent runs rather than a stale snapshot taken at start.
   */
  refreshQuota(quotaTokens: number | undefined): void {
    this.limits = { ...this.limits, quotaTokens };
  }

  record(usage: UsageDelta): void {
    const tokens = usage.inputTokens + usage.outputTokens;
    this.tokens += tokens;
    if (this.currentPhase) {
      this.perPhase[this.currentPhase] = (this.perPhase[this.currentPhase] ?? 0) + tokens;
    }
    this.check();
  }

  /** Re-check limits without recording (used at step boundaries). */
  check(): void {
    const limits = this.limits;
    if (limits.maxTokens !== undefined && this.tokens > limits.maxTokens) {
      throw new UsageLimitExceededError(
        "run",
        `run token limit exceeded: ${this.tokens} > ${limits.maxTokens}`,
      );
    }
    const phaseLimit = limits.perPhaseTokens?.[this.currentPhase];
    if (phaseLimit !== undefined && (this.perPhase[this.currentPhase] ?? 0) > phaseLimit) {
      throw new UsageLimitExceededError(
        "phase",
        `phase '${this.currentPhase}' token limit exceeded: ${this.perPhase[this.currentPhase] ?? 0} > ${phaseLimit}`,
      );
    }
    if (limits.quotaTokens !== undefined && this.tokens > limits.quotaTokens) {
      throw new UsageLimitExceededError("quota_tokens", "project token quota exhausted");
    }
  }

  snapshot(): UsageSnapshot {
    return { tokens: this.tokens, perPhaseTokens: { ...this.perPhase } };
  }
}
