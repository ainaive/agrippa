# M1 Plan — Living Checklist

> Branch: `feat/m1-platform` (all M1 work; one PR). Each phase lands only when `bun run check` + `tsc -b` + `bun test` are green **and** the phase's verify criterion passes. Status legend: ☐ todo · ◐ in progress · ☑ done

## Phase 0 — Design docs ☑

- [x] `docs/design/00–09`, `docs/adr/0001–0008`, this plan, bilingual README
- **Gate: user reviews the design docs before any implementation commits.**

## Phase M1.0 — Scaffold ☑

- [x] Bun workspaces monorepo per [00-overview](../design/00-overview.md) layout; all packages compile (`tsc -b` project references)
- [x] Biome root config; `bun run check` wired in every package
- [x] CI (`ci.yml`): install → biome → typecheck → commitlint → test → build
- [x] `infra/docker-compose.dev.yml` (postgres + redis)
- Verify: `bun install && bun run check && bun test` green locally and in CI

## Phase M1.1 — DB + Auth ☑

- [x] Drizzle schema (all tables from [01-domain-model](../design/01-domain-model.md)), generated migrations, seed (org, scenarios, task types, models, fabri)
- [x] better-auth integration (email+password, sessions); `users` extension (locale, org_role)
- [x] `/me`, projects + members CRUD; `requireRole` middleware; audit helper on all mutations
- [x] secrets table + libsodium encryption helper
- Verify: API integration tests — signup → create project → invite member → RBAC allow/deny matrix → audit rows present

## Phase M1.2 — Resource layer ☑

- [x] Registries CRUD: fabri, skills(+versions), mcp-servers (masked secrets), models
- [x] Template compiler + validator + expression language (`@agrippa/orchestration`); `POST /templates/validate`
- [x] Template draft → publish (immutable) flow; builtin seeding from `templates/` (checksum-guarded)
- [x] Project resource grants + submission-time gating; quotas CRUD
- Verify: all builtin templates validate; publish immutability test; grant-gating tests

## Phase M1.3 — Engine + executors (long pole) ☑

- [x] `executor-core`: Executor interface, ExecutorEvent schema, BudgetMeter, FakeExecutor
- [x] Engine loop: phases/steps, `when`/`requires`/skip, retries, approvals (slot-free waits), budgets, output contract, step-granular resume
- [x] pg-boss wiring: transactional submit, `run.execute`/`run.expire-approval`/`quota.rollup`, graceful drain
- [x] `run_events` persistence + Redis publish + SSE endpoint with `Last-Event-ID` replay; cancellation path
- [x] Workspace provisioning (git clone, credential scrub, cleanup)
- [x] `executor-claude`: full SDK mapping ([03](../design/03-executor-abstraction.md)); artifact watching; patch generation
- Verify: engine suite vs FakeExecutor (approval pause/resume, budget abort, crash-resume without double-counted usage, cancellation); live smoke run of `swdev.bug-localize-fix` on a sample repo

## Phase M1.4 — Scenarios + UI ☑

- [x] 6 builtin templates: `pm.status-report`, `pm.plan-breakdown`, `swdev.requirements-dev`, `swdev.bug-localize-fix`, `test.test-plan`, `test.regression-verify` (+ shared prompts, builtin skills)
- [x] SPA screens 1–9 from [06-frontend](../design/06-frontend.md), incl. `TaskParamsForm` auto-generation and live run detail via `useRunEvents`
- [x] Approvals inbox; template editor with validate + form preview + publish
- Verify: manual E2E per scenario — submit → watch live → approve → artifacts downloadable

## Phase M1.5 — i18n + polish ☑

- [x] Full en/zh-CN coverage: UI namespaces, backend errors, all builtin template metadata
- [x] Locale switcher (instant, persisted to profile); `pickLocale` everywhere DB metadata renders
- [x] Usage endpoint + dashboard breakdown; hard-stop quota enforced at submit and mid-run (both tested)
- Verify: key-parity test green; full zh-CN walkthrough; run blocked at exhausted quota (submit + mid-run)

## Phase M1.6 — Docker + release ☑

- [x] `Dockerfile.api` / `Dockerfile.worker` (built in CI on every push); production `docker-compose.yml`; migrate-on-boot with advisory lock
- [x] `.env.example` + deployment docs finalized; `healthz` with DB ping (worker heartbeat deferred past M1)
- [x] `release.yml` → GHCR images on tag
- Verify: images build in CI; full stack verified live on the dev host (api+worker+SPA, two scenario smokes incl. a real git checkout). The literal fresh-machine `docker compose up` walkthrough needs a Docker host — the one remaining manual step before merge.

## Exit

- [x] PR marked ready; merged `feat/m1-platform` → `main` (2026-07-17, merge commit `5079c1f`)
