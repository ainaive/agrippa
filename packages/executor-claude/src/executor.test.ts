import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecutionContext, ExecutorEvent, StepExecutionRequest } from "@agrippa/executor-core";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildQueryArgs, createClaudeExecutor } from "./executor";

function makeCtx(signal?: AbortSignal): ExecutionContext {
  return {
    signal: signal ?? new AbortController().signal,
    budget: { record: () => {} },
    secrets: async () => "",
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

function makeRequest(overrides: Partial<StepExecutionRequest> = {}): StepExecutionRequest {
  const workspaceDir = mkdtempSync(path.join(tmpdir(), "claude-exec-test-"));
  return {
    runId: "run-1",
    stepId: "step-1",
    instructions: "Do the thing.",
    systemPrompt: "You are Forge.",
    model: { provider: "anthropic", providerModelId: "claude-opus-4-8" },
    subagents: [
      {
        id: "code-locator",
        description: "finds code",
        prompt: "You locate code.",
        tools: ["Read", "Grep"],
        model: { provider: "anthropic", providerModelId: "claude-sonnet-5" },
      },
    ],
    skills: [],
    mcpServers: [
      { slug: "github", transport: "http", url: "https://mcp.example/", headers: { a: "b" } },
    ],
    toolPolicy: { writeRoot: workspaceDir, access: "readWrite" },
    limits: { maxTurns: 50 },
    workspaceDir,
    priorContext: [{ stepId: "earlier", output: "earlier result", artifactKeys: [] }],
    expectedArtifacts: [{ key: "fix-report", kind: "markdown" }],
    ...overrides,
  };
}

const sdk = (message: unknown) => message as SDKMessage;

function scriptedQuery(messages: unknown[], capture?: { options?: Options; prompt?: string }) {
  return (params: { prompt: string; options?: Options }) => {
    if (capture) {
      capture.options = params.options;
      capture.prompt = params.prompt;
    }
    return (async function* () {
      for (const message of messages) yield sdk(message);
    })();
  };
}

async function collect(iterable: AsyncIterable<ExecutorEvent>): Promise<ExecutorEvent[]> {
  const events: ExecutorEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("claude executor option mapping (docs/design/03)", () => {
  it("maps the request onto query() options", () => {
    const req = makeRequest({ resumeSessionId: "sess-42" });
    const { prompt, options } = buildQueryArgs(req, makeCtx(), new AbortController());

    expect(options.model).toBe("claude-opus-4-8");
    expect(options.cwd).toBe(req.workspaceDir);
    expect(options.maxTurns).toBe(50);
    expect(options.includePartialMessages).toBe(true);
    expect(options.resume).toBe("sess-42");
    expect(options.settingSources).toEqual(["project"]);
    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "You are Forge.",
    });
    expect(options.agents?.["code-locator"]).toMatchObject({
      description: "finds code",
      prompt: "You locate code.",
      tools: ["Read", "Grep"],
      model: "claude-sonnet-5",
    });
    expect(options.mcpServers?.github).toEqual({
      type: "http",
      url: "https://mcp.example/",
      headers: { a: "b" },
    });

    // prompt = prior context + instructions + artifact convention
    expect(prompt).toContain("## Results from earlier steps");
    expect(prompt).toContain("Do the thing.");
    expect(prompt).toContain(".agrippa/artifacts/fix-report.md");
  });

  it("canUseTool contains writes and shell per the workspace policy", async () => {
    const ctx = { signal: new AbortController().signal, suggestions: [] } as never;
    const rwReq = makeRequest();
    const rw = buildQueryArgs(rwReq, makeCtx(), new AbortController()).options.canUseTool;
    if (!rw) throw new Error("canUseTool missing");

    // read-write: writes inside the workspace allowed, escaping writes denied
    expect((await rw("Write", { file_path: "/etc/passwd" }, ctx))?.behavior).toBe("deny");
    expect(
      (await rw("Write", { file_path: path.join(rwReq.workspaceDir, "src/x.ts") }, ctx))?.behavior,
    ).toBe("allow");
    // sibling-prefix directory must not pass the containment check
    expect((await rw("Write", { file_path: `${rwReq.workspaceDir}-evil/x` }, ctx))?.behavior).toBe(
      "deny",
    );
    // read-write: shell is permitted (OS-sandboxed when available)
    expect((await rw("Bash", { command: "ls" }, ctx))?.behavior).toBe("allow");
    // reads are confined to the workspace: /proc and other runs are denied
    expect((await rw("Read", { file_path: "/proc/self/environ" }, ctx))?.behavior).toBe("deny");
    expect((await rw("Read", { file_path: "/work/runs/other/secret" }, ctx))?.behavior).toBe(
      "deny",
    );
    expect(
      (await rw("Read", { file_path: path.join(rwReq.workspaceDir, "src/a.ts") }, ctx))?.behavior,
    ).toBe("allow");

    // read-only: shell denied, repo writes denied, artifact writes allowed
    const roReq = makeRequest();
    roReq.toolPolicy = { writeRoot: roReq.workspaceDir, access: "readOnly" };
    const ro = buildQueryArgs(roReq, makeCtx(), new AbortController()).options.canUseTool;
    if (!ro) throw new Error("canUseTool missing");
    expect((await ro("Bash", { command: "ls" }, ctx))?.behavior).toBe("deny");
    expect(
      (await ro("Write", { file_path: path.join(roReq.workspaceDir, "src/x.ts") }, ctx))?.behavior,
    ).toBe("deny");
    expect(
      (
        await ro(
          "Write",
          { file_path: path.join(roReq.workspaceDir, ".agrippa/artifacts/report.md") },
          ctx,
        )
      )?.behavior,
    ).toBe("allow");
  });

  it("scrubs platform secrets from the agent subprocess env", () => {
    const req = makeRequest();
    const prev = process.env.AGRIPPA_SECRET_KEY;
    process.env.AGRIPPA_SECRET_KEY = "master-key";
    try {
      const { options } = buildQueryArgs(req, makeCtx(), new AbortController());
      expect(options.env?.AGRIPPA_SECRET_KEY).toBeUndefined();
      expect(options.env?.DATABASE_URL).toBeUndefined();
      // strict MCP + no repo settings/hooks honored
      expect(options.strictMcpConfig).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AGRIPPA_SECRET_KEY;
      else process.env.AGRIPPA_SECRET_KEY = prev;
    }
  });
});

describe("claude executor event stream", () => {
  it("translates SDK messages into normalized executor events", async () => {
    const req = makeRequest();
    // agent wrote an artifact into the convention directory
    const artifactDir = path.join(req.workspaceDir, ".agrippa/artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(path.join(artifactDir, "fix-report.md"), "# fixed");

    const messages = [
      { type: "system", subtype: "init", session_id: "sess-1" },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Working" } },
      },
      {
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          content: [
            { type: "text", text: "Running tests now." },
            { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "bun test" } },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 40,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 2,
          },
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok", is_error: false }],
        },
      },
      { type: "result", subtype: "success", result: "All done.", is_error: false },
    ];

    const executor = createClaudeExecutor(scriptedQuery(messages));
    const events = await collect(executor.executeStep(req, makeCtx()));

    expect(events[0]).toEqual({ type: "step.started", sessionId: "sess-1" });
    expect(events).toContainEqual({ type: "message.delta", text: "Working" });
    expect(events).toContainEqual({
      type: "message.completed",
      role: "assistant",
      text: "Running tests now.",
    });
    expect(events).toContainEqual({
      type: "tool.started",
      toolName: "Bash",
      input: { command: "bun test" },
      toolUseId: "tu-1",
    });
    expect(events).toContainEqual({
      type: "tool.completed",
      toolUseId: "tu-1",
      output: "ok",
      isError: false,
    });
    expect(events).toContainEqual({
      type: "usage",
      model: "claude-opus-4-8",
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
    });
    expect(events).toContainEqual({
      type: "artifact",
      key: "fix-report",
      kind: "markdown",
      path: ".agrippa/artifacts/fix-report.md",
    });
    expect(events.at(-1)).toEqual({ type: "step.completed", output: "All done." });
  });

  it("collects only contracted artifacts, skipping patch and uncontracted files", async () => {
    const req = makeRequest({
      expectedArtifacts: [
        { key: "fix-report", kind: "markdown" },
        { key: "patch", kind: "patch" },
      ],
    });
    const artifactDir = path.join(req.workspaceDir, ".agrippa/artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(path.join(artifactDir, "fix-report.md"), "# fixed");
    // the agent also wrote the patch (engine generates it) and a stray file
    writeFileSync(path.join(artifactDir, "patch"), "diff --git a/x b/x");
    writeFileSync(path.join(artifactDir, "scratch.txt"), "junk");

    // patch instructions must not tell the agent to author the patch file
    const { prompt } = buildQueryArgs(req, makeCtx(), new AbortController());
    expect(prompt).toContain(".agrippa/artifacts/fix-report.md");
    expect(prompt).not.toContain(".agrippa/artifacts/patch");

    const executor = createClaudeExecutor(
      scriptedQuery([
        { type: "system", subtype: "init", session_id: "s" },
        { type: "result", subtype: "success", result: "done", is_error: false },
      ]),
    );
    const events = await collect(executor.executeStep(req, makeCtx()));
    const artifacts = events.filter((e) => e.type === "artifact");
    expect(artifacts).toEqual([
      {
        type: "artifact",
        key: "fix-report",
        kind: "markdown",
        path: ".agrippa/artifacts/fix-report.md",
      },
    ]);
  });

  it("maps SDK errors and aborts to step.failed", async () => {
    const failing = createClaudeExecutor(
      scriptedQuery([
        { type: "system", subtype: "init", session_id: "s" },
        { type: "result", subtype: "error_max_turns", is_error: true, errors: [] },
      ]),
    );
    const failEvents = await collect(failing.executeStep(makeRequest(), makeCtx()));
    expect(failEvents.at(-1)).toMatchObject({
      type: "step.failed",
      error: { code: "model_error" },
    });

    const aborted = new AbortController();
    aborted.abort();
    const abortedExecutor = createClaudeExecutor(
      scriptedQuery([{ type: "system", subtype: "init", session_id: "s" }]),
    );
    const abortEvents = await collect(
      abortedExecutor.executeStep(makeRequest(), makeCtx(aborted.signal)),
    );
    expect(abortEvents.at(-1)).toMatchObject({
      type: "step.failed",
      error: { code: "aborted" },
    });
  });

  it("fails when the stream ends without a result", async () => {
    const executor = createClaudeExecutor(
      scriptedQuery([{ type: "system", subtype: "init", session_id: "s" }]),
    );
    const events = await collect(executor.executeStep(makeRequest(), makeCtx()));
    expect(events.at(-1)).toMatchObject({
      type: "step.failed",
      error: { code: "internal" },
    });
  });
});
