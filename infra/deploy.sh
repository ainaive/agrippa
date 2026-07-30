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
# ROLLBACK DOES NOT REVERT THE DATABASE. The API applies migrations on boot
# before it serves (apps/api/src/index.ts), and this repo has irreversible ones
# (0011_drop_money). A failed deploy can therefore leave older code against a
# newer schema. The pre-deploy dump below is what makes that recoverable; on
# rollback the exact restore command is printed rather than pretended away.
#
# Usage:
#   deploy.sh [<commit-ish>]     # default: the deploy ref on $DEPLOY_REMOTE
#
# The commit must be reachable from $DEPLOY_REMOTE/$DEPLOY_REF. That is the
# privilege boundary: this script runs as root on the CI user's behalf (see
# infra/janus/), so an unconstrained argument would let its caller deploy any
# branch — including a compose file that mounts the host — and root-owning the
# tree would buy nothing.
#
# EDITS TO THIS FILE TAKE EFFECT ONE DEPLOY LATER. The script is launched from
# the tree as it stood at the PREVIOUS deploy, and only then resets that tree to
# the new commit. Bash keeps executing the file it opened — git swaps in a new
# inode, so the running process is unaffected (infra/deploy.test.ts covers that)
# — which means a deploy that ships a change to this script still runs the old
# version of it. Verify a change against the deploy AFTER the one that ships it,
# or run the new script by hand. Getting this wrong looks like the fix silently
# not working.
#
# Overridable via environment:
#   APP_DIR (/opt/agrippa)  DEPLOY_REMOTE (gitcode)  DEPLOY_REF (deploy)
#   HEALTH_TIMEOUT (180)    LOCK_WAIT (1800)         STATE_DIR (/var/lib/agrippa-deploy)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/agrippa}"
DEPLOY_REMOTE="${DEPLOY_REMOTE:-gitcode}"
DEPLOY_REF="${DEPLOY_REF:-deploy}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
LOCK_WAIT="${LOCK_WAIT:-1800}"
LOCK_FILE="${LOCK_FILE:-/var/lock/agrippa-deploy.lock}"
STATE_DIR="${STATE_DIR:-/var/lib/agrippa-deploy}"
KEEP_DUMPS="${KEEP_DUMPS:-5}"

COMPOSE_FILE="$APP_DIR/infra/docker-compose.yml"
ENV_FILE="$APP_DIR/infra/env/.env"
LAST_GOOD="$STATE_DIR/last-good"

log() { printf '\n==> %s\n' "$*"; }
die() {
  echo "deploy failed: $*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "run as root: sudo $0"
[ -f "$COMPOSE_FILE" ] || die "no compose file at $COMPOSE_FILE"
[ -f "$ENV_FILE" ] || die "no env file at $ENV_FILE"

# Name the project explicitly rather than letting compose resolve it from the
# file's `name:`. The restore procedure printed on failure is copy-pasted by an
# operator into a shell that may not share this one's environment, and without
# -p it resolves against whatever `name:` the tree happens to carry — which is
# the WRONG STACK if this deploy was run with COMPOSE_PROJECT_NAME set. Found by
# running the restore drill against a throwaway stack: the printed commands
# would have dropped the production database.
#
# Deliberately below die() and the -f guard above, not beside the other
# assignments. It was above both, which made those guards dead code: a missing
# compose file killed the script on awk's own error under `set -e`, and a
# compose file with no `name:` reached a `die` that did not exist yet — exit
# 127, `die: command not found`, no explanation.
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-$(awk '/^name:/{print $2; exit}' "$COMPOSE_FILE")}"
[ -n "$COMPOSE_PROJECT" ] || die "no 'name:' in $COMPOSE_FILE and COMPOSE_PROJECT_NAME is unset"

# The dumps below are a full copy of production, and this host also runs Janus
# as an unprivileged `janus` user that the deploy design treats as untrusted.
# An inherited 022 umask would write them 0644 in a 0755 directory — readable by
# exactly the account the root-owned tree exists to keep out.
umask 077
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

