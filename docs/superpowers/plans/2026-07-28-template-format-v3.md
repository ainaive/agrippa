# Template Format v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a flat, GitHub-Actions-style `version: 3` authoring format for orchestration templates that compiles into the existing v2 IR, convert 6 of 7 builtin templates to it, and update docs — with zero engine/API/DB impact.

**Architecture:** v3 is a *source-only* format. A new `templateDocV3Schema` (reusing existing sub-schemas) plus a `normalizeV3ToCompiled()` function in `compile.ts` flatten the v3 doc into the unchanged `CompiledTemplate` (v2 IR). `compileTemplate()` routes on `version: 3` before the existing `apiVersion` branches. Engine, API, DB schema, and `CompiledTemplate` are untouched.

**Tech Stack:** TypeScript, Zod, Bun (test runner), Biome (lint/format), YAML.

## Global Constraints

- **No runtime changes:** `CompiledTemplate` type, engine, API, and DB schema must not be modified. v1/v2 templates keep working.
- **i18n:** every user-facing/localizable field carries BOTH `en` and `zh-CN`; the bilingual parity test fails CI on missing keys. Both locales of `docs/manual/05-template-authoring.md` move in the same commit.
- **Commit gate:** every commit keeps `bun run check` green (bisectable). No `Co-Authored-By`/AI-attribution lines. Conventional Commits; body explains why.
- **Templates gate:** `bun run templates:validate` must pass for all 7 builtins after every template edit.
- **`bug-localize-fix.yaml` stays v1** — it is the fixture for the v1→v2 upgrade path and underpins the `mutate()`-based test suite.
- **Build/dir:** `AGENT_STEP_DEFAULT_SLOT = "main"`, `EXECUTOR_DEFAULT_SENTINEL` (imported from `@agrippa/core`) — both already imported in `compile.ts`.

**Reference spec:** `docs/superpowers/specs/2026-07-28-template-format-v3-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `packages/orchestration/src/template-schema.ts` | Add `templateDocV3Schema` + `TemplateDocV3` type | Modify (append before `durationToMinutes`) |
| `packages/orchestration/src/compile.ts` | `normalizeV3ToCompiled()` + version routing | Modify |
| `packages/orchestration/src/compile.test.ts` | v3 test block | Modify (append) |
| `templates/pm/status-report.yaml` | simplest v1→v3 | Rewrite |
| `templates/pm/plan-breakdown.yaml` | v1→v3 with approval→checkpoint | Rewrite |
| `templates/swdev/requirement-delivery.yaml` | only multi-agent v2→v3 | Rewrite |
| `templates/swdev/requirements-dev.yaml` | v1→v3 with subagents + approval | Rewrite |
| `templates/test/test-plan.yaml` | v1→v3 | Rewrite |
| `templates/test/regression-verify.yaml` | v1→v3 with subagents | Rewrite |
| `templates/swdev/bug-localize-fix.yaml` | fixture | **Do NOT modify** |
| `docs/design/02-orchestration-template.md` | format spec | Modify |
| `docs/manual/en/05-template-authoring.md` | authoring guide | Modify |
| `docs/manual/zh-CN/05-template-authoring.md` | authoring guide (zh) | Modify |
| `docs/adr/0016-v3-flat-authoring-format.md` | decision record | Create |
| `ARCHITECTURE.md` | overview template mention | Modify |
| `CHANGELOG.md` | unreleased entry | Modify |

---

### Task 1: Add the v3 Zod schema

**Files:**
- Modify: `packages/orchestration/src/template-schema.ts` (append before `durationToMinutes`, after the v2 section)

**Interfaces:**
- Consumes: existing module-internal schemas `idSchema`, `templateSlugSchema`, `skillRefSchema`, `mcpRefSchema`, `subagentSchema`, `modelRoleSchema`, and exported `localizedTextSchema`, `templateInputSchema`, `agentSlotSchema`, `flowNodeSchema`, `budgetsSchema`; `ARTIFACT_KINDS` (imported line 1).
- Produces: exported `templateDocV3Schema` (a `z.ZodObject`) and `type TemplateDocV3 = z.infer<typeof templateDocV3Schema>`.

- [ ] **Step 1: Write the schema**

Append this block to `packages/orchestration/src/template-schema.ts` immediately before the `/** "45m" | "24h" | "2d" → minutes */` comment above `durationToMinutes`:

```ts
// ── agrippa/v3 flat authoring format (ADR-0016) ───────────────────────────────

/**
 * v3 flat authoring format (GitHub-Actions-style). Both single-agent
 * (`faber`) and multi-agent (`slots`) templates compile to the same v2 IR.
 * v3 is source-only sugar — the compiler normalizes it into CompiledTemplate,
 * so the engine, API, and DB are unchanged. v1/v2 stay accepted.
 */
export const templateDocV3Schema = z
  .object({
    version: z.literal(3),
    slug: templateSlugSchema,
    scenario: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: localizedTextSchema,
    description: localizedTextSchema,

    // single-agent mode (was spec.faber)
    faber: idSchema.optional(),

    // multi-agent mode (was spec.agents)
    slots: z.record(idSchema, agentSlotSchema).optional(),

    inputs: z.array(templateInputSchema).default([]),
    workspace: z
      .object({
        repo: z.string(),
        ref: z.string().optional(),
        access: z.enum(["readOnly", "readWrite"]).default("readOnly"),
      })
      .optional(),

    // flat resource refs (were spec.resources.*)
    skills: z.array(skillRefSchema).default([]),
    mcpServers: z.array(mcpRefSchema).default([]),
    subagents: z.array(subagentSchema).default([]),

    // flat model roles (spec.models.roles wrapper removed)
    models: z.record(z.string(), modelRoleSchema),
    allowProjectOverride: z.boolean().default(true),

    // unified flow: plain phases and loop nodes, in declaration order
    phases: z.array(flowNodeSchema).min(1),

    // singular budget (was spec.budgets)
    budget: budgetsSchema.default({ perPhase: {} }),

    // flat outputs (spec.outputs.artifacts wrapper removed)
    outputs: z
      .array(
        z.object({
          key: idSchema,
          kind: z.enum(ARTIFACT_KINDS),
          required: z.boolean().default(false),
        }),
      )
      .min(1),
    summary: z.object({ from: idSchema }).optional(),
  })
  .refine((doc) => (doc.faber !== undefined) !== (doc.slots !== undefined), {
    message: "must declare exactly one of 'faber' (single-agent) or 'slots' (multi-agent)",
  });

export type TemplateDocV3 = z.infer<typeof templateDocV3Schema>;
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd /home/leonaltair/code/agrippa && bun run check`
Expected: PASS (biome + tsc -b + deps). If biome reformats, re-run after accepting its style.

- [ ] **Step 3: Commit**

```bash
git add packages/orchestration/src/template-schema.ts
git commit -m "feat(orchestration): add templateDocV3Schema (flat authoring format)

v3 is a GitHub-Actions-style source format: top-level slug/scenario/name,
faber-or-slots agent declaration, flat resources/models/budget/outputs.
It compiles into the unchanged v2 IR, so the engine/API/DB are untouched.
Schema only here — routing lands next."
```

---

### Task 2: Add the v3 normalizer + version routing (TDD)

**Files:**
- Modify: `packages/orchestration/src/compile.ts` (add `normalizeV3ToCompiled`; update `compileTemplate` routing)
- Test: `packages/orchestration/src/compile.test.ts` (append `describe("v3 format")` with the inline rejection/error cases)

**Interfaces:**
- Consumes: `templateDocV3Schema`, `TemplateDocV3` from Task 1; `AGENT_STEP_DEFAULT_SLOT`, `EXECUTOR_DEFAULT_SENTINEL` (already imported in `compile.ts`).
- Produces: `normalizeV3ToCompiled(doc: TemplateDocV3): CompiledTemplate` (module-internal); `compileTemplate` now accepts `version: 3` sources.

- [ ] **Step 1: Write the failing tests (inline v3 — no file dependency yet)**

Append to `packages/orchestration/src/compile.test.ts`, after the existing `describe("template compiler (agrippa/v2)", ...)` block:

```ts
// ── agrippa/v3 flat authoring format ─────────────────────────────────────────

