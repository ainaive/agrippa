# ADR-0005: Executor Granularity — One Step = One Executor Invocation

- Status: accepted · Date: 2026-07-17
- **This is the most consequential ADR**: it fixes the boundary between the engine and all present/future agent engines.

## Context

Product decision: Agrippa owns its domain model and template format; the Claude Agent SDK is the *first* executor, not the architecture. Something must define where "our orchestration" ends and "the engine's agent loop" begins. Candidates ranged from "executor runs the whole template" to "executor is a bare LLM call".

## Decision

The engine (`@agrippa/orchestration`) interprets everything structural — phases, step ordering, `when:` conditions, approvals, retries, budgets, output contract. The executor executes exactly **one step**: one agent invocation with its own sub-agents, Skills, MCP servers, tool policy, and model, communicating results back solely through a normalized event stream. Cross-step state flows through the engine (`priorContext` summaries + artifacts), not through executor sessions; `resumeSessionId` exists only for retry-resume of the *same* step.

## Alternatives considered

- **Whole-template executor** (hand the SDK the full plan): fastest to demo, but approvals, budgets, and resumability would live inside engine-specific behavior — templates become Claude-SDK scripts and the "pluggable executor" promise is fiction.
- **Bare LLM-call executor** (engine owns the tool loop): maximally portable but re-implements the agent loop, sub-agents, and MCP wiring the SDK already provides — the exact work the hybrid decision was meant to avoid.
- **Phase-granular executor**: fewer invocations, but approvals-inside-phases and per-step retry/budget attribution get muddy; steps are already the natural idempotency unit.

## Consequences

- Templates stay engine-portable; a future executor implements one interface and passes the existing FakeExecutor-based compliance suite.
- Steps are the resume/budget/usage attribution unit — crash recovery and cost accounting fall out of the same boundary.
- Cost: each step is a fresh executor session — cross-step context is re-established via `priorContext`, spending some tokens (mitigated by summaries; prompt caching helps within a step). If evidence shows same-session phase continuity matters, the interface grows a capability flag rather than the templates growing engine semantics.
- Rule enforced in review: if a step can't be expressed as "prompt + resources + model + tool policy", the *template format* must grow — never the executor contract.
