# 09 — Testing & CI

> Status: draft for review · Last updated: 2026-07-17

Toolchain: **Biome** (lint + format, one root config), **bun:test** everywhere, **GitHub Actions**. Conventional Commits enforced by commitlint in CI.

## Test Pyramid

### Unit (no I/O — colocated with source in each package)

- Template compiler & validator (`@agrippa/orchestration`): valid/invalid YAML, missing locales, semver resolution, checksum stability.
- Expression language: interpolation, `when:` evaluation, rejection of anything outside the grammar.
- Model-selection resolver: role→tier→model with grants, overrides, fallbacks, no-candidate errors.
- Run state machine (`@agrippa/core`): full legal/illegal transition matrix.
- `pickLocale`, `BudgetMeter` (accumulation, per-phase caps, resume-from-persisted-totals), RBAC decision matrix.

### Engine integration (the crown jewel — `@agrippa/orchestration` × FakeExecutor × real Postgres)

Runs against `docker-compose.dev.yml` Postgres. Scenarios, each asserting both `run_events` stream and final DB state:

- happy path: all phases → `succeeded`, contract artifacts present, usage totals correct;
- approval: pause (job completes, slot freed) → approve → resume; reject → `failed`; expire → per-template `onTimeout`;
- budget: run-level and per-phase `maxCostUsd` abort; duration timeout → `timed_out`; project hard-stop quota mid-run;
- crash-resume: kill mid-step → retry skips succeeded steps → resumes/restarts correct attempt → **no double-counted usage**;
- cancellation: mid-step abort latency, queued/waiting cancellation via API path;
- `when:` false and unmet optional `requires:` → `skipped`;
- required-artifact missing → `failed` with `contract_violation`.

This suite doubles as the executor compliance spec (any future executor must pass it via an adapter harness).

### API integration (Hono `app.request()` × real Postgres/Redis)

Auth flows, RBAC allow/deny matrix per role × endpoint class, transactional task submission (run + job atomicity), SSE replay from `Last-Event-ID`, grants gating submission, quota rejection at submit, audit rows on every mutation.

### Claude executor

- Unit: mocked SDK `query()` asserting the full option-mapping table from [03](03-executor-abstraction.md) (subagents, skills materialization path, MCP config, tool policy, resume).
- One live smoke test behind `ANTHROPIC_API_KEY`, excluded from CI, run manually before releases.

### Frontend

- Component tests for `TaskParamsForm` (schema → widgets → zod validation, both locales) and the run timeline reducer (event stream → UI state).
- Full-browser E2E is deferred to M1.4 exit criteria as a manual scripted walkthrough (automating with Playwright is a stretch goal, not a gate).

### Cross-cutting guards

- i18n key parity (en ↔ zh-CN) across namespaces.
- Dependency-direction check (script asserting the import rules from the monorepo layout — e.g. executors never import `db`).
- Template validation of all builtins (`bun run templates:validate templates/**`).

## CI Pipeline (`.github/workflows/ci.yml`)

On PR + push to `main` / `feat/**`:

1. `bun install` (cached)
2. `biome ci .`
3. `tsc -b` (project references across packages)
4. commitlint (Conventional Commits)
5. unit tests (`bun test --filter unit` per package)
6. integration tests with `services: postgres, redis`
7. build web + api + worker
8. builtin template validation + i18n parity + dependency-direction check

`release.yml`: tag `v*` → Docker images → GHCR ([08-deployment](08-deployment.md)).

## Local Developer Loop

```
bun install
docker compose -f infra/docker-compose.dev.yml up -d   # pg + redis
bun run db:migrate && bun run db:seed
bun dev            # api + worker + web concurrently (bun --filter)
bun run check      # biome + tsc
bun test           # everything (integration tests auto-skip if deps are down)
```
