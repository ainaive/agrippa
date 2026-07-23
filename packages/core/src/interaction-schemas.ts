import { z } from "zod";
import { REVIEW_SEVERITIES } from "./domain";

/**
 * Structured interaction contracts shared by the engine (artifact validation),
 * the API (checkpoint respond handlers), and the SPA (form rendering).
 *
 * A `questions` artifact drives an `input` checkpoint; a `review-report`
 * artifact drives a `review-gate` checkpoint. A present, valid artifact with
 * an empty list auto-passes; an absent questions artifact also auto-passes
 * (nothing to ask), while an absent review report FAILS the gate — and a
 * malformed artifact of either kind fails the producing step.
 */

export const questionSchema = z
  .object({
    id: z.string().min(1).max(64),
    text: z.string().min(1).max(2000),
    kind: z.enum(["text", "select", "boolean"]).default("text"),
    /** Choices for kind=select. */
    options: z.array(z.string().min(1).max(200)).max(20).optional(),
    required: z.boolean().default(true),
    /** The agent's suggested answer, offered as a one-click fill in the UI. */
    recommended: z.union([z.string().max(2000), z.boolean()]).optional(),
  })
  .superRefine((q, ctx) => {
    // a required select without options is an unanswerable form — the input
    // checkpoint has no reject path, so the run would deadlock until timeout
    if (q.kind === "select" && (q.options === undefined || q.options.length === 0)) {
      ctx.addIssue({ code: "custom", message: `question '${q.id}': select needs options` });
    }
    if (q.recommended === undefined) return;
    if (q.kind === "boolean" && typeof q.recommended !== "boolean") {
      ctx.addIssue({
        code: "custom",
        message: `question '${q.id}': boolean questions need a boolean recommendation`,
      });
    }
    if (q.kind !== "boolean" && typeof q.recommended !== "string") {
      ctx.addIssue({
        code: "custom",
        message: `question '${q.id}': recommendation must be a string`,
      });
    }
    if (q.kind === "select" && typeof q.recommended === "string") {
      if (!(q.options ?? []).includes(q.recommended)) {
        ctx.addIssue({
          code: "custom",
          message: `question '${q.id}': recommendation must be one of the options`,
        });
      }
    }
  });
export type Question = z.infer<typeof questionSchema>;

// strict + required: `{}`, a typo'd key ({"questionz": …}), or stray
// top-level fields must FAIL parsing, not silently read as "no questions"
export const questionsArtifactSchema = z.strictObject({
  questions: z.array(questionSchema).max(20),
});
export type QuestionsArtifact = z.infer<typeof questionsArtifactSchema>;

export const reviewFindingSchema = z.object({
  id: z.string().min(1).max(64),
  severity: z.enum(REVIEW_SEVERITIES),
  file: z.string().max(500).optional(),
  line: z.number().int().positive().optional(),
  title: z.string().min(1).max(300),
  detail: z.string().min(1).max(2000),
  suggestion: z.string().max(2000).optional(),
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

// caps keep typical reports well under the 64 KB inline artifact limit (an
// interaction artifact that only exists on disk cannot drive its checkpoint);
// a pathological maximal report can still exceed it, which the engine reports
// as a distinct too-large contract violation rather than "no findings"
// strict + required findings: a malformed report must never read as a clean
// one — `{}` or {"findingz": …} auto-passing the review gate is exactly the
// failure this guards against. Nested objects stay tolerant of extra keys.
export const reviewReportSchema = z.strictObject({
  summary: z.string().max(5000).default(""),
  findings: z.array(reviewFindingSchema).max(50),
});
export type ReviewReport = z.infer<typeof reviewReportSchema>;

/**
 * What a decided checkpoint stores in `checkpoints.response` and what
 * templates read back as `checkpoints.<id>` in expressions.
 *
 * `outcome` is the loop-condition surface: `pass` uniformly means "nothing
 * left to do here" (no questions, no findings, or findings accepted), so
 * `until: checkpoints.<id>.outcome == 'pass'` reads the same for every kind.
 * `auto` marks decisions the engine made itself (empty source artifact).
 */
export type CheckpointStoredResponse =
  | { kind: "approval"; outcome: "approved" | "rejected" | "request_changes"; comment?: string }
  | {
      kind: "input";
      outcome: "answered" | "pass";
      answers?: Record<string, string | boolean>;
      auto?: boolean;
    }
  | {
      kind: "review-gate";
      outcome: "fix" | "pass";
      selectedFindings: ReviewFinding[];
      acceptedFindings: ReviewFinding[];
      acceptedFindingIds: string[];
      auto?: boolean;
    };
