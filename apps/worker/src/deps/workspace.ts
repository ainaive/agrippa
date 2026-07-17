import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Db, decryptSecret, loadSecretKey, repoConnections, secrets } from "@agrippa/db";
import type { WorkspaceManager, WorkspaceSpec } from "@agrippa/orchestration";
import { eq } from "drizzle-orm";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? path.join(tmpdir(), "agrippa-workspaces");

async function git(args: string[], cwd?: string): Promise<string> {
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

/**
 * Per-run throwaway checkouts under WORKSPACE_ROOT. Credentials are injected
 * into the clone URL for the single clone call and scrubbed from the remote
 * immediately after — they never persist in .git/config or the environment
 * (docs/design/03 §Sandboxing).
 */
export class GitWorkspaceManager implements WorkspaceManager {
  constructor(private readonly db: Db) {}

  private dirFor(runId: string): string {
    return path.join(WORKSPACE_ROOT, runId);
  }

  async ensureDir(runId: string): Promise<string> {
    const dir = this.dirFor(runId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async checkout(runId: string, spec: WorkspaceSpec): Promise<void> {
    const repoRef = spec.repo as { repoConnectionId?: string } | null;
    if (!repoRef?.repoConnectionId) throw new Error("workspace.checkout: repoRef missing");

    const [connection] = await this.db
      .select()
      .from(repoConnections)
      .where(eq(repoConnections.id, repoRef.repoConnectionId));
    if (!connection) throw new Error("workspace.checkout: repo connection not found");

    let cloneUrl = connection.url;
    if (connection.credentialSecretRef) {
      const [secret] = await this.db
        .select()
        .from(secrets)
        .where(eq(secrets.id, connection.credentialSecretRef));
      if (secret) {
        const token = decryptSecret(secret.ciphertext, loadSecretKey());
        const url = new URL(connection.url);
        url.username = "x-access-token";
        url.password = token;
        cloneUrl = url.toString();
      }
    }

    const dir = this.dirFor(runId);
    const ref = spec.ref || connection.defaultBranch;
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await git(["clone", "--depth", "50", "--branch", ref, cloneUrl, dir]);
    // scrub the credential from the remote before any agent code runs
    await git(["remote", "set-url", "origin", connection.url], dir);
  }

  async diff(runId: string): Promise<string> {
    const dir = this.dirFor(runId);
    try {
      // intent-to-add so new files show up in the diff
      await git(["add", "-A", "-N"], dir);
      return await git(["diff"], dir);
    } catch {
      return "";
    }
  }

  async cleanup(runId: string): Promise<void> {
    if (process.env.AGRIPPA_KEEP_WORKSPACES === "1") return;
    await rm(this.dirFor(runId), { recursive: true, force: true });
  }
}
