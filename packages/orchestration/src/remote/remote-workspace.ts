import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchWorkspaceSpec } from "@agrippa/core";
import {
  type Db,
  decryptSecret,
  dispatches,
  loadSecretKey,
  repoConnections,
  runs,
  runtimes,
  secrets,
} from "@agrippa/db";
import { git } from "@agrippa/workspace";
import { and, desc, eq, sql } from "drizzle-orm";
import { DiskArtifactStore } from "../artifact-store";
import type { WorkspaceManager, WorkspaceSpec } from "../engine/deps";

/** Runtime liveness window for isIntact — mirrors routing's 60s watermark. */
const RUNTIME_LIVE_MS = 60_000;

/**
 * Workspace manager for daemon-routed runs (ADR-0017 Decision 5): the REAL
 * workspace lives on the daemon. Locally there is only a scratch staging dir
 * (the ordinary resource materializer writes skill files there; the
 * RemoteExecutor ships them inline and rewrites the paths). `checkout`
 * resolves the repo connection to a URL WITHOUT platform credentials — the
 * daemon clones with its machine's ambient git auth — and persists the spec
 * on runs.workspace_ref so resumes rebuild dispatch payloads without
 * re-running the (already succeeded) checkout step. `diff` reads the evidence
 * patch the daemon uploaded; `isIntact` maps "workspace present" to "the
 * pinned runtime is alive".
 */
export class RemoteWorkspaceManager implements WorkspaceManager {
  private readonly artifacts = new DiskArtifactStore();

  constructor(
    private readonly db: Db,
    private readonly runtimeId: string,
  ) {}

  private stagingDir(runId: string): string {
    return path.join(tmpdir(), "agrippa-remote", runId);
  }

  async ensureDir(runId: string): Promise<string> {
    const dir = this.stagingDir(runId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async checkout(runId: string, spec: WorkspaceSpec): Promise<void> {
    const repoConnectionId = (spec.repo as { repoConnectionId?: string } | null)?.repoConnectionId;
    if (!repoConnectionId) {
      throw new Error("remote checkout requires a repoConnectionId workspace value");
    }
    // scoped by project, never by raw id (same rule as the git manager)
    const [conn] = await this.db
      .select()
      .from(repoConnections)
      .where(
        and(
          eq(repoConnections.id, repoConnectionId),
          eq(repoConnections.projectId, spec.projectId),
        ),
      );
    if (!conn) throw new Error(`repo connection ${repoConnectionId} not found for project`);

    // Pin the publication base SERVER-SIDE at checkout: the daemon must
    // materialize exactly this commit, and git.push later applies the
    // approved patch against exactly this commit. Trusting a daemon-chosen
    // base would let it pick any other reachable commit and smuggle that
    // commit's contents past the approval. The credential is decrypted here
    // for one ls-remote and never leaves this host.
    const ref = spec.ref || conn.defaultBranch;
    const baseSha = await this.resolveRemoteRef(conn, ref);

    const wireSpec: DispatchWorkspaceSpec = {
      repoUrl: conn.url,
      ref,
      baseSha,
      access: spec.access,
    };
    await this.db
      .update(runs)
      .set({ workspaceRef: JSON.stringify(wireSpec) })
      .where(eq(runs.id, runId));
  }

  private async resolveRemoteRef(
    conn: typeof repoConnections.$inferSelect,
    ref: string,
  ): Promise<string> {
    let credentialedUrl = conn.url;
    if (conn.credentialSecretRef) {
      const [secret] = await this.db
        .select()
        .from(secrets)
        .where(eq(secrets.id, conn.credentialSecretRef));
      if (secret) {
        const token = decryptSecret(secret.ciphertext, loadSecretKey());
        const withAuth = new URL(conn.url);
        withAuth.username = "x-access-token";
        withAuth.password = token;
        credentialedUrl = withAuth.toString();
      }
    }
    const heads = await git(["ls-remote", credentialedUrl, `refs/heads/${ref}`]);
    let sha = heads.split("\t")[0]?.trim();
    if (!sha) {
      // Not a branch — a tag or other ref form the template pinned. The pin
      // must be the COMMIT: for an annotated tag, plain ls-remote returns the
      // tag-object sha, while the daemon checks out (and reports) the peeled
      // commit and git.push needs a commit parent — so prefer the `^{}`
      // (peeled) line when the ref points at a tag object.
      const any = await git(["ls-remote", credentialedUrl, ref, `${ref}^{}`]);
      const lines = any
        .split("\n")
        .map((line) => line.split("\t") as [string, string?])
        .filter(([oid]) => oid?.trim());
      const peeled = lines.find(([, refname]) => refname?.trim().endsWith("^{}"));
      sha = (peeled ?? lines[0])?.[0]?.trim();
    }
    if (!sha) throw new Error(`cannot resolve ref '${ref}' on ${conn.url}`);
    return sha;
  }

  /** The dispatch payload's workspace block; workBranch is read live (git.branch runs centrally). */
  async workspaceSpec(runId: string): Promise<DispatchWorkspaceSpec | null> {
    const [run] = await this.db
      .select({ workspaceRef: runs.workspaceRef, workBranch: runs.workBranch })
      .from(runs)
      .where(eq(runs.id, runId));
    if (!run?.workspaceRef) return null;
    let parsed: DispatchWorkspaceSpec;
    try {
      parsed = JSON.parse(run.workspaceRef) as DispatchWorkspaceSpec;
    } catch {
      return null; // a central-format workspaceRef — not a remote spec
    }
    return { ...parsed, ...(run.workBranch ? { workBranch: run.workBranch } : {}) };
  }

  async diff(runId: string): Promise<string> {
    const [latest] = await this.db
      .select({ id: dispatches.id })
      .from(dispatches)
      .where(and(eq(dispatches.runId, runId), eq(dispatches.status, "completed")))
      .orderBy(desc(dispatches.finishedAt))
      .limit(1);
    if (!latest) return "";
    return (await this.artifacts.readStaged(`${latest.id}/.workspace-diff`)) ?? "";
  }

  async isIntact(_runId: string): Promise<boolean> {
    // the workspace lives on the daemon; it is "present" iff the pinned
    // runtime is alive. A vanished daemon fails the resume workspace_lost —
    // the honest boundary ADR-0017 Decision 4 documents (Phase C hardens it).
    const [row] = await this.db
      .select({ lastSeenAt: runtimes.lastSeenAt, status: runtimes.status })
      .from(runtimes)
      .where(eq(runtimes.id, this.runtimeId));
    if (row?.status !== "active" || !row.lastSeenAt) return false;
    const [{ dbNow }] = (await this.db.execute(sql`select now() as "dbNow"`)) as unknown as [
      { dbNow: Date },
    ];
    return dbNow.getTime() - row.lastSeenAt.getTime() < RUNTIME_LIVE_MS;
  }

  async cleanup(runId: string): Promise<void> {
    await rm(this.stagingDir(runId), { recursive: true, force: true });
  }
}
