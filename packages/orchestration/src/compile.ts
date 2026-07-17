import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { expressionRoots, extractPlaceholders, normalizeConditionExpression } from "./expression";
import { type TemplateDoc, templateDocSchema } from "./template-schema";

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
  compiled: TemplateDoc;
  /** sha256 of the source YAML; guards builtin re-seeding. */
  checksum: string;
};

const ALLOWED_ROOTS = new Set(["inputs", "steps", "run", "project"]);

export function skillSlugOfRef(ref: string): string {
  return ref.split("@")[0] as string;
}

/**
 * Parse YAML → zod-validate → semantic checks → resolve promptFiles.
 * Throws TemplateValidationError listing every issue found (not just the first).
 */
export function compileTemplate(sourceYaml: string, options: CompileOptions = {}): CompileResult {
  let raw: unknown;
  try {
    raw = parseYaml(sourceYaml);
  } catch (err) {
    throw new TemplateValidationError([`invalid YAML: ${(err as Error).message}`]);
  }

  const parsed = templateDocSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TemplateValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  const doc = parsed.data;
  const issues: string[] = [];
  const spec = doc.spec;

  // ── Uniqueness ──────────────────────────────────────────────────────────────
  const phaseIds = spec.phases.map((p) => p.id);
  if (new Set(phaseIds).size !== phaseIds.length) issues.push("duplicate phase ids");
  const allSteps = spec.phases.flatMap((p) => p.steps.map((s) => ({ phase: p.id, step: s })));
  const stepIds = allSteps.map((s) => s.step.id);
  if (new Set(stepIds).size !== stepIds.length) issues.push("duplicate step ids across phases");
  const inputKeys = new Set(spec.inputs.map((i) => i.key));
  if (inputKeys.size !== spec.inputs.length) issues.push("duplicate input keys");

  // ── Reference integrity ─────────────────────────────────────────────────────
  const roleNames = new Set(Object.keys(spec.models.roles));
  const subagentIds = new Set(spec.resources.subagents.map((s) => s.id));
  const skillSlugs = new Set(spec.resources.skills.map((s) => skillSlugOfRef(s.ref)));
  const mcpRefs = new Set(spec.resources.mcpServers.map((m) => m.ref));
  const artifactKeys = new Set(spec.outputs.artifacts.map((a) => a.key));

  for (const subagent of spec.resources.subagents) {
    if (!roleNames.has(subagent.model.role)) {
      issues.push(`subagent ${subagent.id}: unknown model role '${subagent.model.role}'`);
    }
  }

  const producedKeys = new Set<string>();
  for (const { phase, step } of allSteps) {
    const where = `phase ${phase} step ${step.id}`;
    if (step.kind === "agent") {
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
    for (const ref of step.requires?.mcpServers ?? []) {
      if (!mcpRefs.has(ref)) issues.push(`${where}: requires unknown mcp server '${ref}'`);
    }
    for (const key of step.produces) {
      if (!artifactKeys.has(key)) {
        issues.push(`${where}: produces '${key}' which is not in outputs.artifacts`);
      }
      producedKeys.add(key);
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

  for (const phaseId of Object.keys(spec.budgets.perPhase)) {
    if (!phaseIds.includes(phaseId)) issues.push(`budgets.perPhase: unknown phase '${phaseId}'`);
  }
  for (const phase of spec.phases) {
    for (const key of phase.approval?.present ?? []) {
      if (!artifactKeys.has(key)) {
        issues.push(`phase ${phase.id}: approval presents unknown artifact '${key}'`);
      }
    }
  }

  // ── Expression validation (placeholders + when) ────────────────────────────
  const seenStepIds = new Set<string>();
  const checkExpression = (expr: string, where: string): void => {
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
    // referenced inputs must exist; referenced steps must be defined earlier
    for (const match of expr.matchAll(/\binputs\.([a-zA-Z][a-zA-Z0-9]*)/g)) {
      if (!inputKeys.has(match[1] as string)) {
        issues.push(`${where}: unknown input '${match[1]}'`);
      }
    }
    for (const match of expr.matchAll(/\bsteps\.([a-z][a-z0-9-]*)/g)) {
      if (!seenStepIds.has(match[1] as string)) {
        issues.push(`${where}: references step '${match[1]}' which is not defined earlier`);
      }
    }
  };
  const checkText = (text: string, where: string): void => {
    for (const expr of extractPlaceholders(text)) checkExpression(expr, where);
  };

  if (spec.workspace) {
    checkText(spec.workspace.repo, "workspace.repo");
    if (spec.workspace.ref) checkText(spec.workspace.ref, "workspace.ref");
  }
  for (const { phase, step } of allSteps) {
    const where = `phase ${phase} step ${step.id}`;
    if (step.when) {
      step.when = normalizeConditionExpression(step.when);
      checkExpression(step.when, `${where} when`);
    }
    if (step.kind === "agent") checkText(step.instructions, `${where} instructions`);
    seenStepIds.add(step.id);
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
