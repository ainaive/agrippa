import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Db } from "@agrippa/db";
import type { Logger, ResolvedMcpServer, ResolvedSkill } from "@agrippa/executor-core";
import type {
  ArtifactStore,
  PullRequestSpec,
  ResourceMaterializer,
  ScmService,
  StoredArtifact,
  WorkspaceManager,
} from "./deps";
import { workspaceKeyOf } from "./run-lifecycle";

/** In-memory engine dependencies for the integration suite and local dev. */

export class FakeWorkspaceManager implements WorkspaceManager {
  /** Keyed by WORKSPACE, like the real managers — see the constructor. */
  readonly dirs = new Map<string, string>();
  readonly checkouts: Array<{ runId: string; spec: unknown }> = [];
  readonly released: string[] = [];
  diffOutput = "diff --git a/fake b/fake\n";
  diffError: Error | null = null;

  /**
   * With a database handle this resolves runs to workspace keys exactly as the
   * central and remote managers do (ADR-0018 Decision 3) — which is what lets
   * the compliance suite prove that a follow-up continues its ancestor's
   * directory rather than quietly getting a fresh one. Without a handle it
   * degrades to run-keyed, for fixtures with no run rows.
   */
  constructor(private readonly db?: Db) {}

  private async key(runId: string): Promise<string> {
    return this.db ? await workspaceKeyOf(this.db, runId) : runId;
  }

  async ensureDir(runId: string): Promise<string> {
    const key = await this.key(runId);
    let dir = this.dirs.get(key);
    if (!dir) {
      dir = mkdtempSync(path.join(tmpdir(), `agrippa-ws-${key.slice(0, 8)}-`));
      this.dirs.set(key, dir);
    }
    return dir;
  }

  async checkout(runId: string, spec: unknown): Promise<void> {
    this.checkouts.push({ runId, spec });
  }

  async diff(_runId: string): Promise<string> {
    if (this.diffError) throw this.diffError;
    return this.diffOutput;
  }

  /** Flip to false to simulate a resume on a host that lacks the workspace. */
  intact = true;

  async isIntact(_runId: string): Promise<boolean> {
    return this.intact;
  }

  /**
   * Records the release and keeps the directory, like the real central
   * manager: deleting here is precisely what retention exists to stop, since
   * a follow-up may still continue it. Tests that want the collected case
   * flip `intact` or call `collect`.
   */
  async release(runId: string): Promise<void> {
    this.released.push(runId);
  }

  /** What the collector would do — drop the fake's memory of the directory. */
  collect(workspaceKey: string): void {
    this.dirs.delete(workspaceKey);
  }
}

export class FakeResourceMaterializer implements ResourceMaterializer {
  readonly preparedWorkspaces: string[] = [];
  readonly providerCredentialPresenceCalls: Array<{ projectId: string; provider: string }> = [];
  readonly providerCredentialCalls: Array<{ projectId: string; provider: string }> = [];

  constructor(
    private readonly available: {
      skills?: string[];
      mcpServers?: string[];
      /** provider → project credential returned by providerCredential. */
      providerCredentials?: Record<string, { apiKey: string; baseUrl?: string }>;
      /** Explicit providers reported present; defaults to providerCredentials keys. */
      providerCredentialProviders?: string[];
      /** Optional materialization failure used by engine resilience tests. */
      providerCredentialError?: Error;
    } = {},
  ) {}

  async prepareWorkspace(workspaceDir: string): Promise<void> {
    this.preparedWorkspaces.push(workspaceDir);
  }

  async skills(
    refs: string[],
    workspaceDir: string,
  ): Promise<{ resolved: ResolvedSkill[]; missing: string[] }> {
    const allowed = this.available.skills; // undefined = all available
    const resolved: ResolvedSkill[] = [];
    const missing: string[] = [];
    for (const ref of refs) {
      const slug = ref.split("@")[0] as string;
      if (allowed === undefined || allowed.includes(slug) || allowed.includes(ref)) {
        resolved.push({
          slug,
          version: "1.0.0",
          localPath: path.join(workspaceDir, ".claude/skills", slug),
        });
      } else {
        missing.push(ref);
      }
    }
    return { resolved, missing };
  }

  async mcpServers(refs: string[]): Promise<{ resolved: ResolvedMcpServer[]; missing: string[] }> {
    const registered = new Set(this.available.mcpServers ?? []);
    const resolved: ResolvedMcpServer[] = [];
    const missing: string[] = [];
    for (const ref of refs) {
      if (registered.has(ref)) {
        resolved.push({ slug: ref, transport: "http", url: `https://fake/${ref}`, headers: {} });
      } else {
        missing.push(ref);
      }
    }
    return { resolved, missing };
  }

