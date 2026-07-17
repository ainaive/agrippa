import { describe, expect, it } from "bun:test";
import {
  canTransitionRun,
  IllegalRunTransitionError,
  isTerminalRunStatus,
  RUN_STATUSES,
  type RunStatus,
  transitionRun,
} from "./run-status";

describe("run state machine", () => {
  const legal: Array<[RunStatus, RunStatus]> = [
    ["queued", "running"],
    ["queued", "cancelled"],
    ["queued", "failed"], // setup threw before the run was claimed
    ["running", "succeeded"],
    ["running", "failed"],
    ["running", "timed_out"],
    ["running", "waiting_approval"],
    ["running", "cancelled"],
    ["waiting_approval", "running"],
    ["waiting_approval", "cancelled"],
    ["waiting_approval", "failed"],
  ];

  it("allows every documented transition", () => {
    for (const [from, to] of legal) {
      expect(canTransitionRun(from, to)).toBe(true);
      expect(transitionRun(from, to)).toBe(to);
    }
  });

  it("rejects everything not documented", () => {
    const legalSet = new Set(legal.map(([f, t]) => `${f}→${t}`));
    for (const from of RUN_STATUSES) {
      for (const to of RUN_STATUSES) {
        if (from === to || legalSet.has(`${from}→${to}`)) continue;
        expect(canTransitionRun(from, to)).toBe(false);
        expect(() => transitionRun(from, to)).toThrow(IllegalRunTransitionError);
      }
    }
  });

  it("terminal states have no outgoing transitions", () => {
    for (const from of RUN_STATUSES.filter(isTerminalRunStatus)) {
      for (const to of RUN_STATUSES) {
        expect(canTransitionRun(from, to)).toBe(false);
      }
    }
  });
});
