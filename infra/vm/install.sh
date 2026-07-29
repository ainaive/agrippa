#!/usr/bin/env bash
# Agrippa VM installer — idempotent bootstrap for Ubuntu 22.04/24.04 LTS.
#
# Installs Bun, PostgreSQL 17 (PGDG), Redis 7 (optional), the `agrippa` system
# user and data layout, an env file with generated secrets, and the systemd
# units — then hands off to deploy.sh for the first build + start.
#
# Safe to re-run: an existing env file (and with it the database password and
# AGRIPPA_SECRET_KEY) is NEVER regenerated — rotating AGRIPPA_SECRET_KEY would
# orphan every credential the platform has stored.
#
# Usage:
#   sudo ./install.sh [--skip-redis]     # --skip-redis: SSE falls back to DB polling
#
# Overridable via environment:
#   AGRIPPA_REPO_URL (https://github.com/ainaive/agrippa)  AGRIPPA_REF (main)
#   APP_DIR (/opt/agrippa)  DATA_DIR (/var/lib/agrippa)
#   ENV_FILE (/etc/agrippa/agrippa.env)
#   BUN_VERSION (keep in step with the oven/bun tag in infra/Dockerfile.*)
#   CODEX_VERSION (keep in step with the ARG default in infra/Dockerfile.worker)
#   NPM_REGISTRY (mirror for the Codex download, e.g. registry.npmmirror.com)
set -euo pipefail

AGRIPPA_REPO_URL="${AGRIPPA_REPO_URL:-https://github.com/ainaive/agrippa}"
AGRIPPA_REF="${AGRIPPA_REF:-main}"
APP_DIR="${APP_DIR:-/opt/agrippa}"
DATA_DIR="${DATA_DIR:-/var/lib/agrippa}"
ENV_FILE="${ENV_FILE:-/etc/agrippa/agrippa.env}"
BUN_VERSION="${BUN_VERSION:-1.3.14}"
CODEX_VERSION="${CODEX_VERSION:-0.145.0}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"

SKIP_REDIS=0
for arg in "$@"; do
  case "$arg" in
    --skip-redis) SKIP_REDIS=1 ;;
    *)
      echo "unknown argument: $arg (supported: --skip-redis)" >&2
      exit 2
      ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || {
  echo "run as root: sudo $0" >&2
  exit 1
}

# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}-${VERSION_ID:-}" in
  ubuntu-22.04 | ubuntu-24.04) ;;
  *) echo "warning: tested on Ubuntu 22.04/24.04; this is ${PRETTY_NAME:-unknown}" >&2 ;;
esac

log "OS packages (git/ripgrep/bubblewrap mirror infra/Dockerfile.worker; unzip is for the Bun installer)"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  git ripgrep bubblewrap ca-certificates curl unzip gnupg openssl postgresql-common

log "PostgreSQL 17 (PGDG repository)"
/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
apt-get install -y postgresql-17
systemctl enable --now postgresql

if [ "$SKIP_REDIS" -eq 0 ]; then
  log "Redis 7 (packages.redis.io — the 22.04 distro package is still 6.x)"
  if [ ! -f /etc/apt/sources.list.d/redis.list ]; then
    curl -fsSL https://packages.redis.io/gpg | gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg
    chmod 644 /usr/share/keyrings/redis-archive-keyring.gpg
    echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb ${VERSION_CODENAME} main" \
      >/etc/apt/sources.list.d/redis.list
    apt-get update
  fi
  apt-get install -y redis
  systemctl enable --now redis-server
else
  log "Skipping Redis (--skip-redis) — SSE will fall back to DB polling"
fi

log "Bun ${BUN_VERSION} → /usr/local/bin/bun"
if ! /usr/local/bin/bun --version 2>/dev/null | grep -qx "$BUN_VERSION"; then
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}"
fi

# The codex-cli executor spawns a literal `codex` binary, and no workspace
# dependency provides one — `bun install` cannot supply it. Without this the
# executor never registers and swdev/requirement-delivery, whose reviewer slot
# pins `executor: codex-cli`, is un-submittable on a VM install. Mirrors the
# block in infra/Dockerfile.worker; re-run this script to change versions, the
# same way BUN_VERSION lands.
log "Codex CLI ${CODEX_VERSION} → /opt/codex"
if ! codex --version 2>/dev/null | grep -qx "codex-cli ${CODEX_VERSION}"; then
  case "$(dpkg --print-architecture)" in
    amd64) codex_plat=linux-x64 ;;
    arm64) codex_plat=linux-arm64 ;;
    *)
      echo "unsupported architecture for the codex CLI: $(dpkg --print-architecture)" >&2
      exit 1
      ;;
  esac
  curl -fsSL --retry 5 --retry-all-errors --connect-timeout 20 -o /tmp/codex.tgz \
    "${NPM_REGISTRY}/@openai/codex/-/codex-${CODEX_VERSION}-${codex_plat}.tgz"
  rm -rf /opt/codex
  mkdir -p /opt/codex
  # npm tarballs nest their payload under package/; the vendor tree is kept
  # whole because the binary finds its siblings relative to its own realpath
  tar -xzf /tmp/codex.tgz -C /opt/codex --strip-components=1
  rm -f /tmp/codex.tgz
  chmod -R a+rX /opt/codex
  codex_bin="$(find /opt/codex/vendor -type f -name codex | head -n1)"
  [ -n "$codex_bin" ] || {
    echo "no codex binary in the vendor tree" >&2
    exit 1
  }
  ln -sf "$codex_bin" /usr/local/bin/codex
