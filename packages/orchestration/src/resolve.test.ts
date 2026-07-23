import { describe, expect, it } from "bun:test";
import {
  type GrantedModelRow,
  type ModelResolution,
  resolveSlotModels,
  SubmitError,
  slotRoleSets,
} from "./resolve";
import type { CompiledTemplate } from "./template-schema";

const model = (
  provider: string,
  providerModelId: string,
  tier: GrantedModelRow["tier"],
  inputCost: string,
): GrantedModelRow => ({
  id: `id-${providerModelId}`,
  provider,
  providerModelId,
  tier,
  inputCostPerMtok: inputCost,
  outputCostPerMtok: "0",
});

const GRANTED: GrantedModelRow[] = [
  model("anthropic", "claude-opus-4-8", "strong", "5.00"),
  model("anthropic", "claude-haiku-4-5", "fast", "1.00"),
  model("dashscope", "qwen3.7-max", "strong", "2.50"),
  model("dashscope", "qwen3.6-flash", "fast", "0.25"),
  model("openai", "gpt-5.1-codex", "strong", "1.25"),
];

const ROLE_SPECS = {
  coding: { tier: "strong" as const, fallback: [] },
  review: { tier: "strong" as const, fallback: ["fast" as const] },
  triage: { tier: "fast" as const, fallback: [] },
};

const resolve = (
  overrides: Partial<Parameters<typeof resolveSlotModels>[0]> = {},
): ModelResolution =>
  resolveSlotModels({
    slotId: "main",
    granted: GRANTED,
    roleSpecs: ROLE_SPECS,
    roles: new Set(["coding", "triage"]),
    providers: ["anthropic", "dashscope"],
    credentialed: new Set(),
    ...overrides,
  });

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof SubmitError) return err.code;
    throw err;
  }
  throw new Error("expected a SubmitError");
};

describe("resolveSlotModels — single-provider coherence", () => {
  it("resolves every scoped role from ONE provider (never mixed)", () => {
    const resolution = resolve();
    const providers = new Set(Object.values(resolution).map((e) => e.provider));
    expect(providers.size).toBe(1);
    expect(Object.keys(resolution).sort()).toEqual(["coding", "triage"]);
  });

  it("ranks a credentialed provider above a cheaper env-fallback one", () => {
    // without a credential, dashscope (auth: project) is excluded → anthropic
    expect(resolve().coding?.provider).toBe("anthropic");
    // with a project credential, dashscope wins the credentialed-first rank
    const withCred = resolve({ credentialed: new Set(["dashscope"]) });
    expect(withCred.coding?.provider).toBe("dashscope");
    expect(withCred.coding?.providerModelId).toBe("qwen3.7-max");
    expect(withCred.triage?.providerModelId).toBe("qwen3.6-flash");
  });

  it("breaks credential ties by total input cost over the resolved roles", () => {
    // both credentialed → dashscope total (2.50+0.25) beats anthropic (5.00+1.00)
    const both = resolve({ credentialed: new Set(["anthropic", "dashscope"]) });
    expect(both.coding?.provider).toBe("dashscope");
  });

  it("drops a provider that cannot satisfy ALL the slot's roles", () => {
    // openai has no fast-tier model → cannot serve triage even though its
    // strong model is the cheapest for coding
    const resolution = resolve({
      providers: ["openai", "anthropic"],
      credentialed: new Set(["openai"]),
    });
    expect(resolution.coding?.provider).toBe("anthropic");
  });

  it("resolves within a provider by tier fallback, cheapest in tier", () => {
    const resolution = resolve({
      roles: new Set(["review"]),
      providers: ["openai"],
      granted: [model("openai", "gpt-5.1-codex-mini", "fast", "0.25")],
    });
    // strong unavailable → falls back to fast
    expect(resolution.review?.providerModelId).toBe("gpt-5.1-codex-mini");
    expect(resolution.review?.tier).toBe("fast");
  });
});

describe("resolveSlotModels — errors", () => {
  it("provider_credential_required when ONLY the credential blocks resolution", () => {
    expect(codeOf(() => resolve({ providers: ["dashscope"] }))).toBe(
      "provider_credential_required",
    );
  });

  it("model_unresolvable when grants are the blocker, with per-provider reasons", () => {
    try {
      resolve({
        providers: ["openai", "dashscope"],
        granted: [model("openai", "gpt-5.1-codex", "strong", "1.25")],
        credentialed: new Set(["dashscope"]),
      });
      throw new Error("expected a SubmitError");
    } catch (err) {
      if (!(err instanceof SubmitError)) throw err;
      expect(err.code).toBe("model_unresolvable");
      expect(err.message).toContain("provider openai");
      expect(err.message).toContain("provider dashscope");
      expect(err.message).toContain("triage");
    }
  });

  it("no_models_granted when the project has no granted models at all", () => {
    expect(codeOf(() => resolve({ granted: [] }))).toBe("no_models_granted");
  });

  it("an empty role set resolves to {} and skips every check", () => {
    expect(resolve({ roles: new Set(), granted: [] })).toEqual({});
  });
});

describe("resolveSlotModels — '*' legacy path (demo/custom executors)", () => {
  it("keeps mixed-provider cheapest-per-tier resolution with no credential gating", () => {
    const resolution = resolve({ providers: "*", roles: new Set(["coding", "triage"]) });
    // cheapest strong is openai, cheapest fast is dashscope — mixing allowed,
    // and dashscope needs no credential here (the fake executor calls no API)
    expect(resolution.coding?.providerModelId).toBe("gpt-5.1-codex");
    expect(resolution.triage?.providerModelId).toBe("qwen3.6-flash");
  });
});

describe("slotRoleSets", () => {
  const compiled = (spec: Record<string, unknown>): CompiledTemplate =>
    ({ spec }) as unknown as CompiledTemplate;

  const agentStep = (id: string, opts: { agent?: string; role: string; subagents?: string[] }) => ({
    id,
    kind: "agent",
    agent: opts.agent,
    model: { role: opts.role },
    subagents: opts.subagents ?? [],
  });

  it("collects each slot's step roles plus its subagents' roles, loops included", () => {
    const sets = slotRoleSets(
      compiled({
        agents: { implementer: {}, reviewer: {} },
        resources: { subagents: [{ id: "scout", model: { role: "triage" } }] },
        phases: [
          {
            id: "build",
            steps: [
              agentStep("plan", { agent: "implementer", role: "planning" }),
              agentStep("code", { agent: "implementer", role: "coding", subagents: ["scout"] }),
            ],
          },
          {
            kind: "loop",
            phases: [
              { id: "review", steps: [agentStep("rev", { agent: "reviewer", role: "review" })] },
            ],
          },
        ],
      }),
    );
    expect(sets.get("implementer")).toEqual(new Set(["planning", "coding", "triage"]));
    expect(sets.get("reviewer")).toEqual(new Set(["review"]));
  });

  it("defaults slot-less steps to the first slot; unused slots get an empty set", () => {
    const sets = slotRoleSets(
      compiled({
        agents: { main: {}, spare: {} },
        resources: { subagents: [] },
        phases: [{ id: "p", steps: [agentStep("s", { role: "coding" })] }],
      }),
    );
    expect(sets.get("main")).toEqual(new Set(["coding"]));
    expect(sets.get("spare")).toEqual(new Set());
  });
});
