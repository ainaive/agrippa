import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Db, decryptSecret, loadSecretKey, repoConnections, secrets } from "@agrippa/db";
import { buildScrubbedEnv } from "@agrippa/executor-core";
import type { WorkspaceManager, WorkspaceSpec } from "@agrippa/orchestration";
import { and, eq } from "drizzle-orm";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? path.join(tmpdir(), "agrippa-workspaces");

/**
 * Repo-supplied paths removed before any agent runs (a checked-out repo is
 * untrusted): `.claude`/`.mcp.json` would be honored by the SDK project setting
 * source (hooks run shell, settings grant permissions, .mcp.json wires servers);
 * `.agrippa` is the platform's own artifact convention dir — a committed
 * `.agrippa -> /work` symlink would otherwise let workspace-relative artifact
 * paths escape to the shared store. Registry skills and the artifact dir are
 * re-created fresh afterwards (docs/design/03 §Sandboxing).
 */
const REPO_CONFIG_TO_STRIP = [".claude", ".mcp.json", ".agrippa"];

/** Records the clone-time HEAD; diff() reports everything since it. */
const BASE_REF = "refs/agrippa/base";

/**
 * Make the sanitized paths invisible to git in BOTH directions, so the patch
 * evidence and the pushed PR agree that these paths never change:
 *
 * - tracked entries get `--skip-worktree`, so removing them from disk is not a
 *   deletion `git add -A`/`commit -a`/`diff` can see or ship (and `git reset
 *   --hard` won't casually restore repo-supplied `.claude` either);
 * - `.git/info/exclude` covers the UNTRACKED side — the platform itself writes
 *   there (materialized skills → `.claude/skills/`, artifacts →
 *   `.agrippa/artifacts/`), and none of that may leak into diffs or the
 *   platform's finalizing commit.
 *
 * Hooks are removed too: platform git never runs them (core.hooksPath is
 * neutralized on every call), so the clone samples are just clutter an agent
 * could replace.
 */
async function sanitizeWorkspace(dir: string): Promise<void> {
  const tracked = await git(["ls-files", "-z", "--", ...REPO_CONFIG_TO_STRIP], dir);
  const files = tracked.split("\0").filter((f) => f.length > 0);
  if (files.length > 0) {
    await git(["update-index", "--skip-worktree", "--", ...files], dir);
  }
  await appendFile(
    path.join(dir, ".git", "info", "exclude"),
    `\n# agrippa: sanitized paths never enter evidence or commits\n${REPO_CONFIG_TO_STRIP.map(
      (p) => `/${p}`,
    ).join("\n")}\n`,
  );
  for (const entry of REPO_CONFIG_TO_STRIP) {
    await rm(path.join(dir, entry), { recursive: true, force: true });
  }
  await rm(path.join(dir, ".git", "hooks"), { recursive: true, force: true });
}

/**
 * Platform git runs inside a directory an agent had write access to, so it
 * must trust nothing there that can execute code or leak secrets:
 *
 * - the child env is the executor allow-list scrub (PATH/HOME/locale/TLS only)
 *   — never the worker's process.env with DATABASE_URL, AGRIPPA_SECRET_KEY,
 *   and provider keys in it;
 * - global/system gitconfig never load (a host credential.helper or hooksPath
 *   must not apply either);
 * - repo-local hooks and fsmonitor are neutralized on EVERY invocation —
 *   an agent-installed pre-commit/pre-push hook must never run as platform.
 *
 * Repo-local .git/config itself is handled by restorePlatformConfig (the
 * agent can rewrite it; filters/textconv/insteadOf all live there).
 */
