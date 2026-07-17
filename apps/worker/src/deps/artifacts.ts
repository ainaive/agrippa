import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactKind } from "@agrippa/core";
import { isWithin } from "@agrippa/executor-core";
import type { ArtifactStore, StoredArtifact } from "@agrippa/orchestration";

const STORAGE_ROOT = process.env.ARTIFACT_STORAGE_ROOT ?? path.join(tmpdir(), "agrippa-artifacts");
const INLINE_LIMIT = 64 * 1024;

const EMPTY: StoredArtifact = { inline: null, storageRef: null, size: 0, mime: null };

/**
 * Resolve a workspace-relative artifact source to a real path that is provably
 * inside the workspace. Following symlinks (via realpath) is the point: an
 * agent can `ln -s /proc/self/environ .agrippa/artifacts/leak.md`, and a purely
 * lexical containment check would pass while the read escaped. Returns null when
 * the source does not exist (missing files are not artifacts).
 */
async function resolveContainedPath(workspaceDir: string, rel: string): Promise<string | null> {
  const root = await realpath(workspaceDir);
  let real: string;
  try {
    real = await realpath(path.resolve(workspaceDir, rel));
  } catch {
    return null; // missing / broken symlink
  }
  if (!isWithin(root, real)) {
    throw new Error(`artifact source escapes the run workspace: ${rel}`);
  }
  return real;
}

/** ≤64 KB inline in Postgres; larger content on the artifacts volume. */
export class DiskArtifactStore implements ArtifactStore {
  async store(
    runId: string,
    key: string,
    kind: ArtifactKind,
    source: { inline?: unknown; path?: string },
    workspaceDir: string,
  ): Promise<StoredArtifact> {
    let content: string | null = null;
    let mime: string | null = null;

    if (source.inline !== undefined) {
      content = typeof source.inline === "string" ? source.inline : JSON.stringify(source.inline);
      mime = kind === "json" ? "application/json" : "text/markdown";
    } else if (source.path) {
      const real = await resolveContainedPath(workspaceDir, source.path);
      if (real === null) return EMPTY;
      const file = Bun.file(real);
      if (await file.exists()) {
        content = await file.text();
        mime = file.type || null;
      }
    }
    if (content === null) return EMPTY;

    const size = Buffer.byteLength(content);
    if (size <= INLINE_LIMIT) {
      return { inline: content, storageRef: null, size, mime };
    }
    const dir = path.join(STORAGE_ROOT, runId);
    await mkdir(dir, { recursive: true });
    const storageRef = path.join(dir, key);
    await Bun.write(storageRef, content);
    return { inline: null, storageRef, size, mime };
  }
}