describe("v3 format", () => {
  it("rejects v3 with both faber and slots", () => {
    const source = `
version: 3
slug: test.both
scenario: test
name: { en: "Bad", zh-CN: "坏" }
description: { en: "Bad", zh-CN: "坏" }
faber: navigator
slots:
  main: { label: { en: "X", zh-CN: "X" }, faber: navigator, executor: default }
models: { a: { tier: fast } }
phases:
  - id: p
    name: { en: "P", zh-CN: "P" }
    steps:
      - { id: s, kind: agent, model: { role: a }, instructions: "do stuff", produces: [] }
outputs:
  - { key: out, kind: markdown, required: true }
`;
    expect(issuesOf(source).join()).toContain("faber");
  });

  it("rejects v3 with neither faber nor slots", () => {
    const source = `
version: 3
slug: test.none
scenario: test
name: { en: "Bad", zh-CN: "坏" }
description: { en: "Bad", zh-CN: "坏" }
models: { a: { tier: fast } }
phases:
  - id: p
    name: { en: "P", zh-CN: "P" }
    steps:
      - { id: s, kind: agent, model: { role: a }, instructions: "do stuff", produces: [] }
outputs:
  - { key: out, kind: markdown, required: true }
`;
    expect(issuesOf(source).join()).toContain("faber");
  });

  it("rejects a source with neither version nor apiVersion", () => {
    const source = `
slug: test.no-version
scenario: test
name: { en: "T", zh-CN: "T" }
description: { en: "T", zh-CN: "T" }
faber: navigator
models: { a: { tier: fast } }
phases:
  - id: p
    name: { en: "P", zh-CN: "P" }
    steps:
      - { id: s, kind: agent, model: { role: a }, instructions: "x", produces: [] }
outputs:
  - { key: out, kind: markdown, required: true }
`;
    expect(issuesOf(source).join()).toContain("version");
  });
});
```

- [ ] **Step 2: Run tests to verify the first two fail**

Run: `cd /home/leonaltair/code/agrippa && bun test packages/orchestration/src/compile.test.ts`
Expected: "rejects v3 with both faber and slots" FAILS (current routing throws `apiVersion must be 'agrippa/v1' or 'agrippa/v2'`, which does NOT contain `faber`). "rejects v3 with neither faber nor slots" FAILS for the same reason. "rejects a source with neither version nor apiVersion" may already pass (the string `apiVersion` contains `version`) — that's fine; it guards the routing error.

- [ ] **Step 3: Add `normalizeV3ToCompiled` to `compile.ts`**

Insert this function immediately **after** `upgradeCompiledTemplate` (before the `compileTemplate` doc-comment, around line 107):

```ts
/**
 * Pure v3 → v2 IR normalization: flatten the v3 authoring format into the
 * CompiledTemplate shape the engine and API consume. Single-agent templates
 * get one non-overridable `main` slot (mirroring upgradeV1ToV2); multi-agent
 * templates pass `slots` through verbatim. v3 is source-only — the IR is the
 * same v2 shape, so nothing downstream changes.
 */
function normalizeV3ToCompiled(doc: TemplateDocV3): CompiledTemplate {
  const isSingleAgent = doc.faber !== undefined;
  return {
    apiVersion: "agrippa/v2",
    kind: "OrchestrationTemplate",
    metadata: {
      slug: doc.slug,
      scenario: doc.scenario,
      name: doc.name,
      description: doc.description,
    },
    spec: {
      agents: isSingleAgent
        ? {
            [AGENT_STEP_DEFAULT_SLOT]: {
              label: { en: "Agent", "zh-CN": "智能体" },
              faber: doc.faber as string,
              executor: EXECUTOR_DEFAULT_SENTINEL,
              overridable: false,
            },
          }
        : (doc.slots as Record<string, AgentSlot>),
      inputs: doc.inputs,
      workspace: doc.workspace,
      resources: {
        skills: doc.skills,
        mcpServers: doc.mcpServers,
        subagents: doc.subagents,
      },
      models: {
        roles: doc.models,
        allowProjectOverride: doc.allowProjectOverride,
      },
      phases: doc.phases,
      budgets: doc.budget,
      outputs: {
        artifacts: doc.outputs,
        summary: doc.summary,
      },
    },
  };
}
```

Add `AgentSlot`, `TemplateDocV3`, and `templateDocV3Schema` to the import block at the top of `compile.ts`. The existing import from `./template-schema` is:

```ts
import {
  AGENT_STEP_DEFAULT_SLOT,
  type CompiledTemplate,
  flattenPhases,
  isLoopNode,
  type TemplateDoc,
  templateDocSchema,
  templateDocV2Schema,
} from "./template-schema";
```

Change it to:

```ts
import {
  AGENT_STEP_DEFAULT_SLOT,
  type AgentSlot,
  type CompiledTemplate,
  flattenPhases,
  isLoopNode,
  type TemplateDoc,
  templateDocSchema,
  templateDocV2Schema,
  type TemplateDocV3,
  templateDocV3Schema,
} from "./template-schema";
```

- [ ] **Step 4: Update `compileTemplate` version routing**

In `compile.ts`, replace the current routing block (the lines reading `const apiVersion = ...` through the final `else { throw ... }`) with:

```ts
  const version = (raw as { version?: unknown } | null)?.version;
  const apiVersion = (raw as { apiVersion?: unknown } | null)?.apiVersion;
  let doc: CompiledTemplate;
  if (version === 3) {
    const parsed = templateDocV3Schema.safeParse(raw);
    if (!parsed.success) {
      throw new TemplateValidationError(
        parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      );
    }
    doc = normalizeV3ToCompiled(parsed.data);
  } else if (apiVersion === "agrippa/v1") {
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
    throw new TemplateValidationError([
      "version must be 3, or apiVersion must be 'agrippa/v1' or 'agrippa/v2'",
    ]);
  }
```

- [ ] **Step 5: Run tests to verify the v3 rejection tests pass**

Run: `cd /home/leonaltair/code/agrippa && bun test packages/orchestration/src/compile.test.ts`
Expected: all three new v3 tests PASS, and the existing v1/v2 tests still PASS.

- [ ] **Step 6: Verify the full gate**

Run: `cd /home/leonaltair/code/agrippa && bun run check && bun test packages/orchestration/src/compile.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/orchestration/src/compile.ts packages/orchestration/src/compile.test.ts
git commit -m "feat(orchestration): compile version: 3 templates to the v2 IR

normalizeV3ToCompiled flattens the v3 flat format into CompiledTemplate:
single-agent -> one non-overridable main slot (as upgradeV1ToV2 does),
multi-agent -> slots verbatim. compileTemplate routes on version: 3 before
the apiVersion branches; v1/v2 unchanged. Adds the v3 rejection tests."
```

---

### Task 3: Convert `templates/pm/status-report.yaml` to v3 + single-agent test

**Files:**
- Rewrite: `templates/pm/status-report.yaml`
- Test: `packages/orchestration/src/compile.test.ts` (add two file-based tests to the `v3 format` block)

**Interfaces:**
- Consumes: Task 2 routing.
- Produces: a v3 single-agent fixture used by the file-based tests.

- [ ] **Step 1: Rewrite the template to v3**

Overwrite `templates/pm/status-report.yaml` with:

```yaml
version: 3
slug: pm.status-report
scenario: project-management
name: { en: "Status Report", zh-CN: "状态报告" }
description:
  en: "Gather repository activity and synthesize a project status report."
  zh-CN: "汇总代码仓库活动，生成项目状态报告。"

faber: navigator

inputs:
  - key: repo
    type: repoRef
    required: true
    label: { en: "Repository", zh-CN: "代码仓库" }
  - key: period
    type: select
    default: last-week
    label: { en: "Reporting period", zh-CN: "报告周期" }
    options:
      - { value: last-week, label: { en: "Last week", zh-CN: "上周" } }
      - { value: last-sprint, label: { en: "Last two weeks", zh-CN: "近两周" } }
      - { value: last-month, label: { en: "Last month", zh-CN: "上月" } }
  - key: focus
    type: text
    required: false
    label: { en: "Focus areas (optional)", zh-CN: "关注重点（可选）" }
    ui: { widget: textarea, rows: 3 }

