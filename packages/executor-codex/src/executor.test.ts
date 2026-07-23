import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecutionContext, ExecutorEvent, StepExecutionRequest } from "@agrippa/executor-core";
import { probeCodexCli } from "./cli";
import { createCodexExecutor } from "./executor";

const FIXTURE = path.resolve(import.meta.dirname, "../test/fixtures/fake-codex.ts");
const FAKE_CODEX = [process.execPath, FIXTURE];

const workspaces: string[] = [];
function makeWorkspace(scenario: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-exec-test-"));
  workspaces.push(dir);
  writeFileSync(path.join(dir, ".fake-codex-scenario"), scenario);
  return dir;
}

function makeReq(
  workspaceDir: string,
  overrides: Partial<StepExecutionRequest> = {},
): StepExecutionRequest {
  return {
    runId: "run-1",
    stepId: "review",
    iteration: 1,
    agentSlot: "reviewer",
    instructions: "Review the changes.",
    systemPrompt: "You are an exacting reviewer.",
    model: { provider: "openai", providerModelId: "gpt-5-codex" },
    subagents: [],
    skills: [],
    mcpServers: [],
    toolPolicy: { writeRoot: workspaceDir, access: "readWrite" },
    limits: { maxTurns: 50 },
    workspaceDir,
    priorContext: [],
    expectedArtifacts: [],
    ...overrides,
  };
}

