import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ClaimedDispatch,
  DispatchCompleteBody,
  DispatchEventBatch,
  DispatchFailBody,
} from "@agrippa/core";
import { DISPATCH_WORKSPACE_PLACEHOLDER } from "@agrippa/core";
import { FakeExecutor } from "@agrippa/executor-core";
import type { DaemonApi, RegisterResponse } from "./client";
import { DaemonRunner } from "./runner";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

class MockApi implements DaemonApi {
  batches: Array<DispatchEventBatch["batch"]> = [];
  uploads: Array<{ key: string; bytes: string }> = [];
  completed: DispatchCompleteBody | null = null;
  failed: DispatchFailBody | null = null;
  abortAfterBatches = Number.POSITIVE_INFINITY;

  async register(): Promise<RegisterResponse> {
    return {
      runtimeId: "rt-1",
      hints: { claimWaitSec: 1, heartbeatSec: 60, keepaliveSec: 1 },
    };
  }
  async heartbeat(): Promise<void> {}
  async claim(): Promise<never> {
    throw new Error("not used in unit tests");
  }
  async postEvents(_id: string, batch: DispatchEventBatch["batch"]): Promise<{ abort: boolean }> {
    this.batches.push(batch);
    return { abort: this.batches.length > this.abortAfterBatches };
  }
  async uploadArtifact(_id: string, key: string, bytes: Uint8Array | string): Promise<void> {
    this.uploads.push({
      key,
      bytes: typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes),
    });
  }
  async complete(_id: string, body: DispatchCompleteBody): Promise<void> {
    this.completed = body;
  }
  async fail(_id: string, body: DispatchFailBody): Promise<void> {
    this.failed = body;
  }
}

const dispatchFor = (
  executor: string,
  runId: string,
  overrides: Partial<ClaimedDispatch["payload"]> = {},
): ClaimedDispatch => ({
  id: Bun.randomUUIDv7(),
  runId,
  payload: {
    executorId: executor,
    request: {
      runId,
      stepId: "step-1",
      iteration: 1,
      instructions: "go",
      systemPrompt: "sys",
      model: { provider: "anthropic", providerModelId: "claude-opus-4-8", modelId: "m" },
      subagents: [],
      skills: [
        {
          slug: "builtin/git-workflow",
          version: "1.0.0",
          localPath: `${DISPATCH_WORKSPACE_PLACEHOLDER}/.claude/skills/git-workflow`,
        },
      ],
      mcpServers: [],
      toolPolicy: { writeRoot: DISPATCH_WORKSPACE_PLACEHOLDER, access: "readWrite" },
      limits: { maxTurns: 5 },
      workspaceDir: DISPATCH_WORKSPACE_PLACEHOLDER,
      priorContext: [],
      expectedArtifacts: [],
    },
    workspace: null,
    skills: [
      {
        slug: "builtin/git-workflow",
        version: "1.0.0",
        dir: ".claude/skills/git-workflow",
        files: [{ path: "SKILL.md", contentBase64: Buffer.from("# skill").toString("base64") }],
      },
    ],
    ...overrides,
  },
});

const makeRunner = (api: MockApi, executor: FakeExecutor) =>
  new DaemonRunner({
    api,
    executors: { fake: executor },
    hostname: "test-host",
    logger: silentLogger,
    flushMs: 20,
  });

