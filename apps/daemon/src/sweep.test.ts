import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "@agrippa/executor-core";
import { sweepStaleWorkspaces } from "./sweep";

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const agedDir = async (root: string, name: string, daysOld: number): Promise<string> => {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "file.txt"), "x");
  const when = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  await utimes(dir, when, when);
  return dir;
};

const exists = async (dir: string): Promise<boolean> => {
  try {
    await stat(dir);
    return true;
  } catch {
    return false;
  }
};

describe("sweepStaleWorkspaces", () => {
  it("removes only what is older than the floor", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agrippa-sweep-"));
    const old = await agedDir(root, "run-old", 45);
    const recent = await agedDir(root, "run-recent", 3);

    expect(await sweepStaleWorkspaces(root, 30, quiet)).toBe(1);
    expect(await exists(old)).toBe(false);
    // a run merely paused at a checkpoint still owns its workspace: deleting
    // it does not cost a re-clone, it silently drops completed steps' work
    expect(await exists(recent)).toBe(true);
  });

  it("is a no-op on a root that was never created", async () => {
    const root = path.join(mkdtempSync(path.join(tmpdir(), "agrippa-sweep-")), "never");
    expect(await sweepStaleWorkspaces(root, 30, quiet)).toBe(0);
  });

  it("sweeps the platform sidecar alongside its workspace", async () => {
    // removeWorkspace deletes `<id>` and `<id>.platform` together; the sweep
    // sees them as two directories and must age out both
    const root = mkdtempSync(path.join(tmpdir(), "agrippa-sweep-"));
    const work = await agedDir(root, "run-1", 40);
    const sidecar = await agedDir(root, "run-1.platform", 40);

    expect(await sweepStaleWorkspaces(root, 30, quiet)).toBe(2);
    expect(await exists(work)).toBe(false);
    expect(await exists(sidecar)).toBe(false);
  });
});