workspace:
  repo: ${inputs.repo}
  access: readOnly

models:
  analysis: { tier: balanced, fallback: [fast] }
  fast: { tier: fast }

phases:
  - id: gather
    name: { en: "Gather", zh-CN: "收集" }
    steps:
      - id: setup
        kind: system
        action: workspace.checkout
      - id: gather-activity
        kind: agent
        model: { role: analysis }
        instructions: |
          Review this repository's activity for the period "${inputs.period}":
          commit history, merged changes, areas of churn, and anything unusual.
          Ground every observation in evidence (git log, diffs); never invent activity.
          Record your findings as structured notes.
        produces: [activity-notes]

  - id: report
    name: { en: "Report", zh-CN: "报告" }
    steps:
      - id: synthesize
        kind: agent
        model: { role: analysis }
        instructions: |
          Using the activity notes, write a status report with sections:
          Summary, Progress, Risks & Concerns, and Next Steps.
          ${inputs.focus} — weight these focus areas if given.
          Write it bilingual-friendly: clear, plain language.
        produces: [status-report]

budget:
  maxCostUsd: 3
  maxDurationMinutes: 20

outputs:
  - { key: activity-notes, kind: markdown, required: false }
  - { key: status-report, kind: markdown, required: true }
summary: { from: status-report }
```

- [ ] **Step 2: Validate the builtin compiles**

Run: `cd /home/leonaltair/code/agrippa && bun run templates:validate`
Expected: PASS (all 7 builtins, including this v3 one and the still-v1 `bug-localize-fix`).

- [ ] **Step 3: Add the single-agent + idempotency tests**

Add these two tests to the `describe("v3 format", ...)` block in `packages/orchestration/src/compile.test.ts` (after the existing three rejection tests):

```ts
  it("compiles a v3 single-agent template", () => {
    const source = readFileSync(path.join(TEMPLATES_DIR, "pm/status-report.yaml"), "utf8");
    const { compiled } = compileTemplate(source, { resolveFile });
    expect(compiled.metadata.slug).toBe("pm.status-report");
    expect(compiled.spec.agents).toHaveProperty("main");
    expect(compiled.spec.models.roles).toHaveProperty("analysis");
    expect(compiled.spec.outputs.artifacts).toHaveLength(2);
  });

  it("upgradeCompiledTemplate is idempotent on v3-compiled output", () => {
    const source = readFileSync(path.join(TEMPLATES_DIR, "pm/status-report.yaml"), "utf8");
    const { compiled } = compileTemplate(source, { resolveFile });
    expect(upgradeCompiledTemplate(compiled)).toBe(compiled);
  });
```

- [ ] **Step 4: Run the tests**

Run: `cd /home/leonaltair/code/agrippa && bun test packages/orchestration/src/compile.test.ts`
Expected: the two new tests PASS (along with all prior).

- [ ] **Step 5: Commit**

```bash
git add templates/pm/status-report.yaml packages/orchestration/src/compile.test.ts
git commit -m "feat(templates): convert pm/status-report to the v3 flat format

Drops the apiVersion/kind/metadata/spec wrappers; metadata promoted to top
level, resources flattened away (empty), models.roles -> models, budgets ->
budget, outputs.artifacts -> outputs. Compiles to the same v2 IR. Adds the
v3 single-agent compile + idempotency tests."
```

---

### Task 4: Convert `templates/pm/plan-breakdown.yaml` (approval → checkpoint step)

**Files:**
- Rewrite: `templates/pm/plan-breakdown.yaml`

**Interfaces:**
- Consumes: Task 2 routing.

- [ ] **Step 1: Rewrite the template to v3**

Overwrite `templates/pm/plan-breakdown.yaml`. Note the `publish` phase: the v1 phase-level `approval:` becomes a `kind: checkpoint` step prepended to that phase's `steps:` (identical to what `upgradeV1ToV2` synthesizes — the checkpoint id is the original `approval.checkpoint` value `approve-plan`).

```yaml
version: 3
slug: pm.plan-breakdown
scenario: project-management
name: { en: "Plan Breakdown", zh-CN: "计划拆解" }
description:
  en: "Break a goal or PRD into milestones and estimated tasks, with an approval gate."
  zh-CN: "将目标或需求文档拆解为里程碑与可估算的任务，包含审批环节。"

faber: navigator

inputs:
  - key: goal
    type: text
    required: true
    label: { en: "Goal or PRD", zh-CN: "目标或需求文档" }
    ui: { widget: textarea, rows: 10 }
  - key: constraints
    type: text
    required: false
    label: { en: "Constraints (deadlines, team, budget)", zh-CN: "约束（工期、团队、预算）" }
    ui: { widget: textarea, rows: 4 }
  - key: granularity
    type: select
    default: stories
    label: { en: "Breakdown granularity", zh-CN: "拆解粒度" }
    options:
      - { value: milestones, label: { en: "Milestones only", zh-CN: "仅里程碑" } }
      - { value: stories, label: { en: "Milestones + stories", zh-CN: "里程碑 + 需求项" } }
      - { value: tasks, label: { en: "Down to tasks", zh-CN: "细化到任务" } }

models:
  planning: { tier: strong, fallback: [balanced] }
  fast: { tier: fast }

phases:
  - id: analyze
    name: { en: "Analyze", zh-CN: "分析" }
    steps:
      - id: analyze-goal
        kind: agent
        model: { role: planning }
        instructions: |
          Analyze the goal below. Identify scope, assumptions, unknowns, and risks.
          Constraints: ${inputs.constraints}
          --- GOAL ---
          ${inputs.goal}
        produces: [analysis-notes]

  - id: draft
    name: { en: "Draft", zh-CN: "草案" }
    steps:
      - id: draft-plan
        kind: agent
        model: { role: planning }
        instructions: |
          Produce a draft breakdown at "${inputs.granularity}" granularity:
          milestones with outcomes, work items with rough estimates and
          dependencies, and a sequencing rationale.
        produces: [draft-plan]

  - id: publish
    name: { en: "Publish", zh-CN: "发布" }
    steps:
      - id: approve-plan
        kind: checkpoint
        checkpoint:
          kind: approval
          title: { en: "Approve the draft plan", zh-CN: "确认计划草案" }
          present: [draft-plan]
          timeout: 48h
          onTimeout: cancel
      - id: finalize
        kind: agent
        model: { role: fast }
        instructions: |
          Finalize the approved draft into a clean plan document:
          summary table of milestones, then detailed work items.
        produces: [plan-breakdown]

budget:
  maxCostUsd: 4
  maxDurationMinutes: 30

outputs:
  - { key: analysis-notes, kind: markdown, required: false }
  - { key: draft-plan, kind: markdown, required: true }
  - { key: plan-breakdown, kind: markdown, required: true }
summary: { from: plan-breakdown }
```

- [ ] **Step 2: Validate**

Run: `cd /home/leonaltair/code/agrippa && bun run templates:validate`
Expected: PASS (7/7).

- [ ] **Step 3: Commit**

```bash
git add templates/pm/plan-breakdown.yaml
git commit -m "feat(templates): convert pm/plan-breakdown to the v3 flat format

