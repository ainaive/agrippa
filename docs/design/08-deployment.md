# 08 — Deployment (Self-Hosted, Docker Compose)

> Status: draft for review · Last updated: 2026-07-17

M1 ships as a single-org, self-hosted Docker Compose stack. SaaS multi-tenancy is a non-goal but the schema is ready (`org_id` everywhere).

## Topology

```
infra/docker-compose.yml
├── api       # apps/api — Hono; serves REST + SSE and the built SPA (static)
├── worker    # apps/worker — pg-boss consumers + orchestration engine (scale: N)
├── postgres  # postgres:17 + volume
└── redis     # redis:7 (pubsub only — no persistence required)
```

- `api` and `worker` are separate images (`infra/Dockerfile.api`, `infra/Dockerfile.worker`) built from the monorepo with Bun; the SPA is built at image build time and served statically by `api` (no separate web container, no CORS).
- `worker` scales horizontally (`docker compose up --scale worker=3`); run concurrency = workers × slots.
- Migrations run as an entrypoint step of `api` (`bun run db:migrate`) guarded by a Postgres advisory lock; seeding of builtin resources is idempotent (checksum-guarded upserts).
- `infra/docker-compose.dev.yml` starts **dependencies only** (postgres + redis) for local development; `api`/`worker`/`web` run via `bun dev` on the host.

## Configuration (env)

`infra/env/.env.example` documents everything; highlights:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection |
| `REDIS_URL` | Redis pubsub |
| `AGRIPPA_BASE_URL` | Public URL (links in emails/PRs) |
| `AGRIPPA_SECRET_KEY` | libsodium key encrypting the `secrets` table — **back this up; losing it orphans stored credentials** |
| `BETTER_AUTH_SECRET` | session signing |
| `ANTHROPIC_API_KEY` | Claude executor (worker only) |
| `WORKER_SLOTS` | run concurrency per worker (default 2) |
| `WORKSPACE_ROOT` | per-run workspaces volume (default `/work/runs`) |
| `ARTIFACT_STORAGE_ROOT` | large-artifact volume |
| `WORKER_EGRESS_ALLOWLIST` | optional outbound-network restriction for agent Bash |

Secrets policy: provider API keys and the master key live only in `api`/`worker` env (compose `env_file`), never in the DB; user-registered credentials (git tokens, MCP auth) live encrypted in the `secrets` table keyed by `AGRIPPA_SECRET_KEY`.

## Operations

- **Backup**: Postgres volume (pg_dump schedule is the operator's choice) + `ARTIFACT_STORAGE_ROOT` volume + the `AGRIPPA_SECRET_KEY`. Redis is disposable.
- **Upgrade**: pull images → `docker compose up -d` → api entrypoint migrates. Workers drain gracefully (in-flight runs resume on new workers via step-granular resume — see [04](04-execution-runtime.md)).
- **TLS / ingress**: out of scope; operators front the stack with their own reverse proxy. SSE requires the proxy to disable response buffering for `/api/v1/runs/*/events`.
- **Health**: `GET /healthz` (api: DB+Redis ping) and a worker heartbeat table row per worker for the admin UI.

## Release Pipeline

`.github/workflows/release.yml`: on tag `v*` → build `agrippa-api` and `agrippa-worker` images → push to GHCR → attach compose bundle to the GitHub release. Acceptance check for M1.6: fresh machine, `docker compose up`, complete a bug-fix run end-to-end through the browser.
