import type { ExecutionContext, Executor, ExecutorEvent, StepExecutionRequest } from "./types";

export type FakeStepBehavior =
  | {
      kind: "succeed";
      output?: string;
      events?: ExecutorEvent[];
      usage?: FakeUsage;
      delayMs?: number;
    }
  | { kind: "fail"; message?: string; failuresBeforeSuccess?: number; usage?: FakeUsage }
  | { kind: "hang" } // runs until aborted — for cancellation/timeout tests
  | { kind: "crash"; usage?: FakeUsage } // throws mid-step — simulates a dying worker
  | { kind: "script"; events: ExecutorEvent[] };

export type FakeUsage = { inputTokens: number; outputTokens: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function abortError(): ExecutorEvent {
  return { type: "step.failed", error: { code: "aborted", message: "aborted" } };
}

function usageEvent(model: string, usage: FakeUsage): ExecutorEvent {
  return {
    type: "usage",
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/**
 * Replays scripted behaviors per step id — the engine test suite's compliance
 * contract (docs/design/03). Any future executor must behave like this under
 * the same engine: emit usage as it happens, respect the abort signal, and
 * terminate with exactly one step.completed | step.failed.
 */
export class FakeExecutor implements Executor {
  readonly id = "fake";
  readonly capabilities = {
    subagents: true,
    mcp: true,
    skills: true,
    resume: false,
    streaming: true,
  };

  /** step id → attempts observed (for retry assertions). */
  readonly attempts = new Map<string, number>();
  /** every request received, for mapping assertions. */
  readonly requests: StepExecutionRequest[] = [];

  constructor(private readonly script: Record<string, FakeStepBehavior> = {}) {}

  behaviorFor(stepId: string): FakeStepBehavior {
    return this.script[stepId] ?? { kind: "succeed" };
  }

  async *executeStep(
    req: StepExecutionRequest,
    ctx: ExecutionContext,
  ): AsyncIterable<ExecutorEvent> {
    this.requests.push(req);
    const attempt = (this.attempts.get(req.stepId) ?? 0) + 1;
    this.attempts.set(req.stepId, attempt);
    const behavior = this.behaviorFor(req.stepId);

    yield { type: "step.started", sessionId: `fake-${req.stepId}-${attempt}` };

    switch (behavior.kind) {
      case "script": {
        for (const event of behavior.events) {
          if (ctx.signal.aborted) {
            yield abortError();
            return;
          }
          yield event;
        }
        return;
      }
      case "hang": {
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) return resolve();
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield abortError();
        return;
      }
      case "crash": {
        if (behavior.usage) yield usageEvent(req.model.providerModelId, behavior.usage);
        throw new Error("simulated worker crash");
      }
      case "fail": {
        if (behavior.usage) yield usageEvent(req.model.providerModelId, behavior.usage);
        if (
          behavior.failuresBeforeSuccess !== undefined &&
          attempt > behavior.failuresBeforeSuccess
        ) {
          yield { type: "step.completed", output: `succeeded on attempt ${attempt}` };
          return;
        }
        yield {
          type: "step.failed",
          error: { code: "tool_error", message: behavior.message ?? "scripted failure" },
        };
        return;
      }
      case "succeed": {
        if (behavior.delayMs) {
          await sleep(behavior.delayMs);
          if (ctx.signal.aborted) {
            yield abortError();
            return;
          }
        }
        if (behavior.usage) yield usageEvent(req.model.providerModelId, behavior.usage);
        for (const event of behavior.events ?? []) yield event;
        yield { type: "step.completed", output: behavior.output ?? `${req.stepId} done` };
        return;
      }
    }
  }
}
