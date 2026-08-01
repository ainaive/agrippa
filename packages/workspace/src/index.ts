import { appendFile, cp, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSystemEnv } from "@agrippa/executor-core";

/**
 * Git-workspace core shared by the central worker and the remote daemon
 * (ADR-0017): per-run dual-metadata checkouts (agent-owned .git byte-copy +
 * platform-owned sidecar gitdir), sanitization, and the canonical snapshot
 * staging that produces evidence patches (ADR-0012). Credential resolution
 * stays with each host — the worker injects a decrypted platform credential
 * into the clone URL; the daemon clones with its machine's ambient git auth —
 * so this package never touches the database.
 */

// read lazily, not at module load: the daemon sets WORKSPACE_ROOT in its
// entrypoint AFTER imports have evaluated (imports hoist), and tests point
// it at per-suite temp dirs
const workspaceRoot = (): string =>
  process.env.WORKSPACE_ROOT ?? path.join(tmpdir(), "agrippa-workspaces");

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
 * How Git sees the environment:
 *
 * - `platform` (worker): hermetic — no user/system git config, no credential
 *   helpers; the credential arrives inside the URL for exactly one call.
 * - `ambient` (daemon): the machine's own git config and credential helpers
 *   ARE the auth (the BYO-compute thesis); only interactive prompting is
 *   forced off so a missing credential fails instead of hanging.
 */
export type GitEnvProfile = "platform" | "ambient";

export function buildGitEnv(
  profile: GitEnvProfile,
  source: Record<string, string | undefined> = process.env,
  overrides: Record<string, string> = {},
): Record<string, string> {
  if (profile === "ambient") {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) env[key] = value;
    }
    return { ...env, GIT_TERMINAL_PROMPT: "0", ...overrides };
  }
  return {
    ...buildSystemEnv(source),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    ...overrides,
  };
}

/**
 * The environment for platform tools. Unlike the executor environment this
 * contains no provider credentials: Git needs only system/locale/TLS settings.
 */
export function buildPlatformGitEnv(
  source: Record<string, string | undefined> = process.env,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return buildGitEnv("platform", source, overrides);
}

