# 08 — Deployment (Self-Hosted)

> Status: draft for review · Last updated: 2026-07-17

M1 ships single-org and self-hosted. SaaS multi-tenancy is a non-goal but the schema is ready (`org_id` everywhere). Three ways to run it:

1. **Development** — bare-metal Bun + local Postgres; `infra/docker-compose.dev.yml` optionally provides dependencies only (see the README quick start).
2. **Docker Compose** — the containerized production stack below.
3. **VM (systemd, no Docker)** — same processes as Compose, installed directly on an Ubuntu host via `infra/vm/` (see [VM deployment](#vm-deployment-systemd-no-docker)).

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
| `AGRIPPA_SECRET_KEY` | AES-256-GCM key encrypting the `secrets` table — **back this up; losing it orphans stored credentials** |
| `BETTER_AUTH_SECRET` | session signing |
| `ANTHROPIC_API_KEY` | Claude executor (worker only) |
| `WORKER_SLOTS` | run concurrency per worker (default 2) |
| `WORKSPACE_ROOT` | per-run workspaces volume (default `/work/runs`) |
| `ARTIFACT_STORAGE_ROOT` | large-artifact volume |
| `WORKER_EGRESS_ALLOWLIST` | optional outbound-network restriction for agent Bash |
| `APT_MIRROR` | optional **build-time** mirror for the worker image's apt packages (e.g. `https://mirrors.aliyun.com` from a host where `deb.debian.org` is slow/blocked); no-op when empty |

Secrets policy: the master key and the deployment's **fallback** provider API keys live only in `api`/`worker` env (compose `env_file`), never in the DB; user-registered credentials (git tokens, MCP auth, and per-project provider API keys — ADR-0013) live encrypted in the `secrets` table keyed by `AGRIPPA_SECRET_KEY`. A project provider credential **overrides** the worker env for that provider; env auth remains the deployment-wide default for projects without one.

**Aliyun Bailian (DashScope) / Qwen**: no worker env needed — an admin adds a `dashscope` credential in project settings and grants the seeded Qwen models. Runs through the **claude executor only** (Codex CLI ≥0.122 removed the chat wire API Bailian's compatible mode speaks — ADR-0013 amendment); the catalog defaults to the Beijing endpoint `https://dashscope.aliyuncs.com/apps/anthropic`, and international workspaces set the credential's base-URL override to their workspace-scoped `*.maas.aliyuncs.com` host (overrides are policy-checked: https, public DNS names, `.aliyuncs.com` for dashscope). Verify Qwen model rates against the live Model Studio price list — Bailian tiers pricing by input length and the seeds carry entry-tier rates.

## Operations

- **First-run onboarding**: self-registration is closed (invite-only — see [05](05-api-and-auth.md#authentication)). The api/worker do **not** create users on boot. An operator runs `apps/api/src/cli/bootstrap-admin.ts` once (reads `AGRIPPA_BOOTSTRAP_EMAIL`/`PASSWORD` from the env file, creates the first `org_admin`, idempotent on email) — then signs in and invites members from the UI. Runbook in [Operations → First-run](../manual/en/06-operations.md#first-run-create-the-admin).
- **Backup**: Postgres volume (pg_dump schedule is the operator's choice) + `ARTIFACT_STORAGE_ROOT` volume + the `AGRIPPA_SECRET_KEY`. Redis is disposable.
- **Upgrade**: pull images → `docker compose up -d` → api entrypoint migrates. Workers drain gracefully (in-flight runs resume on new workers via step-granular resume — see [04](04-execution-runtime.md)).
- **TLS / ingress**: out of scope; operators front the stack with their own reverse proxy. SSE requires the proxy to disable response buffering for `/api/v1/runs/*/events`.
- **Health**: `GET /healthz` (api: DB ping). A per-worker heartbeat row for the admin UI is deferred past M1.

## VM deployment (systemd, no Docker)

`infra/vm/` codifies the same topology on a single Ubuntu 22.04/24.04 host: `install.sh` (idempotent bootstrap: Bun, Postgres 17 via PGDG, optional Redis 7, `agrippa` system user, env file with generated secrets, units), `deploy.sh` (update: `git pull --ff-only` → `bun install --frozen-lockfile` → SPA build → restart), `agrippa-api.service` / `agrippa-worker.service`, `env.example`, `nginx.conf.example`.

| Piece | Location | Compose equivalent |
|---|---|---|
| Repo + build | `/opt/agrippa` (root-owned; services read-only by permissions) | root-owned `/app` in the images |
| Runtime user | `agrippa` system user (both services) | `bun` user in both containers |
| Run workspaces | `/var/lib/agrippa/runs` (`WORKSPACE_ROOT`) | `workspaces` volume |
| Artifact store | `/var/lib/agrippa/artifacts` (`ARTIFACT_STORAGE_ROOT`) | `artifacts` volume |
| Config | `/etc/agrippa/agrippa.env` (root:agrippa 0640, one `EnvironmentFile=` for both units) | compose `env_file` |
| SPA | built on deploy, served by api via `AGRIPPA_WEB_DIST` | built at image build time |

Boot/upgrade ordering: postgres → api (migrates + seeds on boot) → worker. The worker never migrates; its `ExecStartPre` polls the api's `/healthz` (up to 120 s) so a first boot or an upgrade with new migrations can't run against a stale schema, and `deploy.sh` restarts the api and waits for `/healthz` before restarting the worker.

Sandboxing: the worker unit's hardening is deliberately lighter than the api's — bubblewrap needs user/mount/pid/net namespaces, so `RestrictNamespaces=`/`SystemCallFilter=` must stay off (the SDK sandbox degrades *silently* without them). On Ubuntu 24.04, verify `apparmor_restrict_unprivileged_userns` doesn't block bwrap: `sudo -u agrippa bwrap --unshare-all --ro-bind / / /bin/true`.

Two accepted deviations from Compose (documented, not accidental):

- **Artifacts are not read-only to the api.** Compose mounts the artifact volume `:ro` in the api container; on the VM both services share the `agrippa` user, so the api could write artifacts. Splitting users would require group-permission choreography on every worker-written file for little gain on a single-org box.
- **One env file for both services.** The api process can read `ANTHROPIC_API_KEY`, which Compose scopes to the worker. Operators who care can split a `worker.env` and point the worker unit's `EnvironmentFile=` at it.

## Release Pipeline

`.github/workflows/release.yml`: on tag `v*` → build `agrippa-api` and `agrippa-worker` images → push to GHCR → attach compose bundle to the GitHub release. Acceptance check for M1.6: fresh machine, `docker compose up`, complete a bug-fix run end-to-end through the browser.
