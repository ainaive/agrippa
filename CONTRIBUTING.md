# Contributing to Agrippa

Thanks for helping build 硅基工坊. This guide covers the development environment, the quality gates, and recipes for the most common kinds of change. For the system map, read [ARCHITECTURE.md](ARCHITECTURE.md) first; for design rationale, `docs/design/` and `docs/adr/`.

## Development environment

Requirements: **Bun ≥ 1.3**, **PostgreSQL ≥ 17** (local install or `docker compose -f infra/docker-compose.dev.yml up -d`), optional Redis (only for live SSE fan-out; everything degrades gracefully without it), `git`.

```sh
bun install
createdb agrippa && createdb agrippa_test          # or let compose provide them
cat > .env.local <<EOF
DATABASE_URL=postgres://localhost:5432/agrippa
AGRIPPA_SECRET_KEY=$(openssl rand -base64 32)
AGRIPPA_EXECUTOR=fake                               # token-free demo executor
EOF
bun apps/api/src/index.ts                           # migrates + seeds on boot
bun apps/worker/src/index.ts
cd apps/web && bun run dev                          # http://localhost:5173
```

Prefer one terminal? `bun run dev` at the repo root starts all three (api + worker in watch mode, Vite) with prefixed logs. Their dev scripts pass `--env-file=../../.env.local` because `bun --filter` runs each with its workspace as cwd, where the root file isn't auto-loaded.

Bun loads `.env` / `.env.local` natively from the directory you start it in — no dotenv, no `export`s — and `.env.local` is git-ignored, so secrets can't be committed. Create it **once and keep it**: `AGRIPPA_SECRET_KEY` encrypts credentials you store in dev (repo tokens, MCP auth), and a fresh key per shell — the old `export $(openssl rand …)` workflow — silently orphans them. Plain `export`s still work if you prefer; they take precedence over the file.

The first account you sign up becomes the org admin. Real agent runs need `AGRIPPA_EXECUTOR=claude-agent-sdk` plus `ANTHROPIC_API_KEY` (worker env).

## Quality gates

CI runs exactly these; run them locally before pushing:

```sh
bun run check                # biome lint/format + tsc -b + dependency-direction
bun test                     # unit + integration (integration skips without Postgres — that's not a pass)
bun run templates:validate   # all builtin templates must compile
bun run build                # SPA build
```

## Workflow

- **Branching**: feature-scale work gets a `<type>/<topic>` branch off `main` merged as one reviewable unit; small fixes and doc edits go straight to `main`. Either way the gates must be green first.
- **Commits**: Conventional Commits (`feat(api): …`, `fix(engine): …`). The subject says *what*; the body (required beyond trivial edits) says *why* — the problem, the decision, the trade-off. No AI-attribution trailers. commitlint enforces the format in CI.
- **Docs and tests are part of the change**: new endpoints get integration tests (`apps/api/src/test/`); engine semantics changes extend the compliance suite (`packages/orchestration/src/engine/engine.integration.test.ts`). Update every doc that covers what you touched — the Docs map in [AGENTS.md](AGENTS.md) says what each one tracks — and add a `CHANGELOG.md` entry under `[Unreleased]` for notable changes.

## Recipes

### Add a task type (new template)

1. Write `templates/<scenario-dir>/<name>.yaml` (`agrippa/v1`; see `docs/manual/en/05-template-authoring.md` and the existing six for patterns). Every localized field needs `en` **and** `zh-CN`.
2. `bun run templates:validate` until clean.
3. Add the template head + task type rows to `packages/db/src/seed/index.ts` (slug, i18n names, default Faber, scenario).
4. Boot the api (or `bun run db:seed && bun run templates:seed`) — the template publishes automatically; the submission form appears with zero frontend work.

### Add a builtin skill

1. Create `templates/_shared/skills/<name>/SKILL.md` (frontmatter: `name`, `description`).
2. Register it in the seed (`skills` + `skill_versions`, `contentRef: "builtin://<name>"`).
3. Reference it from templates as `builtin/<name>@^1` and grant it to projects that use it.

### Add an executor

1. Implement the `Executor` interface from `packages/executor-core` — all inputs arrive in `StepExecutionRequest`, all outputs leave as normalized events, terminate with exactly one `step.completed`/`step.failed`, respect `ctx.signal`, emit `usage` as it happens, never import `@agrippa/db`.
2. Register it in `apps/worker/src/index.ts` under a new executor id.
3. Prove it behaves like `FakeExecutor` under the engine compliance suite; read ADR-0005 before bending the contract — if a step can't be expressed as "prompt + resources + model + tool policy", grow the *template format*, never the executor interface.

### Add an API endpoint

1. Request schema in `packages/core/src/schemas.ts` (shared with the SPA).
2. Route in `apps/api/src/routes/` using `validate(...)`, the RBAC middleware (`requireProjectRole` / `requireOrgAdmin`), and `audit(...)` on every mutation. New error codes go into `packages/i18n/locales/{en,zh-CN}/errors.json` (both!).
3. Integration test in `apps/api/src/test/` via the `freshTestDb`/`signUp` helpers.

### Change the database schema

Edit `packages/db/src/schema/`, then `cd packages/db && bunx drizzle-kit generate --name <slug>` and commit the generated SQL. Migrations run on boot under an advisory lock.

## i18n rules

Both locales are mandatory everywhere: UI strings (parity test fails CI), template YAML labels (compiler rejects), API error codes (errors namespace). Keys are semantic (`runs.status.waiting_approval`), never English sentences.
