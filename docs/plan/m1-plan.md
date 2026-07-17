# M1 Plan — Living Checklist

> Branch: `feat/m1-platform` (all M1 work; one PR). Each phase lands only when `bun run check` + `tsc -b` + `bun test` are green **and** the phase's verify criterion passes. Status legend: ☐ todo · ◐ in progress · ☑ done

## Phase 0 — Design docs ☑

- [x] `docs/design/00–09`, `docs/adr/0001–0008`, this plan, bilingual README
- **Gate: user reviews the design docs before any implementation commits.**

## Phase M1.0 — Scaffold ☐

- [ ] Bun workspaces monorepo per [00-overview](../design/00-overview.md) layout; all packages compile (`tsc -b` project references)
- [ ] Biome root config; `bun run check` wired in every package
- [ ] CI (`ci.yml`): install → biome → typecheck → commitlint → test → build
- [ ] `infra/docker-compose.dev.yml` (postgres + redis)
- Verify: `bun install && bun run check && bun test` green locally and in CI

## Phase M1.1 — DB + Auth ☐

- [ ] Drizzle schema (all tables from [01-domain-model](../design/01-domain-model.md)), generated migrations, seed (org, scenarios, task types, models, fabri)
- [ ] better-auth integration (email+password, sessions); `users` extension (locale, org_role)
- [ ] `/me`, projects + members CRUD; `requireRole` middleware; audit helper on all mutations
- [ ] secrets table + libsodium encryption helper
- Verify: API integration tests — signup → create project → invite member → RBAC allow/deny matrix → audit rows present

## Phase M1.2 — Resource layer ☐

- [ ] Registries CRUD: fabri, skills(+versions), mcp-servers (masked secrets), models
- [ ] Template compiler + validator + expression language (`@agrippa/orchestration`); `POST /templates/validate`
- [ ] Template draft → publish (immutable) flow; builtin seeding from `templates/` (checksum-guarded)
- [ ] Project resource grants + submission-time gating; quotas CRUD
- Verify: all builtin templates validate; publish immutability test; grant-gating tests

## Phase M1.3 — Engine + executors (long pole) ☐

- [ ] `executor-core`: Executor interface, ExecutorEvent schema, BudgetMeter, FakeExecutor
- [ ] Engine loop: phases/steps, `when`/`requires`/skip, retries, approvals (slot-free waits), budgets, output contract, step-granular resume
- [ ] pg-boss wiring: transactional submit, `run.execute`/`run.expire-approval`/`quota.rollup`, graceful drain
- [ ] `run_events` persistence + Redis publish + SSE endpoint with `Last-Event-ID` replay; cancellation path
- [ ] Workspace provisioning (git clone, credential scrub, cleanup)
- [ ] `executor-claude`: full SDK mapping ([03](../design/03-executor-abstraction.md)); artifact watching; patch generation
- Verify: engine suite vs FakeExecutor (approval pause/resume, budget abort, crash-resume without double-counted usage, cancellation); live smoke run of `swdev.bug-localize-fix` on a sample repo

## Phase M1.4 — Scenarios + UI ☐

- [ ] 6 builtin templates: `pm.status-report`, `pm.plan-breakdown`, `swdev.requirements-dev`, `swdev.bug-localize-fix`, `test.test-plan`, `test.regression-verify` (+ shared prompts, builtin skills)
- [ ] SPA screens 1–9 from [06-frontend](../design/06-frontend.md), incl. `TaskParamsForm` auto-generation and live run detail via `useRunEvents`
- [ ] Approvals inbox; template editor with validate + form preview + publish
- Verify: manual E2E per scenario — submit → watch live → approve → artifacts downloadable

## Phase M1.5 — i18n + polish ☐

- [ ] Full en/zh-CN coverage: UI namespaces, backend errors, all builtin template metadata
- [ ] Locale switcher (instant, persisted); `pickLocale` everywhere DB metadata renders
- [ ] Usage & quota screens; hard-stop quota enforcement end-to-end
- Verify: key-parity test green; full zh-CN walkthrough; run blocked at exhausted quota (submit + mid-run)

## Phase M1.6 — Docker + release ☐

- [ ] `Dockerfile.api` / `Dockerfile.worker`; production `docker-compose.yml`; migrate-on-boot with advisory lock
- [ ] `.env.example` + deployment docs finalized; `healthz` + worker heartbeat
- [ ] `release.yml` → GHCR images on tag
- Verify: fresh machine, `docker compose up`, complete a bug-fix run through the browser

## Exit

- [ ] PR marked ready; merge `feat/m1-platform` → `main`
