# Architecture

This document is the orientation map for contributors. The authoritative design lives in `docs/design/` (10 documents) and `docs/adr/` (12 decision records); this file tells you what exists, where it lives, and which invariants hold it together.

## Bird's-eye view

Agrippa runs agent-driven work for teams. A user submits a **task** (a task type + parameters) inside a **project**; the platform creates a **run**, queues it, and a **worker** executes it by walking the task type's **orchestration template** — a versioned, declarative YAML document describing phases (and, since agrippa/v2, bounded **loops**), steps, human **checkpoints** (approvals, question forms, review gates), **agent slots** (implementer/reviewer bound to a faber + executor per run), model-selection rules, budgets, and an artifact contract. Each *agent step* is delegated to a pluggable **executor** (Claude Agent SDK and the OpenAI Codex CLI); everything structural — including the platform-side git branch/push/PR write-path — stays in the platform's own engine. Progress streams live to the browser (agent output, checkpoint cards, team comments); deliverables land as downloadable artifacts.

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
| `packages/executor-codex` | Wraps the OpenAI Codex CLI (`codex exec --json`): JSONL events → normalized events, native OS sandbox for containment, fenced-json artifact synthesis for read-only steps (ADR-0011). |
| `packages/i18n` | en/zh-CN resources by namespace + the server-side error-message lookup; a parity test keeps locales in lockstep. |
| `apps/api` | Hono: better-auth, RBAC middleware, registries, template publishing, task submission (grant + quota gating), run lifecycle, approvals, artifacts, SSE, audit log. Serves the built SPA in production. Never imports executors. |
| `apps/worker` | pg-boss consumers around the engine; real deps: `GitWorkspaceManager` (clone with scrubbed credentials), `GitScmService` (branch/push/PR via provider REST — ADR-0011), `DbResourceMaterializer` (skills → disk, MCP + secrets), `DiskArtifactStore`, `DemoExecutor` (token-free, loop-round-aware), checkpoint-expiry handler, reconciliation sweeper. Registers executors and asserts them against core's `EXECUTOR_CATALOG` at boot. |
| `apps/web` | React SPA: TanStack Router/Query, shadcn/ui (GitLab-style sidebar shell, indigo/violet tokens, light+dark), react-i18next. The load-bearing piece is `TaskParamsForm` — rendered from compiled template inputs, so new task types need zero frontend work. |
| `templates/` | Builtin templates (6 × agrippa/v1 + the agrippa/v2 `swdev.requirement-delivery` flagship), shared subagent prompts, builtin skills. Compiled + published at boot, checksum-guarded. |

Dependency direction is enforced by `scripts/check-deps.ts` (runtime deps only).

## Key flows

**Submit → run.** `POST /projects/:id/tasks` validates params against the compiled input schema (the same schema the SPA rendered the form from), verifies each `repoRef` is owned by the project, resolves model roles → concrete granted models (frozen into `runs.model_resolution`), pins the authorized skills/MCP into `runs.resource_manifest` (required grants enforced, optional included only when granted), checks hard-stop quota headroom, then inserts task+run in one transaction and sends a pg-boss job keyed by run id. A worker sweeper re-enqueues stragglers (and runs left paused by a lost approval-resume), so a run can never be stranded nor double-queued.

**Engine loop.** The engine (worker-side) walks flow nodes (phases and bounded loops): `when:` conditions, optional-resource skips, per-step retries, budget checks at every boundary. Loop rounds key every row by `(stepId, iteration)` and derive the resume iteration from persisted rows. Agent steps resolve their slot's executor + faber from `runs.agent_bindings` and stream normalized executor events which the engine persists to `run_events` (per-run monotonic `seq`), mirrors to the bus, and projects into `run_steps`/`token_usage`/`artifacts`. Before every agent attempt the worker replaces executor project configuration and rematerializes only authorized skills. System steps cover checkout plus the platform git write-path (`git.branch`/`git.push`/`pr.open` — the PR body includes accepted-findings waivers). At the end it enforces the artifact contract — *succeeded* always means the contracted outputs exist (latest loop iteration wins).

