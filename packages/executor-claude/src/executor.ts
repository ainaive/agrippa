import { readdirSync } from "node:fs";
import path from "node:path";
import type { ArtifactKind } from "@agrippa/core";
import type {
  ExecutionContext,
  Executor,
  ExecutorEvent,
  StepExecutionRequest,
} from "@agrippa/executor-core";
import { type Options, type SDKMessage, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

const ARTIFACT_DIR = ".agrippa/artifacts";

const KIND_BY_EXT: Record<string, ArtifactKind> = {
  ".md": "markdown",
  ".txt": "markdown",
  ".json": "json",
  ".diff": "patch",
  ".patch": "patch",
  ".url": "link",
};

/** Prompt preamble telling the agent where declared artifacts must land. */
function artifactInstructions(expected: StepExecutionRequest["expectedArtifacts"]): string {
  if (expected.length === 0) return "";
  const list = expected
    .map(
      (a) =>
        `- ${ARTIFACT_DIR}/${a.key}${a.kind === "json" ? ".json" : a.kind === "markdown" ? ".md" : ""}`,
    )
    .filter((line) => !line.includes("(patch)"))
    .join("\n");
  return [
    "",
    "---",
    "This step must produce the following artifact files (relative to the workspace root).",
    "Create each file with the final content before you finish:",
    list,
  ].join("\n");
}

function priorContextBlock(req: StepExecutionRequest): string {
  if (req.priorContext.length === 0) return "";
  const sections = req.priorContext
    .map((p) => `### Step ${p.stepId}\n${p.output.slice(0, 4000)}`)
    .join("\n\n");
  return `## Results from earlier steps\n\n${sections}\n\n---\n\n`;
}

/** Maps a StepExecutionRequest onto Claude Agent SDK query() options (docs/design/03). */
export function buildQueryArgs(
  req: StepExecutionRequest,
  _ctx: ExecutionContext,
  abortController: AbortController,
): { prompt: string; options: Options } {
  const agents: NonNullable<Options["agents"]> = {};
  for (const subagent of req.subagents) {
    agents[subagent.id] = {
      description: subagent.description,
      prompt: subagent.prompt,
      tools: subagent.tools.length > 0 ? subagent.tools : undefined,
      model: subagent.model.providerModelId as never,
    };
  }

  const mcpServers: NonNullable<Options["mcpServers"]> = {};
  for (const server of req.mcpServers) {
    if (server.transport === "stdio") {
      mcpServers[server.slug] = {
        type: "stdio",
        command: server.command,
        args: server.args,
        env: server.env,
      };
    } else {
      mcpServers[server.slug] = {
        type: server.transport,
        url: server.url,
        headers: server.headers,
      };
    }
  }

  const writeRoot = path.resolve(req.toolPolicy.writeRoot);
  const options: Options = {
    cwd: req.workspaceDir,
    model: req.model.providerModelId,
    systemPrompt: { type: "preset", preset: "claude_code", append: req.systemPrompt },
    agents: Object.keys(agents).length > 0 ? agents : undefined,
    mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
    // skills load from <workspace>/.claude/skills via project settings
    settingSources: ["project"],
    maxTurns: req.limits.maxTurns,
    includePartialMessages: true,
    resume: req.resumeSessionId,
    allowedTools: req.toolPolicy.allowedTools,
    disallowedTools: req.toolPolicy.disallowedTools,
    abortController,
    permissionMode: "acceptEdits",
    canUseTool: async (toolName, input) => {
      // deny writes escaping the run workspace; everything else proceeds
      const target = (input.file_path ?? input.path ?? input.notebook_path) as string | undefined;
      if (target && ["Write", "Edit", "NotebookEdit"].includes(toolName)) {
        const resolved = path.resolve(req.workspaceDir, target);
        if (!resolved.startsWith(writeRoot)) {
          return {
            behavior: "deny",
            message: `writes outside the run workspace are not permitted (${target})`,
          };
        }
      }
      return { behavior: "allow", updatedInput: input };
    },
  };

  const prompt = [
    priorContextBlock(req),
    req.instructions,
    artifactInstructions(req.expectedArtifacts),
  ].join("");

  return { prompt, options };
}

function textOf(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

/** Scans the artifact convention directory and emits one event per file. */
function* collectArtifacts(workspaceDir: string): Generator<ExecutorEvent> {
  const dir = path.join(workspaceDir, ARTIFACT_DIR);
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const ext = path.extname(entry);
    const key = ext ? entry.slice(0, -ext.length) : entry;
    yield {
      type: "artifact",
      key,
      kind: KIND_BY_EXT[ext] ?? "file",
      path: path.join(ARTIFACT_DIR, entry),
    };
  }
}

export function createClaudeExecutor(queryFn: QueryFn = sdkQuery as QueryFn): Executor {
  return {
    id: "claude-agent-sdk",
    capabilities: { subagents: true, mcp: true, skills: true, resume: true, streaming: true },

    async *executeStep(
      req: StepExecutionRequest,
      ctx: ExecutionContext,
    ): AsyncIterable<ExecutorEvent> {
      const abortController = new AbortController();
      const onAbort = () => abortController.abort();
      if (ctx.signal.aborted) onAbort();
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const { prompt, options } = buildQueryArgs(req, ctx, abortController);
      let started = false;
      let terminal: ExecutorEvent | null = null;

      try {
        for await (const message of queryFn({ prompt, options })) {
          switch (message.type) {
            case "system": {
              if ("subtype" in message && message.subtype === "init" && !started) {
                started = true;
                yield { type: "step.started", sessionId: message.session_id };
              }
              break;
            }
            case "stream_event": {
              const event = message.event as {
                type: string;
                delta?: { type?: string; text?: string };
              };
              if (
                event.type === "content_block_delta" &&
                event.delta?.type === "text_delta" &&
                event.delta.text
              ) {
                yield { type: "message.delta", text: event.delta.text };
              }
              break;
            }
            case "assistant": {
              const content = message.message.content as Array<{
                type: string;
                text?: string;
                id?: string;
                name?: string;
                input?: unknown;
              }>;
              const text = textOf(content);
              if (text) yield { type: "message.completed", role: "assistant", text };
              for (const block of content) {
                if (block.type === "tool_use") {
                  yield {
                    type: "tool.started",
                    toolName: block.name ?? "unknown",
                    input: block.input,
                    toolUseId: block.id ?? "",
                  };
                }
              }
              const usage = message.message.usage;
              if (usage) {
                yield {
                  type: "usage",
                  model: message.message.model ?? req.model.providerModelId,
                  inputTokens: usage.input_tokens ?? 0,
                  outputTokens: usage.output_tokens ?? 0,
                  cacheReadTokens: usage.cache_read_input_tokens ?? 0,
                  cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
                };
              }
              break;
            }
            case "user": {
              const content = (
                message as unknown as {
                  message: { content: unknown };
                }
              ).message.content;
              if (Array.isArray(content)) {
                for (const block of content as Array<{
                  type: string;
                  tool_use_id?: string;
                  content?: unknown;
                  is_error?: boolean;
                }>) {
                  if (block.type === "tool_result") {
                    yield {
                      type: "tool.completed",
                      toolUseId: block.tool_use_id ?? "",
                      output: block.content,
                      isError: block.is_error ?? false,
                    };
                  }
                }
              }
              break;
            }
            case "result": {
              if (message.subtype === "success") {
                terminal = { type: "step.completed", output: message.result };
              } else {
                terminal = {
                  type: "step.failed",
                  error: {
                    code: message.subtype === "error_max_turns" ? "model_error" : "internal",
                    message:
                      "errors" in message && message.errors.length > 0
                        ? message.errors.join("; ")
                        : message.subtype,
                  },
                };
              }
              break;
            }
            default:
              break;
          }
        }

        if (ctx.signal.aborted) {
          yield { type: "step.failed", error: { code: "aborted", message: "aborted" } };
          return;
        }
        if (terminal?.type === "step.completed") {
          yield* collectArtifacts(req.workspaceDir);
        }
        yield terminal ?? {
          type: "step.failed",
          error: { code: "internal", message: "SDK stream ended without a result message" },
        };
      } catch (err) {
        if (ctx.signal.aborted) {
          yield { type: "step.failed", error: { code: "aborted", message: "aborted" } };
        } else {
          yield {
            type: "step.failed",
            error: { code: "model_error", message: String(err).slice(0, 2000) },
          };
        }
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
