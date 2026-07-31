# Operations

## The stack

`infra/docker-compose.yml` runs four services:

| Service | Role | Notes |
|---|---|---|
| `api` | REST + SSE + serves the web app | Migrates the database and seeds builtin content on boot (advisory-locked, safe with concurrent boots) |
| `worker` | Executes runs | Scale with `WORKER_REPLICAS`; concurrency per worker via `WORKER_SLOTS` |
| `postgres` | System of record | Also carries the job queue (pg-boss) — no separate broker |
| `redis` | Live-event fan-out only | **Disposable**: if it's down, live streams degrade to replay/polling; correctness is unaffected |

Every command in this manual names the compose project explicitly (`-p agrippa`). The project is also pinned in the compose file, so the flag is redundant *until* something sets `COMPOSE_PROJECT_NAME` in your shell — then an unpinned command silently operates a different stack, which for `down -v` means deleting the wrong volumes. If you are running a second stack deliberately (a restore drill, a staging copy), substitute its project name rather than dropping the flag.

## First-run: create the admin

Self-registration is **closed** — the instance is invite-only, so the very first user can't sign up. Create the org admin out-of-band, exactly once, then sign in:

```sh
# Docker — pass the two values to the container directly. Compose's --env-file
# only feeds interpolation of the compose file itself, so putting them there
# would NOT reach the process; and keeping them in the api service's
# environment: would park an admin password in a long-lived container.
read -r -s -p 'admin password: ' PW; echo
docker compose -p agrippa -f infra/docker-compose.yml --env-file infra/env/.env exec \
  -e AGRIPPA_BOOTSTRAP_EMAIL=you@example.com \
  -e AGRIPPA_BOOTSTRAP_PASSWORD="$PW" \
  api bun apps/api/src/cli/bootstrap-admin.ts
unset PW

# VM (from /opt/agrippa, reading /etc/agrippa/agrippa.env for DATABASE_URL):
sudo -u agrippa env AGRIPPA_BOOTSTRAP_EMAIL=you@example.com \
  AGRIPPA_BOOTSTRAP_PASSWORD='choose-a-strong-password' \
  bun --env-file=/etc/agrippa/agrippa.env apps/api/src/cli/bootstrap-admin.ts
```

If the api container isn't up yet, use `run` instead of `exec` — note the `-e` flags go **before** the service name:

```sh
docker compose -p agrippa -f infra/docker-compose.yml --env-file infra/env/.env run --rm --no-deps \
  -e AGRIPPA_BOOTSTRAP_EMAIL=you@example.com \
  -e AGRIPPA_BOOTSTRAP_PASSWORD="$PW" \
  api bun apps/api/src/cli/bootstrap-admin.ts
```

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
| `ARTIFACT_STORAGE_ROOT` | worker | Large-artifact storage (>64 KB; smaller ones — and checkpoint-driving ones up to 2 MiB — live in Postgres) |
| `AGRIPPA_TEMPLATES_DIR` | api, worker | Builtin templates location (set in the images) |
| `AGRIPPA_WEB_DIST` | api | SPA dist directory to serve (set in the api image) |
| `AGRIPPA_MIGRATE_ON_BOOT` | api | `0` disables boot-time migrate/seed |
| `AGRIPPA_KEEP_WORKSPACES` | worker | `1` keeps finished run workspaces on disk for debugging |
| `AGRIPPA_MAX_ARTIFACT_BYTES` | worker | Per-artifact size cap (default 25 MiB). A non-positive or unparseable value falls back to the default rather than lifting the cap |
| `AGRIPPA_SCM` | worker | `fake` fabricates branch/push/PR instead of touching a real remote — for demos |
| `AGRIPPA_SSE_KEEPALIVE_MS` | api | Interval between run-stream keepalive comment frames (default 15000). Lower only for an intermediary that reaps idle connections faster |
| `PORT` | api | Listen port (default 3000) |
| `AGRIPPA_PORT` | compose | Published port mapping. Accepts an interface — use `127.0.0.1:3000` behind a reverse proxy, or the plain-HTTP API binds `0.0.0.0` |

