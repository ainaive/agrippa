import { describe, expect, it } from "bun:test";
import type { ExecutorEvent } from "@agrippa/executor-core";
import { withInactivityWatchdog } from "./watchdog";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const delta: ExecutorEvent = { type: "message.delta", text: "…" };
const toolDone: ExecutorEvent = { type: "tool.completed", name: "bash", output: "ok" } as never;
const completed: ExecutorEvent = { type: "step.completed", output: "done" };

const collect = async (gen: AsyncGenerator<ExecutorEvent>): Promise<ExecutorEvent[]> => {
  const out: ExecutorEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
};

describe("withInactivityWatchdog (ADR-0020)", () => {
  it("passes a lively stream through unchanged and never trips", async () => {
    async function* lively() {
      for (let i = 0; i < 3; i++) {
        await sleep(10);
        yield delta;
      }
      yield completed;
    }
    const trips: string[] = [];
    const events = await collect(
      withInactivityWatchdog(lively(), {
        idleMs: 5_000,
        semanticMs: 5_000,
        onTrip: (code) => trips.push(code),
      }),
    );
    expect(events).toEqual([delta, delta, delta, completed]);
    expect(trips).toEqual([]);
  });

  it("total silence trips the hard-idle watchdog as executor_stalled", async () => {
    async function* silent(): AsyncGenerator<ExecutorEvent> {
      // would eventually complete — but the watchdog stops consuming long
      // before this sleep resolves
      await sleep(60_000);
      yield completed;
    }
    const trips: string[] = [];
    const events = await collect(
      withInactivityWatchdog(silent(), {
        idleMs: 60,
        semanticMs: 0,
        onTrip: (code) => trips.push(code),
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "step.failed",
      error: { code: "executor_stalled" },
    });
    expect(trips).toEqual(["executor_stalled"]);
  });

  it("endless streaming without completion trips the semantic watchdog as no_progress", async () => {
    // tokens are not progress: the stream is never idle, yet nothing completes
    async function* babble(): AsyncGenerator<ExecutorEvent> {
      while (true) {
        await sleep(10);
        yield delta;
      }
    }
    const trips: string[] = [];
    const events = await collect(
      withInactivityWatchdog(babble(), {
        idleMs: 5_000,
        semanticMs: 80,
        onTrip: (code) => trips.push(code),
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "step.failed", error: { code: "no_progress" } });
    expect(trips).toEqual(["no_progress"]);
  });

  it("meaningful events reset the semantic window", async () => {
    // tool completions every 50ms outlive a 120ms semantic window several
    // times over — real progress must never trip it
    async function* working(): AsyncGenerator<ExecutorEvent> {
      for (let i = 0; i < 6; i++) {
        await sleep(50);
        yield toolDone;
      }
      yield completed;
    }
    const trips: string[] = [];
    const events = await collect(
      withInactivityWatchdog(working(), {
        idleMs: 5_000,
        semanticMs: 120,
        onTrip: (code) => trips.push(code),
      }),
    );
    expect(events.at(-1)).toEqual(completed);
    expect(trips).toEqual([]);
  });

  it("a zeroed window disables that watchdog", async () => {
    async function* slowStart(): AsyncGenerator<ExecutorEvent> {
      await sleep(100);
      yield completed;
    }
    const trips: string[] = [];
    const events = await collect(
      withInactivityWatchdog(slowStart(), {
        idleMs: 0,
        semanticMs: 0,
        onTrip: (code) => trips.push(code),
      }),
    );
    expect(events).toEqual([completed]);
    expect(trips).toEqual([]);
  });
});
