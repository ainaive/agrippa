import { describe, expect, it } from "bun:test";
import type { RunEvent } from "@/features/useRunEvents";
import type { Run } from "@/lib/types";
import { buildTimeline, type TurnItem } from "./RunTimeline";

const run = { template: null, checkpoints: [] } as unknown as Run;
const t = (key: string) => key;

const started = (seq: number): RunEvent =>
  ({ seq, type: "step.started", payload: { stepId: "steer", iteration: 1 } }) as RunEvent;
const completed = (seq: number): RunEvent =>
  ({ seq, type: "step.completed", payload: { stepId: "steer", iteration: 1 } }) as RunEvent;

describe("buildTimeline: a step that starts twice", () => {
  it("closes the superseded turn instead of leaving it spinning", () => {
    // One step key legitimately gets two starts: a crash-resume re-runs the
    // attempt, and a rejected resume re-invokes it disclosed. The builder
    // pushed a second turn and left the first open — a spinner nothing could
    // complete, because step.completed resolves through the open-turn map and
    // finds only the newer one.
    const items = buildTimeline([started(1), started(2), completed(3)], run, t);
    const turns = items.filter((item): item is TurnItem => item.kind === "turn");
    expect(turns).toHaveLength(2);
    expect(turns.every((turn) => turn.done)).toBe(true);
  });

  it("leaves a single in-flight turn open", () => {
    const turns = buildTimeline([started(1)], run, t).filter(
      (item): item is TurnItem => item.kind === "turn",
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]?.done).toBe(false);
  });
});
