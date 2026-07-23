import { describe, expect, it } from "bun:test";
import { questionsArtifactSchema, reviewReportSchema } from "./interaction-schemas";

describe("interaction schemas (strict artifact contracts)", () => {
  it("rejects reports whose findings are missing, typo'd, or accompanied by stray keys", () => {
    // `{}` must never read as a clean report — that auto-passed review gates
    expect(reviewReportSchema.safeParse({}).success).toBe(false);
    expect(reviewReportSchema.safeParse({ findingz: [] }).success).toBe(false);
    expect(reviewReportSchema.safeParse({ findings: [], verdict: "ok" }).success).toBe(false);
    // a present, valid empty report is the legitimate auto-pass signal
    const clean = reviewReportSchema.safeParse({ findings: [] });
    expect(clean.success).toBe(true);
    if (clean.success) expect(clean.data.summary).toBe("");
  });

  it("rejects question artifacts without the required list", () => {
    expect(questionsArtifactSchema.safeParse({}).success).toBe(false);
    expect(questionsArtifactSchema.safeParse({ questionz: [] }).success).toBe(false);
    expect(questionsArtifactSchema.safeParse({ questions: [] }).success).toBe(true);
  });

  it("tolerates extra keys on nested findings but not at the top level", () => {
    const report = reviewReportSchema.safeParse({
      findings: [
        { id: "f1", severity: "major", title: "T", detail: "D", rationale: "extra is fine" },
      ],
    });
    expect(report.success).toBe(true);
  });

  it("enforces question contracts: select options and kind-matched recommendations", () => {
    const optionless = questionsArtifactSchema.safeParse({
      questions: [{ id: "q1", text: "Pick", kind: "select", required: true }],
    });
    expect(optionless.success).toBe(false);

    const stringForBoolean = questionsArtifactSchema.safeParse({
      questions: [{ id: "q1", text: "Flag?", kind: "boolean", recommended: "yes" }],
    });
    expect(stringForBoolean.success).toBe(false);

    const offMenu = questionsArtifactSchema.safeParse({
      questions: [{ id: "q1", text: "Pick", kind: "select", options: ["a"], recommended: "b" }],
    });
    expect(offMenu.success).toBe(false);

    const valid = questionsArtifactSchema.safeParse({
      questions: [
        { id: "q1", text: "Pick", kind: "select", options: ["a", "b"], recommended: "a" },
        { id: "q2", text: "Flag?", kind: "boolean", recommended: true },
      ],
    });
    expect(valid.success).toBe(true);
  });
});