compose() { docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# Only one deploy at a time. Janus's `concurrency:` already serializes webhook
# runs, but a manual invocation bypasses Janus entirely — and two concurrent
# builds racing on the same image tags corrupt each other's rollback target.
exec 9>"$LOCK_FILE"
flock -w "$LOCK_WAIT" 9 || die "another deploy holds $LOCK_FILE (waited ${LOCK_WAIT}s)"

cd "$APP_DIR"

# ── resolve the target commit, and prove it belongs to the deploy branch ─────
log "fetch ${DEPLOY_REMOTE}/${DEPLOY_REF}"
git remote get-url "$DEPLOY_REMOTE" >/dev/null 2>&1 ||
  die "remote '$DEPLOY_REMOTE' is not configured in $APP_DIR (see docs/design/08-deployment.md)"
# Only the deploy ref: fetching every branch would make every branch deployable.
fetched=0
for attempt in 1 2 3; do
  if git fetch --prune "$DEPLOY_REMOTE" \
    "+refs/heads/${DEPLOY_REF}:refs/remotes/${DEPLOY_REMOTE}/${DEPLOY_REF}"; then
    fetched=1
    break
  fi
  echo "fetch attempt $attempt failed; retrying" >&2
  sleep $((attempt * 5))
done
[ "$fetched" -eq 1 ] || die "could not fetch ${DEPLOY_REF} from $DEPLOY_REMOTE"

target="${1:-${DEPLOY_REMOTE}/${DEPLOY_REF}}"
sha="$(git rev-parse --verify "${target}^{commit}" 2>/dev/null)" ||
  die "cannot resolve '$target' — is it on ${DEPLOY_REMOTE}/${DEPLOY_REF}?"

# An explicit SHA is how the pipeline pins the triggering commit, so it stays
# supported — but it is verified, not trusted. Anything not reachable from the
# deploy branch is refused, which is what keeps the sudoers rule meaningful.
git merge-base --is-ancestor "$sha" "${DEPLOY_REMOTE}/${DEPLOY_REF}" ||
  die "refusing '$target' (${sha:0:7}): not reachable from ${DEPLOY_REMOTE}/${DEPLOY_REF}"

short_sha="${sha:0:7}"

# ── record what to go back to, BEFORE changing anything ─────────────────────
# The state file holds the last commit that actually passed verification. Fall
# back to the running image tag when it is absent (the first SHA-tagged deploy).
if [ -s "$LAST_GOOD" ]; then
  previous_sha="$(cat "$LAST_GOOD")"
  previous="$previous_sha"
else
  # No state file yet (first deploy under this script). The image tag is the
  # rollback target, but HEAD *is* the configuration currently deployed — record
  # it too, so a first-deploy failure restores config instead of leaving the
  # failed commit's compose file in place.
  previous="$(docker inspect --format '{{.Config.Image}}' agrippa-api-1 2>/dev/null | sed 's/.*://')" || previous=""
  [ -n "$previous" ] || previous="latest"
  previous_sha="$(git rev-parse --verify HEAD 2>/dev/null || true)"
fi
log "deploying $short_sha (rollback target: ${previous:0:12})"

# ── database dump, before the new API can migrate ───────────────────────────
# Rollback restores code and config; it cannot undo a migration. This is what
# makes a bad deploy across a destructive migration recoverable at all.
dump=""
if [ "$(compose ps --status running --services 2>/dev/null | grep -cx postgres)" -eq 1 ]; then
  dump="$STATE_DIR/pgdump-$(date +%Y%m%d-%H%M%S)-${short_sha}.dump"
  log "database dump → $dump"
  if compose exec -T postgres pg_dump -U agrippa -Fc agrippa > "$dump" 2>/dev/null; then
    # keep the most recent few; each is small but they accumulate per deploy
    ls -1t "$STATE_DIR"/pgdump-*.dump 2>/dev/null | tail -n +$((KEEP_DUMPS + 1)) | xargs -r rm -f
  else
    rm -f "$dump"
    die "pre-deploy database dump failed — refusing to deploy without a recovery point"
  fi
else
  # nothing is running yet (first deploy) — there is no data to lose
  log "database dump skipped (postgres not running)"
fi

# Printed on EVERY failure path, not just the recoverable one. The case that
# most needs it is the one where the rolled-back stack is *also* unhealthy —
# typically because an irreversible migration already ran — and that is exactly
# where the old code fell through without saying anything.
#
# The procedure stops the application first: pg_restore --clean drops objects
# the running api and worker still hold connections to.
restore_hint() {
  [ -n "$dump" ] || return 0
  cat >&2 <<HINT

The database was NOT rolled back. If $short_sha applied a migration, restore it:

  DUMP=$dump
  C="docker compose -p $COMPOSE_PROJECT -f $COMPOSE_FILE --env-file $ENV_FILE"

  \$C stop api worker                       # dropdb needs zero connections
  \$C exec -T postgres dropdb -U agrippa --if-exists agrippa
  \$C exec -T postgres createdb -U agrippa agrippa
  \$C exec -T postgres pg_restore -U agrippa -d agrippa \\
      --exit-on-error --single-transaction < "\$DUMP"
  \$C start api worker                      # only once the restore succeeded

Drop and recreate rather than pg_restore --clean: --clean only drops what the
archive contains, so tables the failed migration ADDED would survive and can
block the restore through dependencies. --single-transaction with
--exit-on-error means a partial restore rolls back instead of leaving a
half-populated database.
HINT
}

rollback() {
  local reason="$1"
  echo "$reason; rolling back to $previous" >&2
  compose logs --tail 40 api worker >&2 2>/dev/null || true

  # Restore the previous COMMIT, not just the image tag: compose config, .env
  # defaults and Dockerfiles all come from the tree, so re-upping old images
  # against the failed commit's config would be a mismatched state.
  if [ -n "$previous_sha" ]; then
    # Fatal, not a warning: continuing would start the previous images against
    # the FAILED commit's compose file — the exact config/image mismatch this
    # restore exists to prevent. Better to stop with the tree visibly wrong
    # than to bring the stack up in a state nobody can reason about.
    git reset --hard -q "$previous_sha" || {
      restore_hint
      die "ROLLBACK ABORTED — could not restore the tree to ${previous_sha:0:12}; \
the stack was NOT restarted and is still on ${short_sha}'s config. Fix the working \
tree in $APP_DIR, then re-run this script."
    }
  else
    echo "WARNING: no recorded last-good commit; config stays at $short_sha" >&2
  fi

  export AGRIPPA_VERSION="$previous"
  compose up -d || {
    restore_hint
    die "ROLLBACK FAILED — instance is down; '${previous:0:12}' did not start"
  }
  # Said on both outcomes: the operator cannot tell from here whether a
  # migration ran, and silence would read as "the database is fine".
  restore_hint
  if stack_ok; then
    die "rolled back to ${previous:0:12} after a failed deploy of $short_sha"
  fi
  die "ROLLBACK UNHEALTHY — instance is down; '${previous:0:12}' also fails verification"
}

# ── verification: both services, using the stack's own signals ──────────────
# Not a host-port probe: AGRIPPA_PORT may bind a specific non-loopback
# interface, where curling 127.0.0.1 fails on a perfectly good deploy.
api_ok() {
  # the api service defines a healthcheck in compose, so this is authoritative
  [ "$(compose ps --format '{{.Health}}' api 2>/dev/null | head -n1)" = "healthy" ]
}

# The worker has no HTTP surface and no healthcheck, so verify THREE things:
# every expected replica running, RestartCount steady, and a fresh registration.
# All three are load-bearing; none is instrumentation.
#
# A fresh executor_registrations row alone is NOT enough: the worker registers
# (apps/worker/src/index.ts) before it starts its pg-boss consumers, so it can
# register and then die during consumer setup and still look deployed. And
# registrations are global per executor, so with WORKER_REPLICAS > 1 one healthy
# replica would mask the rest — hence the replica count.
#
# The replica count is not enough either, now that compose sets
# `restart: unless-stopped` so the stack survives a host reboot: a crash-looping
# worker reads as running between restarts, and it has already registered before
# it dies. That is what the RestartCount comparison below is for. Deleting it
# restores the masking exactly — infra/deploy.test.ts covers that, but this
# comment is what a reader trusts first.
#
# Residual gap, accepted: a worker that stays up but wedges *after* registering
# is not detected. Closing that needs a readiness signal written after
# boss.work() returns, which is an apps/worker change.
# Summed RestartCount across the worker containers. Empty/again-unavailable
# reads return 0 rather than failing: this is a tie-breaker on top of the two
# checks below, and a docker hiccup should not by itself fail a deploy.
worker_restarts() {
  local ids
  ids="$(compose ps -q worker 2>/dev/null || true)"
  [ -n "$ids" ] || { printf '0'; return 0; }
  # word-splitting is intended — docker inspect takes many ids
  # shellcheck disable=SC2086
  docker inspect -f '{{.RestartCount}}' $ids 2>/dev/null |
    awk '{s += $1} END {print s + 0}'
}

worker_ok() {
  local since="$1" n running expected
  # Take digits only: the env file may carry an inline comment or CRLF endings,
  # and a non-numeric value would make the comparison below error out on every
  # attempt rather than compare anything.
  expected="$(sed -nE 's/^WORKER_REPLICAS=[[:space:]]*([0-9]+).*/\1/p' "$ENV_FILE" | tail -n1)"
  expected="${expected:-1}"
  running="$(compose ps --status running --format '{{.Service}}' 2>/dev/null | grep -cx worker || true)"
  [ "$running" -eq "$expected" ] 2>/dev/null || return 1
  # Bounded: a wedged Postgres would otherwise block here indefinitely, and the
  # caller's HEALTH_TIMEOUT loop cannot fire while this command hangs.
  # Bounded by whatever is left of HEALTH_TIMEOUT, so a wedged Postgres cannot
  # push the total past the stated budget. statement_timeout goes through
  # PGOPTIONS, not an inline `set`: a `set` statement prints "SET" to stdout,
  # which would corrupt the count this reads.
  # Compose now sets `restart: unless-stopped` so the stack returns after a host
  # reboot. That breaks the assumption above on its own: a crash-looping worker
  # is "running" between restarts, and it registers its executors BEFORE it can
  # die during consumer setup, so it would satisfy both the replica count and
  # the fresh-registration check and report a failed deploy as successful.
  # RestartCount moving during verification is what distinguishes looping from
  # up. Baseline is taken once per stack_ok() call, after `up -d` recreated the
  # containers, so it starts from whatever the fresh containers report.
  local restarts
  restarts="$(worker_restarts)"
  [ "$restarts" = "${worker_restart_baseline:-$restarts}" ] || return 1

  local budget="${probe_budget:-10}"
  [ "$budget" -gt 1 ] 2>/dev/null || budget=1
  [ "$budget" -le 10 ] || budget=10
  # Spelled out rather than via compose(): `timeout` needs a real command. Keep
  # -p in step with compose() — this was the one invocation without it, and it
  # would query a different project than `up -d` acted on whenever the deployed
  # commit's `name:` differs from the tree's at script start.
  n="$(timeout "$budget" \
    docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
    exec -T -e PGCONNECT_TIMEOUT=2 -e PGOPTIONS="-c statement_timeout=${budget}s" \
    postgres psql -U agrippa -d agrippa -tAc \
    "select count(*) from executor_registrations where registered_at > to_timestamp($since);" \
    2>/dev/null | tr -d '[:space:]')"
  [ -n "$n" ] && [ "$n" -gt 0 ] 2>/dev/null
}

