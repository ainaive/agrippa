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
});