## Executors

Workers register the executors they can actually run, at boot and on a 60 s heartbeat, into `executor_registrations`; the API refuses to accept a submission for an executor no worker has. `claude-agent-sdk` and `fake` always register. `codex-cli` registers only if a Codex CLI new enough for `codex exec --ignore-user-config` / `--ignore-rules` is on the worker's `PATH` — the worker image installs one at `/opt/codex` and its build fails if that check doesn't pass.

This matters because **Requirement Delivery** binds its reviewer slot to `codex-cli`. Check after any deploy:

```sh
docker compose -p agrippa logs worker | grep -i codex
docker compose -p agrippa exec worker codex --version
docker compose -p agrippa exec -T postgres psql -U agrippa -d agrippa \
  -c "select executor_id, registered_at from executor_registrations order by 1;"
```

A registered executor still needs a credential for the provider a step resolves to. `openai` takes worker env (`OPENAI_API_KEY`), so does `anthropic`; `dashscope` and org-registered custom providers are **project-credential only**. Note that `dashscope` cannot back a `codex-cli` slot at all — its catalog entry serves the `anthropic` wire protocol only, because Codex ≥ 0.122 dropped the chat wire API Bailian's OpenAI-compatible mode speaks. Point such a slot at a provider that serves the `openai` protocol, or at `claude-agent-sdk`.

## Rotating the database password

`POSTGRES_PASSWORD` is read by Postgres **only when the data volume is first initialized**. On every later boot it is ignored, while compose keeps building `DATABASE_URL` from it — so editing the env file alone does not rotate anything, it just makes the URL stop matching the role. The api and worker then fail with `password authentication failed for user "agrippa"`, `/healthz` returns 503, and a deploy rolls back — unsuccessfully, because `infra/env/.env` is untracked and survives `git reset --hard`.

Change the role first, then the file:

```sh
C="docker compose -p agrippa -f infra/docker-compose.yml --env-file infra/env/.env"
NEW=$(openssl rand -hex 24)          # hex: this ends up in a URL, and base64 can emit /

$C exec -T postgres psql -U agrippa -d agrippa \
    -c "ALTER ROLE agrippa WITH PASSWORD '$NEW'"
# only once that succeeded — put the same value in infra/env/.env
$C up -d api worker                  # picks up the new DATABASE_URL
```

**Upgrading from a stack that relied on the old default?** Earlier versions defaulted the password to the literal `agrippa` when the variable was unset. It is now required, so set it to `agrippa` — the value your role actually has — or rotate with the recipe above first. Any other value will not authenticate.

## Backup — three things

1. The **database** — Compose: the `pgdata` volume; VM: `pg_dump agrippa` — schedule per your policy.
2. The **artifact store** — Compose: the `artifacts` volume; VM: `/var/lib/agrippa/artifacts`. Losing it loses downloads over 64 KB (metadata, small artifacts, and checkpoint-driving artifacts survive in Postgres; publish-time patch verification uses digests stored in Postgres, so it is unaffected).
3. **`AGRIPPA_SECRET_KEY`** — without it, every stored git token and MCP credential is unrecoverable. Redis needs no backup.

## Upgrades & scaling

Compose deployments use **`sudo infra/deploy.sh [<commit>]`**: it fetches from GitCode, builds images tagged with the deployed commit, starts them, waits on `/healthz`, and **rolls back to the previous tag** if the new one doesn't come up. Run it by hand any time; pushing to the `deploy` branch runs the same script automatically via Janus (`.janus/deploy.yml`).

Changes to `deploy.sh` itself land one deploy later: the running script was read from the tree as it stood at the *previous* deploy, and it keeps running from that file after resetting the tree. So the deploy that ships a script change still runs the old script. Check a script change against the following deploy, or run it by hand.

