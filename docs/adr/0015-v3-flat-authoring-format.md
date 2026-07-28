# ADR-0015: agrippa/v3 — Flat Authoring Format

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
