import { describe, expect, it } from "bun:test";
import { requiredExecutorIds, runExecuteQueueName, runExecuteSubsetQueues } from "./queue";

describe("runExecuteQueueName", () => {
  it("sorts and dedupes ids", () => {
    expect(runExecuteQueueName(["codex-cli", "claude-agent-sdk", "codex-cli"])).toBe(
      "run.execute.claude-agent-sdk.codex-cli",
    );
  });

  it("single executor", () => {
    expect(runExecuteQueueName(["fake"])).toBe("run.execute.fake");
  });

  it("rejects an empty set", () => {
    expect(() => runExecuteQueueName([])).toThrow("empty executor set");
  });
});

describe("runExecuteSubsetQueues", () => {
  it("enumerates every non-empty subset", () => {
    const names = runExecuteSubsetQueues(["fake", "claude-agent-sdk"]);
    expect(names.toSorted()).toEqual([
      "run.execute.claude-agent-sdk",
      "run.execute.claude-agent-sdk.fake",
      "run.execute.fake",
    ]);
  });

  it("membership is exactly required-set ⊆ own-set", () => {
    const own = ["claude-agent-sdk", "codex-cli", "fake"];
    const names = new Set(runExecuteSubsetQueues(own));
    expect(names.size).toBe(7); // 2^3 − 1
    // a run needing a subset of own lands on a consumed queue…
    expect(names.has(runExecuteQueueName(["codex-cli", "fake"]))).toBe(true);
    // …a run needing anything outside own does not
    expect(names.has(runExecuteQueueName(["codex-cli", "other"]))).toBe(false);
  });

  it("dedupes own ids before enumerating", () => {
    expect(runExecuteSubsetQueues(["fake", "fake"])).toEqual(["run.execute.fake"]);
  });
});

describe("requiredExecutorIds", () => {
  it("is the primary executor plus every slot binding, sorted unique", () => {
    expect(
      requiredExecutorIds({
        executorId: "codex-cli",
        agentBindings: {
          dev: { executorId: "claude-agent-sdk" },
          reviewer: { executorId: "codex-cli" },
        },
      }),
    ).toEqual(["claude-agent-sdk", "codex-cli"]);
  });

  it("handles absent bindings", () => {
    expect(requiredExecutorIds({ executorId: "fake" })).toEqual(["fake"]);
    expect(requiredExecutorIds({ executorId: "fake", agentBindings: null })).toEqual(["fake"]);
  });
});
