# ADR-0006: YAML-Authored, Compiled-JSON Orchestration Templates with a Minimal Expression Language

- Status: accepted · Date: 2026-07-17

## Context

Orchestration templates are authored and reviewed by humans (git-diffable, PR-reviewable), executed by the engine, and drive auto-generated UI forms. They are also a governance surface: a template determines what an agent may do with project resources, so expressiveness is a liability as much as a feature.

## Decision

Templates are authored in YAML (`apiVersion: agrippa/v1`), compiled to zod-validated JSON stored alongside the source (`template_versions.source_yaml` + `compiled`). Interpolation uses a deliberately **non-Turing-complete** expression language: property paths, equality, boolean operators, literals — no loops, no arithmetic, no user functions. Control flow is limited to `when:`, `retry:`, and `onFailure: continue`.

## Alternatives considered

- **TypeScript-defined templates** (code as config): full expressiveness and type safety, but templates become programs — unauditable by non-engineers, unrenderable as forms, and a sandboxing problem of their own once org admins can author them in the UI.
- **JSON authoring**: same semantics but hostile to humans (no comments, noisy diffs).
- **Rich expression language / loops**: every workflow engine grows one eventually; declining now keeps validation total (the compiler can reason about every reachable state) and keeps the approval-gate semantics honest.

## Consequences

- Draft → validate → publish-immutable lifecycle; runs pin versions, so publishing is always safe.
- The `inputs` schema doubles as the form-generation and server-validation source — one definition, no drift.
- Some workflows won't fit v1 (dynamic fan-out, data-driven loops); they wait for an explicit `agrippa/v2` decision rather than leaking in through expression creep. The version gate (`apiVersion`) exists for exactly that.
