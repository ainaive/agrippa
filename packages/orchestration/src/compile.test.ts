import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { compileTemplate, TemplateValidationError, upgradeCompiledTemplate } from "./compile";
import { flattenPhases } from "./template-schema";

const TEMPLATES_DIR = path.resolve(import.meta.dirname, "../../../templates");
const resolveFile = (p: string): string | undefined => {
  const full = path.join(TEMPLATES_DIR, p);
  return existsSync(full) ? readFileSync(full, "utf8") : undefined;
};

const bugFixSource = readFileSync(path.join(TEMPLATES_DIR, "swdev/bug-localize-fix.yaml"), "utf8");

/** Deep-modify the bug-fix template and return re-serialized YAML. */
// biome-ignore lint/suspicious/noExplicitAny: test fixture mutation needs loose typing
function mutate(fn: (doc: any) => void): string {
  const doc = parseYaml(bugFixSource);
  fn(doc);
  return stringifyYaml(doc);
}

function issuesOf(source: string): string[] {
  try {
    compileTemplate(source, { resolveFile });
  } catch (err) {
    if (err instanceof TemplateValidationError) return err.issues;
    throw err;
  }
  throw new Error("expected compilation to fail");
}

describe("template compiler", () => {
  it("compiles the builtin bug-localize-fix template", () => {
    const { compiled, checksum } = compileTemplate(bugFixSource, { resolveFile });
    expect(compiled.metadata.slug).toBe("swdev.bug-localize-fix");
    expect(compiled.spec.phases).toHaveLength(5);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);

    // promptFile is inlined at compile time
    const locator = compiled.spec.resources.subagents.find((s) => s.id === "code-locator");
    expect(locator?.prompt).toContain("code-localization specialist");
    expect(locator?.promptFile).toBeUndefined();

    // ${...}-wrapped when is normalized to a bare expression
    const allSteps = flattenPhases(compiled.spec.phases).flatMap(({ phase }) => phase.steps);
    const openPr = allSteps.find((s) => s.id === "open-pr");
    expect(openPr?.when).toBe("inputs.autoOpenPr");

    // defaults applied
    expect(compiled.spec.models.allowProjectOverride).toBe(true);

    // v1 → v2 upgrade: the phase approval became a checkpoint step at the
    // head of the gated phase, and agent steps are bound to the 'main' slot
    const fixPhase = flattenPhases(compiled.spec.phases).find(
      ({ phase }) => phase.id === "fix",
    )?.phase;
    const gate = fixPhase?.steps[0];
    expect(gate?.kind).toBe("checkpoint");
    if (gate?.kind === "checkpoint") {
      expect(gate.id).toBe("approve-fix-plan");
      expect(gate.checkpoint.kind).toBe("approval");
      expect(gate.checkpoint.onTimeout).toBe("cancel");
    }
    expect(Object.keys(compiled.spec.agents)).toEqual(["main"]);
    const implementFix = allSteps.find((s) => s.id === "implement-fix");
    expect(implementFix?.kind === "agent" && implementFix.agent).toBe("main");
    // the stored-row upgrade path is idempotent on already-v2 documents
    expect(upgradeCompiledTemplate(compiled)).toBe(compiled);
  });

  it("checksum is stable and source-sensitive", () => {
    const a = compileTemplate(bugFixSource, { resolveFile }).checksum;
    const b = compileTemplate(bugFixSource, { resolveFile }).checksum;
    expect(a).toBe(b);
    const c = compileTemplate(`${bugFixSource}\n# comment`, { resolveFile }).checksum;
    expect(c).not.toBe(a);
  });

  it("rejects invalid YAML", () => {
    expect(issuesOf(": not yaml : [").join()).toContain("invalid YAML");
  });

  it("requires both locales on localized fields", () => {
    const source = mutate((doc) => {
      doc.metadata.name = { en: "Only English" };
    });
    expect(issuesOf(source).join()).toContain("metadata.name");
  });

  it("rejects unknown model roles", () => {
    const source = mutate((doc) => {
      doc.spec.phases[1].steps[0].model.role = "nonexistent";
    });
    expect(issuesOf(source).join()).toContain("unknown model role 'nonexistent'");
  });

  it("rejects produces keys not in the output contract", () => {
    const source = mutate((doc) => {
      doc.spec.phases[1].steps[0].produces = ["mystery-artifact"];
    });
    expect(issuesOf(source).join()).toContain("'mystery-artifact' which is not in outputs");
  });

  it("rejects required artifacts nothing produces", () => {
    const source = mutate((doc) => {
      doc.spec.phases[1].steps[0].produces = [];
    });
    expect(issuesOf(source).join()).toContain(
      "required artifact 'localization-report' is not produced",
    );
  });

  it("rejects a requires.skills reference to an unknown skill", () => {
    const source = mutate((doc) => {
      doc.spec.phases[1].steps[0].requires = { skills: ["nonexistent-skill"] };
    });
    expect(issuesOf(source).join()).toContain("requires unknown skill 'nonexistent-skill'");
  });

  it("rejects references to steps that are not defined earlier", () => {
    const source = mutate((doc) => {
      doc.spec.phases[0].steps[1].instructions = "look at ${steps.summarize.outputs.x}";
    });
    expect(issuesOf(source).join()).toContain("not defined earlier");
  });

  it("rejects unknown context roots and unknown inputs", () => {
    const badRoot = mutate((doc) => {
      doc.spec.phases[0].steps[1].instructions = "use ${environment.secret}";
    });
    expect(issuesOf(badRoot).join()).toContain("unknown context root 'environment'");

    const badInput = mutate((doc) => {
      doc.spec.phases[0].steps[1].instructions = "use ${inputs.doesNotExist}";
    });
    expect(issuesOf(badInput).join()).toContain("unknown input 'doesNotExist'");
  });

  it("rejects duplicate step ids and unknown subagents", () => {
    const dupes = mutate((doc) => {
      doc.spec.phases[0].steps[1].id = "setup";
    });
    expect(issuesOf(dupes).join()).toContain("duplicate step ids");

    const badAgent = mutate((doc) => {
      doc.spec.phases[1].steps[0].subagents = ["ghost"];
    });
    expect(issuesOf(badAgent).join()).toContain("unknown subagent 'ghost'");
  });

  it("rejects missing prompt files", () => {
    const source = mutate((doc) => {
      doc.spec.resources.subagents[0].promptFile = "_shared/prompts/missing.md";
    });
    expect(issuesOf(source).join()).toContain("promptFile '_shared/prompts/missing.md' not found");
  });

  it("rejects select inputs without options and unknown perPhase budgets", () => {
    const noOptions = mutate((doc) => {
      doc.spec.inputs.push({
        key: "flavor",
        type: "select",
        label: { en: "Flavor", "zh-CN": "口味" },
      });
    });
    expect(issuesOf(noOptions).join()).toContain("select inputs must define options");

    const badPhase = mutate((doc) => {
      doc.spec.budgets.perPhase = { "no-such-phase": { maxCostUsd: 1 } };
    });
    expect(issuesOf(badPhase).join()).toContain("unknown phase 'no-such-phase'");
  });
});

