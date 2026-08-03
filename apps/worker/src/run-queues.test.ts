import { describe, expect, it } from "bun:test";
import { runExecuteQueueName } from "@agrippa/core";
import { selectRunQueues } from "./run-queues";

const collect = (): { warnings: string[]; logger: { warn: (m: string) => void } } => {
  const warnings: string[] = [];
  return { warnings, logger: { warn: (m) => warnings.push(m) } };
};

describe("selectRunQueues (dynamic coverage, codex round-2)", () => {
  it("skips runtime sets a live central worker covers — no steal loop", () => {
    const { logger } = collect();
    // this worker: codex only; a live central peer covers claude
    const names = selectRunQueues({
      localExecutorIds: ["codex-cli"],
      centralWorkerSets: [["claude-agent-sdk", "fake"]],
      runtimeAds: [{ name: "laptop", ids: ["claude-agent-sdk"] }],
      logger,
    });
    // the claude queue is the capable peer's to poll, not ours
    expect(names).not.toContain(runExecuteQueueName(["claude-agent-sdk"]));
    expect(names).toContain(runExecuteQueueName(["codex-cli"]));
  });

  it("polls runtime sets no central worker covers (daemon-only executors)", () => {
    const { logger } = collect();
    const names = selectRunQueues({
      localExecutorIds: ["fake"],
      centralWorkerSets: [["fake"]],
      runtimeAds: [{ name: "laptop", ids: ["claude-agent-sdk", "codex-cli"] }],
      logger,
    });
    expect(names).toContain(runExecuteQueueName(["claude-agent-sdk"]));
    expect(names).toContain(runExecuteQueueName(["claude-agent-sdk", "codex-cli"]));
  });

  it("a mixed set is skipped only when ONE worker covers the whole set", () => {
    const { logger } = collect();
    // claude and codex each covered by a different worker — the PAIR is not
    const names = selectRunQueues({
      localExecutorIds: ["fake"],
      centralWorkerSets: [["claude-agent-sdk"], ["codex-cli"]],
      runtimeAds: [{ name: "laptop", ids: ["claude-agent-sdk", "codex-cli"] }],
      logger,
    });
    expect(names).not.toContain(runExecuteQueueName(["claude-agent-sdk"]));
    expect(names).not.toContain(runExecuteQueueName(["codex-cli"]));
    expect(names).toContain(runExecuteQueueName(["claude-agent-sdk", "codex-cli"]));
  });

  it("drops non-catalog advertised ids by default — rotation cannot mint queues", () => {
    const { warnings, logger } = collect();
    // pattern-valid but unknown ids: each fresh one would otherwise cost the
    // fleet persistent pg-boss queues, so catalog membership is the gate
    const names = selectRunQueues({
      localExecutorIds: ["fake"],
      centralWorkerSets: [],
      runtimeAds: [{ name: "rotator", ids: ["codex-cli", "rot-1", "rot-2", "constructor"] }],
      logger,
    });
    expect(names).toContain(runExecuteQueueName(["codex-cli"]));
    expect(names.some((n) => n.includes("rot-") || n.includes("constructor"))).toBe(false);
    expect(warnings.some((w) => w.includes("unknown or queue-unsafe"))).toBe(true);
  });

  it("drops queue-unsafe advertised ids and logs the drop", () => {
    const { warnings, logger } = collect();
    const names = selectRunQueues({
      localExecutorIds: ["fake"],
      centralWorkerSets: [],
      runtimeAds: [{ name: "evil", ids: ["ok-executor", "evil+name", "has space", "Dot.ted"] }],
      logger,
      isAllowedId: () => true, // isolate the charset filter from the catalog gate
    });
    expect(names).toContain(runExecuteQueueName(["ok-executor"]));
    expect(names.some((n) => n.includes("+") || n.includes(" "))).toBe(false);
    expect(names.some((n) => n.includes("Dot"))).toBe(false);
    expect(warnings.some((w) => w.includes("queue-unsafe"))).toBe(true);
  });

  it("skips expansion for oversized advertisements and logs", () => {
    const { warnings, logger } = collect();
    const ids = Array.from({ length: 12 }, (_, i) => `exec-${i}`);
    const names = selectRunQueues({
      localExecutorIds: ["fake"],
      centralWorkerSets: [],
      runtimeAds: [{ name: "greedy", ids }],
      logger,
      isAllowedId: () => true, // the catalog gate would empty this ad first
    });
    expect(names.some((n) => n.includes("exec-0"))).toBe(false);
    expect(warnings.some((w) => w.includes("skipping its queues"))).toBe(true);
  });

  it("hard-caps the total queue set and logs", () => {
    const { warnings, logger } = collect();
    // 8-id ads expand to 255 subsets each; 6 distinct ads overshoot 1024
    const runtimeAds = Array.from({ length: 6 }, (_, r) => ({
      name: `rt-${r}`,
      ids: Array.from({ length: 8 }, (_, i) => `e${r}-${i}`),
    }));
    const names = selectRunQueues({
      localExecutorIds: ["fake"],
      centralWorkerSets: [],
      runtimeAds,
      logger,
      isAllowedId: () => true, // the catalog gate would empty these ads first
    });
    expect(names.length).toBeLessThanOrEqual(1024);
    expect(warnings.some((w) => w.includes("cap"))).toBe(true);
  });
});
