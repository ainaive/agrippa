import { describe, expect, it } from "bun:test";
import {
  ExpressionError,
  evaluateCondition,
  evaluateExpression,
  extractPlaceholders,
  interpolate,
  normalizeConditionExpression,
} from "./expression";

const ctx = {
  inputs: { autoOpenPr: true, branch: "main", count: 3, empty: "" },
  steps: { "find-root-cause": { outputs: { verdict: "fixed" } } },
  run: { id: "run-1" },
  project: { slug: "apollo" },
};

describe("expression language", () => {
  it("resolves paths, including kebab-case step ids", () => {
    expect(evaluateExpression("inputs.branch", ctx)).toBe("main");
    expect(evaluateExpression("steps.find-root-cause.outputs.verdict", ctx)).toBe("fixed");
    expect(evaluateExpression("inputs.missing", ctx)).toBeUndefined();
  });

  it("evaluates equality and boolean operators with precedence", () => {
    expect(evaluateExpression("inputs.branch == 'main'", ctx)).toBe(true);
    expect(evaluateExpression("inputs.branch != 'main'", ctx)).toBe(false);
    expect(evaluateExpression("inputs.count == 3", ctx)).toBe(true);
    expect(evaluateCondition("inputs.autoOpenPr && inputs.branch == 'main'", ctx)).toBe(true);
    // || binds looser than &&
    expect(evaluateCondition("false && false || true", ctx)).toBe(true);
    expect(evaluateCondition("!(false || false)", ctx)).toBe(true);
    expect(evaluateCondition("!inputs.autoOpenPr", ctx)).toBe(false);
    expect(evaluateExpression("inputs.missing == null", ctx)).toBe(false); // undefined !== null
  });

  it("treats empty strings and undefined as falsy conditions", () => {
    expect(evaluateCondition("inputs.empty", ctx)).toBe(false);
    expect(evaluateCondition("inputs.missing", ctx)).toBe(false);
  });

  it("rejects anything outside the grammar", () => {
    expect(() => evaluateExpression("1 + 1", ctx)).toThrow(ExpressionError);
    expect(() => evaluateExpression("inputs.branch >= 'a'", ctx)).toThrow(ExpressionError);
    expect(() => evaluateExpression("'unterminated", ctx)).toThrow(ExpressionError);
    expect(() => evaluateExpression("foo(1)", ctx)).toThrow(ExpressionError);
    expect(() => evaluateExpression("(inputs.branch", ctx)).toThrow(ExpressionError);
  });

  it("interpolates ${...} placeholders", () => {
    expect(interpolate("branch=${inputs.branch} run=${run.id}", ctx)).toBe("branch=main run=run-1");
    expect(interpolate("missing:[${inputs.missing}]", ctx)).toBe("missing:[]");
    expect(interpolate("obj=${steps.find-root-cause.outputs}", ctx)).toBe(
      'obj={"verdict":"fixed"}',
    );
  });

  it("extracts placeholders and normalizes wrapped conditions", () => {
    expect(extractPlaceholders("a ${inputs.x} b ${run.id}")).toEqual(["inputs.x", "run.id"]);
    expect(normalizeConditionExpression("${inputs.autoOpenPr}")).toBe("inputs.autoOpenPr");
    expect(normalizeConditionExpression("inputs.autoOpenPr")).toBe("inputs.autoOpenPr");
    expect(normalizeConditionExpression("  ${ inputs.x == 'y' }  ")).toBe("inputs.x == 'y'");
  });
});
