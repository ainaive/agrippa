# Operations

## The stack

`infra/docker-compose.yml` runs four services:

| Service | Role | Notes |
|---|---|---|
| `api` | REST + SSE + serves the web app | Migrates the database and seeds builtin content on boot (advisory-locked, safe with concurrent boots) |
| `worker` | Executes runs | Scale with `WORKER_REPLICAS`; concurrency per worker via `WORKER_SLOTS` |
| `postgres` | System of record | Also carries the job queue (pg-boss) — no separate broker |
| `redis` | Live-event fan-out only | **Disposable**: if it's down, live streams degrade to replay/polling; correctness is unaffected |

## Configuration reference

Documented in `infra/env/.env.example`; the full set:

| Variable | Used by | Meaning |
|---|---|---|
| `DATABASE_URL` | api, worker | Postgres connection string |
| `REDIS_URL` | api, worker | Redis for pubsub; omit to fall back to DB polling |
| `AGRIPPA_SECRET_KEY` | api, worker | **Required.** 32-byte base64 key encrypting stored credentials. Losing it orphans every stored token |
| `BETTER_AUTH_SECRET` | api | **Required.** Session signing secret |
| `AGRIPPA_BASE_URL` | api | Public URL of the instance |
| `ANTHROPIC_API_KEY` | worker | Claude executor credential |
| `AGRIPPA_EXECUTOR` | api | Default executor for new runs: `claude-agent-sdk` or `fake` (token-free demo) |
| `WORKER_SLOTS` | worker | Concurrent runs per worker (default 2) |
| `WORKSPACE_ROOT` | worker | Per-run checkout directory (default `/work/runs` in the image) |
| `ARTIFACT_STORAGE_ROOT` | worker | Large-artifact storage (>64 KB; smaller ones live in Postgres) |
| `AGRIPPA_TEMPLATES_DIR` | api, worker | Builtin templates location (set in the images) |
| `AGRIPPA_WEB_DIST` | api | SPA dist directory to serve (set in the api image) |
| `AGRIPPA_MIGRATE_ON_BOOT` | api | `0` disables boot-time migrate/seed |
| `AGRIPPA_KEEP_WORKSPACES` | worker | `1` keeps finished run workspaces on disk for debugging |
| `PORT` | api | Listen port (default 3000) |

## Backup — three things

1. The **postgres volume** (`pgdata`) — schedule `pg_dump` per your policy.
2. The **work volume** (`workdata`) — holds large artifacts; losing it loses downloads over 64 KB (metadata and small artifacts survive in Postgres).
3. **`AGRIPPA_SECRET_KEY`** — without it, every stored git token and MCP credential is unrecoverable. Redis needs no backup.

## Upgrades & scaling

Pull new images and `docker compose up -d`. The api migrates on boot under an advisory lock, so rolling multiple replicas is safe. Draining workers is safe too: a killed worker's in-flight runs stay `running`, the queue retries them, and the engine **resumes step-granularly** — completed steps are never re-executed and cost is never double-counted. Scale run throughput with `WORKER_REPLICAS` × `WORKER_SLOTS`.

Reverse proxy note: **disable response buffering** for `/api/v1/runs/*/events` (SSE) — e.g. `proxy_buffering off;` in nginx — or live progress will arrive in bursts.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Run stuck in `queued` | No worker running, or the enqueue was lost — the worker's sweeper re-enqueues queued runs older than 30 s automatically once a worker is up. Check worker logs. |
| Live progress lags ~1 s, no push | `REDIS_URL` unset/unreachable — SSE falls back to DB polling. Harmless; restore Redis for instant updates. |
| Submission rejected `skill_not_granted` / `mcp_not_granted` / `model_unresolvable` | Grant the resource under Project → Settings → Resources (models must cover the tiers the template requests). |
| Submission rejected `quota_exhausted` | The project's hard-stop quota is spent this month — raise it, disable hard stop, or wait for the period. |
| Submission rejected `repo_not_in_project` | The `repoConnectionId` doesn't belong to this project — pick a repository registered under this project's Settings → Repositories. |
| An optional step (e.g. "open a PR") was skipped | Its optional resource isn't granted — grant the MCP server under Settings → Resources; ungranted optional resources are skipped, not run with a shared credential. |
| Run failed `contract_violation` | The agent never produced a required artifact — inspect the step outputs; usually a prompt/instructions issue in the template. |
| Checkout fails for a private repo | The repo connection's token is missing/expired — re-add it under Settings → Repositories (tokens are write-only; re-enter, don't "view"). |
| Need to inspect what an agent actually did on disk | Set `AGRIPPA_KEEP_WORKSPACES=1` on the worker and re-run; workspaces persist under `WORKSPACE_ROOT/<runId>`. |
| `healthz` returns 503 | The api can't reach Postgres — check `DATABASE_URL` and the postgres service. |
