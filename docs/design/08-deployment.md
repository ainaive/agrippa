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
- `worker` scales horizontally via **`WORKER_REPLICAS`** in `infra/env/.env`; run concurrency = workers × slots. Not `docker compose up --scale`: `deploy.sh` verifies the running worker count against `WORKER_REPLICAS` and requires **exact equality**, so scaling out of band desynchronises the two and the next deploy fails verification for the full `HEALTH_TIMEOUT` and rolls back a healthy stack.
- Migrations run **in-process at the top of `apps/api/src/index.ts`**, before the listener opens, guarded by a Postgres advisory lock taken on a reserved connection; seeding of builtin resources and publication of builtin templates follow in the same block, both idempotent (checksum-guarded upserts). `AGRIPPA_MIGRATE_ON_BOOT=0` opts out. There is no entrypoint script — so with the default setting a healthy `/healthz` means all three finished; where the opt-out is set, it means only that the API is serving and can reach Postgres, and the schema is whatever was applied out of band. The worker does not migrate; it **waits** for the schema its own build expects (`awaitSchema`, the first thing `apps/worker/src/index.ts` does — it compares its migration journal's newest entry against `drizzle.__drizzle_migrations`) rather than crashing on a table it has and the database does not. That wait lives in the image on purpose: a compose `depends_on: api: service_healthy` would not cover host reboots or `docker start` (restart policies ignore `depends_on`), would prove nothing under `AGRIPPA_MIGRATE_ON_BOOT=0`, and would make `up -d` block on another service's health — an unbounded deploy hang when an api crash-loops. Its bound (300s) deliberately exceeds `HEALTH_TIMEOUT`, so a schema that never arrives fails the deploy as "worker never became ready" instead of as a restart-count mismatch. The VM unit's `/healthz` `ExecStartPre` remains as belt-and-braces.
- **Both topologies provision the Codex CLI** at `/opt/codex` (pinned by `CODEX_VERSION`, fetched from `NPM_REGISTRY`): the `worker` image at build time, and the VM via `infra/vm/codex.sh`, called from both `install.sh` and `deploy.sh` so updates converge it too. The `codex-cli` executor spawns a literal `codex` binary, so without it `probeCodexCli()` fails, the executor never registers, and templates binding a slot to it — `swdev/requirement-delivery` — become un-submittable. The image build runs the same two flag checks the boot probe does, so a bad pin fails the build rather than degrading silently at runtime.
- `infra/docker-compose.dev.yml` starts **dependencies only** (postgres + redis) for local development; `api`/`worker`/`web` run via `bun dev` on the host.

## Configuration (env)

`infra/env/.env.example` documents everything; highlights:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection |
| `REDIS_URL` | Redis pubsub |
| `AGRIPPA_BASE_URL` | Public URL (links in emails/PRs). Must equal the browser's origin exactly — scheme, host **and** port: it is better-auth's trusted origin and decides the cookie `Secure` flag, so a mismatch either 403s auth POSTs (`INVALID_ORIGIN`) or has the browser drop a cookie sign-in appeared to set |
| `AGRIPPA_SECRET_KEY` | AES-256-GCM key encrypting the `secrets` table — **back this up; losing it orphans stored credentials** |
| `BETTER_AUTH_SECRET` | session signing |
| `ANTHROPIC_API_KEY` | Claude executor (worker only) |
| `OPENAI_API_KEY` / `CODEX_API_KEY` | Codex executor's `openai` provider (worker only); both optional — a keyless worker still registers `codex-cli` and defers runs needing env auth it lacks |
| `WORKER_SLOTS` | run concurrency per worker (default 2) |
| `WORKSPACE_ROOT` | workspaces volume, one directory per workspace key (default `/work/runs`) |
| `AGRIPPA_WORKSPACE_RETENTION_MINUTES` | how long a released workspace stays on disk before the collector takes it (default `0` — collected on the next sweeper tick). Raise it to inspect finished runs' trees; a live run in the chain holds its workspace regardless |
| `ARTIFACT_STORAGE_ROOT` | large-artifact volume |
| `AGRIPPA_PORT` | published port mapping; accepts an interface (`127.0.0.1:3000`) so the plain-HTTP API isn't exposed beside the TLS terminator |
| `AGRIPPA_HSTS_MAX_AGE` | `Strict-Transport-Security` lifetime in seconds (default 31536000). Emitted only when the proxy forwards `X-Forwarded-Proto: https`, so it is inert without TLS. `0` is not "off" — it emits `max-age=0`, which clears a pin browsers already cached, and is the rollback path |
| `APT_MIRROR` | optional **build-time** mirror for the worker image's apt packages (e.g. `https://mirrors.aliyun.com` from a host where `deb.debian.org` is slow/blocked); no-op when empty |
| `CODEX_VERSION` / `NPM_REGISTRY` | which Codex CLI is installed and where from. **Build-time** for the image, **install/deploy-time** for the VM (`infra/vm/codex.sh`). Note `NPM_REGISTRY` is a URL (`https://registry.npmmirror.com`) while `APT_MIRROR` above is a bare host — both forms are accepted for each |

Secrets policy: the master key and the deployment's **fallback** provider API keys live only in `api`/`worker` env (compose `env_file`), never in the DB; user-registered credentials (git tokens, MCP auth, and per-project provider API keys — ADR-0013) live encrypted in the `secrets` table keyed by `AGRIPPA_SECRET_KEY`. A project provider credential **overrides** the worker env for that provider; env auth remains the deployment-wide default for projects without one.

**Aliyun Bailian (DashScope) / Qwen**: no worker env needed — an admin adds a `dashscope` credential in project settings and grants the seeded Qwen models. Runs through the **claude executor only** (Codex CLI ≥0.122 removed the chat wire API Bailian's compatible mode speaks — ADR-0013 amendment); the catalog defaults to the Beijing endpoint `https://dashscope.aliyuncs.com/apps/anthropic`, and international workspaces set the credential's base-URL override to their workspace-scoped `*.maas.aliyuncs.com` host (overrides are policy-checked: https, public DNS names, `.aliyuncs.com` for dashscope).

## Operations

- **First-run onboarding**: self-registration is closed (invite-only — see [05](05-api-and-auth.md#authentication)). The api/worker do **not** create users on boot. An operator runs `apps/api/src/cli/bootstrap-admin.ts` once (reads `AGRIPPA_BOOTSTRAP_EMAIL`/`PASSWORD` from the env file, creates the first `org_admin`, idempotent on email) — then signs in and invites members from the UI. Runbook in [Operations → First-run](../manual/en/06-operations.md#first-run-create-the-admin).
- **Backup**: Postgres volume (pg_dump schedule is the operator's choice) + `ARTIFACT_STORAGE_ROOT` volume + the `AGRIPPA_SECRET_KEY`. Redis is disposable.
- **Upgrade (Compose)**: `infra/deploy.sh [<commit>]` — fetches from GitCode, builds images tagged
  with the deployed commit, `up -d`, waits on `/healthz`, and **rolls back to the previous tag** if
  that fails. It always builds: the SPA and API are baked into the api image, so a bare
  `git pull && docker compose up -d` restarts the *old* code and reports success. A `flock` keeps
  concurrent deploys from racing on the image tags. Automated by Janus on push to the `deploy`
  branch (`.janus/deploy.yml`); the same script is the supported manual path.
  It refuses any commit **not reachable from `deploy`** — the privileged path that lets Janus call
  it as root would otherwise make every branch deployable, and root-owning the tree would buy
  nothing.
  **Edits to `deploy.sh` take effect one deploy later**: it is launched from the tree as it stood at
  the previous deploy and only then resets that tree, and the running bash keeps executing the file
  it opened (git swaps in a new inode). So the deploy that ships a change to the script still runs
  the old version — verify a script change against the *next* deploy, or run it by hand.
  The host checkout is left on a **detached HEAD** at the deployed commit: on a local branch, each
  deploy would force-move that branch, and a stray `git pull` would advance the tree past the
  running images — compose config, `.env` defaults and Dockerfiles are read from that tree, so
  manual compose commands would then use config that does not match what is running.
  `STATE_DIR` holds per-stack recovery state (`last-good` and the dump retention window) but is not
  derived from the project, so it carries an ownership marker: a second stack run under
  `COMPOSE_PROJECT_NAME` without its own `STATE_DIR` is refused rather than allowed to overwrite the
  first's rollback target. The lock is deliberately *not* per-project — image tags carry no project,
  so concurrent deploys of different stacks really do race on them.
  Every compose invocation, and the restore procedure it prints, names the project explicitly
  (`-p`): the procedure is copy-pasted into a shell that does not share the deploy's environment,
  and without it the commands resolve against whatever `name:` the tree carries — the wrong stack
  entirely if the deploy ran under `COMPOSE_PROJECT_NAME`.
  Verification covers **both** services: the api's compose healthcheck, and one ready-AND-alive
  `worker_heartbeats` row per expected worker replica — per container, `consumers_ready_at` cleared
  at boot start and set only after every queue consumer has started (so a worker that registers its
  executors and then wedges inside consumer setup fails verification, issue #15), combined with a
  fresh sweeper heartbeat (so rollbacks and same-SHA redeploys that reuse unchanged, healthy
  containers still pass without a reboot). Rollback restores
  the previous commit's *code and config*, not the database — the api migrates on boot before it is
  healthy and some migrations are irreversible, so Postgres is dumped beforehand and the restore
  command is printed if a rollback happens.
- **How Janus reaches root — not `sudo`.** Janus's systemd unit sets `NoNewPrivileges=true`, which every pipeline step inherits and which no child can drop, so setuid is a permanent no-op there and `sudo` fails regardless of the sudoers rule. The deploy is therefore a oneshot unit, `agrippa-deploy@<sha>.service`, that the pipeline starts with `systemctl start --wait`: that goes to pid 1 over D-Bus rather than escalating in-process, so the flag does not apply, and `--wait` propagates the deploy's exit status back to the pipeline. A polkit rule grants the `janus` user exactly one verb (`start`) on one unit-name pattern (`agrippa-deploy@<hex>.service`). The unit writes its log to `/var/log/agrippa-deploy/<sha>.log` (`root:janus 0750`) for the pipeline to print, because the janus user cannot read the journal and granting it that would expose every unit's logs to every pipeline on the host. Setup, rationale and the verification procedure — including the negative tests that prove the grant does not reach further — are in [`infra/janus/README.md`](../../infra/janus/README.md).
- **Healthcheck timing**: the api's compose healthcheck carries `start_period: 180s` (with `start_interval: 3s`). Migrations, seeding and template publication all run under top-level await *before* the listener opens, so probes until then are connection refusals; without a start period they count as failures and a slow-but-successful migration reads as `unhealthy`.
- **Restart policy**: all four services are `restart: unless-stopped`, so the stack returns after a host reboot — nothing else supervises it (`infra/janus/agrippa-deploy@.service` is the one-shot deploy). That policy interacts with verification: a crash-looping worker is "running" between restarts, and a loop that gets past consumer setup before dying re-freshens its `worker_heartbeats` readiness row on every lap, so it would satisfy both other checks. `worker_ok()` therefore also fails when the workers' summed `RestartCount` moves during verification. **Do not add a restart policy without that check** — together they distinguish "looping" from "up"; separately the first one hides failed deploys.
- **Upgrade (images)**: pull images → `docker compose -p agrippa up -d` → api migrates on boot. Workers drain gracefully (in-flight runs resume on new workers via step-granular resume — see [04](04-execution-runtime.md)); the compose `stop_grace_period` must exceed the drain, so it is set to 60s rather than the 10s default.
- **TLS / ingress**: out of scope; operators front the stack with their own reverse proxy. SSE requires the proxy to disable response buffering for `/api/v1/runs/*/events`, or live progress arrives in bursts. The stream emits a comment frame every 15s (`AGRIPPA_SSE_KEEPALIVE_MS`) so an idle run — a long agent turn, or one parked on an approval — never looks like a dead connection; a generous `proxy_read_timeout` remains worth setting as defence in depth for intermediaries whose idle limits you do not control. The proxy should also forward `X-Forwarded-Proto`, which is what gates the HSTS header (below).
- **Plain HTTP is not merely insecure on a CN host — it is unreachable.** A mainland-China middlebox intercepts HTTP naming a domain without an ICP filing (备案) and answers it itself, with a GB2312 block page titled 非法阻断 that frames the provider's error server. The domain is read from the **cleartext `Host` header**; TLS encrypts that header and exposes only SNI, so `https://host:3000` serves normally while `http://host:3000` is intercepted on the same host and port — a split that reads like "our domain is blocked" and invites the wrong fix (moving to a bare IP, which forfeits the secure context, the cookie `Secure` flag, and IM card deep links, for a scheme that is intercepted anyway). Note the injected page is what makes this identifiable: nginx never sees the request, so a TLS-only `listen` on that port cannot be the explanation even though it would fail too. No redirect can rescue the HTTP side either — nothing of ours is reached. The fix has to act on the client, which is why the api emits `Strict-Transport-Security` (`AGRIPPA_HSTS_MAX_AGE`) — browsers then rewrite a bookmarked or pasted `http://` URL to `https://` locally, before anything goes on the wire. HSTS is scoped to the host and preserves the port, so `:3000` deployments are covered.
- **Health**: `GET /healthz` (api: DB ping). `worker_heartbeats` carries one row per worker container (boot start clears the consumers-ready stamp; it is re-set only after all consumers started; the sweeper bumps a 60s liveness heartbeat; rows silent for a week are pruned). Each row also carries the worker's **capability advertisement** — the executor ids it constructed, their `envAuthProviders`, and the build version — written at boot and refreshed on every beat; the API's submit gating reads per-worker sets from it (jobs route by executor-set queue, so a run's whole set must fit one worker); the old deployment-wide `executor_registrations` table is gone. The fleet is visible at **Admin → Workers** (`GET /api/v1/fleet/workers`, org-admin): live/stale per container (150 s, database clock), advertisement, readiness, version.
- **Remote runtime daemons (ADR-0017)**: `bun run build:daemon` compiles `dist/agrippa-daemon`; a team machine runs it with an `agrd_` token issued in Admin → Workers and executes agent work with its own CLI logins and its own git credentials. The api's artifacts volume is read-write since M2 (the daemon-upload staging area — the write surface is the token-gated endpoint alone). Runs touching platform-held secrets never route to daemons; a daemon silent for 5 minutes triggers a `runtime.offline` notification on its pinned running runs, and its in-flight step fails typed after the 2-minute deadman.
- **Sandboxing under Docker — bubblewrap does not work, and that is the accepted posture.** The worker image installs bubblewrap, but under Docker's default profiles it cannot create the namespaces it needs, and both executors treat an unavailable sandbox as a **silent** degradation (the Claude SDK is configured `failIfUnavailable: false`). Measured on Ubuntu 24.04 / Docker 29: the default seccomp profile blocks namespace creation outright; with `seccomp=unconfined` the namespace is created but mount setup then fails (`Failed to make / slave`) without `CAP_SYS_ADMIN`. Restoring the inner sandbox therefore costs `seccomp=unconfined` **plus** `CAP_SYS_ADMIN` — dismantling most of the outer boundary to rebuild a weaker inner one, which is a bad trade. **The container is the boundary**: the container itself, the non-root `bun` user, `/app` staying root-owned, the throwaway per-run workspace, and the env allow-list that keeps `DATABASE_URL`/`AGRIPPA_SECRET_KEY` out of agent subprocesses. Know the allow-list's limit: agent processes share the worker's UID and PID namespace, and `/proc/1/environ` is readable to same-UID processes (Yama's ptrace_scope guards `PTRACE_MODE_ATTACH`, not the `PTRACE_MODE_READ` check `/proc/<pid>/environ` uses) — so a read-write agent's shell can recover the worker's credentials and, with them, forge any platform state, including artifact digests and checkpoint decisions. That is why this posture is for trusted orgs only; per-run UID/namespace isolation is the M2 work. Deployments that want OS-level sandboxing on top should use the VM/systemd topology, where bwrap works. Probe with `docker compose -p agrippa exec worker bwrap --unshare-all --ro-bind / / /bin/true` if you need to confirm the state on a given host.
- **Deferred**: an outbound-network allowlist for agent Bash. Previously listed here as a `WORKER_EGRESS_ALLOWLIST` env var; nothing implements it, so it is recorded as future work rather than configuration.

## VM deployment (systemd, no Docker)

`infra/vm/` codifies the same topology on a single Ubuntu 22.04/24.04 host: `install.sh` (idempotent bootstrap: Bun, Codex CLI, Postgres 17 via PGDG, optional Redis 7, `agrippa` system user, env file with generated secrets, units), `deploy.sh` (update: `git pull --ff-only` → `bun install --frozen-lockfile` → SPA build → Codex CLI → restart), `codex.sh` (versioned install behind an atomically-swapped symlink, shared by both), `agrippa-api.service` / `agrippa-worker.service`, `env.example`, `nginx.conf.example`.

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
