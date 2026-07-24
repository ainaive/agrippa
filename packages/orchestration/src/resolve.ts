import {
  EXECUTOR_CATALOG,
  EXECUTOR_DEFAULT_SENTINEL,
  type ExecutorCatalogEntry,
  isCredentialGatedExecutor,
  isExecutorId,
  type ModelTier,
  providerAuthPolicy,
} from "@agrippa/core";
import {
  type Db,
  fabri,
  models,
  projectResourceGrants,
  providerCredentials,
  repoConnections,
} from "@agrippa/db";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { type CompiledTemplate, flattenPhases, type TemplateInput } from "./template-schema";

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

/** The slice of a granted model row that resolution needs (drizzle rows conform). */
export type GrantedModelRow = {
  id: string;
  provider: string;
  providerModelId: string;
  tier: ModelTier;
  inputCostPerMtok: string | null;
  outputCostPerMtok: string | null;
};

/** role → cheapest model for its tier chain from a pre-bucketed candidate set. */
function resolveRolesFrom(
  candidates: GrantedModelRow[],
  roleSpecs: CompiledTemplate["spec"]["models"]["roles"],
  roles: ReadonlySet<string>,
): { resolution: ModelResolution } | { missingRole: string; tiers: ModelTier[] } {
  const byTier = new Map<string, GrantedModelRow[]>();
  for (const model of candidates) {
    const list = byTier.get(model.tier) ?? [];
    list.push(model);
    byTier.set(model.tier, list);
  }
  for (const list of byTier.values()) {
    list.sort((a, b) => Number(a.inputCostPerMtok ?? 0) - Number(b.inputCostPerMtok ?? 0));
  }
  const resolution: ModelResolution = {};
  for (const [role, policy] of Object.entries(roleSpecs)) {
    if (!roles.has(role)) continue;
    const tiers: ModelTier[] = [policy.tier, ...policy.fallback];
    const model = tiers.map((tier) => byTier.get(tier)?.[0]).find((m) => m !== undefined);
    if (!model) return { missingRole: role, tiers };
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
  return { resolution };
}

/**
 * Resolve one agent slot's model roles — pure, so the ranking rules are
 * unit-testable without a database.
 *
 * With a provider-constrained executor the slot resolves **single-provider**:
 * a step's base URL is process-wide and its subagents resolve sibling roles
 * inside the same query, so mixing providers within a slot cannot execute.
 * Candidates are the executor's catalog providers minus those whose catalog
 * auth policy demands a project credential the project doesn't have; each
 * remaining candidate must satisfy ALL the slot's roles (tier → fallback,
 * cheapest in tier). Ties rank: has a project credential, then lowest total
 * input cost over the resolved roles, then provider id — deterministic.
 *
 * `providers === "*"` (demo/fake or an uncataloged custom executor) keeps the
 * legacy mixed-provider resolution with no credential gating, so token-free
 * demo deployments behave exactly as before.
 */
export function resolveSlotModels(args: {
  slotId: string;
  granted: GrantedModelRow[];
  roleSpecs: CompiledTemplate["spec"]["models"]["roles"];
  roles: ReadonlySet<string>;
  providers: readonly string[] | "*";
  credentialed: ReadonlySet<string>;
}): ModelResolution {
  const { slotId, granted, roleSpecs, roles, providers, credentialed } = args;
  if (roles.size === 0) return {};
  if (granted.length === 0) {
    throw new SubmitError("no_models_granted", "No models are granted to this project");
  }

  if (providers === "*") {
    const result = resolveRolesFrom(granted, roleSpecs, roles);
    if ("resolution" in result) return result.resolution;
    throw new SubmitError(
      "model_unresolvable",
      `No granted model satisfies role '${result.missingRole}' (tiers: ${result.tiers.join(" → ")})`,
    );
  }

  const successes: Array<{ provider: string; resolution: ModelResolution; totalCost: number }> = [];
  const credentialOnlyBlocked: string[] = [];
  const reasons: string[] = [];
  for (const provider of providers) {
    const result = resolveRolesFrom(
      granted.filter((m) => m.provider === provider),
      roleSpecs,
      roles,
    );
    const needsCredential =
      providerAuthPolicy(provider) === "project" && !credentialed.has(provider);
    if ("resolution" in result && !needsCredential) {
      const totalCost = Object.values(result.resolution).reduce(
        (sum, entry) => sum + entry.inputCostPerMtok,
        0,
      );
      successes.push({ provider, resolution: result.resolution, totalCost });
    } else if ("resolution" in result) {
      credentialOnlyBlocked.push(provider);
      reasons.push(`provider ${provider} — requires a project credential`);
    } else {
      reasons.push(
        `provider ${provider} — no granted model satisfies role '${result.missingRole}' (tiers: ${result.tiers.join(" → ")})`,
      );
    }
  }

  if (successes.length === 0) {
    if (credentialOnlyBlocked.length > 0) {
      throw new SubmitError(
        "provider_credential_required",
        `Agent slot '${slotId}' needs a project credential for provider ${credentialOnlyBlocked.join(
          " or ",
        )} (project settings → providers)`,
        { providers: credentialOnlyBlocked },
      );
    }
    throw new SubmitError(
      "model_unresolvable",
      `No granted model satisfies agent slot '${slotId}': ${reasons.join("; ")}`,
    );
  }

  successes.sort((a, b) => {
    const aCred = credentialed.has(a.provider) ? 0 : 1;
    const bCred = credentialed.has(b.provider) ? 0 : 1;
    if (aCred !== bCred) return aCred - bCred;
    if (a.totalCost !== b.totalCost) return a.totalCost - b.totalCost;
    return a.provider < b.provider ? -1 : 1;
  });
  return (successes[0] as (typeof successes)[number]).resolution;
}

/** Granted active model rows for a project (grants ∩ active registry rows). */
async function fetchGrantedModels(db: Db, projectId: string): Promise<GrantedModelRow[]> {
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
  if (grantedIds.length === 0) return [];
  return db
    .select()
    .from(models)
    .where(and(inArray(models.id, grantedIds), eq(models.status, "active")));
}

/**
 * The set of model roles each agent slot's steps actually reference — the
 * step's own role plus the roles of its subagents. A slot resolves only this
 * set, so a template mixing providers across slots no longer forces every
 * project to grant models for roles a slot never runs.
 */
export function slotRoleSets(compiled: CompiledTemplate): Map<string, Set<string>> {
  const slotIds = Object.keys(compiled.spec.agents);
  const sets = new Map<string, Set<string>>(slotIds.map((id) => [id, new Set<string>()]));
  const subagentRole = new Map(compiled.spec.resources.subagents.map((s) => [s.id, s.model.role]));
  const steps = flattenPhases(compiled.spec.phases).flatMap(({ phase }) => phase.steps);
  for (const step of steps) {
    if (step.kind !== "agent") continue;
    const set = sets.get(step.agent ?? (slotIds[0] as string));
    if (!set) continue; // compile validates slot refs; defensive
    set.add(step.model.role);
    for (const id of step.subagents) {
      const role = subagentRole.get(id);
      if (role !== undefined) set.add(role);
    }
  }
  return sets;
}

/**
 * All-roles resolution against a project's grants — role → tier → cheapest
 * granted active model, frozen into runs.model_resolution at submit. Kept as
 * the general-purpose entry point (compliance fixtures seed runs with it);
 * slot-scoped submission goes through resolveSlotModels via
 * resolveAgentBindings. Explicit provider lists resolve single-provider with
 * every listed provider treated as credentialed (no gating at this layer).
 */
export async function resolveModelRoles(
  db: Db,
  projectId: string,
  spec: CompiledTemplate["spec"]["models"],
  providers: readonly string[] | "*" = "*",
): Promise<ModelResolution> {
  return resolveSlotModels({
    slotId: "main",
    granted: await fetchGrantedModels(db, projectId),
    roleSpecs: spec.roles,
    roles: new Set(Object.keys(spec.roles)),
    providers,
    credentialed: new Set(providers === "*" ? [] : providers),
  });
}

/**
 * Re-assert that every provider a frozen model resolution depends on still
 * has its required project credential. Retries copy the resolution verbatim,
 * so a credential deleted between runs would otherwise surface only as an
 * auth failure mid-run instead of an actionable submit error. Handles both
 * resolution shapes (legacy flat role → entry and slot-keyed) and skips
 * slots bound to the fake or an uncataloged executor — those resolved with
 * no credential gating in the first place.
 */
export async function assertResolutionCredentialed(
  db: Db,
  projectId: string,
  modelResolution: Record<string, unknown>,
  agentBindings: Record<string, { executorId: string }> | null,
  executorId: string,
): Promise<void> {
  const required = new Set<string>();
  const collect = (entries: ModelResolutionEntry[]): void => {
    for (const entry of entries) {
      if (providerAuthPolicy(entry.provider) === "project") required.add(entry.provider);
    }
  };
  const values = Object.values(modelResolution ?? {});
  const flat = values.every(
    (v) => v !== null && typeof v === "object" && "providerModelId" in (v as object),
  );
  if (flat) {
    if (isCredentialGatedExecutor(executorId)) collect(values as ModelResolutionEntry[]);
  } else {
    for (const [slot, resolution] of Object.entries(modelResolution ?? {})) {
      const execId = agentBindings?.[slot]?.executorId ?? executorId;
      if (!isCredentialGatedExecutor(execId)) continue;
      collect(Object.values(resolution as Record<string, ModelResolutionEntry>));
    }
  }
  if (required.size === 0) return;
  const rows = await db
    .select({ provider: providerCredentials.provider })
    .from(providerCredentials)
    .where(eq(providerCredentials.projectId, projectId));
  const have = new Set(rows.map((r) => r.provider));
  const missing = [...required].filter((p) => !have.has(p));
  if (missing.length > 0) {
    throw new SubmitError(
      "provider_credential_required",
      `Provider ${missing.join(" and ")} requires a project credential (project settings → providers)`,
      { providers: missing },
    );
  }
}

export type AgentBindingResolution = {
  /** slot → concrete binding, frozen into runs.agent_bindings. */
  bindings: Record<string, { faberId: string; executorId: string }>;
  /** slot → role resolution, frozen into runs.model_resolution. */
  modelResolution: Record<string, ModelResolution>;
  /** First slot's binding — the runs.faber_id/executor_id denormalization. */
  primary: { faberId: string; executorId: string };
};

/**
 * Resolve every agent slot to a concrete faber + executor at submit:
 * template defaults (the v1-upgrade sentinel maps to the deployment default,
 * preserving pre-slot behavior exactly), then user overrides (overridable
 * slots only), then per-slot capability checks and slot-scoped,
 * single-provider model resolution (see resolveSlotModels) — all before a
 * run row exists, so failures are fast and actionable.
 */
export async function resolveAgentBindings(
  db: Db,
  projectId: string,
  compiled: CompiledTemplate,
  defaults: { faberId: string; executorId: string },
  overrides: Record<string, { executorId?: string; faberId?: string }> = {},
  opts: {
    /**
     * The deployment's live executor set (worker heartbeats). undefined or
     * empty — no worker has advertised yet (fresh deployment, tests) — skips
     * the availability check rather than blocking every submission.
     */
    registeredExecutors?: Set<string>;
  } = {},
): Promise<AgentBindingResolution> {
  const slots = compiled.spec.agents;
  const slotIds = Object.keys(slots);
  for (const key of Object.keys(overrides)) {
    if (!slotIds.includes(key)) {
      throw new SubmitError("slot_unknown", `Template has no agent slot '${key}'`);
    }
  }

  const faberRows = await db.select().from(fabri).where(eq(fabri.status, "active"));
  const bySlug = new Map(faberRows.map((f) => [f.slug, f]));
  const byId = new Map(faberRows.map((f) => [f.id, f]));

  const allSteps = flattenPhases(compiled.spec.phases).flatMap(({ phase }) => phase.steps);
  const grantedModels = await fetchGrantedModels(db, projectId);
  const credentialRows = await db
    .select({ provider: providerCredentials.provider })
    .from(providerCredentials)
    .where(eq(providerCredentials.projectId, projectId));
  const credentialed = new Set(credentialRows.map((r) => r.provider));
  const roleSets = slotRoleSets(compiled);
  const bindings: AgentBindingResolution["bindings"] = {};
  const modelResolution: AgentBindingResolution["modelResolution"] = {};

  // AGRIPPA_EXECUTOR=fake is the token-free demo switch (AGENTS.md): a demo
  // deployment must never silently route a slot to a real, key-consuming
  // executor, so the fake default overrides every template executor.
  const demoMode = defaults.executorId === "fake";

  for (const slotId of slotIds) {
    const slot = slots[slotId] as NonNullable<(typeof slots)[string]>;
    let faberId: string;
    let executorId: string;
    if (slot.executor === EXECUTOR_DEFAULT_SENTINEL || demoMode) {
      // upgraded v1 template (or demo mode): the deployment default executor
      faberId =
        slot.executor === EXECUTOR_DEFAULT_SENTINEL
          ? defaults.faberId
          : (bySlug.get(slot.faber)?.id ?? defaults.faberId);
      executorId = defaults.executorId;
    } else {
      const faberRow = bySlug.get(slot.faber);
      if (!faberRow) {
        throw new SubmitError(
          "faber_unknown",
          `Faber '${slot.faber}' for slot '${slotId}' is not registered`,
        );
      }
      faberId = faberRow.id;
      executorId = slot.executor;
    }

    const override = overrides[slotId];
    if (override && (override.executorId !== undefined || override.faberId !== undefined)) {
      if (!slot.overridable) {
        throw new SubmitError("slot_not_overridable", `Agent slot '${slotId}' is fixed`);
      }
      if (override.executorId !== undefined) {
        if (!isExecutorId(override.executorId)) {
          throw new SubmitError("executor_unknown", `Unknown executor '${override.executorId}'`);
        }
        executorId = override.executorId;
      }
      if (override.faberId !== undefined) {
        if (!byId.has(override.faberId)) {
          throw new SubmitError("faber_unknown", `Faber '${override.faberId}' is not active`);
        }
        faberId = override.faberId;
      }
    }

    // an executor outside the catalog (custom AGRIPPA_EXECUTOR) skips the
    // capability/provider checks — it predates the catalog and stays unfiltered
    const entry: ExecutorCatalogEntry | null = isExecutorId(executorId)
      ? EXECUTOR_CATALOG[executorId]
      : null;
    // the FINAL resolved binding must be live in this deployment — templates
    // can pin an executor (the delivery reviewer pins codex-cli) with no
    // override involved, so checking overrides alone would miss it. Runs
    // before model resolution: "this deployment has no codex" beats "no
    // openai model satisfies the role" when both would fire.
    const registered = opts.registeredExecutors;
    if (entry && !demoMode && registered && registered.size > 0 && !registered.has(executorId)) {
      throw new SubmitError(
        "executor_unavailable",
        `Executor '${executorId}' is not available in this deployment (no worker has registered it)`,
      );
    }
    if (entry) {
      for (const step of allSteps) {
        if (step.kind !== "agent" || (step.agent ?? slotIds[0]) !== slotId) continue;
        const caps = entry.capabilities;
        if (!caps.subagents && step.subagents.length > 0) {
          throw new SubmitError(
            "executor_capability",
            `Executor '${executorId}' cannot run step '${step.id}' (no subagent support)`,
          );
        }
        if (!caps.skills && step.skills.length > 0) {
          throw new SubmitError(
            "executor_capability",
            `Executor '${executorId}' cannot run step '${step.id}' (no skill support)`,
          );
        }
        if (!caps.mcp && step.mcpServers.length > 0) {
          throw new SubmitError(
            "executor_capability",
            `Executor '${executorId}' cannot run step '${step.id}' (no MCP support)`,
          );
        }
      }
    }
    modelResolution[slotId] = resolveSlotModels({
      slotId,
      granted: grantedModels,
      roleSpecs: compiled.spec.models.roles,
      roles: roleSets.get(slotId) ?? new Set(),
      providers: entry?.providers ?? "*",
      credentialed,
    });
    bindings[slotId] = { faberId, executorId };
  }

  const primary = bindings[slotIds[0] as string] as { faberId: string; executorId: string };
  return { bindings, modelResolution, primary };
}

/** The set of resource slugs a run is authorized to use, pinned at submit. */
export type ResourceManifest = { mcpServers: string[]; skills: string[] };

/**
 * Verify required skill/MCP grants and pin the authorized set.
 *
 * Required resources must be granted (else the submit fails). Optional
 * resources are *included only when granted* — previously they skipped the
 * grant check entirely and the worker then resolved them from the global
 * registry with the platform's global credential, so a project with no grant
 * still received (for example) the shared GitHub token. The returned manifest
 * is frozen onto the run; the worker resolves resources only from it, never by
 * re-reading the mutable global registry.
 */
export async function authorizeResources(
  db: Db,
  projectId: string,
  compiled: CompiledTemplate,
  registry: {
    skillIdBySlug: Map<string, string>;
    mcpIdBySlug: Map<string, string>;
  },
): Promise<ResourceManifest> {
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

  const manifest: ResourceManifest = { mcpServers: [], skills: [] };

  for (const skill of compiled.spec.resources.skills) {
    const slug = skill.ref.split("@")[0] as string;
    const id = registry.skillIdBySlug.get(slug);
    const granted = id !== undefined && (grantedByType.get("skill")?.has(id) ?? false);
    if (!skill.optional) {
      if (!id) throw new SubmitError("skill_unregistered", `Skill '${slug}' is not registered`);
      if (!granted) {
        throw new SubmitError(
          "skill_not_granted",
          `Skill '${slug}' is not granted to this project`,
        );
      }
    }
    if (granted) manifest.skills.push(slug);
  }
  for (const server of compiled.spec.resources.mcpServers) {
    const id = registry.mcpIdBySlug.get(server.ref);
    const granted = id !== undefined && (grantedByType.get("mcp_server")?.has(id) ?? false);
    if (!server.optional) {
      if (!id) {
        throw new SubmitError("mcp_unregistered", `MCP server '${server.ref}' is not registered`);
      }
      if (!granted) {
        throw new SubmitError(
          "mcp_not_granted",
          `MCP server '${server.ref}' is not granted to this project`,
        );
      }
    }
    if (granted) manifest.mcpServers.push(server.ref);
  }
  return manifest;
}

/**
 * Validate that every repoRef param points at a repo connection owned by the
 * submitting project. Without this a member could submit another project's (or
 * tenant's) `repoConnectionId` and the worker would clone that repo with its
 * stored credential — a cross-tenant authorization bypass.
 */
export async function verifyRepoRefs(
  db: Db,
  projectId: string,
  inputs: TemplateInput[],
  params: Record<string, unknown>,
): Promise<void> {
  const repoInputs = inputs.filter((i) => i.type === "repoRef");
  for (const input of repoInputs) {
    const value = params[input.key] as { repoConnectionId?: string } | undefined;
    const id = value?.repoConnectionId;
    if (!id) continue; // optional/unset repoRef — nothing to authorize
    const [connection] = await db
      .select({ id: repoConnections.id })
      .from(repoConnections)
      .where(and(eq(repoConnections.id, id), eq(repoConnections.projectId, projectId)));
    if (!connection) {
      throw new SubmitError(
        "repo_not_in_project",
        `Repo connection '${id}' does not belong to this project`,
      );
    }
  }
}
