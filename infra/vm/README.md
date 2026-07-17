# infra/vm — deploy Agrippa on a VM without Docker

Ubuntu 22.04/24.04 LTS, everything on one box (Bun, Postgres 17, optional
Redis, api + worker under systemd, the API serving the built SPA).

```sh
sudo git clone https://github.com/ainaive/agrippa /opt/agrippa
sudo /opt/agrippa/infra/vm/install.sh        # idempotent bootstrap + first deploy
sudo /opt/agrippa/infra/vm/deploy.sh         # later updates: pull → build → restart
```

| File | Purpose |
| --- | --- |
| `install.sh` | Idempotent bootstrap: packages, Postgres 17 (PGDG), Redis 7 (`--skip-redis` to omit), Bun, `agrippa` user, `/etc/agrippa/agrippa.env` with generated secrets, systemd units |
| `deploy.sh` | Update: `git pull --ff-only` → `bun install` → build SPA → restart api (migrates on boot, gated on `/healthz`) → restart worker |
| `agrippa-api.service` / `agrippa-worker.service` | systemd units (the worker's lighter hardening is deliberate — bubblewrap needs namespaces) |
| `env.example` | Template rendered to `/etc/agrippa/agrippa.env` on first install |
| `nginx.conf.example` | Reverse-proxy example — SSE route needs `proxy_buffering off` |

Full guide: [docs/manual/en/06-operations.md](../../docs/manual/en/06-operations.md) ·
design: [docs/design/08-deployment.md](../../docs/design/08-deployment.md)
