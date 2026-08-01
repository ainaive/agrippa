import { describe, expect, it } from "bun:test";
import { EXECUTOR_CATALOG, isExecutorId } from "./executors";

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
