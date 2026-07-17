# 00 — Product & Architecture Overview

> Status: draft for review · Last updated: 2026-07-17

## What is Agrippa?

**Agrippa** (platform display name: **硅基工坊 / Silicon Workshop**) is a team-oriented agent work platform. Teams organize around **projects**, pick a **task type** from a catalog of work scenarios, fill in parameters, and submit. The platform executes the task in the background with a preset agent — a **Faber** (硅基人) — that orchestrates sub-agents, Skills, MCP servers, and models according to a versioned **orchestration template**, streaming progress live and producing reviewable artifacts.

The product is fully bilingual: English and Simplified Chinese (zh-CN), across UI, error messages, and resource metadata.

## The Three Layers

```
┌─────────────────────────────────────────────────────────────┐
│  Scenario layer (UI)                                        │
│  Scenarios → Task types → parameter forms → submit & watch  │
│  (project management / software development / test & verify)│
├─────────────────────────────────────────────────────────────┤
│  Orchestration layer                                        │
│  Fabri (硅基人, preset agents) execute Runs by following    │
│  orchestration templates: phases, steps, approvals,         │
│  model-selection rules, budgets                             │
├─────────────────────────────────────────────────────────────┤
│  Resource layer                                             │
│  Models · Sub-agents · Skills · MCP servers · Templates     │
│  — registration, versioning, permission governance          │
└─────────────────────────────────────────────────────────────┘
```

1. **Scenario layer** — the user-facing catalog. Tasks are organized by work scenario (project management, software development, test & verification), each with sub-task types (requirements development, bug localization & fix, test plan generation, …). Users never touch orchestration details; they fill an auto-generated form and submit.
2. **Orchestration layer** — the execution brain. A Faber is a preset platform agent with a persona and defaults. Given a submitted task, the engine walks the scenario's orchestration template — phases, steps, human-approval checkpoints, budget limits — delegating each step to an **executor** (first implementation: Claude Agent SDK) which runs the actual agent loop with sub-agents, Skills, and MCP servers, on models selected by role→tier rules.
3. **Resource layer** — governed registries. Models (provider registrations with tiers and costs), sub-agents, Skills, MCP servers, and orchestration templates are registered, versioned (immutable published versions), and permission-governed. Projects enable specific resources via grants.

## Core Product Decisions

- **Project-based collaboration.** Users create projects and add members. The project is the resource scope and billing boundary: project-level enablement of Skills/MCP/models, token budget & quota, connected repositories and documents.
- **Hybrid engine strategy.** Agrippa owns its domain model (Task / Run / Step) and template format; agent engines are pluggable behind an `Executor` interface. The Claude Agent SDK is the first executor; templates stay engine-portable.
- **Self-hosted first.** Ships as a Docker Compose stack (api, worker, Postgres, Redis) for a single organization. Every top-level table carries `org_id` so SaaS multi-tenancy can layer on later without schema rewrites.
- **Breadth with a real engine.** M1 ships all three scenarios (2–3 task types each) on a full-strength shared orchestration layer — no stubbed engine.

## Glossary

| Term | 中文 | Definition |
|---|---|---|
| **Faber** (pl. **Fabri**) | 硅基人 | A preset platform agent: persona, system prompt, default model policy. The "worker identity" that executes tasks. |
| **Scenario** | 工作场景 | A category of work (e.g. software development) grouping related task types. |
| **Task type** | 任务类型 | A concrete kind of work users can submit (e.g. bug localization & fix). Binds a scenario to an orchestration template and a default Faber. |
| **Task** | 任务 | A user's submission: task type + parameters. May have multiple runs (retries). |
| **Run** | 执行 | One execution of a task against a pinned template version. Has a state machine, steps, events, artifacts, usage. |
| **Step** | 步骤 | The atomic execution unit inside a run: one agent invocation (or one system action). The idempotency and resume boundary. |
| **Orchestration template** | 编排模板 | Versioned declarative YAML defining inputs, phases/steps, resources, model rules, approvals, budgets, and the output contract for a task type. |
| **Executor** | 执行器 | A pluggable engine that executes a single step (agent loop, tools, sub-agents). First implementation: Claude Agent SDK. |
| **Skill** | 技能 | A packaged instruction set + resources an agent can load (Claude Code skill format). |
| **MCP server** | MCP 服务 | A Model Context Protocol server providing tools/context to agents. |
| **Resource grant** | 资源授权 | Project-level enablement of a resource (skill/MCP/model/template/faber), optionally with config overrides. |
| **Approval** | 审批 | A human checkpoint defined in a template; the run pauses (`waiting_approval`) until a member decides. |
| **Artifact** | 产出物 | A declared output of a run (markdown report, patch, link, file), governed by the template's output contract. |
| **Quota** | 配额 | Project-level token/cost budget per period; enforceable as a hard stop. |

## Non-Goals (M1)

- **SaaS multi-tenancy** — single-org deployment only; schema is multi-org-ready.
- **Per-run container/micro-VM sandboxing** — M1 isolates runs by workspace directory + tool policy inside the worker container; hardened isolation is M2 (see [03-executor-abstraction](03-executor-abstraction.md) §Sandboxing and risk log below).
- **Marketplace / community sharing of resources** — registries are org-internal.
- **Custom engine plugins by end users** — the `Executor` interface is internal API in M1.
- **Template loops/branching beyond `when` + `retry`** — the v1 expression language is deliberately non-Turing-complete.
- **Real-time multi-user co-editing** (e.g. of templates) — last-write-wins with version history.
- **Billing/invoicing integration** — cost accounting and quotas only.

## Architecture at a Glance

- **Runtime**: Bun workspaces monorepo. `apps/web` (Vite + React SPA), `apps/api` (Hono, REST + SSE), `apps/worker` (pg-boss consumers running the orchestration engine).
- **Data**: Postgres via Drizzle ORM; append-only `run_events` as the execution timeline source of truth; Redis for pubsub (live progress, cancellation control) only.
- **Queue**: pg-boss — task + run + job enqueued in one Postgres transaction.
- **Auth**: better-auth (email/password in M1) with org + project RBAC and scoped API keys.
- **i18n**: i18next end-to-end; DB metadata as `{en, zh-CN}` jsonb.

Doc map: [01 domain model](01-domain-model.md) · [02 template format](02-orchestration-template.md) · [03 executor abstraction](03-executor-abstraction.md) · [04 execution runtime](04-execution-runtime.md) · [05 API & auth](05-api-and-auth.md) · [06 frontend](06-frontend.md) · [07 i18n](07-i18n.md) · [08 deployment](08-deployment.md) · [09 testing & CI](09-testing-and-ci.md) · [ADRs](../adr/) · [M1 plan](../plan/m1-plan.md)

## Top Risks (tracked)

1. **Executor abstraction fidelity** — if future engines don't fit "one step = one agent invocation", templates leak engine semantics. Mitigated by `priorContext`/`resumeSessionId` in the interface and a FakeExecutor compliance suite built before the Claude executor ([ADR-0005](../adr/0005-executor-step-granularity.md)).
2. **Sandboxing repo-connected execution** — M1 posture is adequate for a trusted org, not hostile inputs. Secret scrubbing and egress control get explicit tests now; per-run isolation is scheduled for M2.
3. **Resumability & budget correctness across crashes** — usage keyed by (run, step, attempt); budget meter reads persisted totals on resume; kill-and-resume scenarios are first-class tests.