# HEALTH_TIMEOUT is a wall-clock bound, so this tracks an absolute deadline
# rather than counting its own sleeps. Counting sleeps understates the real
# elapsed time badly: each iteration also pays for a `compose ps` and a psql
# round trip, so a nominal 180s could run for many minutes. `probe_budget`
# hands the remaining time to the database probe, which is otherwise the
# slowest step.
stack_ok() {
  local since=$(($(date +%s) - 5))
  # Captured after `up -d` recreated the containers, so a worker that starts
  # crash-looping during verification shows as a change rather than a level.
  worker_restart_baseline="$(worker_restarts)"

  local deadline=$(($(date +%s) + HEALTH_TIMEOUT))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    probe_budget=$((deadline - $(date +%s)))
    if api_ok && worker_ok "$since"; then
      return 0
    fi
    # capped by what is left, so the final iteration cannot sleep past the
    # deadline — a stated bound should be honoured exactly, not approximately
    remaining=$((deadline - $(date +%s)))
    [ "$remaining" -gt 0 ] || break
    sleep "$((remaining < 5 ? remaining : 5))"
  done
  probe_budget=5
  api_ok || echo "  api never became healthy" >&2
  worker_ok "$since" || echo "  worker never became ready" >&2
  return 1
}

# ── build ────────────────────────────────────────────────────────────────────
# Detach first. With HEAD on a local branch, `reset --hard` force-moves that
# branch on every deploy, so its name drifts from whatever it tracks — a host
# checked out on "main" ends up with "main" pointing at the deploy branch's tip
# and reported as ahead of a stale origin nobody fetches.
#
# The bigger reason is that detaching makes `git pull` here fail ("You are not
# currently on a branch") instead of quietly advancing the tree past the running
# images. Compose config, .env defaults and Dockerfiles are all read from this
# tree, so a tree ahead of the deployed commit means manual compose commands —
# including the restore procedure this script prints on rollback — run against a
# config that does not match what is running.
#
# With no argument it detaches at the current commit and leaves the working tree
# alone, so the reset below still does all the forcing. Detaching here also
# covers rollback(), which resets too and only ever runs after this point.
git checkout -q --detach
# Always build: the cache makes a docs-only deploy cheap, and change-detection
# that guesses wrong fails silently by running stale code.
git reset --hard -q "$sha"
git --no-pager log -1 --format='    %h %s' | cat

