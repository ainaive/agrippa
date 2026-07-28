# Template Format v3 — Flat Authoring Format

**Date:** 2026-07-28
**Status:** Approved (design) — pending implementation plan
**Scope:** `packages/orchestration` (source format only), 6 builtin templates, docs, tests. No runtime/engine/API/DB changes.

## 1. Goal

Replace the K8s-style nested source format (`apiVersion` / `kind` / `metadata` / `spec`) with a flat, GitHub-Actions-Workflow-style declarative format for orchestration templates. Flatten unnecessary nesting so templates are more direct to write and read, without changing anything the engine, API, or DB depend on.

## 2. Design principles

1. **Flat over nested** — all fields at the top level; no `metadata`/`spec` wrappers.
2. **Single version field** — `version: 3` (integer) replaces `apiVersion: agrippa/v1` + `kind: OrchestrationTemplate`.
3. **Semantic top-level keys** — every top-level key has a clear meaning (`faber`, `slots`, `budget`, `outputs`, …).
4. **IR backward-compatible** — the internal `CompiledTemplate` type keeps its v2 shape unchanged; v3 is a *source* format only. The compiler normalizes v3 → v2 IR.
5. **Zero runtime impact** — engine, API, DB schema, and `CompiledTemplate` are not modified. Runs that already pinned a v2-IR version re-resolve identically.

## 3. v3 format specification

### Top-level keys

```yaml
version: 3                              # integer, fixed at 3
slug: <scenario-prefix>.<template-name>  # was metadata.slug
scenario: <scenario-id>                  # was metadata.scenario
name: { en: "...", zh-CN: "..." }        # was metadata.name
description: { en: "...", zh-CN: "..." } # was metadata.description

# ── one of (agent declaration) ──────────────────────
faber: <faber-slug>                      # single-agent template (was spec.faber)
# OR
slots:                                   # multi-agent template (was spec.agents)
  <slot-id>:
    label: { en: "...", zh-CN: "..." }
    faber: <faber-slug>
    executor: <executor-id>
    overridable: true|false

# ── common fields ────────────────────────────────────
inputs: [...]                            # unchanged (was spec.inputs)
workspace:                               # unchanged (was spec.workspace)
  repo: ${inputs.repo}
  ref: ${inputs.branch}
  access: readOnly|readWrite

# ── resources, promoted to top level ────────────────
skills: [...]                            # was spec.resources.skills
mcpServers: [...]                        # was spec.resources.mcpServers
subagents: [...]                         # was spec.resources.subagents

# ── models, .roles wrapper removed ──────────────────
models:
  <role-id>: { tier: ..., fallback: [...] }   # was spec.models.roles
allowProjectOverride: true               # was spec.models.allowProjectOverride

# ── flow (phases accepts phase and loop nodes) ──────
phases:                                  # was spec.phases (flowNodeSchema[])
  - id: <phase-id>
    name: { en: "...", zh-CN: "..." }
    steps: [...]
  - kind: loop
    id: <loop-id>
    ...

# ── budget, singular ─────────────────────────────────
budget:                                  # was spec.budgets
  maxCostUsd: <number>
  maxDurationMinutes: <number>
  perPhase:
    <phase-id>: { maxCostUsd: <number> }

# ── outputs, .artifacts wrapper removed ─────────────
outputs:                                 # was spec.outputs.artifacts
  - { key: <id>, kind: <kind>, required: true|false }
summary: { from: <artifact-key> }        # was spec.outputs.summary
```

### Field migration table

| Original (v1/v2) path | v3 path | Note |
|---|---|---|
| `apiVersion: agrippa/v1`/`v2` | `version: 3` | integer version |
| `kind: OrchestrationTemplate` | *(deleted)* | only one resource type |
| `metadata.slug` | `slug` | promoted |
| `metadata.scenario` | `scenario` | promoted |
| `metadata.name` | `name` | promoted |
| `metadata.description` | `description` | promoted |
| `spec.faber` | `faber` | single-agent |
| `spec.agents` | `slots` | multi-agent, renamed for clarity |
| `spec.inputs` | `inputs` | unchanged |
| `spec.workspace` | `workspace` | unchanged |
| `spec.resources.skills` | `skills` | promoted |
| `spec.resources.mcpServers` | `mcpServers` | promoted |
| `spec.resources.subagents` | `subagents` | promoted |
| `spec.models.roles` | `models` | wrapper removed |
| `spec.models.allowProjectOverride` | `allowProjectOverride` | promoted |
| `spec.phases` | `phases` | unchanged (already loop+phase mixed) |
| `spec.budgets` | `budget` | singularized |
| `spec.outputs.artifacts` | `outputs` | wrapper removed |
| `spec.outputs.summary` | `summary` | promoted |

