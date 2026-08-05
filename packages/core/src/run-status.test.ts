import { describe, expect, it } from "bun:test";
import {
  canTransitionRun,
  IllegalRunTransitionError,
  isTerminalRunStatus,
  RUN_STATUSES,
  type RunStatus,
  runHoldsWorkspace,
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

describe("runHoldsWorkspace (steerability, ADR-0018)", () => {
  const hour = 60 * 60 * 1000;

  it("a live run holds it: nothing has released yet", () => {
    expect(runHoldsWorkspace({ finishedAt: null, workspaceExpiresAt: null })).toBe(true);
  });

  it("a finished run holds it until its expiry passes", () => {
    const finishedAt = new Date(Date.now() - hour);
    expect(runHoldsWorkspace({ finishedAt, workspaceExpiresAt: new Date(Date.now() + hour) })).toBe(
      true,
    );
    expect(
      runHoldsWorkspace({ finishedAt, workspaceExpiresAt: new Date(Date.now() - 60_000) }),
    ).toBe(false);
  });

  it("a finished run with NO expiry has already released", () => {
    // runs that finalized before retention existed, and any whose release
    // write was lost. Reading these as "held" is what made the SPA offer a
    // Continue button on every historical run, each of which the API refused.
    expect(
      runHoldsWorkspace({ finishedAt: new Date(Date.now() - hour), workspaceExpiresAt: null }),
    ).toBe(false);
  });

  it("accepts the ISO strings the API actually serves", () => {
    expect(
      runHoldsWorkspace({
        finishedAt: new Date(Date.now() - hour).toISOString(),
        workspaceExpiresAt: new Date(Date.now() + hour).toISOString(),
      }),
    ).toBe(true);
  });
});
