# Getting Started

## Deploy with Docker Compose (recommended)

Requirements: Docker with Compose, ~2 GB RAM.

```sh
git clone https://github.com/ainaive/agrippa && cd agrippa
cp infra/env/.env.example infra/env/.env
# edit infra/env/.env:
#   AGRIPPA_SECRET_KEY   ← openssl rand -base64 32   (back it up!)
#   BETTER_AUTH_SECRET   ← openssl rand -base64 32
#   ANTHROPIC_API_KEY    ← your key, or leave empty with AGRIPPA_EXECUTOR=fake
docker compose -f infra/docker-compose.yml --env-file infra/env/.env up -d
```

Open `http://localhost:3000`. The stack is four services: **api** (also serves the web app), **worker** (executes runs), **postgres**, **redis**. Migrations and builtin content (scenarios, task types, templates, models, skills) apply automatically on boot.

**Demo mode**: set `AGRIPPA_EXECUTOR=fake` and leave `ANTHROPIC_API_KEY` empty — every task type runs end to end with a token-free demo executor that produces placeholder artifacts. Ideal for evaluating the platform before spending tokens.

## Run from source (development)

See the [README quick start](../../../README.md#getting-started): Bun ≥ 1.3 + local Postgres, three processes (`api`, `worker`, `web`).

## First login

Sign up at the login screen — **the first account created becomes the organization admin** (later accounts are regular members). That's how a fresh install bootstraps its administrator, so create your admin account before sharing the URL.

## Initial setup checklist

1. **Create a project** — you'll be prompted on first login. Projects scope everything: members, resources, budgets, repositories.
2. **Connect a repository** (Project → Settings → Repositories): URL, default branch, and an access token for private repos. Tokens are encrypted and never displayed again.
3. **Grant resources** (Project → Settings → Resources): toggle on the **models** the project may use (at least one per tier you need) and any **skills**/**MCP servers** its task types require. Submission fails with a clear error if a required resource isn't granted.
4. **Set a quota** (Project → Settings → Quota), optionally: monthly cost/token limits with a hard stop.
5. **Invite teammates** (Project → Settings → Members) by email — they must have signed up first. Roles: admin / member / viewer.
6. **Submit your first task** from the Catalog tab — try *Status Report* against your connected repo.
