import { mkdir } from "node:fs/promises";
import { type Db, decryptSecret, loadSecretKey, repoConnections, secrets } from "@agrippa/db";
import { type WorkspaceManager, type WorkspaceSpec, workspaceKeyOf } from "@agrippa/orchestration";
import {
  checkoutFromUrl,
  removeWorkspace,
  stagePlatformSnapshot,
  workspaceDirFor,
  workspaceIntact,
} from "@agrippa/workspace";
import { and, eq } from "drizzle-orm";

// The git-workspace core (dual-metadata checkout, sanitization, snapshot
// staging) lives in @agrippa/workspace, shared with the remote daemon
// (ADR-0017). This module keeps the platform-credential half: resolving repo
// connections and injecting decrypted tokens, which must never leave the
// server. Re-exported so scm.ts and tests keep one import site.
export {
  buildPlatformGitEnv,
  git,
  PROTECTED_PATHS,
  platformBaseSha,
  platformDirFor,
  platformGit,
  platformGitDirFor,
  stagePlatformSnapshot,
  workspaceDirFor,
} from "@agrippa/workspace";

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

/** The connection URL with the credential injected for one Git call. */
export function credentialedUrl(url: string, token: string | null): string {
  if (!token) return url;
  const withAuth = new URL(url);
  withAuth.username = "x-access-token";
  withAuth.password = token;
  return withAuth.toString();
}

/**
 * Per-run checkout with dual Git metadata:
 *
 * - workspace/.git is agent-owned and exists for local checkpoints/review;
 * - <run>.platform/git is an independent pristine copy used by the platform.
 */
export class GitWorkspaceManager implements WorkspaceManager {
  constructor(private readonly db: Db) {}

  /**
   * The interface stays run-keyed and the translation happens here (ADR-0018
   * Decision 3), so the engine — which orchestrates runs, not directories —
   * needs no notion of a workspace key at all.
   */
  private key(runId: string): Promise<string> {
    return workspaceKeyOf(this.db, runId);
  }

  async ensureDir(runId: string): Promise<string> {
    const dir = workspaceDirFor(await this.key(runId));
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async checkout(runId: string, spec: WorkspaceSpec): Promise<void> {
    const { connection, token } = await loadRepoConnection(this.db, spec.projectId, spec.repo);
    await checkoutFromUrl(await this.key(runId), {
      cloneUrl: credentialedUrl(connection.url, token),
      displayUrl: connection.url,
      ref: spec.ref || connection.defaultBranch,
      profile: "platform",
    });
  }

  async diff(runId: string): Promise<string> {
    return (await stagePlatformSnapshot(await this.key(runId))).patch;
  }

  async isIntact(runId: string): Promise<boolean> {
    return await workspaceIntact(await this.key(runId));
  }

  async cleanup(runId: string): Promise<void> {
    if (process.env.AGRIPPA_KEEP_WORKSPACES === "1") return;
    await removeWorkspace(await this.key(runId));
  }
}
