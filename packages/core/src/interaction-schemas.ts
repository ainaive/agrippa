import { z } from "zod";
import { REVIEW_SEVERITIES } from "./domain";

/**
 * Structured interaction contracts shared by the engine (artifact validation),
 * the API (checkpoint respond handlers), and the SPA (form rendering).
 *
 * A `questions` artifact drives an `input` checkpoint; a `review-report`
 * artifact drives a `review-gate` checkpoint. Both auto-pass when empty.
 */

export const questionSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(2000),
  kind: z.enum(["text", "select", "boolean"]).default("text"),
  /** Choices for kind=select. */
  options: z.array(z.string().min(1).max(200)).max(20).optional(),
  required: z.boolean().default(true),
  /** The agent's suggested answer, offered as a one-click fill in the UI. */
  recommended: z.string().max(2000).optional(),
});
export type Question = z.infer<typeof questionSchema>;

export const questionsArtifactSchema = z.object({
  questions: z.array(questionSchema).max(20).default([]),
});
export type QuestionsArtifact = z.infer<typeof questionsArtifactSchema>;

export const reviewFindingSchema = z.object({
  id: z.string().min(1).max(64),
  severity: z.enum(REVIEW_SEVERITIES),
  file: z.string().max(500).optional(),
  line: z.number().int().positive().optional(),
  title: z.string().min(1).max(300),
  detail: z.string().min(1).max(5000),
  suggestion: z.string().max(5000).optional(),
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const reviewReportSchema = z.object({
  summary: z.string().max(5000).default(""),
  findings: z.array(reviewFindingSchema).max(100).default([]),
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
