import { type Db, runSteps } from "@agrippa/db";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { CompiledTemplate, TemplateStepV2 } from "./template-schema";
import { flattenPhases } from "./template-schema";

/**
 * The follow-up flow (ADR-0018 Decision 7).
 *
 * A follow-up does not re-enter the compiled template. Re-entry replays
 * answered checkpoints and reopens loops the run already closed, and the
 * obvious target templates end in `git.push` + `pr.open` — a steering message
 * would republish. Nor is it a new template kind: that would make every
 * template author responsible for a flow with exactly one correct shape.
 *
 * What executes is built in memory from the base template: the same agents,
 * models, resources and workspace, with a single agent step bound to the slot
 * and model role the parent last used. Attaching to the existing workspace is
 * asserted by the engine before the flow runs — see `workspace_lost`.
 */

/** The synthetic phase and step ids, stable so the timeline and tests can name them. */
export const FOLLOWUP_PHASE_ID = "followup";
export const FOLLOWUP_STEER_STEP_ID = "steer";

/**
 * Token bound for one follow-up. A follow-up's meter starts at zero, so the
 * base template's per-run limit — sized for a whole multi-phase flow — would
 * apply again to every steering message. Capped by the base limit when that
 * is smaller: a template that budgets less than this means it.
 */
function followupMaxTokens(base: CompiledTemplate): number {
  const raw = Number(process.env.AGRIPPA_FOLLOWUP_MAX_TOKENS ?? "");
  const bound = Number.isFinite(raw) && raw > 0 ? raw : 200_000;
  const baseLimit = base.spec.limits.maxTokens;
  return baseLimit ? Math.min(baseLimit, bound) : bound;
}

export type FollowupSeed = {
  /** Agent slot the parent's last agent step ran on. */
  slot: string;
  /** Model role that step used — the same agent, the same tier. */
  modelRole: string;
  /** The parent's executor session, if it left one. */
  sessionId: string | null;
  /** A patch-kind artifact key to re-diff into, when the base declares one. */
  patchArtifactKey: string | null;
};

/**
 * What the parent run ended up doing, so the follow-up continues THAT agent
 * rather than the template's first slot. Reads the last agent step row and
 * finds its step in the base template — the row records the slot, the
 * template records the model role.
 */
export async function followupSeed(
  db: Db,
  parentRunId: string,
  base: CompiledTemplate,
): Promise<FollowupSeed> {
  const agentStepIds = new Map<string, TemplateStepV2 & { kind: "agent" }>();
  for (const { phase } of flattenPhases(base.spec.phases)) {
    for (const step of phase.steps) {
      if (step.kind === "agent") agentStepIds.set(step.id, step);
    }
  }

  const rows = await db
    .select()
    .from(runSteps)
    .where(and(eq(runSteps.runId, parentRunId), eq(runSteps.status, "succeeded")))
    .orderBy(desc(runSteps.seq), desc(runSteps.attempt));
  const lastAgentRow = rows.find((row) => agentStepIds.has(row.stepId));
  const templateStep = lastAgentRow ? agentStepIds.get(lastAgentRow.stepId) : undefined;

  const slots = Object.keys(base.spec.agents);
  const slot = templateStep?.agent ?? lastAgentRow?.agentRef ?? (slots[0] as string);
  const modelRole = templateStep?.model.role ?? (Object.keys(base.spec.models.roles)[0] as string);

  // The session belongs to the agent's last conversation, which is not
  // necessarily its last SUCCEEDED step — a crashed attempt carries one too.
  // Read it separately so a run that ended on a system step (git.push) still
  // resumes the agent that did the work.
  const [sessionRow] = await db
    .select({ sessionId: runSteps.executorSessionId })
    .from(runSteps)
    .where(and(eq(runSteps.runId, parentRunId), isNotNull(runSteps.executorSessionId)))
    .orderBy(desc(runSteps.seq), desc(runSteps.attempt))
    .limit(1);

  const patch = base.spec.outputs.artifacts.find((artifact) => artifact.kind === "patch");

  return {
    slot,
    modelRole,
    sessionId: sessionRow?.sessionId ?? null,
    patchArtifactKey: patch?.key ?? null,
  };
}

/**
 * The in-memory template a follow-up executes: everything the base declares
 * about *what the agent is*, and a one-step flow for what it does now.
 *
 * The instructions here are engine-authored and free of template syntax; the
 * operator's message is appended by the engine AFTER interpolation, so a
 * message containing `${...}` is delivered rather than evaluated (ADR-0018
 * Decision 6).
 */
export function followupTemplate(base: CompiledTemplate, seed: FollowupSeed): CompiledTemplate {
  const produces = seed.patchArtifactKey && base.spec.workspace ? [seed.patchArtifactKey] : [];
  const steer: TemplateStepV2 = {
    id: FOLLOWUP_STEER_STEP_ID,
    kind: "agent",
    agent: seed.slot,
    model: { role: seed.modelRole },
    instructions:
      "You are continuing work you already did, in the same workspace, at the " +
      "request of the person who read your result. Their message follows. Do " +
      "what it asks and nothing beyond it; if it cannot be done, say so plainly " +
      "rather than doing something adjacent.",
    subagents: [],
    skills: [],
    mcpServers: [],
    produces,
    onFailure: "fail",
  };

  return {
    ...base,
    spec: {
      ...base.spec,
      phases: [
        {
          id: FOLLOWUP_PHASE_ID,
          name: { en: "Follow-up", "zh-CN": "追加" },
          steps: [steer],
        },
      ],
      // Nothing is required of a follow-up's outputs: it may only answer a
      // question. The patch key stays declared so a change to the workspace is
      // still captured as evidence, just never demanded.
      outputs: {
        ...base.spec.outputs,
        artifacts: base.spec.outputs.artifacts.map((artifact) => ({
          ...artifact,
          required: false,
        })),
      },
      limits: { ...base.spec.limits, maxTokens: followupMaxTokens(base), perPhase: {} },
    },
  };
}
