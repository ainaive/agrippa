# Operations

## The stack

`infra/docker-compose.yml` runs four services:

| Service | Role | Notes |
|---|---|---|
| `api` | REST + SSE + serves the web app | Migrates the database and seeds builtin content on boot (advisory-locked, safe with concurrent boots) |
| `worker` | Executes runs | Scale with `WORKER_REPLICAS`; concurrency per worker via `WORKER_SLOTS` |
| `postgres` | System of record | Also carries the job queue (pg-boss) — no separate broker |
| `redis` | Live-event fan-out only | **Disposable**: if it's down, live streams degrade to replay/polling; correctness is unaffected |

## First-run: create the admin

Self-registration is **closed** — the instance is invite-only, so the very first user can't sign up. Create the org admin out-of-band, exactly once, then sign in:

```sh
# Docker — pass the two values to the container directly. Compose's --env-file
# only feeds interpolation of the compose file itself, so putting them there
# would NOT reach the process; and keeping them in the api service's
# environment: would park an admin password in a long-lived container.
read -r -s -p 'admin password: ' PW; echo
docker compose -f infra/docker-compose.yml --env-file infra/env/.env exec \
  -e AGRIPPA_BOOTSTRAP_EMAIL=you@example.com \
  -e AGRIPPA_BOOTSTRAP_PASSWORD="$PW" \
  api bun apps/api/src/cli/bootstrap-admin.ts
unset PW

# VM (from /opt/agrippa, reading /etc/agrippa/agrippa.env for DATABASE_URL):
sudo -u agrippa env AGRIPPA_BOOTSTRAP_EMAIL=you@example.com \
  AGRIPPA_BOOTSTRAP_PASSWORD='choose-a-strong-password' \
  bun --env-file=/etc/agrippa/agrippa.env apps/api/src/cli/bootstrap-admin.ts
```

Use `run --rm --no-deps api …` instead of `exec` if the api container isn't up yet.

