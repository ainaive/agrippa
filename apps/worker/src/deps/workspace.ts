import { appendFile, cp, lstat, mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Db, decryptSecret, loadSecretKey, repoConnections, secrets } from "@agrippa/db";
import { buildSystemEnv } from "@agrippa/executor-core";
import type { WorkspaceManager, WorkspaceSpec } from "@agrippa/orchestration";
import { and, eq } from "drizzle-orm";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? path.join(tmpdir(), "agrippa-workspaces");

/**
 * Repo-supplied/runtime-only paths that never enter evidence or a published
 * tree. The platform-owned index retains their clone-base entries while the
 * worktree copies are stripped, so publishing neither deletes the repository's
 * originals nor adds agent/platform runtime files.
 */
export const PROTECTED_PATHS = [".claude", ".mcp.json", ".agrippa"] as const;
const PROTECTED_PATHSPECS = PROTECTED_PATHS.map((entry) => `:(exclude)${entry}`);

/** Immutable clone-time base, stored only in the platform-owned gitdir. */
const BASE_REF = "refs/agrippa/base";

/**
 * The environment for platform tools. Unlike the executor environment this
 * contains no provider credentials: Git needs only system/locale/TLS settings.
 */
export function buildPlatformGitEnv(
  source: Record<string, string | undefined> = process.env,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    ...buildSystemEnv(source),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    ...overrides,
  };
}

async function runGit(
  args: string[],
  options: {
    cwd?: string;
    gitDir?: string;
    workTree?: string;
    env?: Record<string, string>;
  } = {},
): Promise<string> {
  const locationArgs = [
    ...(options.gitDir ? [`--git-dir=${options.gitDir}`] : []),
    ...(options.workTree ? [`--work-tree=${options.workTree}`] : []),
  ];
  const proc = Bun.spawn(
    [
      "git",
      ...locationArgs,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    {
      cwd: options.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: buildPlatformGitEnv(process.env, options.env),
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

/**
 * Bootstrap-only Git for a fresh checkout, before any agent has touched its
 * metadata. Post-agent platform operations must use {@link platformGit}.
 */
export async function git(
  args: string[],
  cwd?: string,
  env: Record<string, string> = {},
): Promise<string> {
  return await runGit(args, { cwd, env });
}

/** The run's agent-visible checkout directory. */
export function workspaceDirFor(runId: string): string {
  return path.join(WORKSPACE_ROOT, runId);
}

/** Platform-owned sidecar, outside the agent's writable workspace root. */
export function platformDirFor(runId: string): string {
  return path.join(WORKSPACE_ROOT, `${runId}.platform`);
}

/** Trusted gitdir used for all evidence and publication operations. */
export function platformGitDirFor(runId: string): string {
  return path.join(platformDirFor(runId), "git");
}

/** Run Git with trusted metadata and the agent workspace only as a worktree. */
export async function platformGit(
  runId: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<string> {
  return await runGit(args, {
    cwd: platformDirFor(runId),
    gitDir: platformGitDirFor(runId),
    workTree: workspaceDirFor(runId),
    env,
  });
}

/**
 * Convenience-only hygiene for the agent's own Git view. This metadata is
 * never trusted by platform Git; an agent may freely corrupt it without
 * changing evidence or publication.
 */
async function sanitizeAgentWorkspace(dir: string): Promise<void> {
  const tracked = await git(["ls-files", "-z", "--", ...PROTECTED_PATHS], dir);
  const files = tracked.split("\0").filter((file) => file.length > 0);
  if (files.length > 0) {
    await git(["update-index", "--skip-worktree", "--", ...files], dir);
  }
  await appendFile(
    path.join(dir, ".git", "info", "exclude"),
    `\n# agrippa: runtime-only paths\n${PROTECTED_PATHS.map((entry) => `/${entry}`).join("\n")}\n`,
  );
  for (const entry of PROTECTED_PATHS) {
    await rm(path.join(dir, entry), { recursive: true, force: true });
  }
  await rm(path.join(dir, ".git", "hooks"), { recursive: true, force: true });
}

/** Clone-base SHA from trusted metadata; null means the sidecar is incomplete. */
export async function platformBaseSha(runId: string): Promise<string | null> {
  try {
    const sha = await platformGit(runId, ["rev-parse", "--verify", BASE_REF]);
    return sha.trim() || null;
  } catch {
    return null;
  }
}

export type PlatformSnapshot = {
  baseSha: string;
  patch: string;
  treeSha: string;
};

/**
 * Stage one canonical filesystem snapshot in the platform-owned index.
 * Evidence and publication both use this exact operation, including Git's
 * normalization rules and binary patches.
 */
export async function stagePlatformSnapshot(runId: string): Promise<PlatformSnapshot> {
  const baseSha = await platformBaseSha(runId);
  if (!baseSha) throw new Error("trusted platform git base is missing");
  await platformGit(runId, ["read-tree", baseSha]);
  await platformGit(runId, ["add", "-A", "--", ".", ...PROTECTED_PATHSPECS]);
  const patch = await platformGit(runId, [
    "diff",
    "--cached",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    baseSha,
    "--",
    ".",
    ...PROTECTED_PATHSPECS,
  ]);
  const treeSha = (await platformGit(runId, ["write-tree"])).trim();
  return { baseSha, patch, treeSha };
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

  async ensureDir(runId: string): Promise<string> {
    const dir = workspaceDirFor(runId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async checkout(runId: string, spec: WorkspaceSpec): Promise<void> {
    const { connection, token } = await loadRepoConnection(this.db, spec.projectId, spec.repo);
    const cloneUrl = credentialedUrl(connection.url, token);
    const dir = workspaceDirFor(runId);
    const platformDir = platformDirFor(runId);
    const ref = spec.ref || connection.defaultBranch;

    await rm(dir, { recursive: true, force: true });
    await rm(platformDir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await git(["clone", "--depth", "50", "--branch", ref, cloneUrl, dir]);
    await git(["remote", "set-url", "origin", connection.url], dir);
    await git(["update-ref", BASE_REF, "HEAD"], dir);
    await git(["config", "user.name", "Agrippa Agent"], dir);
    await git(["config", "user.email", "agent@agrippa.local"], dir);

    // Move the pristine metadata out first, then give the agent a byte-copy.
    // No inode/object storage is shared between the trust domains.
    await mkdir(platformDir, { recursive: true });
    await rename(path.join(dir, ".git"), platformGitDirFor(runId));
    await cp(platformGitDirFor(runId), path.join(dir, ".git"), { recursive: true });
    await sanitizeAgentWorkspace(dir);
  }

  async diff(runId: string): Promise<string> {
    return (await stagePlatformSnapshot(runId)).patch;
  }

  async isIntact(runId: string): Promise<boolean> {
    try {
      const [workspace, gitDir, head] = await Promise.all([
        lstat(workspaceDirFor(runId)),
        lstat(platformGitDirFor(runId)),
        lstat(path.join(platformGitDirFor(runId), "HEAD")),
      ]);
      return workspace.isDirectory() && gitDir.isDirectory() && head.isFile();
    } catch {
      return false;
    }
  }

  async cleanup(runId: string): Promise<void> {
    if (process.env.AGRIPPA_KEEP_WORKSPACES === "1") return;
    await rm(workspaceDirFor(runId), { recursive: true, force: true });
    await rm(platformDirFor(runId), { recursive: true, force: true });
  }
}
