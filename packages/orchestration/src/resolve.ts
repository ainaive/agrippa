import type { ModelTier } from "@agrippa/core";
import { type Db, models, projectResourceGrants } from "@agrippa/db";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { TemplateDoc, TemplateInput } from "./template-schema";

/**
 * Submit-time resolution (docs/design/04): validate params against the
 * compiled input schema, resolve model roles against the project's granted
 * registry, and verify required skills/MCP grants — all before a run row
 * exists, so failures are fast and actionable.
 */

export class SubmitError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "SubmitError";
  }
}

/** The same compiled inputs drive the SPA form and this server-side validator. */
export function buildParamsValidator(inputs: TemplateInput[]): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const input of inputs) {
    let schema: z.ZodType;
    switch (input.type) {
      case "string":
      case "text":
        schema = input.required ? z.string().min(1) : z.string();
        break;
      case "number":
        schema = z.number();
        break;
      case "boolean":
        schema = z.boolean();
        break;
      case "select": {
        const values = (input.options ?? []).map((o) => o.value);
        schema = z.enum(values as [string, ...string[]]);
        break;
      }
      case "repoRef":
        schema = z.object({ repoConnectionId: z.uuid() });
        break;
      case "docRef":
        schema = z.object({ docId: z.string().min(1) });
        break;
    }
    if (input.default !== undefined) {
      schema = schema.default(input.default as never);
    } else if (!input.required) {
      schema = schema.optional();
    }
    shape[input.key] = schema;
  }
  return z.strictObject(shape) as z.ZodType<Record<string, unknown>>;
}

export type ModelResolutionEntry = {
  role: string;
  tier: ModelTier;
  modelId: string;
  provider: string;
  providerModelId: string;
  inputCostPerMtok: number;
  outputCostPerMtok: number;
};

export type ModelResolution = Record<string, ModelResolutionEntry>;

/**
 * role → tier → cheapest granted active model; falls through the template's
 * fallback tiers; frozen into runs.model_resolution at submit.
 */
export async function resolveModelRoles(
  db: Db,
  projectId: string,
  spec: TemplateDoc["spec"]["models"],
): Promise<ModelResolution> {
  const grants = await db
    .select({ resourceId: projectResourceGrants.resourceId })
    .from(projectResourceGrants)
    .where(
      and(
        eq(projectResourceGrants.projectId, projectId),
        eq(projectResourceGrants.resourceType, "model"),
      ),
    );
  const grantedIds = grants.map((g) => g.resourceId);
  if (grantedIds.length === 0) {
    throw new SubmitError("no_models_granted", "No models are granted to this project");
  }
  const granted = await db
    .select()
    .from(models)
    .where(and(inArray(models.id, grantedIds), eq(models.status, "active")));

  const byTier = new Map<string, typeof granted>();
  for (const model of granted) {
    const list = byTier.get(model.tier) ?? [];
    list.push(model);
    byTier.set(model.tier, list);
  }
  for (const list of byTier.values()) {
    list.sort((a, b) => Number(a.inputCostPerMtok ?? 0) - Number(b.inputCostPerMtok ?? 0));
  }

  const resolution: ModelResolution = {};
  for (const [role, policy] of Object.entries(spec.roles)) {
    const tiers: ModelTier[] = [policy.tier, ...policy.fallback];
    const model = tiers.map((tier) => byTier.get(tier)?.[0]).find((m) => m !== undefined);
    if (!model) {
      throw new SubmitError(
        "model_unresolvable",
        `No granted model satisfies role '${role}' (tiers: ${tiers.join(" → ")})`,
      );
    }
    resolution[role] = {
      role,
      tier: model.tier,
      modelId: model.id,
      provider: model.provider,
      providerModelId: model.providerModelId,
      inputCostPerMtok: Number(model.inputCostPerMtok ?? 0),
      outputCostPerMtok: Number(model.outputCostPerMtok ?? 0),
    };
  }
  return resolution;
}

/** Required (non-optional) skills and MCP servers must be granted to the project. */
export async function verifyResourceGrants(
  db: Db,
  projectId: string,
  compiled: TemplateDoc,
  registry: {
    skillIdBySlug: Map<string, string>;
    mcpIdBySlug: Map<string, string>;
  },
): Promise<void> {
  const grants = await db
    .select()
    .from(projectResourceGrants)
    .where(eq(projectResourceGrants.projectId, projectId));
  const grantedByType = new Map<string, Set<string>>();
  for (const grant of grants) {
    const set = grantedByType.get(grant.resourceType) ?? new Set();
    set.add(grant.resourceId);
    grantedByType.set(grant.resourceType, set);
  }

  for (const skill of compiled.spec.resources.skills) {
    if (skill.optional) continue;
    const slug = skill.ref.split("@")[0] as string;
    const id = registry.skillIdBySlug.get(slug);
    if (!id) throw new SubmitError("skill_unregistered", `Skill '${slug}' is not registered`);
    if (!grantedByType.get("skill")?.has(id)) {
      throw new SubmitError("skill_not_granted", `Skill '${slug}' is not granted to this project`);
    }
  }
  for (const server of compiled.spec.resources.mcpServers) {
    if (server.optional) continue;
    const id = registry.mcpIdBySlug.get(server.ref);
    if (!id) {
      throw new SubmitError("mcp_unregistered", `MCP server '${server.ref}' is not registered`);
    }
    if (!grantedByType.get("mcp_server")?.has(id)) {
      throw new SubmitError(
        "mcp_not_granted",
        `MCP server '${server.ref}' is not granted to this project`,
      );
    }
  }
}
