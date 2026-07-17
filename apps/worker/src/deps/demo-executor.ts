import type {
  ExecutionContext,
  Executor,
  ExecutorEvent,
  StepExecutionRequest,
} from "@agrippa/executor-core";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Token-free executor for demos and SPA development (AGRIPPA_EXECUTOR=fake):
 * narrates a little, emits every artifact the step's contract expects, and
 * succeeds — so any template runs end-to-end without a model call.
 */
export class DemoExecutor implements Executor {
  readonly id = "fake";
  readonly capabilities = {
    subagents: true,
    mcp: true,
    skills: true,
    resume: false,
    streaming: true,
  };

  constructor(private readonly stepDelayMs = 400) {}

  async *executeStep(
    req: StepExecutionRequest,
    ctx: ExecutionContext,
  ): AsyncIterable<ExecutorEvent> {
    yield { type: "step.started", sessionId: `demo-${req.stepId}` };
    yield { type: "message.delta", text: `Working on ${req.stepId}…` };
    await sleep(this.stepDelayMs);
    if (ctx.signal.aborted) {
      yield { type: "step.failed", error: { code: "aborted", message: "aborted" } };
      return;
    }
    yield {
      type: "usage",
      model: req.model.providerModelId,
      inputTokens: 1200,
      outputTokens: 400,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    for (const artifact of req.expectedArtifacts) {
      if (artifact.kind === "patch") continue; // the engine diffs the workspace
      yield {
        type: "artifact",
        key: artifact.key,
        kind: artifact.kind,
        inline:
          artifact.kind === "link"
            ? "https://example.com/demo"
            : `# ${artifact.key}\n\nDemo content produced by the fake executor for step \`${req.stepId}\`.`,
      };
    }
    yield {
      type: "message.completed",
      role: "assistant",
      text: `Step ${req.stepId} completed (demo).`,
    };
    yield { type: "step.completed", output: `Demo result for ${req.stepId}` };
  }
}
