import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DiskArtifactStore } from "./artifacts";

const store = new DiskArtifactStore();
const dirs: string[] = [];

function freshWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agrippa-ws-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("DiskArtifactStore path containment", () => {
  it("stores a normal in-workspace file inline", async () => {
    const ws = freshWorkspace();
    await mkdir(path.join(ws, ".agrippa/artifacts"), { recursive: true });
    writeFileSync(path.join(ws, ".agrippa/artifacts/report.md"), "# ok");

    const stored = await store.store(
      "run-1",
      "report",
      "markdown",
      {
        path: ".agrippa/artifacts/report.md",
      },
      ws,
    );
    expect(stored.inline).toBe("# ok");
    expect(stored.size).toBeGreaterThan(0);
  });

  it("rejects a symlink escaping the workspace", async () => {
    const ws = freshWorkspace();
    await mkdir(path.join(ws, ".agrippa/artifacts"), { recursive: true });
    // secret file outside the workspace, reachable only via the symlink
    const outside = mkdtempSync(path.join(tmpdir(), "agrippa-secret-"));
    dirs.push(outside);
    const secret = path.join(outside, "environ");
    writeFileSync(secret, "AGRIPPA_SECRET_KEY=master");
    symlinkSync(secret, path.join(ws, ".agrippa/artifacts/leak.md"));

    await expect(
      store.store("run-1", "leak", "markdown", { path: ".agrippa/artifacts/leak.md" }, ws),
    ).rejects.toThrow(/escapes the run workspace/);
  });

  it("treats a missing file as no content, not a zero-byte artifact", async () => {
    const ws = freshWorkspace();
    const stored = await store.store(
      "run-1",
      "nope",
      "markdown",
      {
        path: ".agrippa/artifacts/nope.md",
      },
      ws,
    );
    expect(stored.inline).toBeNull();
    expect(stored.storageRef).toBeNull();
    expect(stored.size).toBe(0);
  });

  it("treats an existing but empty file as no content", async () => {
    const ws = freshWorkspace();
    await mkdir(path.join(ws, ".agrippa/artifacts"), { recursive: true });
    writeFileSync(path.join(ws, ".agrippa/artifacts/empty.md"), "");
    const stored = await store.store(
      "run-1",
      "empty",
      "markdown",
      { path: ".agrippa/artifacts/empty.md" },
      ws,
    );
    expect(stored.inline).toBeNull();
    expect(stored.storageRef).toBeNull();
    expect(stored.size).toBe(0);
  });

  it("stores a binary file-kind artifact byte-exact on disk, not decoded as text", async () => {
    const ws = freshWorkspace();
    await mkdir(path.join(ws, ".agrippa/artifacts"), { recursive: true });
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]); // PNG-ish + nulls
    writeFileSync(path.join(ws, ".agrippa/artifacts/blob"), bytes);

    const stored = await store.store(
      "run-1",
      "blob",
      "file",
      { path: ".agrippa/artifacts/blob" },
      ws,
    );
    expect(stored.inline).toBeNull();
    expect(stored.storageRef).not.toBeNull();
    expect(stored.size).toBe(8);
    const round = new Uint8Array(await Bun.file(stored.storageRef as string).arrayBuffer());
    expect([...round]).toEqual([...bytes]); // byte-exact, no UTF-8 corruption
  });

  it("rejects an artifact over the size cap without buffering it", async () => {
    const ws = freshWorkspace();
    await mkdir(path.join(ws, ".agrippa/artifacts"), { recursive: true });
    writeFileSync(path.join(ws, ".agrippa/artifacts/big.md"), "0123456789AB"); // 12 bytes
    const prev = process.env.AGRIPPA_MAX_ARTIFACT_BYTES;
    process.env.AGRIPPA_MAX_ARTIFACT_BYTES = "8";
    try {
      await expect(
        store.store("run-1", "big", "markdown", { path: ".agrippa/artifacts/big.md" }, ws),
      ).rejects.toThrow(/over the .* limit/);
    } finally {
      if (prev === undefined) delete process.env.AGRIPPA_MAX_ARTIFACT_BYTES;
      else process.env.AGRIPPA_MAX_ARTIFACT_BYTES = prev;
    }
  });

  it("falls back to the default cap when the size env is not a valid number", async () => {
    const ws = freshWorkspace();
    await mkdir(path.join(ws, ".agrippa/artifacts"), { recursive: true });
    writeFileSync(path.join(ws, ".agrippa/artifacts/small.md"), "hello");
    const prev = process.env.AGRIPPA_MAX_ARTIFACT_BYTES;
    process.env.AGRIPPA_MAX_ARTIFACT_BYTES = "invalid"; // NaN must not disable the cap
    try {
      // a normal small file still stores (default cap applies, not NaN)
      const stored = await store.store(
        "run-1",
        "small",
        "markdown",
        { path: ".agrippa/artifacts/small.md" },
        ws,
      );
      expect(stored.inline).toBe("hello");
    } finally {
      if (prev === undefined) delete process.env.AGRIPPA_MAX_ARTIFACT_BYTES;
      else process.env.AGRIPPA_MAX_ARTIFACT_BYTES = prev;
    }
  });
});