The publish phase's v1 phase-level approval: becomes a kind: checkpoint
step at the head of the phase (id = approval.checkpoint), identical to
what upgradeV1ToV2 synthesizes for v1 sources — same gate, same position."
```

---

### Task 5: Convert `templates/swdev/requirement-delivery.yaml` (multi-agent) + multi-agent test

**Files:**
- Rewrite: `templates/swdev/requirement-delivery.yaml`
- Test: `packages/orchestration/src/compile.test.ts` (add the multi-agent + v1-still-works tests)

**Interfaces:**
- Consumes: Task 2 routing.
- Produces: a v3 multi-agent fixture (with loops) used by tests.

- [ ] **Step 1: Rewrite the template to v3**

Overwrite `templates/swdev/requirement-delivery.yaml`. Only the wrapper changes: `spec.agents` → top-level `slots`, and the `spec.*` wrappers are flattened. The entire `phases:` block (setup phase + clarify loop + plan loop + implement phase + review-fix loop + publish phase) is copied **verbatim** from the current file's `spec.phases` — step ids, checkpoint specs, loop `until`/`maxIterations`, `${...}` expressions all unchanged.

```yaml
version: 3
slug: swdev.requirement-delivery
scenario: software-development
name: { en: "Requirement Delivery", zh-CN: "需求交付" }
description:
  en: "Take a requirement all the way to a reviewed pull request: clarify with the user, plan, implement on a branch, cross-agent review-fix loop, then a platform-opened PR."
  zh-CN: "把需求一路交付到经过评审的 PR：与用户澄清、规划、在分支上实现、双代理评审-修复循环，最终由平台创建 PR。"

slots:
  implementer:
    label: { en: "Implementer", zh-CN: "实现者" }
    faber: forge
    executor: claude-agent-sdk
  reviewer:
    label: { en: "Reviewer", zh-CN: "评审者" }
    faber: arbiter
    executor: codex-cli

inputs:
  - key: requirement
    type: text
    required: true
    label: { en: "Requirement", zh-CN: "需求描述" }
    help:
      en: "Describe what should be built, in plain language. The implementer will ask about anything ambiguous."
      zh-CN: "用自然语言描述要实现的内容，实现者会就不明确之处向你提问。"
    ui: { widget: textarea, rows: 10 }
  - key: repo
    type: repoRef
    required: true
    label: { en: "Repository", zh-CN: "代码仓库" }
  - key: branch
    type: string
    default: main
    label: { en: "Base branch", zh-CN: "基准分支" }

workspace:
  repo: ${inputs.repo}
  ref: ${inputs.branch}
  access: readWrite

skills:
  - ref: builtin/git-workflow@^1
  - ref: builtin/test-runner@^1
    optional: true

models:
  planning: { tier: strong, fallback: [balanced] }
  coding: { tier: strong, fallback: [balanced] }
  review: { tier: strong, fallback: [fast] }

phases:
  - id: setup
    name: { en: "Setup", zh-CN: "准备" }
    steps:
      - id: checkout
        kind: system
        action: workspace.checkout
      # default branch name: agrippa/run-<n>-<shortId> — the shortId suffix
      # keeps branches unique across tasks (run numbers restart per task)
      - id: branch
        kind: system
        action: git.branch

  - kind: loop
    id: clarify
    name: { en: "Clarify", zh-CN: "澄清" }
    maxIterations: 3
    until: checkpoints.clarify-qa.outcome == 'pass'
    onMaxIterations: continue
    phases:
      - id: clarify-round
        name: { en: "Q&A round", zh-CN: "问答轮次" }
        steps:
          - id: analyze-requirement
            kind: agent
            agent: implementer
            model: { role: planning }
            instructions: |
              Analyze the requirement below against this codebase.

              Answers the user already gave (empty on the first round):
              ${checkpoints.clarify-qa.answers}

              If material ambiguities remain, write the questions artifact as JSON:
              {"questions": [{"id": "q1", "text": "…", "kind": "text|select|boolean",
              "options": ["…"], "required": true, "recommended": "your suggested answer"}]}
              Rules: select questions MUST list their options; `recommended` must match
              the question kind (true/false for boolean, one of the options for select,
              a string otherwise). Ask only what genuinely changes the implementation;
              recommend an answer for every question. If everything is clear, write an
              EMPTY questions list ({"questions": []}) and write clarification-notes
              summarizing the agreed scope, the affected areas of the code, and the
              acceptance criteria.

              --- REQUIREMENT ---
              ${inputs.requirement}
            produces: [questions, clarification-notes]
          - id: clarify-qa
            kind: checkpoint
            checkpoint:
              kind: input
              source: questions
              title: { en: "Answer the implementer's questions", zh-CN: "回答实现者的问题" }
              timeout: 48h

  - kind: loop
    id: plan
    name: { en: "Plan", zh-CN: "规划" }
    maxIterations: 3
    until: checkpoints.confirm-plan.outcome == 'approved'
    onMaxIterations: fail
    phases:
      - id: plan-round
        name: { en: "Plan round", zh-CN: "规划轮次" }
        steps:
          - id: draft-plan
            kind: agent
            agent: implementer
            model: { role: planning }
            instructions: |
              Produce (or revise) the implementation plan for the clarified requirement:
              ordered steps with file-level detail, test strategy, and verification
              criteria a reviewer can check.

              Clarified scope: ${artifacts.clarification-notes}
              Change-request feedback from the user (empty on the first round):
              ${checkpoints.confirm-plan.comment}

              --- REQUIREMENT ---
              ${inputs.requirement}
            produces: [implementation-plan]
          - id: confirm-plan
            kind: checkpoint
            checkpoint:
              kind: approval
              present: [implementation-plan]
              title: { en: "Confirm the implementation plan", zh-CN: "确认实现方案" }
              timeout: 48h
              onTimeout: cancel

  - id: implement
    name: { en: "Implement", zh-CN: "实现" }
    steps:
      - id: implement
        kind: agent
        agent: implementer
        model: { role: coding }
        skills: ["builtin/git-workflow@^1", "builtin/test-runner@^1"]
        instructions: |
          Implement the confirmed plan on the CURRENT branch — the platform already
          created it; do NOT create or switch branches. Local commits are optional
          checkpoints only: the platform publishes the approved filesystem state as
          one verified snapshot commit. Run the repository's test suite before
          finishing.

          The confirmed plan:
          ${artifacts.implementation-plan}
        produces: [changes]

  - kind: loop
    id: review-fix
    name: { en: "Review & fix", zh-CN: "评审与修复" }
    maxIterations: 3
    until: checkpoints.review-gate.outcome == 'pass'
    onMaxIterations: continue
    phases:
      - id: review-round
        name: { en: "Review round", zh-CN: "评审轮次" }
        steps:
          - id: review
            kind: agent
            agent: reviewer
            model: { role: review }
            # the reviewer never writes: anything it changed would be
            # published without re-review, and the engine refuses to push a
            # workspace that drifted from the reviewed patch
            access: readOnly
            # an invalid review-report fails this step at store time; one
            # retry gives the reviewer a second chance at well-formed JSON
            retry: { max: 1 }
            instructions: |
              Review the COMPLETE workspace state against the base branch for
              correctness, security, and codebase conventions. Use
              `git diff ${inputs.branch} --` plus `git status --short`, and inspect
              every untracked file. Local commit history is advisory only; the
              platform publishes one verified snapshot commit. Do NOT modify any code
              — you are the reviewer.

              The plan the change claims to implement:
              ${artifacts.implementation-plan}

              Write the review-report artifact as JSON:
              {"summary": "…", "findings": [{"id": "f1", "severity":
              "blocker|major|minor|info", "file": "path", "line": 1, "title": "…",
              "detail": "…", "suggestion": "…"}]}
              An empty findings array means the change is approved.
            produces: [review-report]
          - id: review-gate
            kind: checkpoint
            checkpoint:
              kind: review-gate
              source: review-report
              present: [review-report, changes]
              title: { en: "Review findings", zh-CN: "评审结果" }
              timeout: 48h
          - id: fix
            kind: agent
            agent: implementer
            model: { role: coding }
            when: checkpoints.review-gate.outcome == 'fix'
            skills: ["builtin/test-runner@^1"]
            instructions: |
              Fix EXACTLY these review findings on the current branch. Do not expand
              the scope beyond them; re-run the tests before finishing. A local commit
              is optional because the platform publishes one verified snapshot commit.

              ${checkpoints.review-gate.selectedFindings}
            produces: [changes]

  - id: publish
    name: { en: "Publish", zh-CN: "发布" }
    steps:
      - id: confirm-publish
        kind: checkpoint
        # only reached when the review loop exhausted right after a fix that was
        # never re-reviewed — the user explicitly signs off before the PR opens
        when: checkpoints.review-gate.outcome == 'fix'
        checkpoint:
          kind: approval
          present: [changes]
          title:
            en: "The last fix was not re-reviewed — open the pull request anyway?"
            zh-CN: "最后一轮修复未经复审——仍要创建 PR 吗？"
          timeout: 48h
          onTimeout: cancel
      - id: push
        kind: system
        action: git.push
        retry: { max: 2 }
      - id: open-pr
        kind: system
        action: pr.open
        retry: { max: 2 }
        with:
          title: "${run.taskTitle}"
          base: "${inputs.branch}"
          body: |
            ## Requirement

            ${inputs.requirement}

            ## Implementation plan

            ${artifacts.implementation-plan}
        produces: [pull-request]

