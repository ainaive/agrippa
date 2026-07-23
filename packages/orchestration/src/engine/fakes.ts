import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger, ResolvedMcpServer, ResolvedSkill } from "@agrippa/executor-core";
import type {
  ArtifactStore,
  PullRequestSpec,
  ResourceMaterializer,
  ScmService,
  StoredArtifact,
  WorkspaceManager,
} from "./deps";

/** In-memory engine dependencies for the integration suite and local dev. */

export class FakeWorkspaceManager implements WorkspaceManager {
  readonly dirs = new Map<string, string>();
  readonly checkouts: Array<{ runId: string; spec: unknown }> = [];
  readonly cleaned: string[] = [];
  diffOutput = "diff --git a/fake b/fake\n";

  async ensureDir(runId: string): Promise<string> {
    let dir = this.dirs.get(runId);
    if (!dir) {
      dir = mkdtempSync(path.join(tmpdir(), `agrippa-run-${runId.slice(0, 8)}-`));
      this.dirs.set(runId, dir);
    }
    return dir;
  }

  async checkout(runId: string, spec: unknown): Promise<void> {
    this.checkouts.push({ runId, spec });
  }

  async diff(_runId: string): Promise<string> {
    return this.diffOutput;
  }

  /** Flip to false to simulate a resume on a host that lacks the workspace. */
  intact = true;

  async isIntact(_runId: string): Promise<boolean> {
    return this.intact;
  }

  async cleanup(runId: string): Promise<void> {
    this.cleaned.push(runId);
    this.dirs.delete(runId);
  }
}

export class FakeResourceMaterializer implements ResourceMaterializer {
  constructor(private readonly available: { skills?: string[]; mcpServers?: string[] } = {}) {}

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
}

export class InMemoryArtifactStore implements ArtifactStore {
  async store(
    _runId: string,
    _key: string,
    _kind: string,
    source: { inline?: unknown; path?: string },
    workspaceDir: string,
  ): Promise<StoredArtifact> {
    if (source.inline !== undefined) {
      const size = JSON.stringify(source.inline).length;
      return { inline: source.inline, storageRef: null, size, mime: null };
    }
    if (source.path) {
      const file = Bun.file(path.resolve(workspaceDir, source.path));
      const content = (await file.exists()) ? await file.text() : "";
      return { inline: content, storageRef: null, size: content.length, mime: file.type || null };
    }
    return { inline: null, storageRef: null, size: 0, mime: null };
  }
}

export class FakeScmService implements ScmService {
  readonly branches: Array<{ runId: string; name: string }> = [];
  readonly pushes: Array<{ runId: string; branch: string }> = [];
  readonly pullRequests: Array<{ runId: string; spec: PullRequestSpec }> = [];
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

  async push(runId: string, spec: { branch: string }): Promise<void> {
    this.consumeFailure("push");
    this.pushes.push({ runId, branch: spec.branch });
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