describe("daemon runner", () => {
  it("executes a dispatch: rewrites paths, materializes skills, streams events, completes", async () => {
    process.env.WORKSPACE_ROOT = mkdtempSync(path.join(tmpdir(), "daemon-ws-"));
    const runId = Bun.randomUUIDv7();
    const api = new MockApi();
    const executor = new FakeExecutor({
      "step-1": {
        kind: "succeed",
        usage: { inputTokens: 10, outputTokens: 5 },
        events: [{ type: "artifact", key: "report", kind: "markdown", path: "report.md" }],
        output: "done",
      },
    });
    const runner = makeRunner(api, executor);
    await runner.register();

    // put the artifact file where the executor claims it is
    const workspaceDir = path.join(process.env.WORKSPACE_ROOT, runId);
    await Bun.write(path.join(workspaceDir, "report.md"), "# report");

    await runner.executeDispatch(dispatchFor("fake", runId));

    // request paths were localized off the placeholder
    const request = executor.requests[0];
    expect(request?.workspaceDir).toBe(workspaceDir);
    expect(request?.toolPolicy.writeRoot).toBe(workspaceDir);
    expect(request?.skills[0]?.localPath).toBe(
      path.join(workspaceDir, ".claude/skills/git-workflow"),
    );

    // skill content was written from the inline payload, at EXACTLY the
    // directory the (rewritten) request points to — the agreement the old
    // assertion missed, which let the namespaced-slug layout bug through
    const writtenSkillDir = path.join(workspaceDir, ".claude", "skills", "git-workflow");
    expect(request?.skills[0]?.localPath).toBe(writtenSkillDir);
    expect(await Bun.file(path.join(writtenSkillDir, "SKILL.md")).text()).toBe("# skill");

    // artifact bytes uploaded BEFORE the event shipped; events in seq order
    expect(api.uploads).toEqual([{ key: "report", bytes: "# report" }]);
    const events = api.batches.flat();
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(events.at(-1)?.event.type).toBe("step.completed");
    expect(api.completed).toEqual({});
    expect(api.failed).toBeNull();
  });

  it("aborts the executor when a batch response carries the abort flag", async () => {
    process.env.WORKSPACE_ROOT = mkdtempSync(path.join(tmpdir(), "daemon-ws-"));
    const api = new MockApi();
    api.abortAfterBatches = 0; // every response says abort
    const executor = new FakeExecutor({ "step-1": { kind: "hang" } });
    const runner = makeRunner(api, executor);
    await runner.register();

    await runner.executeDispatch(dispatchFor("fake", Bun.randomUUIDv7()));

    // the hang behavior converts the abort into a step.failed event, so the
    // stream ends cleanly: complete (the EVENT carries the failure), not fail
    const events = api.batches.flat();
    expect(events.at(-1)?.event.type).toBe("step.failed");
    expect(api.completed).toEqual({});
  });

  it("reports transport-level death via fail() so the server synthesizes the failure", async () => {
    process.env.WORKSPACE_ROOT = mkdtempSync(path.join(tmpdir(), "daemon-ws-"));
    const api = new MockApi();
    const executor = new FakeExecutor({ "step-1": { kind: "crash" } });
    const runner = makeRunner(api, executor);
    await runner.register();

    await runner.executeDispatch(dispatchFor("fake", Bun.randomUUIDv7()));
    expect(api.failed?.code).toBe("internal");
    expect(api.completed).toBeNull();
  });

  it("fails a dispatch naming an executor this machine lacks", async () => {
    const api = new MockApi();
    const runner = makeRunner(api, new FakeExecutor({}));
    await runner.register();
    await runner.executeDispatch(dispatchFor("codex-cli", Bun.randomUUIDv7()));
    expect(api.failed?.message).toContain("codex-cli");
  });
});

describe("daemon runner config isolation", () => {
  it("resets .claude and .mcp.json left by a prior invocation", async () => {
    process.env.WORKSPACE_ROOT = mkdtempSync(path.join(tmpdir(), "daemon-ws-"));
    const runId = Bun.randomUUIDv7();
    const workspaceDir = path.join(process.env.WORKSPACE_ROOT, runId);
    // a previous agent invocation left hooks, settings, and an MCP config
    await Bun.write(path.join(workspaceDir, ".claude", "settings.json"), "{}");
    await Bun.write(path.join(workspaceDir, ".claude", "hooks", "evil.sh"), "#!/bin/sh");
    await Bun.write(path.join(workspaceDir, ".mcp.json"), "{}");

    const api = new MockApi();
    const runner = makeRunner(
      api,
      new FakeExecutor({ "step-1": { kind: "succeed", output: "x" } }),
    );
    await runner.register();
    await runner.executeDispatch(dispatchFor("fake", runId));

    // the per-invocation reset ran before skills materialized: leftovers gone,
    // this dispatch's own skill content present
    expect(await Bun.file(path.join(workspaceDir, ".claude", "settings.json")).exists()).toBe(
      false,
    );
    expect(await Bun.file(path.join(workspaceDir, ".claude", "hooks", "evil.sh")).exists()).toBe(
      false,
    );
    expect(await Bun.file(path.join(workspaceDir, ".mcp.json")).exists()).toBe(false);
    expect(
      await Bun.file(
        path.join(workspaceDir, ".claude", "skills", "git-workflow", "SKILL.md"),
      ).exists(),
    ).toBe(true);
    expect(api.completed).toEqual({});
  });
});
