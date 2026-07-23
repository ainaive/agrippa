import { existsSync } from "node:fs";
import path from "node:path";
import {
  ARTIFACT_DIR,
  artifactInstructions,
  buildScrubbedEnv,
  clearExpectedArtifacts,
  collectArtifacts,
  type ExecutionContext,
  type Executor,
  type ExecutorEvent,
  expectedFilename,
  priorContextBlock,
  type StepExecutionRequest,
} from "@agrippa/executor-core";
import { CodexEventCollector, lastFencedJson } from "./events";

const KILL_GRACE_MS = 5_000;

export type CodexExecutorOptions = {
  /** Command prefix for the CLI (tests point this at a fixture script). */
  command?: string[];
};

/**
 * Artifact directions for read-only steps: the sandbox forbids file writes,
 * so a single declared json artifact is synthesized from the final message's
 * fenced json block, and a markdown artifact from the final message itself.
 */
function readOnlyArtifactInstructions(expected: StepExecutionRequest["expectedArtifacts"]): string {
  const authored = expected.filter((a) => a.kind !== "patch");
  if (authored.length === 0) return "";
  const lines = authored.map((a) =>
    a.kind === "json"
      ? `- End your final message with a fenced \`\`\`json code block containing the '${a.key}' artifact.`
      : `- Your final message is stored as the '${a.key}' artifact — make it the complete document.`,
  );
  return ["", "---", "This step must produce the following artifacts:", ...lines].join("\n");
}

function buildArgs(req: StepExecutionRequest): string[] {
  const sandbox = req.toolPolicy.access === "readWrite" ? "workspace-write" : "read-only";
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    // ~/.codex/config.toml could add MCP servers or other behavior the
    // catalog says this executor doesn't have, bypassing project resource
    // governance; auth still resolves from CODEX_HOME per the CLI docs.
    // .rules execpolicy files (user or checked-out repo) are untrusted too.
    "--ignore-user-config",
    "--ignore-rules",
    "--cd",
    req.workspaceDir,
    "--sandbox",
    sandbox,
    "--model",
    req.model.providerModelId,
    "-c",
    "approval_policy=never",
    "-c",
    "sandbox_workspace_write.network_access=false",
  ];
  if (req.resumeSessionId) args.push("resume", req.resumeSessionId);
  args.push("-"); // prompt on stdin
  return args;
}

function buildPrompt(req: StepExecutionRequest): string {
  const artifactBlock =
    req.toolPolicy.access === "readWrite"
      ? artifactInstructions(req.expectedArtifacts)
      : readOnlyArtifactInstructions(req.expectedArtifacts);
  const role = req.systemPrompt ? `## Role\n\n${req.systemPrompt}\n\n---\n\n` : "";
  return [role, priorContextBlock(req), req.instructions, artifactBlock].join("");
}

function normalizedErrorCode(message: string): "model_error" | "tool_error" {
  return /sandbox|denied|permission/i.test(message) ? "tool_error" : "model_error";
}

/** Split a byte stream into lines (JSONL). */
async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      yield buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer;
}

/**
 * Post-success artifact collection. readWrite steps use the shared file
 * convention; read-only steps (the reviewer) cannot write files, so a json
 * artifact is synthesized from the final message's fenced json block and a
 * markdown artifact from the final message itself.
 */
function* collectStepArtifacts(
  req: StepExecutionRequest,
  finalMessage: string,
): Generator<ExecutorEvent> {
  if (req.toolPolicy.access === "readWrite") {
    yield* collectArtifacts(req.workspaceDir, req.expectedArtifacts);
    return;
  }
  for (const a of req.expectedArtifacts) {
    if (a.kind === "patch") continue;
    // an artifact file may still exist if a previous readWrite step wrote it
    const relative = path.join(ARTIFACT_DIR, expectedFilename(a));
    if (existsSync(path.join(req.workspaceDir, relative))) {
      yield { type: "artifact", key: a.key, kind: a.kind, path: relative };
      continue;
    }
    if (a.kind === "json") {
      const parsed = lastFencedJson(finalMessage);
      if (parsed !== undefined) {
        yield { type: "artifact", key: a.key, kind: a.kind, inline: parsed };
      }
    } else if (finalMessage.length > 0) {
      yield { type: "artifact", key: a.key, kind: a.kind, inline: finalMessage };
    }
  }
}

/**
 * Executor backed by the OpenAI Codex CLI (`codex exec --json`, ADR-0011).
 * Containment relies on Codex's native OS sandbox (Seatbelt/Landlock) driven
 * by the toolPolicy access mode — there is no per-tool-call hook surface, so
 * `evaluateToolCall` cannot back this adapter; the enforcement matrix lives in
 * the ADR. The subprocess env goes through the shared allow-list scrubber.
 */
export function createCodexExecutor(options: CodexExecutorOptions = {}): Executor {
  const command = options.command ?? ["codex"];
  return {
    id: "codex-cli",
    capabilities: { subagents: false, mcp: false, skills: false, resume: true, streaming: true },

    async *executeStep(
      req: StepExecutionRequest,
      ctx: ExecutionContext,
    ): AsyncIterable<ExecutorEvent> {
      clearExpectedArtifacts(req.workspaceDir, req.expectedArtifacts);

      const collector = new CodexEventCollector(req.model.providerModelId);
      const proc = Bun.spawn({
        cmd: [...command, ...buildArgs(req)],
        cwd: req.workspaceDir,
        env: buildScrubbedEnv(),
        stdin: new TextEncoder().encode(buildPrompt(req)),
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderrPromise = new Response(proc.stderr).text().catch(() => "");

      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => {
        proc.kill("SIGTERM");
        killTimer = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
      };
      if (ctx.signal.aborted) onAbort();
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      let started = false;
      try {
        for await (const line of lines(proc.stdout)) {
          for (const event of collector.mapLine(line)) {
            if (event.type === "step.started") {
              if (started) continue; // resume re-announces the thread
              started = true;
            }
            yield event;
          }
        }
        const exitCode = await proc.exited;

        if (ctx.signal.aborted) {
          yield { type: "step.failed", error: { code: "aborted", message: "aborted" } };
          return;
        }
        if (!started) {
          // the CLI died before announcing a thread (bad auth, bad flags…)
          const stderr = (await stderrPromise).trim().slice(-2000);
          yield {
            type: "step.failed",
            error: {
              code: "model_error",
              message: collector.errorMessage ?? stderr ?? "codex produced no output",
            },
          };
          return;
        }
        if (exitCode !== 0 || collector.errorMessage) {
          const stderr = (await stderrPromise).trim().slice(-2000);
          const message = collector.errorMessage ?? stderr ?? `codex exited with ${exitCode}`;
          yield {
            type: "step.failed",
            error: { code: normalizedErrorCode(message), message: message.slice(0, 2000) },
          };
          return;
        }

        yield* collectStepArtifacts(req, collector.lastAgentMessage);
        yield { type: "step.completed", output: collector.lastAgentMessage };
      } catch (err) {
        proc.kill("SIGKILL");
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
        if (killTimer) clearTimeout(killTimer);
      }
    },
  };
}
