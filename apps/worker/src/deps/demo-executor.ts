import type {
  ExecutionContext,
  Executor,
  ExecutorEvent,
  StepExecutionRequest,
} from "@agrippa/executor-core";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Demo content for a contracted artifact. Interaction artifacts (questions /
 * review reports, recognized by key) are round-aware so checkpoint loops
 * demo realistically: round 1 asks questions / reports findings, later
 * rounds come back clean and auto-pass.
 */
function demoArtifact(key: string, kind: string, stepId: string, iteration: number): unknown {
  if (kind === "link") return "https://example.com/demo";
  if (kind === "json") {
    if (key.includes("question")) {
      if (iteration > 1) return { questions: [] };
      return {
        questions: [
          {
            id: "q1",
            text: "Should the change keep backwards compatibility with the current API?",
            recommended: "Yes — keep the existing endpoints working",
          },
          {
            id: "q2",
            text: "Is a feature flag required for the rollout?",
            kind: "boolean",
            required: false,
          },
        ],
      };
    }
    if (key.includes("review")) {
      if (iteration > 1) return { summary: "All previous findings addressed.", findings: [] };
      return {
        summary: "Two issues worth a look before merging.",
        findings: [
          {
            id: "demo-f1",
            severity: "major",
            file: "src/service.ts",
            line: 42,
            title: "Missing error handling on the new endpoint",
            detail: "The handler awaits the repository call without catching failures.",
            suggestion: "Wrap the call and map failures onto the AppError shape.",
          },
          {
            id: "demo-f2",
            severity: "minor",
            title: "Demo naming nit",
            detail: "`tmpVal` could carry a domain name.",
          },
        ],
      };
    }
    return { note: `Demo json artifact for step ${stepId}` };
  }
  return `# ${key}\n\nDemo content produced by the fake executor for step \`${stepId}\` (round ${iteration}).`;
}

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
        inline: demoArtifact(artifact.key, artifact.kind, req.stepId, req.iteration ?? 1),
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
