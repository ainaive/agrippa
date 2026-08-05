import { describe, expect, it } from "bun:test";
import {
  catalogCapabilityShortfall,
  EXECUTOR_CATALOG,
  type ExecutorCapabilityFlags,
  isExecutorId,
} from "./executors";

describe("isExecutorId (catalog membership)", () => {
  it("accepts exactly the catalog's own keys", () => {
    for (const id of Object.keys(EXECUTOR_CATALOG)) {
      expect(isExecutorId(id)).toBe(true);
    }
    expect(isExecutorId("not-a-real-executor")).toBe(false);
  });

  it("rejects prototype-chain property names", () => {
    // `id in EXECUTOR_CATALOG` walked the prototype chain, so "constructor"
    // (all-lowercase — it passes every charset check) counted as a catalog
    // member and EXECUTOR_CATALOG[id].capabilities blew up downstream
    for (const id of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
      expect(isExecutorId(id)).toBe(false);
    }
  });
});

describe("catalogCapabilityShortfall (worker boot parity, ADR-0018)", () => {
  const caps = (over: Partial<ExecutorCapabilityFlags> = {}): ExecutorCapabilityFlags => ({
    subagents: true,
    mcp: true,
    skills: true,
    resume: "verified",
    streaming: true,
    ...over,
  });

  it("passes when the executor delivers exactly, or more than, the promise", () => {
    expect(catalogCapabilityShortfall(caps(), caps())).toBeNull();
    expect(catalogCapabilityShortfall(caps({ subagents: false }), caps())).toBeNull();
    expect(catalogCapabilityShortfall(caps({ resume: "none" }), caps())).toBeNull();
    expect(catalogCapabilityShortfall(caps({ resume: "unverified" }), caps())).toBeNull();
  });

  it("catches a boolean capability the executor does not deliver", () => {
    expect(catalogCapabilityShortfall(caps(), caps({ skills: false }))).toBe("skills");
  });

  it("compares resume by RANK, not truthiness", () => {
    // the trap this function exists for: "none" and "unverified" are both
    // truthy strings, so the boolean implication this replaced accepted an
    // executor that cannot resume against a catalog promising it can prove it
    expect(catalogCapabilityShortfall(caps(), caps({ resume: "none" }))).toBe("resume");
    expect(catalogCapabilityShortfall(caps(), caps({ resume: "unverified" }))).toBe("resume");
    expect(
      catalogCapabilityShortfall(caps({ resume: "unverified" }), caps({ resume: "none" })),
    ).toBe("resume");
  });

  it("every catalog entry is satisfied by itself", () => {
    for (const entry of Object.values(EXECUTOR_CATALOG)) {
      expect(catalogCapabilityShortfall(entry.capabilities, entry.capabilities)).toBeNull();
    }
  });
});
