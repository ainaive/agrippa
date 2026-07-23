import { createHash } from "node:crypto";
import { EXECUTOR_CATALOG, EXECUTOR_DEFAULT_SENTINEL, isExecutorId } from "@agrippa/core";
import { parse as parseYaml } from "yaml";
import { expressionRoots, extractPlaceholders, normalizeConditionExpression } from "./expression";
import {
  AGENT_STEP_DEFAULT_SLOT,
  type CompiledTemplate,
  flattenPhases,
  isLoopNode,
  type TemplateDoc,
  templateDocSchema,
  templateDocV2Schema,
} from "./template-schema";

export class TemplateValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`template validation failed:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "TemplateValidationError";
  }
}

export type CompileOptions = {
  /** Resolves subagent promptFile references (e.g. against templates/). */
  resolveFile?: (path: string) => string | undefined;
};

export type CompileResult = {
  compiled: CompiledTemplate;
  /** sha256 of the source YAML; guards builtin re-seeding. */
  checksum: string;
};

const ALLOWED_ROOTS = new Set(["inputs", "steps", "run", "project", "checkpoints", "artifacts"]);

export function skillSlugOfRef(ref: string): string {
  return ref.split("@")[0] as string;
}

/**
 * Pure v1 → v2 IR upgrade: one non-overridable `main` slot bound to the v1
 * faber and the deployment-default executor (resolved at submit), and each
 * phase `approval:` becomes a synthetic approval checkpoint step prepended to
 * the phase — same gate position, same semantics.
 */
export function upgradeV1ToV2(doc: TemplateDoc): CompiledTemplate {
  const spec = doc.spec;
  return {
    apiVersion: "agrippa/v2",
    kind: doc.kind,
    metadata: doc.metadata,
    spec: {
      agents: {
        [AGENT_STEP_DEFAULT_SLOT]: {
          label: { en: "Agent", "zh-CN": "智能体" },
          faber: spec.faber,
          executor: EXECUTOR_DEFAULT_SENTINEL,
          overridable: false,
        },
      },
      inputs: spec.inputs,
      workspace: spec.workspace,
      resources: spec.resources,
      models: spec.models,
      phases: spec.phases.map((phase) => ({
        id: phase.id,
        name: phase.name,
        steps: [
          ...(phase.approval
            ? [
                {
                  id: phase.approval.checkpoint,
                  kind: "checkpoint" as const,
                  checkpoint: {
                    kind: "approval" as const,
                    title: phase.approval.title,
                    present: phase.approval.present,
                    timeout: phase.approval.timeout,
                    onTimeout: phase.approval.onTimeout,
                  },
                },
              ]
            : []),
          ...phase.steps.map((step) =>
            step.kind === "agent"
              ? { ...step, agent: AGENT_STEP_DEFAULT_SLOT }
              : { ...step, with: {} },
          ),
        ],
      })),
      budgets: spec.budgets,
      outputs: spec.outputs,
    },
  };
}

/**
 * Normalize a stored `template_versions.compiled` value to the v2 IR. Rows
 * published before the v2 format hold validated v1 docs; the upgrade is pure,
 * so no data migration is needed and old runs re-resolve identically.
 */
export function upgradeCompiledTemplate(raw: unknown): CompiledTemplate {
  const apiVersion = (raw as { apiVersion?: unknown } | null)?.apiVersion;
  if (apiVersion === "agrippa/v2") return raw as CompiledTemplate;
  return upgradeV1ToV2(raw as TemplateDoc);
}

/**
 * Parse YAML → zod-validate (v1 or v2) → upgrade v1 to the v2 IR → semantic
 * checks → resolve promptFiles.
 * Throws TemplateValidationError listing every issue found (not just the first).
 */
export function compileTemplate(sourceYaml: string, options: CompileOptions = {}): CompileResult {
  let raw: unknown;
  try {
    raw = parseYaml(sourceYaml);
  } catch (err) {
    throw new TemplateValidationError([`invalid YAML: ${(err as Error).message}`]);
  }

  const apiVersion = (raw as { apiVersion?: unknown } | null)?.apiVersion;
  let doc: CompiledTemplate;
  if (apiVersion === "agrippa/v1") {
    const parsed = templateDocSchema.safeParse(raw);
    if (!parsed.success) {
      throw new TemplateValidationError(
        parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      );
    }
    doc = upgradeV1ToV2(parsed.data);
  } else if (apiVersion === "agrippa/v2") {
    const parsed = templateDocV2Schema.safeParse(raw);
    if (!parsed.success) {
      throw new TemplateValidationError(
        parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      );
    }
    doc = parsed.data;
  } else {
    throw new TemplateValidationError(["apiVersion must be 'agrippa/v1' or 'agrippa/v2'"]);
  }

  const issues: string[] = [];
  const spec = doc.spec;
  const slotNames = Object.keys(spec.agents);
  const defaultSlot = slotNames[0] as string;

  // ── Uniqueness ──────────────────────────────────────────────────────────────
  const nodeIds = spec.phases.map((n) => n.id);
  const innerPhaseIds = spec.phases.flatMap((n) =>
    isLoopNode(n) ? n.phases.map((p) => p.id) : [],
  );
  const allNodeIds = [...nodeIds, ...innerPhaseIds];
  if (new Set(allNodeIds).size !== allNodeIds.length) issues.push("duplicate phase/loop ids");
  const phases = flattenPhases(spec.phases);
  const allSteps = phases.flatMap(({ phase, loop }) =>
    phase.steps.map((s) => ({ phase: phase.id, loop: loop?.id ?? null, step: s })),
  );
  const stepIds = allSteps.map((s) => s.step.id);
  if (new Set(stepIds).size !== stepIds.length) issues.push("duplicate step ids across phases");
  const inputKeys = new Set(spec.inputs.map((i) => i.key));
  if (inputKeys.size !== spec.inputs.length) issues.push("duplicate input keys");

  // ── Reference integrity ─────────────────────────────────────────────────────
  const roleNames = new Set(Object.keys(spec.models.roles));
  const subagentIds = new Set(spec.resources.subagents.map((s) => s.id));
  const skillSlugs = new Set(spec.resources.skills.map((s) => skillSlugOfRef(s.ref)));
  const mcpRefs = new Set(spec.resources.mcpServers.map((m) => m.ref));
  const artifactKinds = new Map(spec.outputs.artifacts.map((a) => [a.key, a.kind]));
  const artifactKeys = new Set(artifactKinds.keys());
  // checkpoint id → owning loop id (null outside loops), for reference rules
  const checkpointLoop = new Map<string, string | null>();
  for (const { loop, step } of allSteps) {
    if (step.kind === "checkpoint") checkpointLoop.set(step.id, loop);
  }

  for (const subagent of spec.resources.subagents) {
    if (!roleNames.has(subagent.model.role)) {
      issues.push(`subagent ${subagent.id}: unknown model role '${subagent.model.role}'`);
    }
  }

  const producedKeys = new Set<string>();
  for (const { phase, step } of allSteps) {
    const where = `phase ${phase} step ${step.id}`;
    if (step.kind === "agent") {
      // normalize the slot so the engine never has to default it
      step.agent = step.agent ?? defaultSlot;
      const slot = spec.agents[step.agent];
      if (!slot) {
        issues.push(`${where}: unknown agent slot '${step.agent}'`);
      } else if (slot.executor !== EXECUTOR_DEFAULT_SENTINEL) {
        // capability check against the slot's *default* executor; submit-time
        // overrides re-check against the actual binding (validateAgentBindings)
        if (!isExecutorId(slot.executor)) {
          issues.push(`agents.${step.agent}: unknown executor '${slot.executor}'`);
        } else {
          const caps = EXECUTOR_CATALOG[slot.executor].capabilities;
          if (!caps.subagents && step.subagents.length > 0) {
            issues.push(`${where}: executor '${slot.executor}' does not support subagents`);
          }
          if (!caps.skills && step.skills.length > 0) {
            issues.push(`${where}: executor '${slot.executor}' does not support skills`);
          }
          if (!caps.mcp && step.mcpServers.length > 0) {
            issues.push(`${where}: executor '${slot.executor}' does not support MCP servers`);
          }
        }
      }
      if (!roleNames.has(step.model.role)) {
        issues.push(`${where}: unknown model role '${step.model.role}'`);
      }
      for (const ref of step.subagents) {
        if (!subagentIds.has(ref)) issues.push(`${where}: unknown subagent '${ref}'`);
      }
      for (const ref of step.skills) {
        if (!skillSlugs.has(skillSlugOfRef(ref)))
          issues.push(`${where}: skill '${ref}' not in resources.skills`);
      }
      for (const ref of step.mcpServers) {
        if (!mcpRefs.has(ref))
          issues.push(`${where}: mcp server '${ref}' not in resources.mcpServers`);
      }
    }
    if (step.kind === "checkpoint") {
      const spec_ = step.checkpoint;
      for (const key of spec_.present) {
        if (!artifactKeys.has(key)) issues.push(`${where}: presents unknown artifact '${key}'`);
      }
      if (spec_.kind !== "approval") {
        if (!artifactKeys.has(spec_.source)) {
          issues.push(`${where}: source '${spec_.source}' is not a declared artifact`);
        } else if (artifactKinds.get(spec_.source) !== "json") {
          issues.push(`${where}: source '${spec_.source}' must be a json artifact`);
        }
      }
    }
    if (step.kind === "system") {
      if (step.action !== "workspace.checkout" && spec.workspace?.access !== "readWrite") {
        issues.push(`${where}: ${step.action} requires a readWrite workspace`);
      }
      if (step.action === "pr.open") {
        if (step.produces.length !== 1) {
          issues.push(`${where}: pr.open must produce exactly one link artifact`);
        } else if (artifactKinds.get(step.produces[0] as string) !== "link") {
          issues.push(`${where}: pr.open must produce a 'link' artifact`);
        }
      } else if (step.produces.length > 0) {
        issues.push(`${where}: ${step.action} must not declare produces`);
      }
    }
    if (step.kind !== "checkpoint") {
      for (const ref of step.requires?.mcpServers ?? []) {
        if (!mcpRefs.has(ref)) issues.push(`${where}: requires unknown mcp server '${ref}'`);
      }
      for (const ref of step.requires?.skills ?? []) {
        if (!skillSlugs.has(skillSlugOfRef(ref)))
          issues.push(`${where}: requires unknown skill '${ref}'`);
      }
      for (const key of step.produces) {
        if (!artifactKeys.has(key)) {
          issues.push(`${where}: produces '${key}' which is not in outputs.artifacts`);
        }
        producedKeys.add(key);
      }
    }
  }

  for (const artifact of spec.outputs.artifacts) {
    if (artifact.required && !producedKeys.has(artifact.key)) {
      issues.push(`required artifact '${artifact.key}' is not produced by any step`);
    }
  }
  if (spec.outputs.summary && !artifactKeys.has(spec.outputs.summary.from)) {
    issues.push(`outputs.summary.from '${spec.outputs.summary.from}' is not a declared artifact`);
  }

  const budgetablePhaseIds = new Set([...phases.map((p) => p.phase.id)]);
  for (const phaseId of Object.keys(spec.budgets.perPhase)) {
    if (!budgetablePhaseIds.has(phaseId)) {
      issues.push(`budgets.perPhase: unknown phase '${phaseId}'`);
    }
  }

  // ── Expression validation (placeholders, when, until) ───────────────────────
  const seenStepIds = new Set<string>();
  const seenCheckpointIds = new Set<string>();
  const checkExpression = (expr: string, where: string, currentLoop: string | null): void => {
    let roots: string[];
    try {
      roots = expressionRoots(expr);
    } catch (err) {
      issues.push(`${where}: ${(err as Error).message}`);
      return;
    }
    for (const root of roots) {
      if (!ALLOWED_ROOTS.has(root)) {
        issues.push(`${where}: unknown context root '${root}'`);
      }
    }
    // referenced inputs/artifacts must exist; steps must be defined earlier;
    // checkpoints must be defined earlier OR live in the same loop (where a
    // forward reference resolves to the previous iteration's response)
    for (const match of expr.matchAll(/\binputs\.([a-zA-Z][a-zA-Z0-9]*)/g)) {
      if (!inputKeys.has(match[1] as string)) {
        issues.push(`${where}: unknown input '${match[1]}'`);
      }
    }
    for (const match of expr.matchAll(/\bartifacts\.([a-z][a-z0-9-]*)/g)) {
      if (!artifactKeys.has(match[1] as string)) {
        issues.push(`${where}: unknown artifact '${match[1]}'`);
      }
    }
    for (const match of expr.matchAll(/\bsteps\.([a-z][a-z0-9-]*)/g)) {
      if (!seenStepIds.has(match[1] as string)) {
        issues.push(`${where}: references step '${match[1]}' which is not defined earlier`);
      }
    }
    for (const match of expr.matchAll(/\bcheckpoints\.([a-z][a-z0-9-]*)/g)) {
      const id = match[1] as string;
      if (!checkpointLoop.has(id)) {
        issues.push(`${where}: unknown checkpoint '${id}'`);
      } else if (
        !seenCheckpointIds.has(id) &&
        !(currentLoop !== null && checkpointLoop.get(id) === currentLoop)
      ) {
        issues.push(
          `${where}: references checkpoint '${id}' which is neither earlier nor in the same loop`,
        );
      }
    }
  };
  const checkText = (text: string, where: string, currentLoop: string | null): void => {
    for (const expr of extractPlaceholders(text)) checkExpression(expr, where, currentLoop);
  };

  if (spec.workspace) {
    checkText(spec.workspace.repo, "workspace.repo", null);
    if (spec.workspace.ref) checkText(spec.workspace.ref, "workspace.ref", null);
  }
  for (const node of spec.phases) {
    const loopId = isLoopNode(node) ? node.id : null;
    const nodePhases = isLoopNode(node) ? node.phases : [node];
    for (const phase of nodePhases) {
      for (const step of phase.steps) {
        const where = `phase ${phase.id} step ${step.id}`;
        if (step.when) {
          step.when = normalizeConditionExpression(step.when);
          checkExpression(step.when, `${where} when`, loopId);
        }
        if (step.kind === "agent") checkText(step.instructions, `${where} instructions`, loopId);
        if (step.kind === "system") {
          for (const [key, value] of Object.entries(step.with)) {
            checkText(value, `${where} with.${key}`, loopId);
          }
        }
        if (step.kind === "checkpoint") seenCheckpointIds.add(step.id);
        seenStepIds.add(step.id);
      }
    }
    if (isLoopNode(node)) {
      // validated after the loop body so same-loop steps/checkpoints are seen
      node.until = normalizeConditionExpression(node.until);
      checkExpression(node.until, `loop ${node.id} until`, node.id);
    }
  }

  // ── Resolve subagent prompt files ───────────────────────────────────────────
  for (const subagent of spec.resources.subagents) {
    if (subagent.promptFile !== undefined) {
      const content = options.resolveFile?.(subagent.promptFile);
      if (content === undefined) {
        issues.push(`subagent ${subagent.id}: promptFile '${subagent.promptFile}' not found`);
      } else {
        subagent.prompt = content;
        subagent.promptFile = undefined;
      }
    }
  }

  if (issues.length > 0) throw new TemplateValidationError(issues);

  const checksum = createHash("sha256").update(sourceYaml).digest("hex");
  return { compiled: doc, checksum };
}
