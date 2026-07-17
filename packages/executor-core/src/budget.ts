import type { UsageDelta } from "./types";

export class BudgetExceededError extends Error {
  constructor(
    /** Which limit tripped: "run" | "phase" | "quota_cost" | "quota_tokens". */
    readonly scope: string,
    message: string,
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export type BudgetLimits = {
  /** Template budgets.maxCostUsd. */
  maxCostUsd?: number;
  /** Template budgets.perPhase — phaseId → maxCostUsd. */
  perPhaseCostUsd?: Record<string, number>;
  /** Project quota (hard stop) — remaining headroom at run start. */
  quotaCostUsd?: number;
  quotaTokens?: number;
};

export type BudgetSnapshot = {
  costUsd: number;
  tokens: number;
  perPhaseCostUsd: Record<string, number>;
};

/**
 * Accumulates usage against run, phase, and quota limits; throws
 * BudgetExceededError at the cap. Initialized from persisted token_usage
 * totals on resume so a crash never resets spend (docs/design/04).
 */
export class BudgetMeter {
  private costUsd: number;
  private tokens: number;
  private readonly perPhase: Record<string, number>;
  private currentPhase = "";

  constructor(
    private readonly limits: BudgetLimits,
    initial: Partial<BudgetSnapshot> = {},
  ) {
    this.costUsd = initial.costUsd ?? 0;
    this.tokens = initial.tokens ?? 0;
    this.perPhase = { ...(initial.perPhaseCostUsd ?? {}) };
  }

  enterPhase(phaseId: string): void {
    this.currentPhase = phaseId;
    this.perPhase[phaseId] ??= 0;
  }

  record(usage: UsageDelta & { costUsd: number }): void {
    this.costUsd += usage.costUsd;
    this.tokens += usage.inputTokens + usage.outputTokens;
    if (this.currentPhase) {
      this.perPhase[this.currentPhase] = (this.perPhase[this.currentPhase] ?? 0) + usage.costUsd;
    }
    this.check();
  }

  /** Re-check limits without recording (used at step boundaries). */
  check(): void {
    const limits = this.limits;
    if (limits.maxCostUsd !== undefined && this.costUsd > limits.maxCostUsd) {
      throw new BudgetExceededError(
        "run",
        `run budget exceeded: $${this.costUsd.toFixed(4)} > $${limits.maxCostUsd}`,
      );
    }
    const phaseLimit = limits.perPhaseCostUsd?.[this.currentPhase];
    if (phaseLimit !== undefined && (this.perPhase[this.currentPhase] ?? 0) > phaseLimit) {
      throw new BudgetExceededError(
        "phase",
        `phase '${this.currentPhase}' budget exceeded: $${(this.perPhase[this.currentPhase] ?? 0).toFixed(4)} > $${phaseLimit}`,
      );
    }
    if (limits.quotaCostUsd !== undefined && this.costUsd > limits.quotaCostUsd) {
      throw new BudgetExceededError("quota_cost", "project cost quota exhausted");
    }
    if (limits.quotaTokens !== undefined && this.tokens > limits.quotaTokens) {
      throw new BudgetExceededError("quota_tokens", "project token quota exhausted");
    }
  }

  snapshot(): BudgetSnapshot {
    return { costUsd: this.costUsd, tokens: this.tokens, perPhaseCostUsd: { ...this.perPhase } };
  }
}
