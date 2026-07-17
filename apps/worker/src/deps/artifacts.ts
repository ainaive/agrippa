import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactKind } from "@agrippa/core";
import type { ArtifactStore, StoredArtifact } from "@agrippa/orchestration";

const STORAGE_ROOT = process.env.ARTIFACT_STORAGE_ROOT ?? path.join(tmpdir(), "agrippa-artifacts");
const INLINE_LIMIT = 64 * 1024;

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
      const file = Bun.file(path.resolve(workspaceDir, source.path));
      if (await file.exists()) {
        content = await file.text();
        mime = file.type || null;
      }
    }
    if (content === null) return { inline: null, storageRef: null, size: 0, mime: null };

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
