import { describe, expect, it } from "bun:test";
import { BudgetExceededError, BudgetMeter } from "./budget";

const usage = (costUsd: number, tokens = 100) => ({
  model: "m",
  inputTokens: tokens / 2,
  outputTokens: tokens / 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd,
});

describe("BudgetMeter", () => {
  it("accumulates and trips the run budget", () => {
    const meter = new BudgetMeter({ maxCostUsd: 1 });
    meter.enterPhase("a");
    meter.record(usage(0.6));
    expect(() => meter.record(usage(0.6))).toThrow(BudgetExceededError);
  });

  it("enforces per-phase limits independently", () => {
    const meter = new BudgetMeter({ maxCostUsd: 10, perPhaseCostUsd: { fix: 1 } });
    meter.enterPhase("plan");
    meter.record(usage(2)); // fine — no phase limit on plan
    meter.enterPhase("fix");
    meter.record(usage(0.9));
    let error: unknown;
    try {
      meter.record(usage(0.2));
    } catch (err) {
      error = err;
    }
    expect((error as BudgetExceededError).scope).toBe("phase");
  });

  it("initializes from persisted totals on resume — no spend reset", () => {
    const meter = new BudgetMeter({ maxCostUsd: 1 }, { costUsd: 0.9, tokens: 5000 });
    expect(() => meter.record(usage(0.2))).toThrow(BudgetExceededError);
  });

  it("enforces quota limits with their own scopes", () => {
    const costMeter = new BudgetMeter({ quotaCostUsd: 0.5 });
    costMeter.enterPhase("a");
    let error: unknown;
    try {
      costMeter.record(usage(0.6));
    } catch (err) {
      error = err;
    }
    expect((error as BudgetExceededError).scope).toBe("quota_cost");

    const tokenMeter = new BudgetMeter({ quotaTokens: 100 });
    tokenMeter.enterPhase("a");
    try {
      tokenMeter.record(usage(0, 200));
    } catch (err) {
      error = err;
    }
    expect((error as BudgetExceededError).scope).toBe("quota_tokens");
  });

  it("snapshot round-trips through a new meter", () => {
    const first = new BudgetMeter({});
    first.enterPhase("a");
    first.record(usage(0.25, 40));
    const second = new BudgetMeter({ maxCostUsd: 0.3 }, first.snapshot());
    second.enterPhase("b");
    expect(() => second.record(usage(0.1))).toThrow(BudgetExceededError);
  });
});