async function runGit(
  args: string[],
  options: {
    cwd?: string;
    gitDir?: string;
    workTree?: string;
    env?: Record<string, string>;
    profile?: GitEnvProfile;
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
      env: buildGitEnv(options.profile ?? "platform", process.env, options.env),
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
  profile: GitEnvProfile = "platform",
): Promise<string> {
  return await runGit(args, { cwd, env, profile });
}

/** The run's agent-visible checkout directory. */
export function workspaceDirFor(runId: string): string {
  return path.join(workspaceRoot(), runId);
}

/** Platform-owned sidecar, outside the agent's writable workspace root. */
export function platformDirFor(runId: string): string {
  return path.join(workspaceRoot(), `${runId}.platform`);
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
export async function sanitizeAgentWorkspace(dir: string): Promise<void> {
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

export type CheckoutSource = {
  /** URL used for the clone itself (worker: credential injected; daemon: ambient auth). */
  cloneUrl: string;
  /** Credential-free URL restored as origin so the token never persists on disk. */
  displayUrl: string;
  /** Absent = the remote's default branch (daemon dispatches may omit it). */
  ref?: string;
  /**
   * Server-pinned base commit: after the clone, HEAD is forced to exactly
   * this sha (fetching it if the shallow clone missed it), and the trusted
   * base ref records it. Daemon checkouts always pin (ADR-0017 — the server
   * chose the base; the daemon may not).
   */
  pinSha?: string;
  /** Env profile for the clone call — the one place ambient auth matters. */
  profile?: GitEnvProfile;
};

/**
 * Per-run checkout with dual Git metadata:
 *
 * - workspace/.git is agent-owned and exists for local checkpoints/review;
 * - <run>.platform/git is an independent pristine copy used by the platform.
 */
export async function checkoutFromUrl(runId: string, source: CheckoutSource): Promise<void> {
  const dir = workspaceDirFor(runId);
  const platformDir = platformDirFor(runId);

  await rm(dir, { recursive: true, force: true });
  await rm(platformDir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const profile = source.profile ?? "platform";
  const branchArgs = source.ref ? ["--branch", source.ref] : [];
  await git(
    ["clone", "--depth", "50", ...branchArgs, source.cloneUrl, dir],
    undefined,
    {},
    profile,
  );
  if (source.pinSha) {
    const head = (await git(["rev-parse", "HEAD"], dir)).trim();
    if (head !== source.pinSha) {
      // the branch moved between the server's pin and this clone — force the
      // exact pinned commit. The depth-50 clone usually already contains it;
      // only a farther-moved branch needs the explicit-sha fetch (which
      // requires the server to allow reachable-sha wants).
      const present = await git(["cat-file", "-e", `${source.pinSha}^{commit}`], dir).then(
        () => true,
        () => false,
      );
      if (!present) {
        await git(["fetch", "--depth", "1", "origin", source.pinSha], dir, {}, profile).catch(
          (err) => {
            throw new Error(
              `pinned base ${source.pinSha} is not fetchable from origin: ${String(err)}`,
            );
          },
        );
      }
      await git(["reset", "--hard", source.pinSha], dir);
    }
  }
  await git(["remote", "set-url", "origin", source.displayUrl], dir);
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

/** Whether a previously checked-out workspace is actually present here. */
export async function workspaceIntact(runId: string): Promise<boolean> {
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

export async function removeWorkspace(runId: string): Promise<void> {
  await rm(workspaceDirFor(runId), { recursive: true, force: true });
  await rm(platformDirFor(runId), { recursive: true, force: true });
}

export type ApplyApprovedPatchSpec = {
  /** Where the base commit's objects come from: a credentialed remote URL, or
   *  the platform sidecar gitdir path for central runs (pristine by ADR-0012). */
  fetchSource: string;
  /** What to fetch from it: the base sha itself (remotes that allow OID want),
   *  or a ref like refs/agrippa/base (the sidecar always has it). */
  fetchRef: string;
  baseSha: string;
  branch: string;
  /** The APPROVED patch bytes — sha256-verified upstream; applied verbatim. */
  patch: string;
  /** Credentialed URL the deterministic commit is pushed to. */
  pushUrl: string;
  message?: string;
};

export type ApplyApprovedPatchResult = { commitSha: string; treeSha: string };

/**
 * Publication inversion (ADR-0017 Decision 5, amending ADR-0011/0012): apply
 * the approved patch to a PRISTINE clone of the pinned base and push the
 * deterministic snapshot commit. No workspace state participates — the
 * published tree derives from approved evidence alone. Idempotency is
 * re-derived without the sidecar branch ref: identity, message, tree, parent,
 * and both dates (pinned to the base commit) are fixed, so every retry
 * reproduces the byte-identical commit SHA, and the push is a remote-ref CAS
 * (--force-with-lease against the observed tip; an existing tip must BE that
 * commit or the publish fails rather than clobbering someone's work).
 */
export async function applyApprovedPatch(
  spec: ApplyApprovedPatchSpec,
): Promise<ApplyApprovedPatchResult> {
  if (spec.patch.length === 0) {
    throw new Error("nothing to publish — the approved patch is empty");
  }
  const tmp = await mkdtemp(path.join(tmpdir(), "agrippa-publish-"));
  try {
    await git(["init", "--quiet", tmp]);
    await git(["fetch", "--quiet", spec.fetchSource, spec.fetchRef], tmp);
    // the base must be exactly the pinned commit, whatever we fetched by
    await git(["cat-file", "-e", `${spec.baseSha}^{commit}`], tmp);

    await git(["read-tree", spec.baseSha], tmp);
    const patchFile = path.join(tmp, ".agrippa-approved.patch");
    await Bun.write(patchFile, spec.patch);
    await git(["apply", "--cached", "--binary", "--whitespace=nowarn", patchFile], tmp);
    await rm(patchFile, { force: true });
    const treeSha = (await git(["write-tree"], tmp)).trim();

    const baseDate = (await git(["show", "-s", "--format=%cI", spec.baseSha], tmp)).trim();
    const commitSha = (
      await git(
        [
          "commit-tree",
          treeSha,
          "-p",
          spec.baseSha,
          "-m",
          spec.message ?? "chore: publish approved Agrippa changes",
        ],
        tmp,
        {
          GIT_AUTHOR_NAME: "Agrippa",
          GIT_AUTHOR_EMAIL: "agrippa@agrippa.local",
          GIT_AUTHOR_DATE: baseDate,
          GIT_COMMITTER_NAME: "Agrippa",
          GIT_COMMITTER_EMAIL: "agrippa@agrippa.local",
          GIT_COMMITTER_DATE: baseDate,
        },
      )
    ).trim();

    const branchRef = `refs/heads/${spec.branch}`;
    const remoteTip = (await git(["ls-remote", spec.pushUrl, branchRef], tmp))
      .split("\t")[0]
      ?.trim();
    if (remoteTip) {
      if (remoteTip !== commitSha) {
        throw new Error(
          "publish branch tip does not match the approved snapshot commit — refusing to overwrite",
        );
      }
      return { commitSha, treeSha }; // idempotent retry: already published
    }
    // creation CAS: the lease requires the branch to still be absent
    await git(
      [
        "push",
        "--quiet",
        spec.pushUrl,
        `${commitSha}:${branchRef}`,
        `--force-with-lease=${branchRef}:`,
      ],
      tmp,
    );
    return { commitSha, treeSha };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Remove project configuration created by a prior agent invocation (`.claude`
 * and `.mcp.json`) and recreate the empty skills directory. `rm` on a symlink
 * removes the link itself; it never traverses into the target. Shared by the
 * worker's materializer (per attempt) and the daemon runner (per dispatch) —
 * the per-invocation config-isolation contract must not fork between hosts.
 */
export async function resetAgentProjectConfig(workspaceDir: string): Promise<void> {
  for (const relative of [".claude", ".mcp.json"]) {
    const target = path.join(workspaceDir, relative);
    try {
      await lstat(target);
    } catch {
      continue;
    }
    await rm(target, { recursive: true, force: true });
  }
  await mkdir(path.join(workspaceDir, ".claude", "skills"), { recursive: true });
}
