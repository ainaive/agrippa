import { describe, expect, it } from "bun:test";
import { FAILURE_REASONS, failureClassOf } from "./failure-reasons";

describe("failure taxonomy (ADR-0020)", () => {
  it("classifies the codes the retry policy branches on", () => {
    expect(failureClassOf("provider_rate_limited")).toEqual({
      class: "platform",
      transient: true,
    });
    expect(failureClassOf("max_turns_exceeded")).toEqual({ class: "agent", transient: false });
    expect(failureClassOf("cancelled")).toEqual({ class: "user_policy", transient: false });
    expect(failureClassOf("workspace_lost")).toEqual({ class: "platform", transient: false });
  });

  it("unknown codes land in the conservative corner: platform, non-transient", () => {
    // never auto-retried (an unknown fault may not be safe to repeat), never
    // blamed on the agent
    expect(failureClassOf("some_future_code")).toEqual({ class: "platform", transient: false });
    expect(failureClassOf(null)).toEqual({ class: "platform", transient: false });
    expect(failureClassOf(undefined)).toEqual({ class: "platform", transient: false });
  });

  it("only user_policy codes are never-retry by class, and no policy code is transient", () => {
    for (const [code, reason] of Object.entries(FAILURE_REASONS)) {
      if (reason.class === "user_policy") {
        expect({ code, transient: reason.transient }).toEqual({ code, transient: false });
      }
      // transient is a PLATFORM-only concept: the agent's budget is the
      // template's retry, and a policy decision is never retried at all
      if (reason.transient) {
        expect({ code, cls: reason.class }).toEqual({ code, cls: "platform" });
      }
    }
  });
});
