import { ARTIFACT_KINDS, MODEL_TIERS } from "@agrippa/core";
import { z } from "zod";

/**
 * Zod schemas for agrippa/v1 and agrippa/v2 orchestration templates
 * (docs/design/02-orchestration-template.md, ADR-0006, ADR-0010). Both locales
 * are required on every localizable field — builtin templates cannot ship
 * half-translated.
 *
 * v1 remains fully supported as an authoring format; the compiler upgrades it
 * to the v2 intermediate representation (`CompiledTemplate`) that the engine
 * and API consume. v2 adds agent slots, checkpoint steps, bounded loops, and
 * the git/PR system actions.
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

// ── agrippa/v2 (ADR-0010): agent slots, checkpoint steps, loops, SCM actions ──

/** Slot every v1 agent step is bound to after the upgrade to the v2 IR. */
export const AGENT_STEP_DEFAULT_SLOT = "main";

export const agentSlotSchema = z.object({
  /** Slot display name (e.g. Implementer / Reviewer). */
  label: localizedTextSchema,
  /** Default faber slug; resolved to a registry row at submit. */
  faber: idSchema,
  /** Default executor id from the core EXECUTOR_CATALOG (or the v1 sentinel). */
  executor: z.string().min(1),
  /** Whether the submitter may override faber/executor for this slot. */
  overridable: z.boolean().default(true),
});

const checkpointCommon = {
  title: localizedTextSchema,
  /** Artifact keys shown to the responder. */
  present: z.array(idSchema).default([]),
  timeout: durationSchema.default("24h"),
};

/**
 * `approval` gates on a human decision; `input` collects answers to the
 * questions artifact named by `source`; `review-gate` decides what happens to
 * the findings of the review-report artifact named by `source`. input and
 * review-gate auto-pass when their source artifact is absent or empty.
 */
export const checkpointSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("approval"),
    ...checkpointCommon,
    onTimeout: z.enum(["cancel", "reject", "approve"]).default("cancel"),
  }),
  z.object({
    kind: z.literal("input"),
    ...checkpointCommon,
    source: idSchema,
    onTimeout: z.literal("cancel").default("cancel"),
  }),
  z.object({
    kind: z.literal("review-gate"),
    ...checkpointCommon,
    source: idSchema,
    onTimeout: z.literal("cancel").default("cancel"),
  }),
]);

const agentStepV2Schema = z.object({
  ...stepCommon,
  kind: z.literal("agent"),
  /** Agent slot; the compiler defaults it to the first declared slot. */
  agent: idSchema.optional(),
  model: z.object({ role: z.string() }),
  instructions: z.string().min(1),
  subagents: z.array(idSchema).default([]),
  skills: z.array(z.string()).default([]),
  mcpServers: z.array(idSchema).default([]),
});

export const SYSTEM_ACTIONS_V2 = [
  "workspace.checkout",
  "git.branch",
  "git.push",
  "pr.open",
] as const;

const systemStepV2Schema = z.object({
  ...stepCommon,
  kind: z.literal("system"),
  action: z.enum(SYSTEM_ACTIONS_V2),
  /** Action config; values are interpolable `${...}` strings. */
  with: z.record(z.string(), z.string()).default({}),
});

const checkpointStepV2Schema = z.object({
  id: idSchema,
  kind: z.literal("checkpoint"),
  when: z.string().optional(),
  checkpoint: checkpointSpecSchema,
});

export const stepV2Schema = z.discriminatedUnion("kind", [
  agentStepV2Schema,
  systemStepV2Schema,
  checkpointStepV2Schema,
]);

const phaseV2Schema = z.object({
  id: idSchema,
  name: localizedTextSchema,
  steps: z.array(stepV2Schema).min(1),
});

/**
 * Bounded loop over a group of phases. `until` is evaluated after each
 * iteration; the static maxIterations bound keeps compiler validation total
 * (every reachable state is still enumerable — the ADR-0006 property).
 */
const loopNodeSchema = z.object({
  kind: z.literal("loop"),
  id: idSchema,
  name: localizedTextSchema,
  maxIterations: z.number().int().min(1).max(10),
  until: z.string().min(1),
  onMaxIterations: z.enum(["fail", "continue"]).default("fail"),
  phases: z.array(phaseV2Schema).min(1),
});

/** Top-level flow: plain phases and loop groups, in declaration order. */
export const flowNodeSchema = z.union([loopNodeSchema, phaseV2Schema]);

export const templateDocV2Schema = z.object({
  apiVersion: z.literal("agrippa/v2"),
  kind: z.literal("OrchestrationTemplate"),
  metadata: z.object({
    slug: templateSlugSchema,
    scenario: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: localizedTextSchema,
    description: localizedTextSchema,
  }),
  spec: z.object({
    agents: z
      .record(idSchema, agentSlotSchema)
      .refine((agents) => Object.keys(agents).length > 0, { message: "at least one agent slot" }),
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
    phases: z.array(flowNodeSchema).min(1),
    budgets: budgetsSchema.default({ perPhase: {} }),
    outputs: outputsSchema,
  }),
});

export type TemplateDocV2 = z.infer<typeof templateDocV2Schema>;
/** The engine/API-facing IR — always v2-shaped; v1 docs are upgraded into it. */
export type CompiledTemplate = TemplateDocV2;
export type AgentSlot = z.infer<typeof agentSlotSchema>;
export type CheckpointSpec = z.infer<typeof checkpointSpecSchema>;
export type TemplateStepV2 = z.infer<typeof stepV2Schema>;
export type TemplatePhaseV2 = z.infer<typeof phaseV2Schema>;
export type LoopNode = z.infer<typeof loopNodeSchema>;
export type FlowNode = z.infer<typeof flowNodeSchema>;

export function isLoopNode(node: FlowNode): node is LoopNode {
  return "kind" in node && (node as { kind?: string }).kind === "loop";
}

/** Every phase in flow order, with the loop (if any) it belongs to. */
export function flattenPhases(
  nodes: FlowNode[],
): Array<{ phase: TemplatePhaseV2; loop: LoopNode | null }> {
  const flat: Array<{ phase: TemplatePhaseV2; loop: LoopNode | null }> = [];
  for (const node of nodes) {
    if (isLoopNode(node)) {
      for (const phase of node.phases) flat.push({ phase, loop: node });
    } else {
      flat.push({ phase: node, loop: null });
    }
  }
  return flat;
}

/** "45m" | "24h" | "2d" → minutes */
export function durationToMinutes(duration: string): number {
  const value = Number(duration.slice(0, -1));
  const unit = duration.slice(-1);
  if (unit === "m") return value;
  if (unit === "h") return value * 60;
  return value * 60 * 24;
}
