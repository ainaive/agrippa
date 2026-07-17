import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactKind } from "@agrippa/core";
import { isWithin } from "@agrippa/executor-core";
import type { ArtifactStore, StoredArtifact } from "@agrippa/orchestration";

const STORAGE_ROOT = process.env.ARTIFACT_STORAGE_ROOT ?? path.join(tmpdir(), "agrippa-artifacts");
const INLINE_LIMIT = 64 * 1024;
/** Hard cap on a single artifact so an agent can't OOM the worker (env-tunable). */
const maxArtifactSize = (): number =>
  Number(process.env.AGRIPPA_MAX_ARTIFACT_BYTES ?? 25 * 1024 * 1024);

class ArtifactTooLargeError extends Error {
  constructor(key: string, size: number) {
    super(`artifact '${key}' is ${size} bytes, over the ${maxArtifactSize()}-byte limit`);
    this.name = "ArtifactTooLargeError";
  }
}

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
    // engine-provided inline content (patch diffs, links) is always text
    if (source.inline !== undefined) {
      const content =
        typeof source.inline === "string" ? source.inline : JSON.stringify(source.inline);
      const mime = kind === "json" ? "application/json" : "text/markdown";
      return this.storeText(runId, key, content, mime);
    }
    if (!source.path) return EMPTY;

    const real = await resolveContainedPath(workspaceDir, source.path);
    if (real === null) return EMPTY;
    const file = Bun.file(real);
    if (!(await file.exists())) return EMPTY;

    // stat BEFORE reading, so a huge/sparse file is rejected without buffering it
    const size = file.size;
    if (size === 0) return EMPTY;
    if (size > maxArtifactSize()) throw new ArtifactTooLargeError(key, size);
    const mime = file.type || null;

    // small text can inline in Postgres; `file`-kind (possibly binary) and any
    // large artifact stream straight to disk byte-exact, never fully buffered
    if (kind !== "file" && size <= INLINE_LIMIT) {
      return this.storeText(runId, key, await file.text(), mime);
    }
    const storageRef = await this.writeToDisk(runId, key, file);
    return { inline: null, storageRef, size, mime };
  }

  private async storeText(
    runId: string,
    key: string,
    content: string,
    mime: string | null,
  ): Promise<StoredArtifact> {
    const size = Buffer.byteLength(content);
    if (size === 0) return EMPTY;
    if (size > maxArtifactSize()) throw new ArtifactTooLargeError(key, size);
    if (size <= INLINE_LIMIT) return { inline: content, storageRef: null, size, mime };
    const storageRef = await this.writeToDisk(runId, key, content);
    return { inline: null, storageRef, size, mime };
  }

  private async writeToDisk(
    runId: string,
    key: string,
    data: string | Uint8Array | Blob,
  ): Promise<string> {
    const dir = path.join(STORAGE_ROOT, runId);
    await mkdir(dir, { recursive: true });
    const storageRef = path.join(dir, key);
    await Bun.write(storageRef, data);
    return storageRef;
  }
}
