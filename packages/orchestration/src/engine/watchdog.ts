import type { ExecutorEvent } from "@agrippa/executor-core";

/**
 * The two inactivity watchdogs (ADR-0020 Decision 5), as a stream combinator
 * so `invokeExecutor` wraps every transport at one seam:
 *
 * - **hard idle** — no events at all for the window. The dispatch deadman
 *   only proves the daemon's TRANSPORT is alive (its keepalive is an empty
 *   batch that produces no events), so an executor that dies under a living
 *   transport is exactly this watchdog's prey. `executor_stalled`,
 *   platform-transient: the retry costs the agent nothing.
 * - **semantic inactivity** — no *meaningful* event for a longer window. A
 *   model can stream plausible tokens forever, so `message.delta` is
 *   deliberately not meaningful; completions, tool completions and artifacts
 *   are. `no_progress`, agent-class: the budget is the author's answer to an
 *   agent that spins.
 *
 * On a trip the combinator calls `onTrip` (the caller aborts the invocation,
 * exactly like a cancellation), yields one synthetic terminal `step.failed`,
 * and stops consuming.
 */

export const MEANINGFUL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "tool.completed",
  "message.completed",
  "artifact",
]);

export type WatchdogConfig = {
  /** 0 disables the hard-idle watchdog. */
  idleMs: number;
  /** 0 disables the semantic watchdog. */
  semanticMs: number;
};

const TIMEOUT = Symbol("watchdog-timeout");

function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  if (!Number.isFinite(ms)) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMEOUT), Math.max(ms, 0));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function* withInactivityWatchdog(
  stream: AsyncIterable<ExecutorEvent>,
  cfg: WatchdogConfig & { onTrip: (code: "executor_stalled" | "no_progress") => void },
): AsyncGenerator<ExecutorEvent> {
  const idleMs = cfg.idleMs > 0 ? cfg.idleMs : Number.POSITIVE_INFINITY;
  const semanticMs = cfg.semanticMs > 0 ? cfg.semanticMs : Number.POSITIVE_INFINITY;
  const iterator = stream[Symbol.asyncIterator]();
  let lastAny = Date.now();
  let lastMeaningful = Date.now();
  try {
    while (true) {
      const idleDeadline = lastAny + idleMs;
      const semanticDeadline = lastMeaningful + semanticMs;
      const next = await raceTimeout(
        iterator.next(),
        Math.min(idleDeadline, semanticDeadline) - Date.now(),
      );
      if (next === TIMEOUT) {
        const code = Date.now() >= idleDeadline ? "executor_stalled" : "no_progress";
        cfg.onTrip(code);
        yield {
          type: "step.failed",
          error: {
            code,
            message:
              code === "executor_stalled"
                ? `no executor events for ${Math.round(idleMs / 1000)}s — the transport may live, the executor does not`
                : `no meaningful progress (tool/message completion, artifact) for ${Math.round(semanticMs / 1000)}s`,
          },
        };
        return;
      }
      if (next.done) return;
      lastAny = Date.now();
      if (MEANINGFUL_EVENT_TYPES.has(next.value.type)) lastMeaningful = lastAny;
      yield next.value;
    }
  } finally {
    // best-effort teardown; a pending next() resolves once the caller's
    // onTrip abort reaches the executor
    void iterator.return?.(undefined as never);
  }
}