The script is idempotent on email (re-running with the same address is a no-op), hashes the password with the same routine the login flow uses, and writes an audit row. After it prints `org_admin created`, sign in at the instance URL. Subsequent members join only via invitation (Admin → Members) — see [Administration](04-administration.md#accounts--onboarding).

## VM (systemd) deployment

The same stack installed by `infra/vm/install.sh` on one Ubuntu host (no Docker; see [Getting Started](01-getting-started.md#deploy-on-a-vm-systemd-no-docker)):

| Piece | Where |
|---|---|
| Services | `agrippa-api.service`, `agrippa-worker.service` (Postgres and Redis run as regular system services) |
| Logs | `journalctl -u agrippa-api -f` · `journalctl -u agrippa-worker -f` |
| Code + SPA build | `/opt/agrippa` (root-owned) |
| Config | `/etc/agrippa/agrippa.env` — one file for both services |
| Run workspaces / artifacts | `/var/lib/agrippa/runs` · `/var/lib/agrippa/artifacts` |

Updates: `sudo /opt/agrippa/infra/vm/deploy.sh` — pulls (`--ff-only`), installs with the frozen lockfile, rebuilds the SPA, restarts the api, waits for `/healthz` (migrations apply on api boot), then restarts the worker. Config changes take effect with `sudo systemctl restart agrippa-api agrippa-worker`.

## Configuration reference

Documented in `infra/env/.env.example`; the full set:

| Variable | Used by | Meaning |
|---|---|---|
| `DATABASE_URL` | api, worker | Postgres connection string |
| `REDIS_URL` | api, worker | Redis for pubsub; omit to fall back to DB polling |
| `AGRIPPA_SECRET_KEY` | api, worker | **Required.** 32-byte base64 key encrypting stored credentials. Losing it orphans every stored token |
| `BETTER_AUTH_SECRET` | api | **Required.** Session signing secret |
| `AGRIPPA_BASE_URL` | api | Public URL of the instance |
| `ANTHROPIC_API_KEY` | worker | Claude executor credential — the deployment-wide fallback; a project's own provider credential (Settings → Providers) overrides it for that provider |
| `OPENAI_API_KEY` · `CODEX_API_KEY` | worker | Same, for the Codex executor's `openai` provider. Both optional: a keyless worker still registers `codex-cli`, and a project credential always wins |
| `AGRIPPA_EXECUTOR` | api | Default executor for slots that don't declare one: `claude-agent-sdk`, `codex-cli`, or `fake` (token-free demo) |
| `CODEX_VERSION` | build | Codex CLI version baked into the worker image (default 0.145.0, floor 0.122) |
| `NPM_REGISTRY` | build | Where to fetch the Codex CLI from — `https://registry.npmmirror.com` from CN hosts |
| `APT_MIRROR` | build | Closer Debian mirror for the worker image build |
| `WORKER_SLOTS` | worker | Concurrent runs per worker (default 2) |
| `WORKSPACE_ROOT` | worker | Per-run checkout directory (default `/work/runs` in the image) |
| `ARTIFACT_STORAGE_ROOT` | worker | Large-artifact storage (>64 KB; smaller ones live in Postgres) |
| `AGRIPPA_TEMPLATES_DIR` | api, worker | Builtin templates location (set in the images) |
| `AGRIPPA_WEB_DIST` | api | SPA dist directory to serve (set in the api image) |
| `AGRIPPA_MIGRATE_ON_BOOT` | api | `0` disables boot-time migrate/seed |
| `AGRIPPA_KEEP_WORKSPACES` | worker | `1` keeps finished run workspaces on disk for debugging |
| `AGRIPPA_MAX_ARTIFACT_BYTES` | worker | Per-artifact size cap (default 25 MiB). A non-positive or unparseable value falls back to the default rather than lifting the cap |
| `AGRIPPA_SCM` | worker | `fake` fabricates branch/push/PR instead of touching a real remote — for demos |
| `PORT` | api | Listen port (default 3000) |
| `AGRIPPA_PORT` | compose | Published port mapping. Accepts an interface — use `127.0.0.1:3000` behind a reverse proxy, or the plain-HTTP API binds `0.0.0.0` |

## Executors

Workers register the executors they can actually run, at boot and on a 60 s heartbeat, into `executor_registrations`; the API refuses to accept a submission for an executor no worker has. `claude-agent-sdk` and `fake` always register. `codex-cli` registers only if a Codex CLI new enough for `codex exec --ignore-user-config` / `--ignore-rules` is on the worker's `PATH` — the worker image installs one at `/opt/codex` and its build fails if that check doesn't pass.

This matters because **Requirement Delivery** binds its reviewer slot to `codex-cli`. Check after any deploy:

```sh
docker compose logs worker | grep -i codex
docker compose exec worker codex --version
docker compose exec -T postgres psql -U agrippa -d agrippa \
  -c "select executor_id, registered_at from executor_registrations order by 1;"
```

A registered executor still needs a credential for the provider a step resolves to. `openai` takes worker env (`OPENAI_API_KEY`), so does `anthropic`; `dashscope` and org-registered custom providers are **project-credential only**. Note that `dashscope` cannot back a `codex-cli` slot at all — its catalog entry serves the `anthropic` wire protocol only, because Codex ≥ 0.122 dropped the chat wire API Bailian's OpenAI-compatible mode speaks. Point such a slot at a provider that serves the `openai` protocol, or at `claude-agent-sdk`.

## Backup — three things

1. The **database** — Compose: the `pgdata` volume; VM: `pg_dump agrippa` — schedule per your policy.
2. The **artifact store** — Compose: the `artifacts` volume; VM: `/var/lib/agrippa/artifacts`. Losing it loses downloads over 64 KB (metadata and small artifacts survive in Postgres).
3. **`AGRIPPA_SECRET_KEY`** — without it, every stored git token and MCP credential is unrecoverable. Redis needs no backup.

## Upgrades & scaling

Pull new images and `docker compose up -d` (VM: `sudo /opt/agrippa/infra/vm/deploy.sh`, which restarts the api first — see the VM section above). The api migrates on boot under an advisory lock, so rolling multiple replicas is safe. Draining workers is safe too: a killed worker's in-flight runs stay `running`, the queue retries them, and the engine **resumes step-granularly** — completed steps are never re-executed and token usage is never double-counted. Scale run throughput with `WORKER_REPLICAS` × `WORKER_SLOTS`.

When upgrading to the release that introduced platform-owned Git snapshots (ADR-0012), first drain active **repository-backed** runs. Older checkouts do not contain the trusted platform gitdir and deliberately fail closed as `workspace_lost` on a new worker; non-repository runs are unaffected. Later upgrades retain normal step-granular resume behavior.

Reverse proxy note: **disable response buffering** for `/api/v1/runs/*/events` (SSE) — e.g. `proxy_buffering off;` in nginx — or live progress will arrive in bursts. The stream emits a comment frame every 15 s so an idle run doesn't look like a dead connection; tune with `AGRIPPA_SSE_KEEPALIVE_MS` if an intermediary reaps faster than that.

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
| `git.push` fails / `pr.open needs a stored repo credential` | Publishing needs a token even for public repos (anonymous HTTPS is read-only) — add a connection with a token that has contents + pull-request write access. |
| `pr.open is not supported for provider 'generic-git'` | The branch was pushed but only GitHub/GitLab/GitCode connections can create the PR — recreate the connection with the right provider, or open the PR manually. |
| Need to inspect what an agent actually did on disk | Set `AGRIPPA_KEEP_WORKSPACES=1` on the worker and re-run; workspaces persist under `WORKSPACE_ROOT/<runId>`. |
| Submission rejected `executor_unavailable` | No live worker registered that executor. For `codex-cli`, check `docker compose logs worker \| grep -i codex` — the reason string comes straight from the CLI probe. |
| Run sits `queued` with a deferral event mentioning provider auth | The worker has no usable credential for the provider that step resolved to — add the key to worker env, or a project credential under Settings → Providers. |
| `healthz` returns 503 | The api can't reach Postgres — check `DATABASE_URL` and the postgres service. |
| (Docker) sandboxing is suspect | Docker's default seccomp profile can block the namespace operations bubblewrap needs, and the sandbox then degrades **silently**. Probe with `docker compose exec worker bwrap --unshare-all --ro-bind / / /bin/true`; if it fails, decide explicitly whether to accept the container as the boundary or to relax `security_opt` on the worker. |
| (VM) worker stuck in "activating" | Its `ExecStartPre` is waiting for the api's `/healthz` (up to 120 s) — check `journalctl -u agrippa-api` for why the api isn't healthy. |
| (VM) agent commands fail, or sandboxing is suspect on Ubuntu 24.04 | AppArmor's `apparmor_restrict_unprivileged_userns` can block bubblewrap — and without bwrap the sandbox degrades **silently**. Probe with `sudo -u agrippa bwrap --unshare-all --ro-bind / / /bin/true`; if it fails, allow unprivileged user namespaces (or install a bwrap AppArmor profile) and restart the worker. |