# Tag with the FULL sha, not the 7-char prefix: a prefix collision would
# overwrite an existing tag, and if that tag were the rollback target the
# rollback would silently restore the wrong image. Log messages stay short.
export AGRIPPA_VERSION="$sha"
log "build ($AGRIPPA_VERSION)"
# Prove the tag reached compose before spending minutes building — the .env
# file also defines AGRIPPA_VERSION, and shell precedence is the only reason
# ours wins.
compose config 2>/dev/null | grep -q "agrippa-api:${sha}" ||
  rollback "AGRIPPA_VERSION did not reach compose; images would be mistagged"
compose build || rollback "image build failed"

# ── start, verify, roll back on any failure ─────────────────────────────────
log "up -d"
# Not bare: under `set -e` a port collision or mount failure would exit here,
# leaving the new commit checked out and never rolling back.
compose up -d || rollback "docker compose up -d failed"

log "verifying api + worker (${HEALTH_TIMEOUT}s)"
stack_ok || rollback "health check failed"

# ── success ─────────────────────────────────────────────────────────────────
echo "$sha" > "$LAST_GOOD"
log "healthy — deployed $short_sha"

# Prune superseded images. Each pair is ~4 GB, so keeping every deploy fills
# the disk. The rollback target is retained; anything older is not.
log "prune"
for repo in agrippa-api agrippa-worker; do
  docker images --format '{{.Repository}}:{{.Tag}}' |
    grep "/${repo}:" |
    grep -vE ":(${sha}|${previous})$" |
    xargs -r docker rmi >/dev/null 2>&1 || true
done

log "deployed $short_sha"
