#!/usr/bin/env bash
# Provision the OpenAI Codex CLI for a VM deployment. Idempotent: a matching
# version already on PATH is left alone, so both install.sh and deploy.sh can
# call this unconditionally.
#
# The codex-cli executor spawns a literal `codex` binary (ADR-0011) and no
# workspace dependency ships one, so `bun install` cannot supply it. Without
# this the executor never registers and swdev/requirement-delivery — whose
# reviewer slot pins `executor: codex-cli` — is un-submittable.
#
# Mirrors the block in infra/Dockerfile.worker. Keep the versions in step.
#
# Usage: sudo ./codex.sh
# Overridable via environment:
#   CODEX_VERSION (keep in step with the ARG default in infra/Dockerfile.worker)
#   NPM_REGISTRY  a URL, not a bare host (unlike APT_MIRROR) — a scheme is added
#                 if you omit one, e.g. https://registry.npmmirror.com from CN
#   PREFIX        install root (default /opt)
set -euo pipefail

CODEX_VERSION="${CODEX_VERSION:-0.145.0}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
PREFIX="${PREFIX:-/opt}"

# accept a bare host as well as a URL; the value goes straight into a curl URL,
# where a missing scheme makes curl guess
case "$NPM_REGISTRY" in
  *://*) ;;
  *) NPM_REGISTRY="https://${NPM_REGISTRY}" ;;
esac
NPM_REGISTRY="${NPM_REGISTRY%/}"

# Versioned directories behind a symlink:
#
#   $PREFIX/codex-<version>/                real tree, one per version
#   $PREFIX/codex          -> codex-<ver>   swapped with rename(2), atomically
#   /usr/local/bin/codex   -> $PREFIX/codex/vendor/<triple>/bin/codex
#
# The old tree is never moved or removed until the new one is fully in place and
# probed, so a failure anywhere leaves the running worker's `codex` working. And
# because /usr/local/bin/codex resolves *through* $PREFIX/codex, an upgrade does
# not rewrite it at all — there is no window where it dangles.
CODEX_LINK="$PREFIX/codex"
CODEX_DIR="$PREFIX/codex-${CODEX_VERSION}"

[ "$(id -u)" -eq 0 ] || {
  echo "run as root: sudo $0" >&2
  exit 1
}

# already at the pinned version — nothing to do
if codex --version 2>/dev/null | grep -qx "codex-cli ${CODEX_VERSION}"; then
  echo "==> codex ${CODEX_VERSION} already installed"
  exit 0
fi

case "$(dpkg --print-architecture)" in
  amd64) plat=linux-x64 ;;
  arm64) plat=linux-arm64 ;;
  *)
    echo "unsupported architecture for the codex CLI: $(dpkg --print-architecture)" >&2
    exit 1
    ;;
esac

echo "==> Codex CLI ${CODEX_VERSION} → ${CODEX_DIR}"

# Staged under $PREFIX rather than /tmp for two reasons: /tmp is world-writable,
# so a predictable name there lets another local user pre-create a symlink that
# root's curl would follow; and staging on the same filesystem makes the final
# swap a rename instead of a copy.
staging="$(mktemp -d "${PREFIX}/.agrippa-codex.XXXXXX")"
trap 'rm -rf "$staging"' EXIT

curl -fsSL --retry 5 --retry-all-errors --connect-timeout 20 \
  -o "$staging/codex.tgz" \
  "${NPM_REGISTRY}/@openai/codex/-/codex-${CODEX_VERSION}-${plat}.tgz"

mkdir -p "$staging/payload"
# npm tarballs nest their payload under package/; the vendor tree is kept whole
# because the binary finds codex-code-mode-host, codex-path/ and
# codex-resources/ relative to its own realpath
tar -xzf "$staging/codex.tgz" -C "$staging/payload" --strip-components=1
chmod -R a+rX "$staging/payload"

staged_bin="$(find "$staging/payload/vendor" -type f -name codex | head -n1)"
[ -n "$staged_bin" ] || {
  echo "no codex binary in the vendor tree" >&2
  exit 1
}

# Probe the STAGED binary before touching an existing install — these are the
# same two checks probeCodexCli() (packages/executor-codex/src/cli.ts) runs at
# worker boot, where failing them means the executor silently does not register.
# Validating first means a bad pin or a truncated download leaves the current
# installation working.
"$staged_bin" --version >/dev/null
"$staged_bin" exec --help | grep -q -- --ignore-user-config
"$staged_bin" exec --help | grep -q -- --ignore-rules

# Put the new tree in place under its own version, leaving any current one
# untouched. Only after this succeeds does anything live change.
rm -rf "$CODEX_DIR"
mv "$staging/payload" "$CODEX_DIR"

# One-time conversion from the earlier layout, where $PREFIX/codex was a real
# directory: mv -T refuses to replace a populated directory with a symlink.
if [ -d "$CODEX_LINK" ] && [ ! -L "$CODEX_LINK" ]; then
  rm -rf "${CODEX_LINK}.legacy"
  mv "$CODEX_LINK" "${CODEX_LINK}.legacy"
fi

# Atomic swap: build the link beside its target, then rename over the old one.
# A worker resolving the path concurrently sees either the old tree or the new
# one, never a missing path.
ln -sfn "codex-${CODEX_VERSION}" "${CODEX_LINK}.new"
mv -T "${CODEX_LINK}.new" "$CODEX_LINK"
rm -rf "${CODEX_LINK}.legacy"

# Version-independent, so upgrades never touch it. Written only when missing or
# pointing elsewhere, and even then via rename so it is never briefly absent.
codex_target="$(find -H "$CODEX_LINK/vendor" -type f -name codex | head -n1)"
[ -n "$codex_target" ] || {
  echo "no codex binary under $CODEX_LINK/vendor" >&2
  exit 1
}
if [ "$(readlink /usr/local/bin/codex || true)" != "$codex_target" ]; then
  ln -sfn "$codex_target" /usr/local/bin/codex.new
  mv -T /usr/local/bin/codex.new /usr/local/bin/codex
fi

# Prune superseded versions. Safe here: the swap already succeeded, and the
# rollback guarantee comes from the ordering above, not from retaining ~310 MB
# trees indefinitely.
for old in "$PREFIX"/codex-*; do
  [ "$old" = "$CODEX_DIR" ] || [ ! -d "$old" ] || rm -rf "$old"
done

echo "==> $(codex --version)"
