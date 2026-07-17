# AGENTS.md — working on Agrippa

Agrippa (硅基工坊 / Silicon Workshop) is a team-oriented agent work platform: users pick a **task type** from a scenario catalog, fill an auto-generated form, and the platform executes it in the background — a preset **Faber** agent walks a versioned **orchestration template** (phases, steps, approvals, budgets), delegating each agent step to a pluggable **executor** (first: Claude Agent SDK). See [ARCHITECTURE.md](ARCHITECTURE.md) for the map and `docs/design/` for the full design.

## Commands

```sh
bun install                    # workspaces install
bun run check                  # THE gate: biome + tsc -b + dependency-direction
bun test                       # unit + integration (needs Postgres, see below)
bun run build                  # builds the SPA (apps/web/dist)
bun run db:migrate             # apply migrations (DATABASE_URL)
bun run db:seed                # seed org/scenarios/fabri/models/skills (idempotent)
bun run templates:seed         # compile + publish templates/ into the DB (checksum-guarded)
bun run templates:validate     # compile-check all builtin templates (also a CI step)
```

Dev boot (three processes):

```sh
export DATABASE_URL=postgres://localhost:5432/agrippa
export AGRIPPA_SECRET_KEY=$(openssl rand -base64 32)
export AGRIPPA_EXECUTOR=fake          # token-free demo executor; omit for the real Claude executor
bun apps/api/src/index.ts             # :3000 — migrates + seeds on boot (AGRIPPA_MIGRATE_ON_BOOT=0 to skip)
bun apps/worker/src/index.ts          # pg-boss consumers + engine
cd apps/web && bun run dev            # :5173, proxies /api → :3000
```

**Tests need Postgres.** Integration suites hit `TEST_DATABASE_URL` (default `postgres://localhost:5432/agrippa_test`) and **skip themselves** when it's unreachable — "N tests skipped" locally is not the same as green. CI provides postgres+redis services. Redis is optional everywhere: SSE falls back to DB polling, cancellation to step-boundary flag checks.

## Monorepo map & dependency direction

```
apps/      web (Vite React SPA) · api (Hono REST+SSE) · worker (pg-boss + engine)
packages/  core (domain vocab, zod schemas, run state machine)
           db (Drizzle schema + migrations + seed + secrets crypto)
           orchestration (template compiler, expression lang, engine, queue, buses)
           executor-core (Executor interface, BudgetMeter, FakeExecutor)
           executor-claude (Claude Agent SDK executor)
           i18n (en/zh-CN resources) · api-client (SPA client types)
templates/ builtin agrippa/v1 YAML templates + shared prompts/skills
```

`scripts/check-deps.ts` enforces the direction (runtime deps only; tests may simulate adjacent layers):
`core` depends on nothing internal · executors never import `db` · `api` never imports executors (it enqueues; the worker executes) · `web` only sees `core`/`api-client`/`i18n`.

## Conventions

- **Commits**: Conventional Commits; the body explains *why* (required beyond trivial edits). No `Co-Authored-By`/AI-attribution lines. `subject-case` is relaxed (proper nouns allowed); commitlint runs in CI.
- **Formatting/lint**: Biome, one root config. Run `bun run check` before committing — CI runs the identical commands.
- **i18n**: every user-facing string has **both** `en` and `zh-CN`. UI copy lives in `packages/i18n/locales/` (a parity test fails CI on missing keys); DB metadata uses `*_i18n` jsonb; template YAML labels require both locales (the compiler rejects otherwise). API error `message` localizes from the `errors` namespace by stable `code`.
- **Templates**: builtin YAML in `templates/` must pass `bun run templates:validate` (CI gate). Editing a builtin's source publishes the next immutable version on boot; runs pin versions, so this is always safe.
- **API changes**: request schemas live in `packages/core/src/schemas.ts` (shared with the SPA); every mutation writes an audit row via `apps/api/src/lib/audit.ts`; add an integration test in `apps/api/src/test/`.

## Gotchas (learned the hard way)

- **Test DB reset must drop the `drizzle` schema too** — the migrator journals there; dropping only `public` makes migrations silently no-op on the next run. `freshTestDb()` in `apps/api/src/test/helpers.ts` does this correctly; reuse it.
- **One shared DB pool per test process.** A pool per fixture exhausts Postgres `max_connections`. Both test helper modules keep a module-level shared pool — follow that pattern.
- **Advisory locks are session-scoped.** `migrateDb` acquires/releases `pg_advisory_lock` on a single *reserved* connection (`db.$client.reserve()`); a pooled acquire/release pair lands on different connections and deadlocks the next boot.
- **Engine error semantics**: `RunFailure`/`BudgetExceededError` finalize the run; *unexpected* errors rethrow on purpose so pg-boss retries and the engine resumes step-granularly. Don't "fix" that by catching everything.
- **`AGRIPPA_SECRET_KEY`** (32-byte base64) is required whenever secrets are written (MCP auth, repo tokens); test helpers auto-generate one.
- **FakeExecutor is the compliance contract** — a new executor must behave under `packages/orchestration/src/engine/engine.integration.test.ts` exactly as it does.

## Where to read more

`docs/design/00-overview.md` (concepts + glossary) · `02` (template format) · `03` (executor contract) · `04` (runtime/queue/SSE) · `docs/adr/0005` (the engine/executor boundary — most consequential decision) · [CONTRIBUTING.md](CONTRIBUTING.md) (recipes).
