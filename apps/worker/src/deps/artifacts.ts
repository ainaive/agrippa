import { mkdir, realpath, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactKind } from "@agrippa/core";
import { isWithin } from "@agrippa/executor-core";
import type { ArtifactStore, StoredArtifact } from "@agrippa/orchestration";

const STORAGE_ROOT = process.env.ARTIFACT_STORAGE_ROOT ?? path.join(tmpdir(), "agrippa-artifacts");
const INLINE_LIMIT = 64 * 1024;
/** Hard cap on a single artifact so an agent can't OOM the worker (env-tunable). */
const DEFAULT_MAX_ARTIFACT_SIZE = 25 * 1024 * 1024;
const maxArtifactSize = (): number => {
  const raw = process.env.AGRIPPA_MAX_ARTIFACT_BYTES;
  if (raw === undefined) return DEFAULT_MAX_ARTIFACT_SIZE;
  const n = Number(raw);
  // a bad value (e.g. "invalid" → NaN, or 0/negative) must not silently disable the cap
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_ARTIFACT_SIZE;
};

class ArtifactTooLargeError extends Error {
  constructor(key: string, size: number) {
    super(`artifact '${key}' is ${size} bytes, over the ${maxArtifactSize()}-byte limit`);
    this.name = "ArtifactTooLargeError";
  }
}

const EMPTY: StoredArtifact = { inline: null, storageRef: null, size: 0, mime: null, sha256: null };

const sha256Hex = (content: string | Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(content).digest("hex");

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

/**
 * ≤64 KB inline in Postgres; larger content on the artifacts volume. The
 * engine raises the inline threshold per call (opts.inlineLimitBytes) for
 * checkpoint-driving artifacts, which must inline whole to survive resume.
 */
export class DiskArtifactStore implements ArtifactStore {
  async store(
    runId: string,
    key: string,
    kind: ArtifactKind,
    source: { inline?: unknown; path?: string },
    workspaceDir: string,
    opts?: { inlineLimitBytes?: number },
  ): Promise<StoredArtifact> {
    const inlineLimit = opts?.inlineLimitBytes ?? INLINE_LIMIT;
    // engine-provided inline content (patch diffs, links) is always text
    if (source.inline !== undefined) {
      const content =
        typeof source.inline === "string" ? source.inline : JSON.stringify(source.inline);
      const mime = kind === "json" ? "application/json" : "text/markdown";
      return this.storeText(runId, key, content, mime, inlineLimit);
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
    if (kind !== "file" && size <= inlineLimit) {
      return this.storeText(runId, key, await file.text(), mime, inlineLimit);
    }
    return { inline: null, mime, ...(await this.streamToDisk(runId, key, file)) };
  }

  /**
   * Single-pass spill: hash and count exactly the bytes being written — the
   * source lives in the (agent-mutable) workspace, so re-reading it to hash
   * after the copy could describe different content than what was stored, and
   * a file growing mid-copy must trip the size cap, not land oversized.
   */
  private async streamToDisk(
    runId: string,
    key: string,
    file: ReturnType<typeof Bun.file>,
  ): Promise<{ storageRef: string; size: number; sha256: string }> {
    const dir = path.join(STORAGE_ROOT, runId);
    await mkdir(dir, { recursive: true });
    const storageRef = path.join(dir, key);
    const hasher = new Bun.CryptoHasher("sha256");
    const writer = Bun.file(storageRef).writer();
    let written = 0;
    try {
      for await (const chunk of file.stream()) {
        written += chunk.byteLength;
        if (written > maxArtifactSize()) throw new ArtifactTooLargeError(key, written);
        hasher.update(chunk);
        // write() returns a Promise when the sink applies backpressure —
        // ignoring it lets end() run before those chunks land
        await writer.write(chunk);
      }
      await writer.end();
    } catch (err) {
      await Promise.resolve(writer.end()).catch(() => {});
      await unlink(storageRef).catch(() => {});
      throw err;
    }
    return { storageRef, size: written, sha256: hasher.digest("hex") };
  }

  private async storeText(
    runId: string,
    key: string,
    content: string,
    mime: string | null,
    inlineLimit: number,
  ): Promise<StoredArtifact> {
    const size = Buffer.byteLength(content);
    if (size === 0) return EMPTY;
    if (size > maxArtifactSize()) throw new ArtifactTooLargeError(key, size);
    const sha256 = sha256Hex(content);
    if (size <= inlineLimit) return { inline: content, storageRef: null, size, mime, sha256 };
    const storageRef = await this.writeToDisk(runId, key, content);
    return { inline: null, storageRef, size, mime, sha256 };
  }

  private async writeToDisk(runId: string, key: string, data: string): Promise<string> {
    const dir = path.join(STORAGE_ROOT, runId);
    await mkdir(dir, { recursive: true });
    const storageRef = path.join(dir, key);
    await Bun.write(storageRef, data);
    return storageRef;
  }
}