  async hasProviderCredential(projectId: string, provider: string): Promise<boolean> {
    this.providerCredentialPresenceCalls.push({ projectId, provider });
    const providers =
      this.available.providerCredentialProviders ??
      Object.keys(this.available.providerCredentials ?? {});
    return providers.includes(provider);
  }

  async providerCredential(
    projectId: string,
    provider: string,
  ): Promise<{ apiKey: string; baseUrl?: string } | null> {
    this.providerCredentialCalls.push({ projectId, provider });
    if (this.available.providerCredentialError) {
      throw this.available.providerCredentialError;
    }
    return this.available.providerCredentials?.[provider] ?? null;
  }
}

export class InMemoryArtifactStore implements ArtifactStore {
  /** Default mirrors DiskArtifactStore's 64 KiB threshold so the compliance suite exercises the same inline policy. */
  constructor(private readonly inlineLimitBytes: number = 64 * 1024) {}

  async store(
    runId: string,
    key: string,
    _kind: string,
    source: { inline?: unknown; path?: string },
    workspaceDir: string,
    opts?: { inlineLimitBytes?: number },
  ): Promise<StoredArtifact> {
    const limit = opts?.inlineLimitBytes ?? this.inlineLimitBytes;
    if (source.inline !== undefined) {
      const content =
        typeof source.inline === "string" ? source.inline : JSON.stringify(source.inline);
      const size = Buffer.byteLength(content);
      const sha256 = new Bun.CryptoHasher("sha256").update(content).digest("hex");
      // over-limit keeps a non-null storageRef so the engine reads "stored,
      // not inline" rather than "produced no bytes"
      if (size > limit) {
        return { inline: null, storageRef: `mem://${runId}/${key}`, size, mime: null, sha256 };
      }
      return { inline: source.inline, storageRef: null, size, mime: null, sha256 };
    }
    if (source.path) {
      const file = Bun.file(path.resolve(workspaceDir, source.path));
      const content = (await file.exists()) ? await file.text() : "";
      const size = Buffer.byteLength(content);
      const mime = file.type || null;
      const sha256 = new Bun.CryptoHasher("sha256").update(content).digest("hex");
      if (size > limit) {
        return { inline: null, storageRef: `mem://${runId}/${key}`, size, mime, sha256 };
      }
      return { inline: content, storageRef: null, size, mime, sha256 };
    }
    return { inline: null, storageRef: null, size: 0, mime: null, sha256: null };
  }
}

export class FakeScmService implements ScmService {
  readonly branches: Array<{ runId: string; name: string }> = [];
  readonly pushes: Array<{ runId: string; branch: string }> = [];
  readonly pullRequests: Array<{ runId: string; spec: PullRequestSpec }> = [];
  evidenceMismatchNext = false;
  /** Set to make the next call of that action throw once (retry testing). */
  failNext: Partial<Record<"branch" | "push" | "pr", number>> = {};

  private consumeFailure(kind: "branch" | "push" | "pr"): void {
    const left = this.failNext[kind] ?? 0;
    if (left > 0) {
      this.failNext[kind] = left - 1;
      throw new Error(`fake scm ${kind} failure`);
    }
  }

  async createBranch(runId: string, name: string): Promise<void> {
    this.consumeFailure("branch");
    this.branches.push({ runId, name });
  }

  async push(
    runId: string,
    spec: { branch: string },
  ): Promise<{ status: "pushed"; commitSha: string } | { status: "evidence_mismatch" }> {
    this.consumeFailure("push");
    if (this.evidenceMismatchNext) {
      this.evidenceMismatchNext = false;
      return { status: "evidence_mismatch" };
    }
    this.pushes.push({ runId, branch: spec.branch });
    return { status: "pushed", commitSha: `fake-${this.pushes.length}` };
  }

  async openPullRequest(runId: string, spec: PullRequestSpec): Promise<{ url: string }> {
    this.consumeFailure("pr");
    // like the real providers post-dup-recovery: re-opening for the same
    // head/base returns the existing PR instead of creating a duplicate
    const existing = this.pullRequests.findIndex(
      (p) => p.spec.head === spec.head && p.spec.base === spec.base,
    );
    if (existing >= 0) return { url: `https://fake.scm/pr/${existing + 1}` };
    this.pullRequests.push({ runId, spec });
    return { url: `https://fake.scm/pr/${this.pullRequests.length}` };
  }
}

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