budget:
  maxCostUsd: 15
  maxDurationMinutes: 120
  perPhase:
    implement: { maxCostUsd: 6 }
    review-round: { maxCostUsd: 5 }

outputs:
  - { key: questions, kind: json, required: false }
  - { key: clarification-notes, kind: markdown, required: false }
  - { key: implementation-plan, kind: markdown, required: true }
  - { key: changes, kind: patch, required: true }
  - { key: review-report, kind: json, required: true }
  - { key: pull-request, kind: link, required: true }
summary: { from: implementation-plan }
```

- [ ] **Step 2: Validate**

Run: `cd /home/leonaltair/code/agrippa && bun run templates:validate`
Expected: PASS (7/7).

- [ ] **Step 3: Add the multi-agent + v1-still-works tests**

Add to the `describe("v3 format", ...)` block in `packages/orchestration/src/compile.test.ts`:

```ts
  it("compiles a v3 multi-agent template", () => {
    const source = readFileSync(
      path.join(TEMPLATES_DIR, "swdev/requirement-delivery.yaml"),
      "utf8",
    );
    const { compiled } = compileTemplate(source, { resolveFile });
    expect(compiled.metadata.slug).toBe("swdev.requirement-delivery");
    expect(Object.keys(compiled.spec.agents)).toEqual(["implementer", "reviewer"]);
    const loops = compiled.spec.phases.filter((n) => "kind" in n && n.kind === "loop");
    expect(loops.length).toBeGreaterThan(0);
  });

  it("v1 template still works alongside v3", () => {
    const v1Source = readFileSync(path.join(TEMPLATES_DIR, "swdev/bug-localize-fix.yaml"), "utf8");
    const v1Compiled = compileTemplate(v1Source, { resolveFile });
    expect(v1Compiled.compiled.metadata.slug).toBe("swdev.bug-localize-fix");
    expect(Object.keys(v1Compiled.compiled.spec.agents)).toEqual(["main"]);
    expect(upgradeCompiledTemplate(v1Compiled.compiled)).toBe(v1Compiled.compiled);
  });
```

- [ ] **Step 4: Run the tests**

Run: `cd /home/leonaltair/code/agrippa && bun test packages/orchestration/src/compile.test.ts`
Expected: all v3 tests PASS; existing v1/v2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add templates/swdev/requirement-delivery.yaml packages/orchestration/src/compile.test.ts
git commit -m "feat(templates): convert swdev/requirement-delivery to the v3 flat format

The only multi-agent builtin: spec.agents -> top-level slots, the rest of
the spec wrapper flattened. The phases block (clarify/plan/review-fix loops
+ checkpoints + SCM actions) is copied verbatim — same IR, same runtime.
Adds the v3 multi-agent compile test and a v1-still-works guard."
```

---

### Task 6: Convert `templates/swdev/requirements-dev.yaml` (subagents + approval)

**Files:**
- Rewrite: `templates/swdev/requirements-dev.yaml`

**Interfaces:**
- Consumes: Task 2 routing. `subagents` (with `promptFile`) flows to `spec.resources.subagents`; the compiler's existing promptFile-resolution step inlines it.

- [ ] **Step 1: Rewrite the template to v3**

Overwrite `templates/swdev/requirements-dev.yaml`. The `plan` phase's v1 `approval:` becomes a head-of-phase `kind: checkpoint` step (id `approve-design`, from `approval.checkpoint`). The `subagents:` block (with `promptFile: _shared/prompts/code-locator.md`) is promoted to top level.

```yaml
version: 3
slug: swdev.requirements-dev
scenario: software-development
name: { en: "Requirements Development", zh-CN: "需求开发" }
description:
  en: "Turn a requirement into a clarified design and an implementation plan for the codebase."
  zh-CN: "将需求转化为清晰的设计与针对代码库的实现方案。"

faber: forge

inputs:
  - key: requirement
    type: text
    required: true
    label: { en: "Requirement", zh-CN: "需求描述" }
    ui: { widget: textarea, rows: 10 }
  - key: repo
    type: repoRef
    required: true
    label: { en: "Repository", zh-CN: "代码仓库" }
  - key: branch
    type: string
    default: main
    label: { en: "Base branch", zh-CN: "基准分支" }

workspace:
  repo: ${inputs.repo}
  ref: ${inputs.branch}
  access: readOnly

subagents:
  - id: code-locator
    description: "Explores the codebase to ground the design in reality"
    promptFile: _shared/prompts/code-locator.md
    tools: [Read, Grep, Glob]
    model: { role: analysis }

models:
  planning: { tier: strong, fallback: [balanced] }
  analysis: { tier: balanced }
  fast: { tier: fast }

phases:
  - id: clarify
    name: { en: "Clarify", zh-CN: "澄清" }
    steps:
      - id: setup
        kind: system
        action: workspace.checkout
      - id: clarify-requirement
        kind: agent
        model: { role: analysis }
        instructions: |
          Analyze the requirement against the codebase. List ambiguities with your
          recommended resolution for each, affected areas of the code, and the
          acceptance criteria you infer.
          --- REQUIREMENT ---
          ${inputs.requirement}
        produces: [clarification-notes]

  - id: design
    name: { en: "Design", zh-CN: "设计" }
    steps:
      - id: draft-design
        kind: agent
        model: { role: planning }
        subagents: [code-locator]
        instructions: |
          Produce a design proposal grounded in the existing code: approach,
          affected modules with file references, data/API changes, alternatives
          considered, and risks.
        produces: [design-proposal]

  - id: plan
    name: { en: "Plan", zh-CN: "规划" }
    steps:
      - id: approve-design
        kind: checkpoint
        checkpoint:
          kind: approval
          title: { en: "Approve the design proposal", zh-CN: "确认设计方案" }
          present: [design-proposal]
          timeout: 48h
          onTimeout: cancel
      - id: implementation-plan
        kind: agent
        model: { role: planning }
        instructions: |
          Turn the approved design into an ordered implementation plan:
          steps with file-level detail, test strategy, and verification criteria
          a reviewer can check.
        produces: [implementation-plan]

budget:
  maxCostUsd: 6
  maxDurationMinutes: 40

outputs:
  - { key: clarification-notes, kind: markdown, required: false }
  - { key: design-proposal, kind: markdown, required: true }
  - { key: implementation-plan, kind: markdown, required: true }
summary: { from: implementation-plan }
```

- [ ] **Step 2: Validate**

Run: `cd /home/leonaltair/code/agrippa && bun run templates:validate`
Expected: PASS (7/7). The `code-locator` subagent's `promptFile` is inlined at compile time by the existing resolver.

- [ ] **Step 3: Commit**

```bash
git add templates/swdev/requirements-dev.yaml
git commit -m "feat(templates): convert swdev/requirements-dev to the v3 flat format

Subagents (with promptFile) promoted to top level; the plan phase's v1
approval: becomes a head-of-phase kind: checkpoint step (approve-design).
Same IR; promptFile inlining still runs in the existing compile step."
```

---

### Task 7: Convert `templates/test/test-plan.yaml`

**Files:**
- Rewrite: `templates/test/test-plan.yaml`

- [ ] **Step 1: Rewrite the template to v3**

Overwrite `templates/test/test-plan.yaml`:

