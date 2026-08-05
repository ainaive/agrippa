import type { ResumeCapability } from "@agrippa/core";
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

/**
 * What the fake claims about a resume it was asked to perform — scripted per
 * step, orthogonal to whether the step succeeds:
 *
 * - `honored` — continued the session (the default when a session id arrives,
 *   which is what the crash-recovery tests have always assumed);
 * - `rejected` — started fresh and says so, the case the engine must disclose;
 * - `omit` — started fresh and says NOTHING, i.e. an executor that claims
 *   `verified` and lies by silence. "Fails closed" is untestable until the
 *   fake can lie, so this is part of the compliance contract, not a nicety.
 */
export type FakeResumeReport = "honored" | "rejected" | "omit";

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
  readonly capabilities: {
    subagents: boolean;
    mcp: boolean;
    skills: boolean;
    resume: ResumeCapability;
    streaming: boolean;
  };

  /** step id → attempts observed (for retry assertions). */
  readonly attempts = new Map<string, number>();
  /** every request received, for mapping assertions. */
  readonly requests: StepExecutionRequest[] = [];
  /** undefined = no env-auth gating (the default for demo/compliance runs). */
  readonly envAuthProviders?: readonly string[];
  private readonly resumeReports: Record<string, FakeResumeReport>;

  constructor(
    private readonly script: Record<string, FakeStepBehavior> = {},
    opts: {
      envAuthProviders?: readonly string[];
      /**
       * Advertised resume capability; `verified` is what earns a session id.
       * Defaults to `verified` — the crash-recovery path is part of what this
       * fake exists to prove, and defaulting to `none` would silently switch
       * the engine's resume plumbing off for the whole suite while every test
       * kept passing. Weaker values are opted into by the tests about them.
       */
      resume?: ResumeCapability;
      /** Per-step resume outcome, same `<stepId>@<iteration>` keying as the script. */
      resumeReports?: Record<string, FakeResumeReport>;
    } = {},
  ) {
    this.envAuthProviders = opts.envAuthProviders;
    this.capabilities = {
      subagents: true,
      mcp: true,
      skills: true,
      resume: opts.resume ?? "verified",
      streaming: true,
    };
    this.resumeReports = opts.resumeReports ?? {};
  }

  /** `<stepId>@<iteration>` keys override the bare step id (loop-round scripting). */
  behaviorFor(stepId: string, iteration = 1): FakeStepBehavior {
    return this.script[`${stepId}@${iteration}`] ?? this.script[stepId] ?? { kind: "succeed" };
  }

  /** Default `honored`: a scripted resume that says nothing is the normal case. */
  resumeReportFor(stepId: string, iteration = 1): FakeResumeReport {
    return this.resumeReports[`${stepId}@${iteration}`] ?? this.resumeReports[stepId] ?? "honored";
  }

  async *executeStep(
    req: StepExecutionRequest,
    ctx: ExecutionContext,
  ): AsyncIterable<ExecutorEvent> {
    this.requests.push(req);
    const attempt = (this.attempts.get(req.stepId) ?? 0) + 1;
    this.attempts.set(req.stepId, attempt);
    const behavior = this.behaviorFor(req.stepId, req.iteration ?? 1);

    // Nothing to report when no session id arrived — there was no resume to
    // honor. A honored resume keeps the session it continued, which is what
    // makes "did we get the session we asked for?" a real comparison.
    const report = req.resumeSessionId
      ? this.resumeReportFor(req.stepId, req.iteration ?? 1)
      : null;
    yield {
      type: "step.started",
      sessionId:
        report === "honored" ? (req.resumeSessionId as string) : `fake-${req.stepId}-${attempt}`,
      ...(report === "honored" || report === "rejected" ? { resumed: report } : {}),
    };

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