function makeCtx(signal?: AbortSignal): ExecutionContext {
  return {
    signal: signal ?? new AbortController().signal,
    budget: { record: () => {} },
    secrets: async () => {
      throw new Error("unused");
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

async function collect(
  req: StepExecutionRequest,
  ctx: ExecutionContext = makeCtx(),
): Promise<ExecutorEvent[]> {
  const executor = createCodexExecutor({ command: FAKE_CODEX });
  const events: ExecutorEvent[] = [];
  for await (const event of executor.executeStep(req, ctx)) events.push(event);
  return events;
}

const savedEnv: Record<string, string | undefined> = {};
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("codex executor", () => {
  it("maps the JSONL stream onto normalized events with exactly one terminal", async () => {
    const events = await collect(makeReq(makeWorkspace("happy")));

    expect(events[0]).toEqual({ type: "step.started", sessionId: "sess-1" });
    const messages = events.filter((e) => e.type === "message.completed");
    expect(messages.map((m) => (m.type === "message.completed" ? m.text : ""))).toEqual([
      "First note",
      "All done",
    ]);
    const toolStart = events.find((e) => e.type === "tool.started");
    expect(toolStart?.type === "tool.started" && toolStart.toolUseId).toBe("item_1");
    const toolDone = events.find((e) => e.type === "tool.completed");
    expect(toolDone?.type === "tool.completed" && toolDone.isError).toBe(false);

    // input_tokens is cached-inclusive — the mapper splits it
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toMatchObject({
      model: "gpt-5-codex",
      inputTokens: 1000,
      cacheReadTokens: 500,
      outputTokens: 42,
    });

    const terminals = events.filter((e) => e.type === "step.completed" || e.type === "step.failed");
    expect(terminals).toEqual([{ type: "step.completed", output: "All done" }]);
  });

  it("builds sandboxed argv from the tool policy and resumes sessions", async () => {
    const readWrite = await collect(makeReq(makeWorkspace("argv")));
    const done = readWrite.find((e) => e.type === "step.completed");
    const argv = JSON.parse(done?.type === "step.completed" ? done.output : "[]") as string[];
    expect(argv).toContain("exec");
    expect(argv).toContain("--json");
    expect(argv).toContain("--skip-git-repo-check");
    // user config.toml (MCP servers…) and execpolicy rules must never load
    expect(argv).toContain("--ignore-user-config");
    expect(argv).toContain("--ignore-rules");
    expect(argv.slice(argv.indexOf("--sandbox"))[1]).toBe("workspace-write");
    expect(argv.slice(argv.indexOf("--model"))[1]).toBe("gpt-5-codex");
    expect(argv).toContain("approval_policy=never");
    expect(argv.at(-1)).toBe("-");
    expect(argv).not.toContain("resume");

    const resumed = await collect(
      makeReq(makeWorkspace("argv"), {
        toolPolicy: { writeRoot: "/tmp", access: "readOnly" },
        resumeSessionId: "sess-9",
      }),
    );
    const done2 = resumed.find((e) => e.type === "step.completed");
    const argv2 = JSON.parse(done2?.type === "step.completed" ? done2.output : "[]") as string[];
    expect(argv2.slice(argv2.indexOf("--sandbox"))[1]).toBe("read-only");
    expect(argv2.slice(argv2.indexOf("resume"))[1]).toBe("sess-9");
  });

  it("assembles the prompt from role, prior context, instructions, and artifact directions", async () => {
    const events = await collect(
      makeReq(makeWorkspace("echo-prompt"), {
        priorContext: [
          { stepId: "implement", output: "implemented the feature", artifactKeys: [] },
        ],
        expectedArtifacts: [{ key: "notes", kind: "markdown" }],
      }),
    );
    const done = events.find((e) => e.type === "step.completed");
    const prompt = done?.type === "step.completed" ? done.output : "";
    expect(prompt).toContain("## Role");
    expect(prompt).toContain("You are an exacting reviewer.");
    expect(prompt).toContain("### Step implement");
    expect(prompt).toContain("Review the changes.");
    expect(prompt).toContain(".agrippa/artifacts/notes.md");
  });

  it("synthesizes a json artifact from the final fenced block in read-only mode", async () => {
    const workspaceDir = makeWorkspace("readonly-report");
    const events = await collect(
      makeReq(workspaceDir, {
        toolPolicy: { writeRoot: workspaceDir, access: "readOnly" },
        expectedArtifacts: [{ key: "review-report", kind: "json" }],
      }),
    );
    const artifact = events.find((e) => e.type === "artifact");
    expect(artifact?.type === "artifact" && artifact.key).toBe("review-report");
    const inline =
      artifact?.type === "artifact" ? (artifact.inline as { findings: unknown[] }) : null;
    expect(inline?.findings).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("step.completed");
  });

  it("collects contracted artifact files in workspace-write mode", async () => {
    const events = await collect(
      makeReq(makeWorkspace("write-artifact"), {
        expectedArtifacts: [{ key: "report", kind: "markdown" }],
      }),
    );
    const artifact = events.find((e) => e.type === "artifact");
    expect(artifact?.type === "artifact" && artifact.path).toBe(".agrippa/artifacts/report.md");
  });

  it("normalizes CLI errors into step.failed", async () => {
    const events = await collect(makeReq(makeWorkspace("fail")));
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("step.failed");
    if (terminal?.type === "step.failed") {
      expect(terminal.error.code).toBe("model_error");
      expect(terminal.error.message).toContain("quota exceeded");
    }
    expect(events.some((e) => e.type === "step.completed")).toBe(false);
  });

  it("kills the subprocess and reports aborted on cancellation", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const start = Date.now();
    const events = await collect(makeReq(makeWorkspace("hang")), makeCtx(controller.signal));
    expect(Date.now() - start).toBeLessThan(4000);
    const terminal = events.at(-1);
    expect(terminal?.type === "step.failed" && terminal.error.code).toBe("aborted");
  });

  it("registers only CLIs that support the config-isolation flags", () => {
    const cliFixture = path.resolve(import.meta.dirname, "../test/fixtures/fake-codex-cli.ts");
    const modern = probeCodexCli([process.execPath, cliFixture, "modern"]);
    expect(modern).toEqual({ ok: true, version: "codex-cli 0.145.0" });
    const legacy = probeCodexCli([process.execPath, cliFixture, "legacy"]);
    expect(legacy.ok).toBe(false);
    if (!legacy.ok) expect(legacy.reason).toContain("--ignore-user-config");
  });

  it("routes a project provider credential through a synthesized model provider", async () => {
    const events = await collect(
      makeReq(makeWorkspace("argv"), {
        model: { provider: "dashscope", providerModelId: "qwen3.7-max" },
        providerAuth: { provider: "dashscope", apiKey: "sk-bailian-project" },
      }),
    );
    const done = events.find((e) => e.type === "step.completed");
    const argv = JSON.parse(done?.type === "step.completed" ? done.output : "[]") as string[];
    expect(argv).toContain("model_provider=agrippa");
    expect(argv).toContain(
      'model_providers.agrippa.base_url="https://dashscope.aliyuncs.com/compatible-mode/v1"',
    );
    expect(argv).toContain("model_providers.agrippa.env_key=OPENAI_API_KEY");
    expect(argv).toContain("model_providers.agrippa.wire_api=chat");
  });

  it("keeps plain argv for a credential with no base URL (native openai)", async () => {
    const events = await collect(
      makeReq(makeWorkspace("argv"), {
        providerAuth: { provider: "openai", apiKey: "sk-openai-project" },
      }),
    );
    const done = events.find((e) => e.type === "step.completed");
    const argv = JSON.parse(done?.type === "step.completed" ? done.output : "[]") as string[];
    expect(argv).not.toContain("model_provider=agrippa");
  });

  it("project credential replaces env auth and redirects CODEX_HOME", async () => {
    savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    savedEnv.CODEX_HOME = process.env.CODEX_HOME;
    process.env.OPENAI_API_KEY = "sk-worker-env";
    process.env.CODEX_HOME = "/home/worker/.codex";

    const events = await collect(
      makeReq(makeWorkspace("env"), {
        providerAuth: { provider: "dashscope", apiKey: "sk-bailian-project" },
      }),
    );
    const done = events.find((e) => e.type === "step.completed");
    const seen = JSON.parse(done?.type === "step.completed" ? done.output : "{}") as {
      openai: string | null;
      openaiBaseUrl: string | null;
      codexHome: string | null;
    };
    expect(seen.openai).toBe("sk-bailian-project"); // project key wins over env
    expect(seen.openaiBaseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    // ambient auth.json under the worker's CODEX_HOME must not outrank the key
    expect(seen.codexHome).toContain("agrippa-codex-home");
    expect(seen.codexHome).toContain("run-1");
  });

  it("scrubs the subprocess environment down to the allow-list", async () => {
    savedEnv.AGRIPPA_SECRET_KEY = process.env.AGRIPPA_SECRET_KEY;
    savedEnv.NODE_OPTIONS = process.env.NODE_OPTIONS;
    savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    process.env.AGRIPPA_SECRET_KEY = "super-secret-master-key";
    process.env.NODE_OPTIONS = "--inspect";
    process.env.OPENAI_API_KEY = "sk-test-openai";

    const events = await collect(makeReq(makeWorkspace("env")));
    const done = events.find((e) => e.type === "step.completed");
    const seen = JSON.parse(done?.type === "step.completed" ? done.output : "{}") as {
      secret: string | null;
      nodeOptions: string | null;
      openai: string | null;
    };
    expect(seen.secret).toBeNull(); // platform master key never reaches the agent
    expect(seen.nodeOptions).toBeNull(); // no code injection via NODE_OPTIONS
    expect(seen.openai).toBe("sk-test-openai"); // provider auth passes through
  });
});
