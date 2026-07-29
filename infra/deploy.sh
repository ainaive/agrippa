#!/usr/bin/env bash
# Agrippa Docker deploy/update — fetch, build, restart, verify, roll back.
#
# The VM topology has infra/vm/deploy.sh; this is its Compose counterpart, and
# it exists because "git pull && docker compose up -d" is WRONG here. The SPA
# and the API are baked into the api image at build time, so a pull-then-up
# restarts the OLD code and reports success. This script always builds.
#
# Images are tagged with the deployed commit rather than :latest, which is what
# makes rollback possible at all — a plain `build` overwrites :latest and leaves
# the previous image dangling and unnameable.
#
# Usage:
#   deploy.sh [<commit-ish>]     # default: the deploy ref on $DEPLOY_REMOTE
#
# Overridable via environment:
#   APP_DIR (/opt/agrippa)  DEPLOY_REMOTE (gitcode)  DEPLOY_REF (deploy)
#   HEALTH_TIMEOUT (120)    LOCK_WAIT (1800)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/agrippa}"
DEPLOY_REMOTE="${DEPLOY_REMOTE:-gitcode}"
DEPLOY_REF="${DEPLOY_REF:-deploy}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
LOCK_WAIT="${LOCK_WAIT:-1800}"
LOCK_FILE="${LOCK_FILE:-/var/lock/agrippa-deploy.lock}"

COMPOSE_FILE="$APP_DIR/infra/docker-compose.yml"
ENV_FILE="$APP_DIR/infra/env/.env"

log() { printf '\n==> %s\n' "$*"; }
die() {
  echo "deploy failed: $*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "run as root: sudo $0"
[ -f "$COMPOSE_FILE" ] || die "no compose file at $COMPOSE_FILE"
[ -f "$ENV_FILE" ] || die "no env file at $ENV_FILE"

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# Only one deploy at a time. Janus's `concurrency:` already serializes webhook
# runs, but a manual invocation bypasses Janus entirely — and two concurrent
# builds racing on the same image tags corrupt each other's rollback target.
exec 9>"$LOCK_FILE"
flock -w "$LOCK_WAIT" 9 || die "another deploy holds $LOCK_FILE (waited ${LOCK_WAIT}s)"

cd "$APP_DIR"

# ── resolve the target commit ────────────────────────────────────────────────
# An explicit SHA (what the webhook pipeline passes) makes the deploy
# deterministic: we deploy what triggered the run, not whatever the branch tip
# has drifted to since.
log "fetch $DEPLOY_REMOTE"
git remote get-url "$DEPLOY_REMOTE" >/dev/null 2>&1 ||
  die "remote '$DEPLOY_REMOTE' is not configured in $APP_DIR (see docs/design/08-deployment.md)"
fetched=0
for attempt in 1 2 3; do
  if git fetch --prune "$DEPLOY_REMOTE" "+refs/heads/*:refs/remotes/${DEPLOY_REMOTE}/*"; then
    fetched=1
    break
  fi
  echo "fetch attempt $attempt failed; retrying" >&2
  sleep $((attempt * 5))
done
[ "$fetched" -eq 1 ] || die "could not fetch from $DEPLOY_REMOTE"

target="${1:-${DEPLOY_REMOTE}/${DEPLOY_REF}}"
sha="$(git rev-parse --verify "${target}^{commit}" 2>/dev/null)" ||
  die "cannot resolve '$target' — is the commit on $DEPLOY_REMOTE?"
short_sha="${sha:0:7}"

# ── record the rollback target BEFORE changing anything ──────────────────────
# The tag the api container is actually running is the authoritative answer to
# "what do we go back to", more trustworthy than a state file we might have
# failed to write last time.
previous="$(docker inspect --format '{{.Config.Image}}' agrippa-api-1 2>/dev/null | sed 's/.*://')" || previous=""
[ -n "$previous" ] || previous="latest"
log "deploying $short_sha (rollback target: $previous)"

git reset --hard "$sha" --quiet
git --no-pager log -1 --format='    %h %s' | cat

# ── build ────────────────────────────────────────────────────────────────────
# Always build: the cache makes a docs-only deploy cheap, and change-detection
# that guesses wrong fails silently by running stale code.
export AGRIPPA_VERSION="$short_sha"
log "build ($AGRIPPA_VERSION)"
# Prove the tag actually reached compose before spending minutes on a build —
# the .env file also defines AGRIPPA_VERSION, and shell precedence is the only
# reason ours wins.
compose config 2>/dev/null | grep -q "agrippa-api:${short_sha}" ||
  die "AGRIPPA_VERSION did not reach compose; images would be mistagged"
compose build

health_ok() {
  local port
  # AGRIPPA_PORT may carry an interface (127.0.0.1:3001) — take the last field
  port="$(grep -E '^AGRIPPA_PORT=' "$ENV_FILE" | tail -n1 | sed 's/.*[:=]//')"
  port="${port:-3000}"
  local waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    if curl -sf --max-time 3 "http://127.0.0.1:${port}/healthz" >/dev/null; then
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

# ── start, verify, roll back on failure ──────────────────────────────────────
log "up -d"
compose up -d

log "waiting for /healthz (${HEALTH_TIMEOUT}s)"
if health_ok; then
  log "healthy — deployed $short_sha"
else
  echo "health check failed; rolling back to $previous" >&2
  compose logs --tail 40 api >&2 || true
  export AGRIPPA_VERSION="$previous"
  compose up -d ||
    die "ROLLBACK FAILED — instance is down, previous tag '$previous' did not start"
  if health_ok; then
    die "rolled back to $previous after a failed deploy of $short_sha"
  fi
  die "ROLLBACK UNHEALTHY — instance is down; previous tag '$previous' also fails /healthz"
fi

# ── prune superseded images ──────────────────────────────────────────────────
# Each pair is ~4 GB, so keeping every deploy fills the disk. The rollback
# target is retained; anything older is not (rollback is one step by design).
log "prune"
for repo in agrippa-api agrippa-worker; do
  docker images --format '{{.Repository}}:{{.Tag}}' |
    grep "/${repo}:" |
    grep -vE ":(${short_sha}|${previous}|latest)$" |
    xargs -r docker rmi >/dev/null 2>&1 || true
done

log "deployed $short_sha ($(git rev-parse --short HEAD))"
