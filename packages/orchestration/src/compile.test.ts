import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { compileTemplate, TemplateValidationError } from "./compile";

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
    const openPr = compiled.spec.phases.flatMap((p) => p.steps).find((s) => s.id === "open-pr");
    expect(openPr?.when).toBe("inputs.autoOpenPr");

    // defaults applied
    expect(compiled.spec.models.allowProjectOverride).toBe(true);
    const approval = compiled.spec.phases.find((p) => p.id === "fix")?.approval;
    expect(approval?.onTimeout).toBe("cancel");
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
