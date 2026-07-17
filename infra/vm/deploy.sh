#!/usr/bin/env bash
# Agrippa VM deploy/update — pull, build, restart. install.sh runs this for the
# first deploy too, so install and update share one code path.
#
# Ordering matters: the API restarts first and must pass /healthz (it migrates
# and seeds the database on boot) before the worker restarts — schema changes
# always land before code that expects them.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/agrippa}"
ENV_FILE="${ENV_FILE:-/etc/agrippa/agrippa.env}"
BUN="${BUN:-/usr/local/bin/bun}"

[ "$(id -u)" -eq 0 ] || {
  echo "run as root: sudo $0" >&2
  exit 1
}

port_from_env="$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2 || true)"
PORT="${PORT:-${port_from_env:-3000}}"

cd "$APP_DIR"

echo "==> git pull (--ff-only: refuses if the tree has diverged)"
git pull --ff-only

echo "==> bun install (frozen lockfile)"
# NODE_ENV must NOT be production here — the SPA build needs devDependencies
# (vite). The systemd units set NODE_ENV=production for the runtime instead.
"$BUN" install --frozen-lockfile

echo "==> build SPA (apps/web/dist)"
"$BUN" run build

echo "==> refresh systemd units"
install -m 0644 infra/vm/agrippa-api.service infra/vm/agrippa-worker.service /etc/systemd/system/
systemctl daemon-reload

echo "==> restart API (migrates + seeds on boot)"
systemctl restart agrippa-api

echo "==> wait for /healthz on :${PORT}"
healthy=0
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null; then
    healthy=1
    break
  fi
  sleep 2
done
if [ "$healthy" -ne 1 ]; then
  echo "API failed to become healthy within 120s; recent logs:" >&2
  journalctl -u agrippa-api -n 50 --no-pager >&2
  exit 1
fi

echo "==> restart worker"
systemctl restart agrippa-worker

echo "deployed $(git rev-parse --short HEAD)"
