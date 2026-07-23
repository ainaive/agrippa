import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Db, decryptSecret, loadSecretKey, repoConnections, secrets } from "@agrippa/db";
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

async function sanitizeWorkspace(dir: string): Promise<void> {
  for (const entry of REPO_CONFIG_TO_STRIP) {
    await rm(path.join(dir, entry), { recursive: true, force: true });
  }
}

export async function git(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
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
  }

  async diff(runId: string): Promise<string> {
    const dir = this.dirFor(runId);
    try {
      // intent-to-add so new files show up in the diff
      await git(["add", "-A", "-N"], dir);
      let hasBase = true;
      try {
        await git(["rev-parse", "--verify", "--quiet", BASE_REF], dir);
      } catch {
        hasBase = false; // workspace from before the base ref existed
      }
      if (!hasBase) return await git(["diff"], dir);
      // diff against the clone base: committed + staged + worktree changes.
      // The sanitization deletions (.claude/.mcp.json/.agrippa are stripped
      // right after clone) must not pollute every patch, hence the excludes.
      return await git(
        ["diff", BASE_REF, "--", ".", ...REPO_CONFIG_TO_STRIP.map((p) => `:(exclude)${p}`)],
        dir,
      );
    } catch (err) {
      // an empty required patch fails the producing step upstream — surface
      // why the diff itself broke instead of silently reporting "no changes"
      console.warn(`[worker] workspace diff failed for run ${runId}: ${String(err)}`);
      return "";
    }
  }

  async cleanup(runId: string): Promise<void> {
    if (process.env.AGRIPPA_KEEP_WORKSPACES === "1") return;
    await rm(this.dirFor(runId), { recursive: true, force: true });
  }
}