export async function git(
  args: string[],
  cwd?: string,
  env: Record<string, string> = {},
): Promise<string> {
  const proc = Bun.spawn(
    ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...buildScrubbedEnv(),
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        ...env,
      },
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr.slice(0, 2000)}`);
  return stdout;
}

/** The run's checkout directory (shared with GitScmService). */
export function workspaceDirFor(runId: string): string {
  return path.join(WORKSPACE_ROOT, runId);
}

/**
 * Platform-owned sidecar for a run — a SIBLING of the workspace dir, so the
 * agent's write containment (rooted at the workspace) can't reach it. Holds
 * the known-good .git/config snapshot and the clone-base SHA; both are
 * evidence anchors an agent must not be able to move. (A shell command under
 * a degraded OS sandbox could still reach it — that residual risk is the
 * documented container-layer boundary, docs/design/03.)
 */
export function platformDirFor(runId: string): string {
  return path.join(WORKSPACE_ROOT, `${runId}.platform`);
}

/**
 * Overwrite the workspace .git/config with the snapshot taken at provision
 * time, discarding anything the agent added (filter.*.clean, diff.*.textconv,
 * url.*.insteadOf, credential.helper, core.hooksPath — every one of those is
 * a code-execution or credential-exfiltration vector when platform git runs).
 * Restore-not-verify: agents have no legitimate reason to edit config (the
 * platform pre-seeds identity), but killing the run over it would turn a
 * nuisance into a DoS; tampering is logged, not fatal. Returns false when no
 * snapshot exists (pre-sidecar workspace).
 */
export async function restorePlatformConfig(runId: string): Promise<boolean> {
  const snapshotPath = path.join(platformDirFor(runId), "git-config");
  let snapshot: Buffer;
  try {
    snapshot = await readFile(snapshotPath);
  } catch {
    return false;
  }
  const configPath = path.join(workspaceDirFor(runId), ".git", "config");
  const current = await readFile(configPath).catch(() => null);
  if (current === null || !current.equals(snapshot)) {
    console.warn(`[worker] run ${runId}: workspace .git/config was modified — restoring snapshot`);
    await writeFile(configPath, snapshot);
  }
  return true;
}

/** The clone-base SHA from the platform sidecar (null for pre-sidecar workspaces). */
export async function platformBaseSha(runId: string): Promise<string | null> {
  try {
    const sha = await readFile(path.join(platformDirFor(runId), "base-sha"), "utf8");
    return sha.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Load a repo connection scoped to the run's project (never by raw id — a
 * foreign repoConnectionId in params must not resolve) plus its decrypted
 * credential when one is stored.
 */
export async function loadRepoConnection(
  db: Db,
  projectId: string,
  repo: unknown,
): Promise<{ connection: typeof repoConnections.$inferSelect; token: string | null }> {
  const repoRef = repo as { repoConnectionId?: string } | null;
  if (!repoRef?.repoConnectionId) throw new Error("repoRef missing");
  const [connection] = await db
    .select()
    .from(repoConnections)
    .where(
      and(
        eq(repoConnections.id, repoRef.repoConnectionId),
        eq(repoConnections.projectId, projectId),
      ),
    );
  if (!connection) throw new Error("repo connection not found");
  let token: string | null = null;
  if (connection.credentialSecretRef) {
    const [secret] = await db
      .select()
      .from(secrets)
      .where(eq(secrets.id, connection.credentialSecretRef));
    if (secret) token = decryptSecret(secret.ciphertext, loadSecretKey());
  }
  return { connection, token };
}

/** The connection URL with the credential injected (for one git call, never persisted). */
export function credentialedUrl(url: string, token: string | null): string {
  if (!token) return url;
  const withAuth = new URL(url);
  withAuth.username = "x-access-token";
  withAuth.password = token;
  return withAuth.toString();
}

/**
 * Per-run throwaway checkouts under WORKSPACE_ROOT. Credentials are injected
 * into the clone URL for the single clone call and scrubbed from the remote
 * immediately after — they never persist in .git/config or the environment
 * (docs/design/03 §Sandboxing).
 */
export class GitWorkspaceManager implements WorkspaceManager {
  constructor(private readonly db: Db) {}

  private dirFor(runId: string): string {
    return workspaceDirFor(runId);
  }

  async ensureDir(runId: string): Promise<string> {
    const dir = this.dirFor(runId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async checkout(runId: string, spec: WorkspaceSpec): Promise<void> {
    // scoped by project so a run can never clone another project's/tenant's
    // repo even if its params carry a foreign repoConnectionId
    const { connection, token } = await loadRepoConnection(this.db, spec.projectId, spec.repo);
    const cloneUrl = credentialedUrl(connection.url, token);

    const dir = this.dirFor(runId);
    const ref = spec.ref || connection.defaultBranch;
    await rm(dir, { recursive: true, force: true });
    await rm(platformDirFor(runId), { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await git(["clone", "--depth", "50", "--branch", ref, cloneUrl, dir]);
    // scrub the credential from the remote before any agent code runs
    await git(["remote", "set-url", "origin", connection.url], dir);
    await sanitizeWorkspace(dir);
    // pin the checkout base so diff() can include COMMITTED work — templates
    // instruct agents to commit, and a plain worktree diff would come back
    // empty for a cleanly committed change. A ref (not a marker file) is
    // gc-safe and gives a clean existence check.
    await git(["update-ref", BASE_REF, "HEAD"], dir);
    // pre-seed identity so agents never have a reason to touch .git/config
    // (their own commits would otherwise fail with "tell me who you are")
    await git(["config", "user.name", "Agrippa Agent"], dir);
    await git(["config", "user.email", "agent@agrippa.local"], dir);
    // snapshot the evidence anchors OUTSIDE the agent-writable tree: the
    // known-good config (restored before every platform git op) and the base
    // SHA (BASE_REF stays for older workspaces, but it lives in agent-writable
    // .git — the sidecar copy is the one diff/push trust)
    const platformDir = platformDirFor(runId);
    await mkdir(platformDir, { recursive: true });
    await writeFile(
      path.join(platformDir, "git-config"),
      await readFile(path.join(dir, ".git", "config")),
    );
    const baseSha = (await git(["rev-parse", "HEAD"], dir)).trim();
    await writeFile(path.join(platformDir, "base-sha"), `${baseSha}\n`);
  }

  async diff(runId: string): Promise<string> {
    const dir = this.dirFor(runId);
    try {
      await restorePlatformConfig(runId);
      // intent-to-add so new files show up in the diff
      await git(["add", "-A", "-N"], dir);
      // diff against the clone base: committed + staged + worktree changes.
      // No pathspec excludes needed — sanitizeWorkspace made the stripped
      // paths invisible to git itself (skip-worktree + info/exclude), which
      // keeps the evidence and any commit/push consistent by construction.
      const baseSha = await platformBaseSha(runId);
      if (baseSha) return await git(["diff", baseSha], dir);
      // older workspaces: the ref, then a plain worktree diff
      try {
        await git(["rev-parse", "--verify", "--quiet", BASE_REF], dir);
      } catch {
        return await git(["diff"], dir);
      }
      return await git(["diff", BASE_REF], dir);
    } catch (err) {
      // an empty required patch fails the producing step upstream — surface
      // why the diff itself broke instead of silently reporting "no changes"
      console.warn(`[worker] workspace diff failed for run ${runId}: ${String(err)}`);
      return "";
    }
  }

  async isIntact(runId: string): Promise<boolean> {
    // a resumed run whose checkout succeeded elsewhere must not proceed
    // against the bare mkdir ensureDir() leaves on a fresh host — the .git
    // dir is the cheapest reliable witness that the checkout is actually here
    return await Bun.file(path.join(this.dirFor(runId), ".git", "HEAD")).exists();
  }

  async cleanup(runId: string): Promise<void> {
    if (process.env.AGRIPPA_KEEP_WORKSPACES === "1") return;
    await rm(this.dirFor(runId), { recursive: true, force: true });
    await rm(platformDirFor(runId), { recursive: true, force: true });
  }
}