### Agent-declaration rule

A v3 template declares **exactly one** of `faber` (single-agent) or `slots` (multi-agent), enforced by a root `z.refine`: `(faber !== undefined) !== (slots !== undefined)`.

- Single-agent compiles to one non-overridable `main` slot bound to the declared faber and the `EXECUTOR_DEFAULT_SENTINEL` executor — identical to `upgradeV1ToV2()`.
- Multi-agent compiles to `doc.slots` verbatim.

### Phase-level approval conversion

v1 `phases[].approval:` does not exist in v3 (v3 `phases` use the v2 step schema). Converting a v1 phase with `approval:` produces a `kind: checkpoint` step prepended to that phase's `steps:`, mirroring `upgradeV1ToV2()` exactly:

```yaml
# v1 phase approval            →   v3 checkpoint step
approval:                            - id: <approval.checkpoint>
  checkpoint: approve-plan            kind: checkpoint
  title: { ... }                       checkpoint:
  present: [draft-plan]                 kind: approval
  timeout: 48h                           title: { ... }
  onTimeout: cancel                       present: [draft-plan]
                                          timeout: 48h
                                          onTimeout: cancel
```

## 4. Implementation surface

### 4.1 `packages/orchestration/src/template-schema.ts` — add `templateDocV3Schema`

A new `z.object` reusing the existing (mostly module-internal) sub-schemas: `localizedTextSchema`, `templateInputSchema`, `skillRefSchema`, `mcpRefSchema`, `subagentSchema`, `modelRoleSchema`, `agentSlotSchema`, `flowNodeSchema`, `budgetsSchema`, `idSchema`, `templateSlugSchema`, `ARTIFACT_KINDS`. The schema lives in the same file, so the internal (non-exported) schemas are in scope. Export `templateDocV3Schema` and `type TemplateDocV3`.

Key shape (validated against the file):
- `version: z.literal(3)`
- `slug: templateSlugSchema`, `scenario: z.string().regex(/^[a-z][a-z0-9-]*$/)`, `name`/`description: localizedTextSchema`
- `faber: idSchema.optional()`, `slots: z.record(idSchema, agentSlotSchema).optional()`
- `inputs: z.array(templateInputSchema).default([])`
- `workspace: z.object({ repo: z.string(), ref: z.string().optional(), access: z.enum(["readOnly","readWrite"]).default("readOnly") }).optional()`
- `skills/mcpServers/subagents: z.array(<ref>).default([])`
- `models: z.record(z.string(), modelRoleSchema)`, `allowProjectOverride: z.boolean().default(true)`
- `phases: z.array(flowNodeSchema).min(1)` — phase+loop mixing inherited from `flowNodeSchema`
- `budget: budgetsSchema.default({ perPhase: {} })`
- `outputs: z.array(z.object({ key: idSchema, kind: z.enum(ARTIFACT_KINDS), required: z.boolean().default(false) })).min(1)`
- `summary: z.object({ from: idSchema }).optional()`
- root `.refine` enforcing the `faber` xor `slots` rule.

### 4.2 `packages/orchestration/src/compile.ts` — normalize + route

- New `normalizeV3ToCompiled(doc: TemplateDocV3): CompiledTemplate`. Single-agent → `agents: { [AGENT_STEP_DEFAULT_SLOT]: { label, faber, executor: EXECUTOR_DEFAULT_SENTINEL, overridable: false } }`; multi-agent → `agents: doc.slots`. Maps `models`→`spec.models.roles`, `allowProjectOverride`→`spec.models.allowProjectOverride`, `budget`→`spec.budgets`, `outputs`→`spec.outputs.artifacts`, `summary`→`spec.outputs.summary`, `skills/mcpServers/subagents`→`spec.resources`, `inputs`/`workspace`/`phases` verbatim. `EXECUTOR_DEFAULT_SENTINEL` and `AGENT_STEP_DEFAULT_SLOT` are already imported in `compile.ts`.
- `compileTemplate()` routing: read `version` first. `version === 3` → `templateDocV3Schema.safeParse` → `normalizeV3ToCompiled`. The existing `apiVersion === "agrippa/v1"|"v2"` branches are unchanged. The final `else` error becomes `"version must be 3, or apiVersion must be 'agrippa/v1' or 'agrippa/v2'"`.
- `upgradeCompiledTemplate()` is unchanged — it operates on stored `template_versions.compiled` values, which are always v2-IR (what v3 compiles to).