**Verified Git publication.** Repository workspaces have two independent Git metadata domains: the agent sees `<workspace>/.git`, while evidence and publication use a pristine platform gitdir in a sibling sidecar. The platform resets its private index to the clone base, stages the workspace while retaining base versions of `.claude`, `.mcp.json`, and `.agrippa`, and derives both the patch artifact and publish tree from that canonical snapshot. Push rechecks the exact stored evidence and creates one idempotent Agrippa-authored snapshot commit; agent-local commit history is advisory and is not published (ADR-0012).

**Checkpoints.** A checkpoint step (approval / question form / review gate) records a pending row with a payload snapshot, flips the run to `waiting_approval`, and **completes the job** (no held worker slot); question forms and review gates auto-pass when their source artifact is empty. The API respond endpoint validates the answer against the snapshot, stores a structured `response` (which re-enters the run as the `checkpoints.<id>` expression root), and re-enqueues; the engine resumes at the gated step. Expiry is a scheduled pg-boss job applying the template's `onTimeout`. Run comments ride the same event stream (`comment.added`).

**Crash-resume.** Unexpected engine errors rethrow → pg-boss retries → the engine resumes: succeeded steps skip, a stale `running` step row is marked failed and re-attempted, and the `BudgetMeter` rebuilds from persisted `token_usage` rows keyed per attempt — no double counting. This exact path is exercised by a mid-step crash test.

**Live progress.** `GET /runs/:id/events` (SSE) replays `run_events` past `Last-Event-ID`, then bridges Redis (or polls the DB when Redis is absent). Reconnects are gap-free by construction; Redis is never a correctness dependency.

## Invariants

1. **Runs pin `template_version_id`** at submit; published versions are immutable — republishing can never affect in-flight or historical runs.
2. **`run_events` is append-only** and the source of truth for the timeline; everything else about a run is a projection.
3. **Steps are the idempotency unit** — restart-safe by template rule, resumable by session id where the executor supports it.
4. **Usage rows are keyed `(run, step, attempt)`** so retries re-incur cost without ever double-counting.
5. **Executors are stateless I/O**: all inputs in the request, all outputs as events; they never touch the database.
6. **Secrets never leave as plaintext**: encrypted at rest (AES-256-GCM), write-only in the API, scrubbed from git remotes before agent code runs, stripped from the agent subprocess environment (the master key and datastore URLs never reach a tool call), and redacted from event payloads before they persist or stream.
7. **Containment goes through one seam**: every tool call (reads and writes confined to the workspace) and the subprocess env are decided by `packages/executor-core/isolation.ts`; the adapter never reimplements it (ADR-0009). OS-level isolation between runs and keeping the provider key out of the subprocess are deferred to the container layer.
8. **The worker trusts only the pinned manifest**: repos are project-scoped and skills/MCP resolve solely from `runs.resource_manifest`, never the mutable global registry.
9. **Lifecycle mutations are atomic**: run status transitions are compare-and-swap on the expected status and event `seq` is allocated by the database, so concurrent writers can't clobber a status or collide on a seq (`run-lifecycle.ts`).
10. **Approved evidence is the published tree**: platform Git reads only its private gitdir/index, excludes runtime configuration from both evidence and publication, and refuses errors, empty snapshots, or any patch mismatch before push (ADR-0012).

## Where to look

| I want to… | Start at |
|---|---|
| Change the template format | `packages/orchestration/src/template-schema.ts` + `compile.ts`, then `docs/design/02` |
| Touch run execution semantics | `packages/orchestration/src/engine/engine.ts` + its integration test (the compliance suite) |
| Add/modify an executor | `packages/executor-core/src/types.ts` (contract), `executor-claude`/`executor-codex` (references), core `EXECUTOR_CATALOG`, ADR-0005/0011 |
| Add an API endpoint | `apps/api/src/routes/`, schema in `packages/core/src/schemas.ts`, test in `apps/api/src/test/` |
| Change the data model | `packages/db/src/schema/`, then `bunx drizzle-kit generate` in `packages/db` |
| Understand a past decision | `docs/adr/` — 0005 (executor granularity) and 0003 (pg-boss) carry the most weight |
