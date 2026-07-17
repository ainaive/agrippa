import { ARTIFACT_KINDS, MODEL_TIERS } from "@agrippa/core";
import { z } from "zod";

/**
 * Zod schema for agrippa/v1 orchestration templates
 * (docs/design/02-orchestration-template.md). Both locales are required on
 * every localizable field — builtin templates cannot ship half-translated.
 */

export const localizedTextSchema = z
  .object({ en: z.string().min(1), "zh-CN": z.string().min(1) })
  .catchall(z.string());

const idSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase kebab-case identifier");
const templateSlugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/, "<scenario-prefix>.<template-name>");

export const INPUT_TYPES = [
  "string",
  "text",
  "number",
  "boolean",
  "select",
  "repoRef",
  "docRef",
] as const;

export const templateInputSchema = z
  .object({
    key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
    type: z.enum(INPUT_TYPES),
    required: z.boolean().default(false),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    label: localizedTextSchema,
    help: localizedTextSchema.optional(),
    ui: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    options: z
      .array(z.object({ value: z.string(), label: localizedTextSchema }))
      .min(1)
      .optional(),
  })
  .refine((input) => input.type !== "select" || input.options !== undefined, {
    message: "select inputs must define options",
  });

const skillRefSchema = z.object({
  ref: z.string().regex(/^[a-z0-9/._-]+@[\^~]?[0-9][0-9a-zA-Z.*-]*$/, "slug@semver-range"),
  optional: z.boolean().default(false),
});

const mcpRefSchema = z.object({
  ref: idSchema,
  optional: z.boolean().default(false),
});

const subagentSchema = z
  .object({
    id: idSchema,
    description: z.string().min(1),
    prompt: z.string().min(1).optional(),
    promptFile: z.string().optional(),
    tools: z.array(z.string()).default([]),
    model: z.object({ role: z.string() }),
  })
  .refine((s) => (s.prompt !== undefined) !== (s.promptFile !== undefined), {
    message: "subagent needs exactly one of prompt / promptFile",
  });

const modelRoleSchema = z.object({
  tier: z.enum(MODEL_TIERS),
  fallback: z.array(z.enum(MODEL_TIERS)).default([]),
});

const durationSchema = z.string().regex(/^\d+(m|h|d)$/, "duration like 45m, 24h, 2d");

const requiresSchema = z.object({
  mcpServers: z.array(idSchema).default([]),
  skills: z.array(z.string()).default([]),
});

const stepCommon = {
  id: idSchema,
  when: z.string().optional(),
  requires: requiresSchema.optional(),
  produces: z.array(idSchema).default([]),
  onFailure: z.enum(["fail", "continue"]).default("fail"),
  retry: z.object({ max: z.number().int().min(1).max(5) }).optional(),
};

export const SYSTEM_ACTIONS = ["workspace.checkout"] as const;

const agentStepSchema = z.object({
  ...stepCommon,
  kind: z.literal("agent"),
  model: z.object({ role: z.string() }),
  instructions: z.string().min(1),
  subagents: z.array(idSchema).default([]),
  skills: z.array(z.string()).default([]),
  mcpServers: z.array(idSchema).default([]),
});

const systemStepSchema = z.object({
  ...stepCommon,
  kind: z.literal("system"),
  action: z.enum(SYSTEM_ACTIONS),
});

export const stepSchema = z.discriminatedUnion("kind", [agentStepSchema, systemStepSchema]);

const approvalSchema = z.object({
  checkpoint: idSchema,
  title: localizedTextSchema,
  present: z.array(idSchema).default([]),
  timeout: durationSchema.default("24h"),
  onTimeout: z.enum(["cancel", "reject", "approve"]).default("cancel"),
});

const phaseSchema = z.object({
  id: idSchema,
  name: localizedTextSchema,
  approval: approvalSchema.optional(),
  steps: z.array(stepSchema).min(1),
});

const budgetsSchema = z.object({
  maxCostUsd: z.number().positive().optional(),
  maxDurationMinutes: z.number().int().positive().optional(),
  perPhase: z.record(idSchema, z.object({ maxCostUsd: z.number().positive() })).default({}),
});

const outputsSchema = z.object({
  artifacts: z
    .array(
      z.object({
        key: idSchema,
        kind: z.enum(ARTIFACT_KINDS),
        required: z.boolean().default(false),
      }),
    )
    .min(1),
  summary: z.object({ from: idSchema }).optional(),
});

export const templateDocSchema = z.object({
  apiVersion: z.literal("agrippa/v1"),
  kind: z.literal("OrchestrationTemplate"),
  metadata: z.object({
    slug: templateSlugSchema,
    scenario: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: localizedTextSchema,
    description: localizedTextSchema,
  }),
  spec: z.object({
    faber: idSchema,
    inputs: z.array(templateInputSchema).default([]),
    workspace: z
      .object({
        repo: z.string(),
        ref: z.string().optional(),
        access: z.enum(["readOnly", "readWrite"]).default("readOnly"),
      })
      .optional(),
    resources: z
      .object({
        skills: z.array(skillRefSchema).default([]),
        mcpServers: z.array(mcpRefSchema).default([]),
        subagents: z.array(subagentSchema).default([]),
      })
      .default({ skills: [], mcpServers: [], subagents: [] }),
    models: z.object({
      roles: z.record(z.string(), modelRoleSchema),
      allowProjectOverride: z.boolean().default(true),
    }),
    phases: z.array(phaseSchema).min(1),
    budgets: budgetsSchema.default({ perPhase: {} }),
    outputs: outputsSchema,
  }),
});

export type TemplateDoc = z.infer<typeof templateDocSchema>;
export type TemplateInput = z.infer<typeof templateInputSchema>;
export type TemplateStep = z.infer<typeof stepSchema>;
export type TemplatePhase = z.infer<typeof phaseSchema>;

/** "45m" | "24h" | "2d" → minutes */
export function durationToMinutes(duration: string): number {
  const value = Number(duration.slice(0, -1));
  const unit = duration.slice(-1);
  if (unit === "m") return value;
  if (unit === "h") return value * 60;
  return value * 60 * 24;
}