fi
# the same two checks probeCodexCli() runs at worker boot, where failing them
# means the executor silently does not register
codex --version >/dev/null
codex exec --help | grep -q -- --ignore-user-config
codex exec --help | grep -q -- --ignore-rules

log "System user + data directories"
getent passwd agrippa >/dev/null ||
  useradd --system --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin agrippa
install -d -o agrippa -g agrippa -m 750 "$DATA_DIR" "$DATA_DIR/runs" "$DATA_DIR/artifacts"

log "Repository at $APP_DIR (root-owned — services read it, agent code cannot modify it)"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone --branch "$AGRIPPA_REF" "$AGRIPPA_REPO_URL" "$APP_DIR"
fi

log "Database role + database"
DB_PASSWORD=""
if [ ! -f "$ENV_FILE" ]; then
  # First install only: the generated password lands in the env file below.
  # Re-runs with an existing env file must never rotate it.
  DB_PASSWORD="$(openssl rand -hex 24)"
  if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='agrippa'" | grep -q 1; then
    sudo -u postgres psql -qc "ALTER ROLE agrippa WITH LOGIN PASSWORD '${DB_PASSWORD}'"
  else
    sudo -u postgres psql -qc "CREATE ROLE agrippa WITH LOGIN PASSWORD '${DB_PASSWORD}'"
  fi
fi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='agrippa'" | grep -q 1 ||
  sudo -u postgres createdb -O agrippa agrippa

log "Environment file $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  install -d -o root -g agrippa -m 750 "$(dirname "$ENV_FILE")"
  SECRET_KEY="$(openssl rand -base64 32)"
  AUTH_SECRET="$(openssl rand -base64 32)"
  sed \
    -e "s|__DB_PASSWORD__|${DB_PASSWORD}|" \
    -e "s|__SECRET_KEY__|${SECRET_KEY}|" \
    -e "s|__AUTH_SECRET__|${AUTH_SECRET}|" \
    "$APP_DIR/infra/vm/env.example" >"$ENV_FILE"
  if [ "$SKIP_REDIS" -eq 1 ]; then
    # No Redis on this box — leave the URL unset so SSE falls back to DB
    # polling instead of ioredis retrying a dead server forever.
    sed -i 's|^REDIS_URL=|# REDIS_URL=|' "$ENV_FILE"
  fi
  chown root:agrippa "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  cat <<'BANNER'

  ┌───────────────────────────────────────────────────────────────┐
  │  BACK UP AGRIPPA_SECRET_KEY from the env file NOW.            │
  │  Losing it orphans every credential the platform has stored.  │
  └───────────────────────────────────────────────────────────────┘
BANNER
else
  echo "    exists — leaving secrets and database password untouched"
fi

log "systemd units"
install -m 0644 "$APP_DIR/infra/vm/agrippa-api.service" "$APP_DIR/infra/vm/agrippa-worker.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable agrippa-api agrippa-worker

log "First deploy (build + start — same path as future updates)"
"$APP_DIR/infra/vm/deploy.sh"

PORT="$(grep -E '^PORT=' "$ENV_FILE" | tail -n1 | cut -d= -f2 || true)"
cat <<SUMMARY

Agrippa is up on port ${PORT:-3000}.

Next steps:
  - Create the first org admin — self-registration is CLOSED, so nobody can get
    in until you run this (idempotent on the email; everyone else joins by
    invitation from Admin → Members):
      sudo -u agrippa env AGRIPPA_BOOTSTRAP_EMAIL=you@example.com \\
        AGRIPPA_BOOTSTRAP_PASSWORD=at-least-8-chars \\
        /usr/local/bin/bun --env-file=$ENV_FILE \\
        $APP_DIR/apps/api/src/cli/bootstrap-admin.ts
  - Real runs need ANTHROPIC_API_KEY in $ENV_FILE (or set AGRIPPA_EXECUTOR=fake
    for a token-free demo), then: systemctl restart agrippa-api agrippa-worker
  - Set AGRIPPA_BASE_URL once the instance has a public URL.
  - Reverse proxy + TLS are operator-owned; see infra/vm/nginx.conf.example
    (SSE needs proxy buffering OFF on /api/v1/runs/*/events).
  - Update later with: sudo $APP_DIR/infra/vm/deploy.sh
  - Logs: journalctl -u agrippa-api -f · journalctl -u agrippa-worker -f
SUMMARY