// ── agrippa/v2 ────────────────────────────────────────────────────────────────

const V2_BASE = {
  apiVersion: "agrippa/v2",
  kind: "OrchestrationTemplate",
  metadata: {
    slug: "swdev.v2-fixture",
    scenario: "software-development",
    name: { en: "Fixture", "zh-CN": "夹具" },
    description: { en: "v2 test fixture", "zh-CN": "v2 测试夹具" },
  },
  spec: {
    agents: {
      implementer: {
        label: { en: "Implementer", "zh-CN": "实现者" },
        faber: "forge",
        executor: "claude-agent-sdk",
      },
      reviewer: {
        label: { en: "Reviewer", "zh-CN": "评审者" },
        faber: "arbiter",
        executor: "codex-cli",
      },
    },
    inputs: [
      { key: "requirement", type: "text", required: true, label: { en: "R", "zh-CN": "需" } },
      { key: "repo", type: "repoRef", required: true, label: { en: "Repo", "zh-CN": "仓库" } },
    ],
    workspace: { repo: "${inputs.repo}", access: "readWrite" },
    models: { roles: { coding: { tier: "strong" }, review: { tier: "strong" } } },
    phases: [
      {
        id: "setup",
        name: { en: "Setup", "zh-CN": "准备" },
        steps: [
          { id: "checkout", kind: "system", action: "workspace.checkout" },
          { id: "branch", kind: "system", action: "git.branch" },
        ],
      },
      {
        id: "implement",
        name: { en: "Implement", "zh-CN": "实现" },
        steps: [
          {
            id: "implement",
            kind: "agent",
            agent: "implementer",
            model: { role: "coding" },
            instructions: "build it",
            produces: ["changes"],
          },
        ],
      },
      {
        kind: "loop",
        id: "review-fix",
        name: { en: "Review", "zh-CN": "评审" },
        maxIterations: 3,
        until: "checkpoints.review-gate.outcome == 'pass'",
        onMaxIterations: "continue",
        phases: [
          {
            id: "review-round",
            name: { en: "Round", "zh-CN": "轮次" },
            steps: [
              {
                id: "review",
                kind: "agent",
                agent: "reviewer",
                model: { role: "review" },
                instructions: "review ${checkpoints.review-gate.outcome}",
                produces: ["review-report"],
              },
              {
                id: "review-gate",
                kind: "checkpoint",
                checkpoint: {
                  kind: "review-gate",
                  source: "review-report",
                  title: { en: "Findings", "zh-CN": "评审结果" },
                },
              },
              {
                id: "fix",
                kind: "agent",
                agent: "implementer",
                model: { role: "coding" },
                when: "checkpoints.review-gate.outcome == 'fix'",
                instructions: "fix ${checkpoints.review-gate.selectedFindings}",
                produces: ["changes"],
              },
            ],
          },
        ],
      },
      {
        id: "publish",
        name: { en: "Publish", "zh-CN": "发布" },
        steps: [
          { id: "push", kind: "system", action: "git.push", retry: { max: 2 } },
          {
            id: "open-pr",
            kind: "system",
            action: "pr.open",
            with: { title: "${run.taskTitle}" },
            produces: ["pull-request"],
          },
        ],
      },
    ],
    outputs: {
      artifacts: [
        { key: "changes", kind: "patch", required: true },
        { key: "review-report", kind: "json", required: true },
        { key: "pull-request", kind: "link", required: true },
      ],
    },
  },
};

