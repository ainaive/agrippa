# Getting Started

## Deploy with Docker Compose (recommended)

Requirements: Docker with Compose, ~2 GB RAM.

```sh
git clone https://github.com/ainaive/agrippa && cd agrippa
cp infra/env/.env.example infra/env/.env
# edit infra/env/.env:
#   POSTGRES_PASSWORD    ← openssl rand -hex 24    (hex, not base64 — see below)
#   AGRIPPA_SECRET_KEY   ← openssl rand -base64 32   (back it up!)
#   BETTER_AUTH_SECRET   ← openssl rand -base64 32
#   ANTHROPIC_API_KEY    ← your key, or leave empty with AGRIPPA_EXECUTOR=fake
docker compose -p agrippa -f infra/docker-compose.yml --env-file infra/env/.env up -d
```

`POSTGRES_PASSWORD` must be **hex**: it is interpolated into `DATABASE_URL`, and base64 can emit `/`, which makes the URL unparseable. It is also applied only when the database volume is first created — changing it later needs an `ALTER ROLE` as well ([Operations → rotating the database password](06-operations.md#rotating-the-database-password)).

Open `http://localhost:3000`. The stack is four services: **api** (also serves the web app), **worker** (executes runs), **postgres**, **redis**. Migrations and builtin content (scenarios, task types, templates, models, skills) apply automatically on boot.

**Demo mode**: set `AGRIPPA_EXECUTOR=fake` and leave `ANTHROPIC_API_KEY` empty — every task type runs end to end with a token-free demo executor that produces placeholder artifacts. Ideal for evaluating the platform before spending tokens.

## Deploy on a VM (systemd, no Docker)

Requirements: Ubuntu 22.04/24.04 LTS, ~2 GB RAM, root access.

```sh
sudo git clone https://github.com/ainaive/agrippa /opt/agrippa
sudo /opt/agrippa/infra/vm/install.sh        # add --skip-redis to omit Redis
```

The installer is idempotent and sets up everything on one box:

- Bun, plus the worker's OS dependencies (`git`, `ripgrep`, `bubblewrap` for the agent sandbox)
- the OpenAI Codex CLI at `/opt/codex` — the `codex-cli` executor spawns it directly, and without it the **Requirement Delivery** workflow cannot be submitted. `infra/vm/deploy.sh` reinstalls it on every update, so a version bump lands with a normal deploy
- PostgreSQL 17 (PGDG) and Redis 7 (optional — without it, live streams fall back to polling)
- an `agrippa` system user, data directories under `/var/lib/agrippa`
- `/etc/agrippa/agrippa.env` with generated secrets — **back up `AGRIPPA_SECRET_KEY`**
- `agrippa-api` + `agrippa-worker` systemd units, then the first build and start

Open `http://<host>:3000`. The demo-mode note above applies here too (`AGRIPPA_EXECUTOR=fake` in `/etc/agrippa/agrippa.env`). To update later:

```sh
sudo /opt/agrippa/infra/vm/deploy.sh         # pull → build → restart (api first, then worker)
```

See [Operations](06-operations.md) for logs, backup, and troubleshooting on a VM.

## Run from source (development)

See the [README quick start](../../../README.md#getting-started): Bun ≥ 1.3 + local Postgres, three processes (`api`, `worker`, `web`).

## First login

Sign up at the login screen — **the first account created becomes the organization admin** (later accounts are regular members). That's how a fresh install bootstraps its administrator, so create your admin account before sharing the URL.

## Finding your way around

Navigation lives in the **left sidebar**. At its top sits the **project switcher** — search your projects, jump between them, or create a new one. Below it, the *Project* section holds Dashboard, Catalog, Tasks, and (for project admins) Settings; the *Organization* section holds the Approvals inbox and, for org admins, the Admin area. The sidebar collapses to an icon rail via the toggle in the top bar, and becomes a drawer on small screens. The top bar shows breadcrumbs for where you are, and the **avatar menu** on the right switches language (English / 中文) and theme (light / dark / system) and signs you out.

## Initial setup checklist

1. **Create a project** — you'll be prompted on first login. Projects scope everything: members, resources, quotas, repositories. A new project is **auto-granted every built-in model, skill, and Faber**, so the resource grants you'd otherwise toggle on by hand are already in place.
2. **Connect a repository** (Project → Settings → Repositories): pick the hosting provider (GitHub / GitLab / GitCode / generic Git), then URL (HTTPS, not SSH), default branch, and an access token. The token authenticates pushes for every provider, and pull-request creation on GitHub / GitLab / GitCode (generic Git is push-only) — publishing workflows need it even for public repos. Tokens are encrypted and never displayed again.
3. **Add a provider key if a task needs one** (Project → Settings → Resources): each provider groups its key and model grants in one place — e.g. an Aliyun Bailian/DashScope key for Qwen models. Adding a key **also grants that provider's built-in models automatically**.
4. **Need a custom provider?** (Admin → Models & Providers): an org admin registers a custom provider (DeepSeek, a self-hosted gateway, …) with its Anthropic- or OpenAI-compatible endpoint and a host allowlist, then registers models under it. Projects then configure a key for it in Resources just like a builtin.
5. **Fine-tune grants only if needed** (Project → Settings → Resources): built-ins are already on; toggle off anything you don't want. The submit summary shows a **readiness checklist** (models, key, skills, repo) before you submit — each failing item links straight to the settings tab to fix.
6. **Set a quota** (Project → Settings → Quota), optionally: a monthly token ceiling, with **hard stop** on to reject new submissions and abort in-flight runs once it is reached, or off to leave it advisory.
7. **Invite teammates** (Project → Settings → Members) by email — they must have signed up first. Roles: admin / member / viewer.
8. **Submit your first task** from the Catalog tab — try *Status Report* against your connected repo.
