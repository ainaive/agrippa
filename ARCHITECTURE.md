# Architecture

This document is the orientation map for contributors. The authoritative design lives in `docs/design/` (10 documents) and `docs/adr/` (8 decision records); this file tells you what exists, where it lives, and which invariants hold it together.

## Bird's-eye view

Agrippa runs agent-driven work for teams. A user submits a **task** (a task type + parameters) inside a **project**; the platform creates a **run**, queues it, and a **worker** executes it by walking the task type's **orchestration template** — a versioned, declarative YAML document describing phases, steps, human-approval checkpoints, model-selection rules, budgets, and an artifact contract. Each *agent step* is delegated to a pluggable **executor** (Claude Agent SDK first); everything structural stays in the platform's own engine. Progress streams live to the browser; deliverables land as downloadable artifacts.

```
Browser (SPA) ──REST──▶ api ──singleton-keyed send──▶ pg-boss (Postgres)
     ▲                   │                                 │
     │ SSE (replay from  │ tx: task+run rows               ▼
     │ run_events, then  │                              worker ──▶ engine ──▶ executor
     │ Redis bridge)     ▼                                 │        (steps)   (Claude SDK / demo)
     └────────────── Postgres ◀── run_events, run_steps, ──┘
                                  artifacts, token_usage
```

## Codemap

| Path | What it is |
|---|---|
| `packages/core` | Domain vocabulary (roles, tiers, statuses), the pure run state machine, zod request schemas shared by API and SPA, `pickLocale`, queue names. Depends on nothing internal. |
| `packages/db` | Drizzle schema (one file per aggregate), committed SQL migrations, idempotent seed, AES-256-GCM secrets crypto, the advisory-locked migrator. |
| `packages/orchestration` | The platform brain: `compile.ts` (YAML → validated compiled JSON), `expression.ts` (the deliberately non-Turing-complete `${...}` language), `engine/engine.ts` (the run loop), `queue.ts` (pg-boss factory), `engine/bus.ts` + `redis-bus.ts` (live-event fan-out), `resolve.ts` (submit-time param validation + model-role resolution), `seed-builtins.ts`. |
| `packages/executor-core` | The `Executor` interface and normalized event stream (ADR-0005), `BudgetMeter`, and `FakeExecutor` — the compliance fixture every executor must satisfy. |
| `packages/executor-claude` | Maps a step request onto Claude Agent SDK `query()` options and SDK messages back onto normalized events; scans `.agrippa/artifacts/` on success. |
| `packages/i18n` | en/zh-CN resources by namespace + the server-side error-message lookup; a parity test keeps locales in lockstep. |
| `apps/api` | Hono: better-auth, RBAC middleware, registries, template publishing, task submission (grant + quota gating), run lifecycle, approvals, artifacts, SSE, audit log. Serves the built SPA in production. Never imports executors. |
| `apps/worker` | pg-boss consumers around the engine; real deps: `GitWorkspaceManager` (clone with scrubbed credentials), `DbResourceMaterializer` (skills → disk, MCP + secrets), `DiskArtifactStore`, `DemoExecutor` (token-free), approval-expiry handler, reconciliation sweeper. |
| `apps/web` | React SPA: TanStack Router/Query, shadcn/ui, react-i18next. The load-bearing piece is `TaskParamsForm` — rendered from compiled template inputs, so new task types need zero frontend work. |
| `templates/` | Builtin `agrippa/v1` templates (6), shared subagent prompts, builtin skills. Compiled + published at boot, checksum-guarded. |

Dependency direction is enforced by `scripts/check-deps.ts` (runtime deps only).

## Key flows

**Submit → run.** `POST /projects/:id/tasks` validates params against the compiled input schema (the same schema the SPA rendered the form from), verifies skill/MCP grants, resolves model roles → concrete granted models (frozen into `runs.model_resolution`), checks hard-stop quota headroom, then inserts task+run in one transaction and sends a pg-boss job keyed by run id. A worker sweeper re-enqueues stragglers, so a run can never be stranded nor double-queued.

**Engine loop.** The engine (worker-side) walks phases/steps: `when:` conditions, optional-resource skips, per-step retries, budget checks at every boundary. Agent steps stream normalized executor events which the engine persists to `run_events` (per-run monotonic `seq`), mirrors to the bus, and projects into `run_steps`/`token_usage`/`artifacts`. At the end it enforces the artifact contract — *succeeded* always means the contracted outputs exist.

**Approvals.** An approval checkpoint records a pending row, flips the run to `waiting_approval`, and **completes the job** (no held worker slot). The API decision re-enqueues; the engine resumes at the gated phase. Expiry is a scheduled pg-boss job applying the template's `onTimeout`.

**Crash-resume.** Unexpected engine errors rethrow → pg-boss retries → the engine resumes: succeeded steps skip, a stale `running` step row is marked failed and re-attempted, and the `BudgetMeter` rebuilds from persisted `token_usage` rows keyed per attempt — no double counting. This exact path is exercised by a mid-step crash test.

**Live progress.** `GET /runs/:id/events` (SSE) replays `run_events` past `Last-Event-ID`, then bridges Redis (or polls the DB when Redis is absent). Reconnects are gap-free by construction; Redis is never a correctness dependency.

## Invariants

1. **Runs pin `template_version_id`** at submit; published versions are immutable — republishing can never affect in-flight or historical runs.
2. **`run_events` is append-only** and the source of truth for the timeline; everything else about a run is a projection.
3. **Steps are the idempotency unit** — restart-safe by template rule, resumable by session id where the executor supports it.
4. **Usage rows are keyed `(run, step, attempt)`** so retries re-incur cost without ever double-counting.
5. **Executors are stateless I/O**: all inputs in the request, all outputs as events; they never touch the database.
6. **Secrets never leave as plaintext**: encrypted at rest (AES-256-GCM), write-only in the API, scrubbed from git remotes before agent code runs.

## Where to look

| I want to… | Start at |
|---|---|
| Change the template format | `packages/orchestration/src/template-schema.ts` + `compile.ts`, then `docs/design/02` |
| Touch run execution semantics | `packages/orchestration/src/engine/engine.ts` + its integration test (the compliance suite) |
| Add/modify an executor | `packages/executor-core/src/types.ts` (contract), `executor-claude` (reference), ADR-0005 |
| Add an API endpoint | `apps/api/src/routes/`, schema in `packages/core/src/schemas.ts`, test in `apps/api/src/test/` |
| Change the data model | `packages/db/src/schema/`, then `bunx drizzle-kit generate` in `packages/db` |
| Understand a past decision | `docs/adr/` — 0005 (executor granularity) and 0003 (pg-boss) carry the most weight |