```yaml
version: 3
slug: test.test-plan
scenario: test-verification
name: { en: "Test Plan", zh-CN: "测试计划" }
description:
  en: "Produce a risk-based test plan and case matrix for a feature or change."
  zh-CN: "为功能或变更生成基于风险的测试计划与用例矩阵。"

faber: sentinel

inputs:
  - key: changeDescription
    type: text
    required: true
    label: { en: "Feature or change to test", zh-CN: "待测功能或变更" }
    ui: { widget: textarea, rows: 8 }
  - key: repo
    type: repoRef
    required: true
    label: { en: "Repository", zh-CN: "代码仓库" }
  - key: riskFocus
    type: select
    default: functional
    label: { en: "Primary risk focus", zh-CN: "主要风险关注点" }
    options:
      - { value: functional, label: { en: "Functional correctness", zh-CN: "功能正确性" } }
      - { value: regression, label: { en: "Regression safety", zh-CN: "回归安全" } }
      - { value: performance, label: { en: "Performance", zh-CN: "性能" } }
      - { value: security, label: { en: "Security", zh-CN: "安全" } }

workspace:
  repo: ${inputs.repo}
  access: readOnly

models:
  analysis: { tier: balanced, fallback: [fast] }
  fast: { tier: fast }

phases:
  - id: analyze
    name: { en: "Analyze", zh-CN: "分析" }
    steps:
      - id: setup
        kind: system
        action: workspace.checkout
      - id: analyze-risk
        kind: agent
        model: { role: analysis }
        instructions: |
          Analyze the change below against the codebase with a "${inputs.riskFocus}"
          risk focus. Identify what could break, boundary conditions, and the
          existing test coverage relevant to it.
          --- CHANGE ---
          ${inputs.changeDescription}
        produces: [risk-analysis]

  - id: plan
    name: { en: "Plan", zh-CN: "计划" }
    steps:
      - id: design-cases
        kind: agent
        model: { role: analysis }
        instructions: |
          Produce (1) a test plan: scope, environments, entry/exit criteria,
          prioritized by the risk analysis; and (2) a case matrix table:
          case id, precondition, steps, expected result, priority.
        produces: [test-plan, case-matrix]

budget:
  maxCostUsd: 3
  maxDurationMinutes: 20

outputs:
  - { key: risk-analysis, kind: markdown, required: false }
  - { key: test-plan, kind: markdown, required: true }
  - { key: case-matrix, kind: markdown, required: true }
summary: { from: test-plan }
```

- [ ] **Step 2: Validate**

Run: `cd /home/leonaltair/code/agrippa && bun run templates:validate`
Expected: PASS (7/7).

- [ ] **Step 3: Commit**

```bash
git add templates/test/test-plan.yaml
git commit -m "feat(templates): convert test/test-plan to the v3 flat format"
```

---

### Task 8: Convert `templates/test/regression-verify.yaml` (subagents + skills)

**Files:**
- Rewrite: `templates/test/regression-verify.yaml`

- [ ] **Step 1: Rewrite the template to v3**

Overwrite `templates/test/regression-verify.yaml`. `skills` and `subagents` (with `promptFile`) are promoted to top level; the `run-suites` agent step keeps its `retry: { max: 1 }`.

```yaml
version: 3
slug: test.regression-verify
scenario: test-verification
name: { en: "Regression Verification", zh-CN: "回归验证" }
description:
  en: "Run the test suites against a change and report a verdict with evidence."
  zh-CN: "针对变更执行测试套件，输出带证据的验证结论。"

faber: sentinel

inputs:
  - key: repo
    type: repoRef
    required: true
    label: { en: "Repository", zh-CN: "代码仓库" }
  - key: ref
    type: string
    default: main
    label: { en: "Branch or ref to verify", zh-CN: "待验证分支或引用" }
  - key: testCommand
    type: string
    required: false
    label: { en: "Test command (optional; auto-detected otherwise)", zh-CN: "测试命令（可选，默认自动识别）" }

workspace:
  repo: ${inputs.repo}
  ref: ${inputs.ref}
  access: readWrite

skills:
  - ref: builtin/test-runner@^1

subagents:
  - id: verifier
    description: "Runs tests and validates outcomes"
    promptFile: _shared/prompts/verifier.md
    tools: [Bash, Read]
    model: { role: fast }

models:
  analysis: { tier: balanced, fallback: [fast] }
  fast: { tier: fast }

phases:
  - id: setup
    name: { en: "Setup", zh-CN: "准备" }
    steps:
      - id: setup
        kind: system
        action: workspace.checkout

  - id: execute
    name: { en: "Execute", zh-CN: "执行" }
    steps:
      - id: run-suites
        kind: agent
        model: { role: fast }
        subagents: [verifier]
        skills: [builtin/test-runner]
        instructions: |
          Run the test suites on ref "${inputs.ref}".
          ${inputs.testCommand} — use this command if provided, otherwise detect
          the project's test command. Capture verbatim results; re-run single
          failures once to separate flakes from deterministic failures.
        produces: [test-log]
        retry: { max: 1 }

  - id: verdict
    name: { en: "Verdict", zh-CN: "结论" }
    steps:
      - id: verdict
        kind: agent
        model: { role: analysis }
        instructions: |
          Write the verification verdict: pass/fail per suite, deterministic
          failures vs flakes, and verbatim evidence for every claim. End with a
          single-line verdict: PASS, FAIL, or PASS-WITH-FLAKES.
        produces: [verdict-report]

budget:
  maxCostUsd: 4
  maxDurationMinutes: 30

outputs:
  - { key: test-log, kind: markdown, required: false }
  - { key: verdict-report, kind: markdown, required: true }
summary: { from: verdict-report }
```

- [ ] **Step 2: Validate**

Run: `cd /home/leonaltair/code/agrippa && bun run templates:validate`
Expected: PASS (7/7).

- [ ] **Step 3: Commit**

```bash
git add templates/test/regression-verify.yaml
git commit -m "feat(templates): convert test/regression-verify to the v3 flat format

skills + subagents (with promptFile) promoted to top level; run-suites
keeps its retry. Same IR."
```

---

### Task 9: Update `docs/design/02-orchestration-template.md`

**Files:**
- Modify: `docs/design/02-orchestration-template.md`

- [ ] **Step 1: Add v3 as the recommended authoring format**

Update the title line (line 1) and the "Two authoring versions exist" paragraph (line 7) to mention v3. Replace line 1:

```markdown
# 02 — Orchestration Template Format (`agrippa/v1`, `agrippa/v2`, `agrippa/v3`)
```

Replace the line 7 paragraph with:

```markdown
Three authoring versions exist: `agrippa/v3` (the recommended flat format — top-level `slug`/`scenario`/`faber`/`slots`/`models`/`budget`/`outputs`, no `metadata`/`spec` wrappers; [ADR-0016](../adr/0016-v3-flat-authoring-format.md)), `agrippa/v2` (agent slots, checkpoint steps, bounded loops, SCM actions — [ADR-0010](../adr/0010-agrippa-v2-slots-checkpoints-loops.md)), and `agrippa/v1` (linear phases, phase-level approvals — [ADR-0006](../adr/0006-yaml-template-format.md)). All three compile to one v2-shaped IR (`CompiledTemplate`); pure `upgradeV1ToV2` and `normalizeV3ToCompiled` run at compile time, and `upgradeCompiledTemplate` normalizes stored compiled rows, so v1/v3 templates keep working unchanged and no data migration ever happens. **Author new templates in v3.**
```

- [ ] **Step 2: Add a v3 section**

After the `## agrippa/v2 additions` section (which ends before `## Full Example`), insert a new section:

```markdown
## `agrippa/v3` flat authoring format ([ADR-0016](../adr/0016-v3-flat-authoring-format.md))

v3 is a **source-only** flattening of the v2 format — the IR is identical, so the engine, API, and DB are unchanged. New templates should be authored in v3; v1/v2 remain accepted.

Top level (no `apiVersion`/`kind`/`metadata`/`spec`):

```yaml
version: 3
slug: <scenario-slug>.<template-slug>     # was metadata.slug
scenario: <scenario slug>                  # was metadata.scenario
name: { en: "...", zh-CN: "..." }          # both locales always
description: { en: "...", zh-CN: "..." }

faber: <faber-slug>                        # single-agent (was spec.faber)
# OR, for multi-agent:
slots:                                     # was spec.agents
  <slot-id>: { label, faber, executor, overridable }