// biome-ignore lint/suspicious/noExplicitAny: test fixture mutation needs loose typing
function v2Source(fn?: (doc: any) => void): string {
  const doc = structuredClone(V2_BASE);
  fn?.(doc);
  return stringifyYaml(doc);
}

describe("template compiler (agrippa/v2)", () => {
  it("compiles slots, loops, checkpoints, and scm actions", () => {
    const { compiled } = compileTemplate(v2Source());
    expect(Object.keys(compiled.spec.agents)).toEqual(["implementer", "reviewer"]);
    const loop = compiled.spec.phases.find((n) => "kind" in n && n.kind === "loop");
    expect(loop && "maxIterations" in loop && loop.maxIterations).toBe(3);
    const steps = flattenPhases(compiled.spec.phases).flatMap(({ phase }) => phase.steps);
    expect(steps.find((s) => s.id === "review-gate")?.kind).toBe("checkpoint");
  });

  it("rejects unknown agent slots and unknown executors", () => {
    const badSlot = v2Source((doc) => {
      doc.spec.phases[1].steps[0].agent = "ghost";
    });
    expect(issuesOf(badSlot).join()).toContain("unknown agent slot 'ghost'");

    const badExecutor = v2Source((doc) => {
      doc.spec.agents.reviewer.executor = "not-a-real-executor";
    });
    expect(issuesOf(badExecutor).join()).toContain("unknown executor 'not-a-real-executor'");
  });

  it("rejects steps whose slot executor lacks a capability", () => {
    const source = v2Source((doc) => {
      doc.spec.resources = {
        subagents: [
          {
            id: "helper",
            description: "helps",
            prompt: "help",
            tools: [],
            model: { role: "review" },
          },
        ],
      };
      // codex-cli has no subagent support
      doc.spec.phases[2].phases[0].steps[0].subagents = ["helper"];
    });
    expect(issuesOf(source).join()).toContain("does not support subagents");
  });

  it("rejects checkpoint sources that are missing or not json", () => {
    const missing = v2Source((doc) => {
      doc.spec.phases[2].phases[0].steps[1].checkpoint.source = "nonexistent";
    });
    expect(issuesOf(missing).join()).toContain("'nonexistent' is not a declared artifact");

    const notJson = v2Source((doc) => {
      doc.spec.phases[2].phases[0].steps[1].checkpoint.source = "changes";
    });
    expect(issuesOf(notJson).join()).toContain("must be a json artifact");
  });

  it("allows same-loop checkpoint references but rejects cross-loop forward ones", () => {
    // `review` reads checkpoints.review-gate (defined later, same loop) — ok
    expect(() => compileTemplate(v2Source())).not.toThrow();

    const forward = v2Source((doc) => {
      doc.spec.phases[1].steps[0].instructions = "use ${checkpoints.review-gate.outcome}";
    });
    expect(issuesOf(forward).join()).toContain("neither earlier nor in the same loop");
  });

  it("rejects scm steps in read-only workspaces and bad pr.open contracts", () => {
    const readOnly = v2Source((doc) => {
      doc.spec.workspace.access = "readOnly";
    });
    expect(issuesOf(readOnly).join()).toContain("requires a readWrite workspace");

    const badProduces = v2Source((doc) => {
      doc.spec.phases[3].steps[1].produces = [];
    });
    expect(issuesOf(badProduces).join()).toContain("must produce exactly one link artifact");

    const notLink = v2Source((doc) => {
      doc.spec.phases[3].steps[1].produces = ["review-report"];
    });
    expect(issuesOf(notLink).join()).toContain("must produce a 'link' artifact");
  });

  it("rejects unknown artifact references in expressions", () => {
    const source = v2Source((doc) => {
      doc.spec.phases[1].steps[0].instructions = "see ${artifacts.nonexistent}";
    });
    expect(issuesOf(source).join()).toContain("unknown artifact 'nonexistent'");
  });
});
