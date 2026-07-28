import { describe, expect, it } from "bun:test";
import { UsageLimitExceededError, UsageMeter } from "./usage-meter";

const usage = (tokens: number, cacheTokens = 0) => ({
  model: "m",
  inputTokens: tokens / 2,
  outputTokens: tokens / 2,
  cacheReadTokens: cacheTokens,
  cacheWriteTokens: cacheTokens,
});

describe("UsageMeter", () => {
  it("accumulates and trips the run token limit", () => {
    const meter = new UsageMeter({ maxTokens: 1000 });
    meter.enterPhase("a");
    meter.record(usage(600));
    expect(() => meter.record(usage(600))).toThrow(UsageLimitExceededError);
  });

  it("counts input + output only — cache reads and writes are free", () => {
    const meter = new UsageMeter({ maxTokens: 1000 });
    meter.enterPhase("a");
    meter.record(usage(400, 50_000));
    expect(meter.snapshot().tokens).toBe(400);
  });

  it("enforces per-phase limits independently", () => {
    const meter = new UsageMeter({ maxTokens: 10_000, perPhaseTokens: { fix: 1000 } });
    meter.enterPhase("plan");
    meter.record(usage(2000)); // fine — no phase limit on plan
    meter.enterPhase("fix");
    meter.record(usage(900));
    let error: unknown;
    try {
      meter.record(usage(200));
    } catch (err) {
      error = err;
    }
    expect((error as UsageLimitExceededError).scope).toBe("phase");
  });

  it("initializes from persisted totals on resume — no consumption reset", () => {
    const meter = new UsageMeter({ maxTokens: 1000 }, { tokens: 900 });
    expect(() => meter.record(usage(200))).toThrow(UsageLimitExceededError);
  });

  it("enforces the project token quota with its own scope", () => {
    const meter = new UsageMeter({ quotaTokens: 100 });
    meter.enterPhase("a");
    let error: unknown;
    try {
      meter.record(usage(200));
    } catch (err) {
      error = err;
    }
    expect((error as UsageLimitExceededError).scope).toBe("quota_tokens");
  });

  it("refreshQuota reacts to headroom consumed by other runs", () => {
    const meter = new UsageMeter({ quotaTokens: 10_000 });
    meter.enterPhase("a");
    meter.record(usage(500));
    meter.refreshQuota(400); // a concurrent run ate the headroom
    expect(() => meter.check()).toThrow(UsageLimitExceededError);
  });

  it("snapshot round-trips through a new meter", () => {
    const first = new UsageMeter({});
    first.enterPhase("a");
    first.record(usage(400));
    const snapshot = first.snapshot();
    expect(snapshot).toEqual({ tokens: 400, perPhaseTokens: { a: 400 } });

    const second = new UsageMeter({ maxTokens: 500 }, snapshot);
    second.enterPhase("b");
    expect(() => second.record(usage(200))).toThrow(UsageLimitExceededError);
  });
});