inputs: [...]                              # was spec.inputs (unchanged)
workspace: { repo, ref, access }           # was spec.workspace (unchanged)

skills: [...]                              # was spec.resources.skills
mcpServers: [...]                          # was spec.resources.mcpServers
subagents: [...]                           # was spec.resources.subagents

models:                                    # was spec.models.roles (wrapper removed)
  <role>: { tier, fallback }
allowProjectOverride: true                 # was spec.models.allowProjectOverride

phases: [...]                              # was spec.phases (phase + loop nodes)
budget: { maxCostUsd, maxDurationMinutes, perPhase }  # was spec.budgets (singular)
outputs: [{ key, kind, required }]         # was spec.outputs.artifacts (wrapper removed)
summary: { from: <key> }                   # was spec.outputs.summary
```

A v3 template declares **exactly one** of `faber` or `slots` (root-level `z.refine`). Single-agent compiles to one non-overridable `main` slot, identical to the v1 upgrade. A v1 phase-level `approval:` must be written in v3 as a `kind: checkpoint` step at the head of the phase (the compiler does this automatically for v1; v3 authors do it explicitly). See `templates/pm/status-report.yaml` (single-agent) and `templates/swdev/requirement-delivery.yaml` (multi-agent) for working references.
```

- [ ] **Step 3: Commit**

```bash
git add docs/design/02-orchestration-template.md
git commit -m "docs(design): document the v3 flat authoring format in 02

v3 is the recommended source format; v1/v2 stay accepted. All three
compile to the same v2 IR."
```

---

### Task 10: Update the bilingual user manual `05-template-authoring.md`

**Files:**
- Modify: `docs/manual/en/05-template-authoring.md`
- Modify: `docs/manual/zh-CN/05-template-authoring.md`

- [ ] **Step 1: Rewrite the EN "minimal template, annotated" example to v3**

In `docs/manual/en/05-template-authoring.md`, replace the fenced YAML block under `## A minimal template, annotated` (the `apiVersion: agrippa/v1` ... `summary: { from: result }` block) with:

```yaml
version: 3
slug: swdev.my-task            # <scenario-prefix>.<name>, must match the template head
scenario: software-development # must match the head's scenario
name: { en: "My Task", zh-CN: "我的任务" }        # BOTH locales, always
description: { en: "...", zh-CN: "……" }

faber: forge                   # default preset agent (single-agent)

inputs:                        # ⇒ auto-generates the submission form
  - key: goal
    type: text                 # string|text|number|boolean|select|repoRef|docRef
    required: true
    label: { en: "Goal", zh-CN: "目标" }
    ui: { widget: textarea, rows: 6 }

models:                        # roles → tiers; resolved to granted models at submit
  planning: { tier: strong, fallback: [balanced] }
  fast: { tier: fast }

phases:
  - id: work
    name: { en: "Work", zh-CN: "执行" }
    steps:
      - id: do-it
        kind: agent
        model: { role: planning }
        instructions: |
          Accomplish this goal: ${inputs.goal}
        produces: [result]     # artifact keys this step must create

budget:
  maxCostUsd: 6
  maxDurationMinutes: 40

outputs:
  - { key: result, kind: markdown, required: true }   # run fails without it
summary: { from: result }
```

Also update the prose introducing it: change "## A minimal template, annotated" to add a one-line note after the heading: `The v3 flat format is the recommended way to author templates; v1/v2 sources are still accepted. See [docs/design/02](../../design/02-orchestration-template.md) for the full spec.`

- [ ] **Step 2: Update the EN "Approvals, budgets, artifacts" example to v3**

In the same EN file, replace the `phases:`/`budgets:` fenced block under `## Approvals, budgets, artifacts` with the v3 form (phase-level `approval:` → a `kind: checkpoint` step; `budgets:` → `budget:`):

```yaml
phases:
  - id: build
    steps:
      - id: approve-plan                # gate BEFORE the build runs (was phase-level approval:)
        kind: checkpoint
        checkpoint:
          kind: approval
          title: { en: "Approve the plan", zh-CN: "确认方案" }
          present: [draft-plan]         # artifacts shown to the approver
          timeout: 48h                  # then: cancel | reject | approve
          onTimeout: cancel
      - id: do-build
        kind: agent
        model: { role: planning }
        instructions: "build it"
        produces: [built]

budget:
  maxCostUsd: 6
  maxDurationMinutes: 40
  perPhase:
    build: { maxCostUsd: 3 }
```

And in the "Execution plan" section, update the line that says step kinds include `system` (currently `workspace.checkout`) to mention v2 SCM actions too: change "`system` (platform action; currently `workspace.checkout`)" to "`system` (platform action: `workspace.checkout`, `git.branch`, `git.push`, `pr.open` — v2)". Add a sentence: "Multi-agent templates declare `slots:` instead of `faber:`; bounded loops (`kind: loop`) and checkpoint steps (`kind: checkpoint`) are available in v3/v2 (ADR-0010)."

- [ ] **Step 3: Apply the same v3 edits to the zh-CN manual**

The zh-CN file `docs/manual/zh-CN/05-template-authoring.md` mirrors the EN structure exactly (confirmed): `## 最小模板（带注释）` at line 11 holds the annotated `apiVersion: agrippa/v1` example (lines 14–50), and `## 审批、预算、产出物` at line 79 holds the `phases:`/`budgets:` example. Apply the **same structural changes** as steps 1–2: replace the annotated minimal-example YAML block (lines 14–50) with the v3 YAML from Step 1 (the YAML is locale-neutral — same content), and replace the approvals/budgets example block (lines 82–96) with the v3 checkpoint-step + `budget:` form from Step 2. Then update the surrounding zh-CN prose to match the EN prose changes: a one-line note after `## 最小模板（带注释）` that v3 是推荐格式、v1/v2 仍受支持（见 [docs/design/02](../../design/02-orchestration-template.md)）；and in the `## 执行计划` section, note that `system` actions include `git.branch`/`git.push`/`pr.open`（v2），多代理模板用 `slots:` 代替 `faber:`，有界循环（`kind: loop`）与检查点步骤（`kind: checkpoint`）在 v3/v2 可用（ADR-0010）。

- [ ] **Step 4: Verify i18n parity + build**

Run: `cd /home/leonaltair/code/agrippa && bun run check && bun run build`
Expected: PASS (the i18n parity test only covers `packages/i18n/locales`, but `bun run check` lints the docs-tree where applicable; `bun run build` builds the SPA).

- [ ] **Step 5: Commit (both locales together)**

```bash
git add docs/manual/en/05-template-authoring.md docs/manual/zh-CN/05-template-authoring.md
git commit -m "docs(manual): teach the v3 flat format in template authoring (en + zh-CN)

Both locales move together: the annotated minimal example and the
approvals/budgets example now use v3 (top-level keys, checkpoint step for
approvals, singular budget). v1/v2 noted as still accepted."
```

---

### Task 11: Write ADR-0016

**Files:**
- Create: `docs/adr/0016-v3-flat-authoring-format.md`

- [ ] **Step 1: Create the ADR**

Create `docs/adr/0016-v3-flat-authoring-format.md`:

```markdown
# ADR-0016: agrippa/v3 — Flat Authoring Format

- Status: accepted · Date: 2026-07-28
- Complements ADR-0006 (v1) and ADR-0010 (v2); does not amend either.

## Context

The v1/v2 source format mirrors a Kubernetes resource: `apiVersion`, `kind: OrchestrationTemplate`, `metadata`, `spec`. That nesting was carried over to make the format feel familiar, but Agrippa has exactly one resource type — the `kind` field is always `OrchestrationTemplate`, `apiVersion` is always one of three values, and every field authors care about lives under `spec` (and, for resources/models/outputs, one level deeper still). The nesting adds keystrokes and indirection without carrying information, and it pushes every real field two indent levels right.

The IR is stable: `CompiledTemplate` (the v2 shape) is what the engine, API, and DB depend on, and ADR-0010 already established that v1 sources upgrade into it at compile time. A flat source format is therefore pure sugar — it can compile into the same IR with no downstream change.

## Decision

Introduce `version: 3` (integer) as a flat, GitHub-Actions-style authoring format alongside v1/v2. v3 is **source-only**: `normalizeV3ToCompiled` flattens a v3 doc into the unchanged `CompiledTemplate` at compile time, and `upgradeCompiledTemplate` (which normalizes stored compiled rows) is unchanged because stored rows hold the v2 IR, which is what v3 compiles to.

1. **Top-level keys.** `metadata.*` and `spec.*` are promoted to the top level: `slug`, `scenario`, `name`, `description`, `faber`/`slots`, `inputs`, `workspace`, `skills`, `mcpServers`, `subagents`, `models`, `allowProjectOverride`, `phases`, `budget`, `outputs`, `summary`. `apiVersion` + `kind` collapse to `version: 3`.
2. **Wrappers removed.** `spec.resources` → top-level `skills`/`mcpServers`/`subagents`; `spec.models.roles` → `models`; `spec.models.allowProjectOverride` → `allowProjectOverride`; `spec.budgets` → `budget` (singular); `spec.outputs.artifacts` → `outputs`; `spec.outputs.summary` → `summary`.
3. **Agent declaration is exclusive.** A v3 template declares exactly one of `faber` (single-agent) or `slots` (multi-agent), enforced by a root `z.refine`. Single-agent compiles to one non-overridable `main` slot bound to `EXECUTOR_DEFAULT_SENTINEL` — identical to the v1 upgrade — so single-agent v3 and upgraded v1 produce the same IR.
4. **Phase-level approvals are explicit.** v1's phase-level `approval:` is gone (v3 `phases` use the v2 step schema). Authors write the gate as a `kind: checkpoint` step at the head of the phase — exactly what `upgradeV1ToV2` synthesizes for v1, so a converted template yields the same IR.
5. **v1/v2 stay accepted.** `compileTemplate` routes on `version: 3` first, then the existing `apiVersion` branches. No v1/v2 source changes; the v1→v2 upgrade path stays exercised by the kept-v1 `bug-localize-fix.yaml` fixture.

## Alternatives considered

- **Rewrite the IR to a v3 shape.** Rejected: it would touch the engine, API, DB schema, and every stored compiled row, for zero behavioral gain — the v2 IR is already the contract.
- **A separate pre-processor** that emits a v2 doc string. Rejected: it would duplicate parse/checksum logic and bypass the single compile pipeline shared by `templates:validate`, `templates:seed`, and the API editor.
- **Deprecate v1/v2 on sight.** Rejected: `bug-localize-fix.yaml` is the v1→v2 upgrade-path fixture and the most complex v1 template (subagents + phase approval + promptFile); keeping it v1 gives continuous real-fixture coverage of the upgrade path, and v1/v2 sources in the wild keep compiling.

## Consequences

- Six builtins (`pm/status-report`, `pm/plan-breakdown`, `swdev/requirement-delivery`, `swdev/requirements-dev`, `test/test-plan`, `test/regression-verify`) move to v3; `swdev/bug-localize-fix.yaml` is intentionally kept on v1 as the upgrade-path fixture (to be converted only if the `mutate()`-based compiler tests are rewritten to v3 paths in the same change).
- Re-seeding publishes new immutable versions for the six changed builtins (checksums differ); runs that pinned an older version keep resolving their stored v2 IR — no migration, no behavior change.
- The engine, API, DB schema, and `CompiledTemplate` type are unchanged.
- New templates should be authored in v3; the bilingual manual and `docs/design/02` now teach v3 first.
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0016-v3-flat-authoring-format.md
git commit -m "docs(adr): ADR-0016 — agrippa/v3 flat authoring format

Records v3 as source-only sugar over the v2 IR: top-level keys, wrappers
removed, faber/slots exclusive, phase approvals explicit. v1/v2 stay
accepted; bug-localize-fix.yaml kept on v1 as the upgrade-path fixture."
```

---

### Task 12: Update `ARCHITECTURE.md` and `CHANGELOG.md`

**Files:**
- Modify: `ARCHITECTURE.md` (template mention line 33 and any format-version mention)
- Modify: `CHANGELOG.md` (add under `[Unreleased]`)

- [ ] **Step 1: Update the ARCHITECTURE builtin-templates line**

In `ARCHITECTURE.md`, replace the `templates/` row (line 33) text:

```markdown
| `templates/` | Builtin templates (6 × `agrippa/v3` + the `swdev.bug-localize-fix.yaml` v1 fixture), shared subagent prompts, builtin skills. Compiled + published at boot, checksum-guarded. Author new templates in v3 (ADR-0016); v1/v2 still accepted. |
```

- [ ] **Step 2: Add the CHANGELOG entry**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Added`, add this entry at the top of the `Added` list:

```markdown
- **Template format v3 — flat authoring format (ADR-0016)** — templates can now be authored in a flat, GitHub-Actions-style `version: 3` format with no `apiVersion`/`kind`/`metadata`/`spec` wrappers: top-level `slug`/`scenario`/`name`, `faber`-or-`slots` agent declaration, flat `skills`/`mcpServers`/`subagents`, `models` (no `.roles` wrapper), singular `budget`, and `outputs` (no `.artifacts` wrapper). v3 is source-only — `normalizeV3ToCompiled` flattens it into the unchanged v2 IR (`CompiledTemplate`), so the engine, API, and DB are untouched; `compileTemplate` routes on `version: 3` before the existing `apiVersion` branches. Six builtins converted (`pm/status-report`, `pm/plan-breakdown`, `swdev/requirement-delivery`, `swdev/requirements-dev`, `test/test-plan`, `test/regression-verify`); `swdev/bug-localize-fix.yaml` is intentionally kept on v1 as the v1→v2 upgrade-path fixture. v1/v2 sources keep working; the bilingual template-authoring manual and `docs/design/02` now teach v3 first.
```

- [ ] **Step 3: Commit**

```bash
git add ARCHITECTURE.md CHANGELOG.md
git commit -m "docs: note v3 authoring format in ARCHITECTURE + CHANGELOG

Builtin count is now 6 v3 + 1 v1 (bug-localize-fix fixture). Unreleased
changelog records the flat format, the v3->v2 IR normalization, and the
kept-v1 fixture rationale."
```

---

### Task 13: Final verification — all gates

**Files:** none (verification only)

- [ ] **Step 1: Run the full check gate**

Run: `cd /home/leonaltair/code/agrippa && bun run check`
Expected: PASS (biome + tsc -b + dependency-direction).

- [ ] **Step 2: Validate all builtins**

Run: `cd /home/leonaltair/code/agrippa && bun run templates:validate`
Expected: PASS — all 7 builtins compile (6 v3 + the v1 `bug-localize-fix`).

- [ ] **Step 3: Run the full test suite**

Run: `cd /home/leonaltair/code/agrippa && bun test`
Expected: PASS. Note: integration suites need local Postgres (`TEST_DATABASE_URL`); if Postgres is unreachable they skip silently — "0 fail with skipped suites" is NOT a pass. Confirm the orchestration compiler tests (including the new v3 block) all run green.

- [ ] **Step 4: Build the SPA**

Run: `cd /home/leonaltair/code/agrippa && bun run build`
Expected: PASS.

- [ ] **Step 5: Confirm the checklist**

Verify against the design spec's completion checklist:
- `bun run check`, `bun run templates:validate`, `bun test`, `bun run build` all green.
- `bug-localize-fix.yaml` is still v1 (git shows no change to it).
- 6 templates are v3 (`head -1` on each shows `version: 3`).
- v3 schema validates both `faber` and `slots` modes (tests pass).
- `compileTemplate` routes `version: 3` (test passes).
- Tests cover v3 single-agent, multi-agent, and validation errors.
- Docs updated: `docs/design/02`, both `05-template-authoring.md` locales, ADR-0016, `ARCHITECTURE.md`, `CHANGELOG.md`.
- All bilingual fields carry both `en` and `zh-CN`.

- [ ] **Step 6: Final commit (if any doc/format fixups were needed during gates)**

If the gates surfaced fixups, commit them now with a focused message. If everything passed clean, no commit is needed — the work is complete.
