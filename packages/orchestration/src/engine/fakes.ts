import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger, ResolvedMcpServer, ResolvedSkill } from "@agrippa/executor-core";
import type { ArtifactStore, ResourceMaterializer, StoredArtifact, WorkspaceManager } from "./deps";

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

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