The host checkout sits on a **detached HEAD** at the deployed commit, so `git pull` there fails rather than quietly advancing the tree past the running images — compose config, `.env` defaults and Dockerfiles all come from that tree. To see what is deployed, `git -C /opt/agrippa log -1`; to change it, move the `deploy` branch and push.

The api's healthcheck has a 180s `start_period`, because migrations and seeding run before the listener opens — without it a slow migration shows as `unhealthy` partway through a deploy.

All four services are `restart: unless-stopped`, so the stack comes back after a host reboot; nothing else supervises it. Note this is coupled to verification — a crash-looping worker looks "running" between restarts, so the deploy also fails if the workers' restart count moves while it is being verified. Do not remove one without the other.

It always rebuilds, deliberately: the SPA and the API are baked into the api image, so a bare `git pull && docker compose up -d` restarts the **old** code and looks like it worked. Build cache keeps a docs-only deploy cheap. A `flock` serializes concurrent deploys, and only the current and previous image tags are kept (each pair is ~4 GB).

Two things it will not do. It **only deploys commits reachable from the `deploy` branch** — an arbitrary SHA is refused, which is what keeps the root-level grant meaningful. And **rollback does not revert the database**: the API applies migrations on boot before it is healthy, and some are irreversible.

Janus does not reach root through `sudo`. Its service runs with `NoNewPrivileges`, which every pipeline step inherits and which makes setuid a permanent no-op, so `sudo` cannot work there whatever the sudoers rule says. The pipeline instead starts a oneshot systemd unit, `agrippa-deploy@<sha>.service`, authorized by a polkit rule scoped to that one unit and the `start` verb alone; the deploy log is written to `/var/log/agrippa-deploy/<sha>.log` and printed back into the pipeline. See [`infra/janus/README.md`](https://github.com/ainaive/agrippa/blob/main/infra/janus/README.md).

The printed commands name the compose project explicitly (`-p`). They are meant to be pasted into a fresh shell, and without that they would resolve the project from the compose file in the tree — a different stack than the one that just failed, if the deploy ran under `COMPOSE_PROJECT_NAME`.

The script therefore takes a `pg_dump` before every deploy, into `/var/lib/agrippa-deploy` (mode `0700`, dumps `0600`, last 5 retained — they are a full copy of production and the host also runs an unprivileged CI user). On any failure it prints the restore procedure rather than implying the schema came back:

```sh
# the deploy prints the dump path it took; assign it rather than pasting a placeholder
DUMP=/var/lib/agrippa-deploy/pgdump-20260730-064413-070e868.dump
C="docker compose -p agrippa -f infra/docker-compose.yml --env-file infra/env/.env"

$C stop api worker                       # dropdb needs zero connections
$C exec -T postgres dropdb -U agrippa --if-exists agrippa
$C exec -T postgres createdb -U agrippa agrippa
$C exec -T postgres pg_restore -U agrippa -d agrippa \
    --exit-on-error --single-transaction < "$DUMP"
$C start api worker                      # only once the restore succeeded
```

Drop and recreate rather than `pg_restore --clean`: `--clean` only drops what the archive contains, so tables the failed migration *added* would survive, and can block the restore through dependencies. `--single-transaction` with `--exit-on-error` means a partial restore rolls back instead of leaving a half-populated database. Stopping the app first is not optional — `dropdb` refuses while the api and worker hold connections.

A deploy is reported successful only once the api reports healthy **and** every expected worker replica is running **and** each expected replica has a ready-and-alive row in `worker_heartbeats`: `consumers_ready_at` set (cleared at every boot start, re-set only after all queue consumers have started — so a worker that registers its executors and then wedges during startup no longer reads as deployed) plus a fresh 60 s heartbeat proving the process is alive. Requiring liveness rather than a post-deploy ready stamp means rollbacks and same-commit redeploys that reuse unchanged, healthy containers verify without a reboot. Inspect the rows with:

```sh
docker compose -p agrippa exec -T postgres psql -U agrippa -d agrippa \
  -c "select container_id, consumers_ready_at, heartbeat_at from worker_heartbeats order by 2 desc;"
```

Pull new images and `docker compose -p agrippa up -d` (VM: `sudo /opt/agrippa/infra/vm/deploy.sh`, which restarts the api first — see the VM section above). The api migrates on boot under an advisory lock, so rolling multiple replicas is safe. Draining workers is safe too: a killed worker's in-flight runs stay `running`, the queue retries them, and the engine **resumes step-granularly** — completed steps are never re-executed and token usage is never double-counted. Scale run throughput with `WORKER_REPLICAS` × `WORKER_SLOTS`.

### Upgrading from a deployment created before the compose project was named

Releases up to and including `v0.2.0` shipped `infra/docker-compose.yml` with no `name:` key, so Compose derived the project name from the file's directory: `infra`. The stack is now explicitly `agrippa`. If your volumes are named `infra_pgdata` / `infra_artifacts` / `infra_workspaces` (`docker volume ls`), a plain `docker compose up -d` would build a **second, empty** stack beside the old one — and collide on the published port. Migrate once:

```sh
# 0. ONLY if you already ran `docker compose up -d` on the new code, which
#    created an empty agrippa stack. Confirm `docker volume ls` still shows your
#    data under infra_* first — this deletes the new, empty volumes.
docker compose -p agrippa -f infra/docker-compose.yml --env-file infra/env/.env down -v

# 1. stop the old stack — WITHOUT -v, which would delete the data
docker compose -p infra -f infra/docker-compose.yml --env-file infra/env/.env down

# 2. preflight the SOURCES before creating anything. Docker creates a missing
#    named volume on the fly, so a typo here would mount an empty one, copy
#    nothing, and leave you with a fresh empty database that passes /healthz —
#    a migration that looks like it worked while your data sits elsewhere.
for v in pgdata artifacts workspaces; do
  docker volume inspect "infra_$v" >/dev/null 2>&1 || {
    echo "infra_$v does not exist — check 'docker volume ls' for the real names" >&2
    exit 1
  }
done
docker run --rm -v infra_pgdata:/from postgres:17 test -f /from/PG_VERSION || {
  echo "infra_pgdata has no PG_VERSION — that is not a Postgres data directory" >&2
  exit 1
}

# 3. copy each volume infra_X -> agrippa_X. Any image with cp works; postgres:17
#    is already pulled. Run workspaces are disposable — pgdata and artifacts are
#    the ones that matter.
#
#    The guard is not optional: `docker volume create` succeeds silently on an
#    existing volume and `cp -a` does not remove files already there, so copying
#    onto a started-then-abandoned stack would merge two Postgres clusters with
#    different system identifiers — mixed WAL and catalog files, and no clean
#    way back.
for v in pgdata artifacts workspaces; do
  if docker volume inspect "agrippa_$v" >/dev/null 2>&1 &&
     [ -n "$(docker run --rm -v "agrippa_$v:/to" postgres:17 sh -c 'ls -A /to')" ]; then
    echo "agrippa_$v exists and is not empty — do step 0 first" >&2
    exit 1
  fi
  docker volume create "agrippa_$v" >/dev/null
  docker run --rm -v "infra_$v:/from" -v "agrippa_$v:/to" postgres:17 \
    sh -c 'cd /from && cp -a . /to'
done

# 4. start under the new project name and verify before cleaning up
docker compose -p agrippa -f infra/docker-compose.yml --env-file infra/env/.env up -d
curl -fsS http://127.0.0.1:3000/healthz

# 5. only once you're satisfied — this is the irreversible step
docker volume rm infra_pgdata infra_artifacts infra_workspaces
```

Nothing else changes: same images, same env file, same data. Only the resource namespace moves.

When upgrading to the release that introduced platform-owned Git snapshots (ADR-0012), first drain active **repository-backed** runs. Older checkouts do not contain the trusted platform gitdir and deliberately fail closed as `workspace_lost` on a new worker; non-repository runs are unaffected. Later upgrades retain normal step-granular resume behavior.

Reverse proxy note: **disable response buffering** for `/api/v1/runs/*/events` (SSE) — e.g. `proxy_buffering off;` in nginx — or live progress will arrive in bursts. The stream emits a comment frame every 15 s so an idle run doesn't look like a dead connection; tune with `AGRIPPA_SSE_KEEPALIVE_MS` if an intermediary reaps faster than that.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Deploy fails `AGRIPPA_VERSION did not reach compose; images would be mistagged` | Compose could not render the file at all — almost always a required variable is unset, and `POSTGRES_PASSWORD` is the one that became mandatory. Set it in `infra/env/.env` (see `infra/env/.env.example`) and redeploy; your stack was rolled back and is still running, so this is not urgent. The message names tagging because the *previous* release's `deploy.sh` discarded compose's stderr, and script changes only take effect one deploy later. **Do not check by running `compose config` in `/opt/agrippa`** — the rollback already reset the checkout to the previous commit, whose compose file still defaulted the password, so it renders cleanly and tells you nothing. To see compose's real error, render the commit that failed (its SHA is in the deploy's `after a failed deploy of …` line): `cd /opt/agrippa && git show <failed-sha>:infra/docker-compose.yml \| docker compose -p agrippa -f - --env-file infra/env/.env config --quiet`. Keep `--quiet`: without it Compose prints the fully resolved model, which carries `AGRIPPA_SECRET_KEY`, `BETTER_AUTH_SECRET`, `ANTHROPIC_API_KEY` and the database password — straight into your terminal and any incident notes you paste it into. `--quiet` validates and reports the error on stderr without printing any of it. Deploys from this release onward report the cause directly. |
| Deploy rolls back with `worker never became ready` after you scaled workers | You scaled out of band (`--scale`). `deploy.sh` requires the running worker count to equal `WORKER_REPLICAS` exactly — set that variable in `infra/env/.env` instead and redeploy. |
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
| Submission rejected `executor_unavailable` | No live worker registered that executor. For `codex-cli`, check `docker compose -p agrippa logs worker \| grep -i codex` — the reason string comes straight from the CLI probe. |
| Run sits `queued` with a deferral event mentioning provider auth | The worker has no usable credential for the provider that step resolved to — add the key to worker env, or a project credential under Settings → Providers. |
| `healthz` returns 503 | The api can't reach Postgres — check `DATABASE_URL` and the postgres service. |
| (Docker) sandboxing is suspect | Expected: under Docker's default profiles bubblewrap **cannot** create namespaces, and the sandbox degrades silently. Restoring it needs `seccomp=unconfined` *and* `CAP_SYS_ADMIN` — a worse trade than accepting the container as the boundary (see [design/08](../../design/08-deployment.md)). Use the VM topology if you need OS-level sandboxing. Probe: `docker compose -p agrippa exec worker bwrap --unshare-all --ro-bind / / /bin/true`. |
| (VM) worker stuck in "activating" | Its `ExecStartPre` is waiting for the api's `/healthz` (up to 120 s) — check `journalctl -u agrippa-api` for why the api isn't healthy. |
| (VM) agent commands fail, or sandboxing is suspect on Ubuntu 24.04 | AppArmor's `apparmor_restrict_unprivileged_userns` can block bubblewrap — and without bwrap the sandbox degrades **silently**. Probe with `sudo -u agrippa bwrap --unshare-all --ro-bind / / /bin/true`; if it fails, allow unprivileged user namespaces (or install a bwrap AppArmor profile) and restart the worker. |