### 4.3 Templates — 6 converted, 1 kept

Convert to v3: `templates/pm/status-report.yaml`, `templates/pm/plan-breakdown.yaml`, `templates/swdev/requirement-delivery.yaml`, `templates/swdev/requirements-dev.yaml`, `templates/test/test-plan.yaml`, `templates/test/regression-verify.yaml`.

Keep on v1: `templates/swdev/bug-localize-fix.yaml` — the most complex v1 template (subagents + phase approval + promptFile); keeping it ensures the v1→v2 upgrade path has continuous real-fixture coverage, and avoids cascading breakage of the `mutate()`-based test suite (Appendix A). Rationale recorded in CHANGELOG + ADR-0015.

Because `compileTemplate` computes the checksum from the source YAML and the compiled IR is shape-identical, re-seeding publishes new immutable versions for the 6 changed builtins; runs that pinned an older version keep resolving their stored v2 IR. No migration.

### 4.4 Tests — `packages/orchestration/src/compile.test.ts`

Add a `describe("v3 format")` block reusing existing `issuesOf` / `resolveFile` / `TEMPLATES_DIR`:
1. compiles a v3 single-agent template (`pm/status-report`) → `agents` has `main`, `models.roles` has `analysis`, `outputs.artifacts` length 2;
2. compiles a v3 multi-agent template (`swdev/requirement-delivery`) → `agents` keys `["implementer","reviewer"]`, at least one loop node;
3. rejects v3 with both `faber` and `slots`;
4. rejects v3 with neither;
5. rejects v3 missing `version` (falls through to the routing error mentioning `version`);
6. `upgradeCompiledTemplate` is idempotent on v3-compiled output;
7. the v1 `bug-localize-fix` template still compiles alongside v3 → `agents` `["main"]`, idempotent upgrade.

### 4.5 Docs (the items the original prompt omitted, now approved)

- `docs/design/02-orchestration-template.md` — add a v3 section; mark v3 as the recommended authoring format, v1/v2 still accepted.
- `docs/manual/en/05-template-authoring.md` **and** `docs/manual/zh-CN/05-template-authoring.md` — rewrite the annotated examples to v3; keep a short "legacy v1/v2 still supported" note. Both locales move in the same commit (AGENTS.md requirement).
- `docs/adr/0015-v3-flat-authoring-format.md` — new ADR: v3 is source-only sugar, v2 IR unchanged, rationale for flat, the `bug-localize-fix` fixture decision.
- `ARCHITECTURE.md` — note v3 as the authoring format.
- `CHANGELOG.md` — `[Unreleased]` entry, including the rationale for keeping `bug-localize-fix.yaml` on v1.

## 5. Hard constraints (must not be violated)

- The `CompiledTemplate` type is not modified.
- Engine, API, and DB schema are not modified.
- v1 and v2 templates keep working (no change to their compile paths beyond adding the `version` branch ahead of them).
- All quality gates pass: `bun run check`, `bun run templates:validate` (7 builtins), `bun test` (Postgres required for integration), `bun run build`.

## 6. Execution order

1. Add `templateDocV3Schema` + `TemplateDocV3` to `template-schema.ts`.
2. Add `normalizeV3ToCompiled()` to `compile.ts`.
3. Update `compileTemplate()` version routing.
4. Convert `templates/pm/status-report.yaml` (simplest v1) → `bun run templates:validate` to confirm.
5. Convert `templates/pm/plan-breakdown.yaml` (phase approval → checkpoint step).
6. Convert `templates/swdev/requirement-delivery.yaml` (only multi-agent; phases verbatim).
7. Convert the remaining 3 (`requirements-dev`, `test-plan`, `regression-verify`).
8. Add the v3 test block to `compile.test.ts`.
9. Update docs: `docs/design/02`, both `05-template-authoring.md` locales, ADR-0015, `ARCHITECTURE.md`, `CHANGELOG.md`.
10. Final verification — all four gates.

## 7. Risks & mitigations

- **Test-fixture coupling** — `compile.test.ts` mutates `bug-localize-fix.yaml` via `doc.metadata.*` / `doc.spec.*` (v1 paths). Keeping that template v1 avoids the cascade (Appendix A). If a later cleanup converts it, those `mutate()` tests must move to v3 paths in the same change.
- **Biome formatting** — the new schema/normalize code must satisfy `bun run check`; write it in the file's existing style (2-space, trailing commas) to minimize churn.
- **Zod refine ordering** — the `faber`/`slots` XOR refine runs after field parsing; both-optional is correct (absent → `undefined`), so the XOR catches both-present and neither-present. Verified against the schema.
