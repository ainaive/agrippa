import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexHomeDirFor, platformDirFor, removeWorkspace, workspaceDirFor } from "./index";

describe("removeWorkspace", () => {
  let savedRoot: string | undefined;

  beforeEach(() => {
    savedRoot = process.env.WORKSPACE_ROOT;
    process.env.WORKSPACE_ROOT = mkdtempSync(path.join(tmpdir(), "agrippa-collect-"));
  });

  afterEach(() => {
    if (savedRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = savedRoot;
  });

  it("removes the workspace, the platform sidecar, and the codex session home", async () => {
    // The codex home is a workspace sibling precisely so this call is the one
    // place session lifetime is enforced — the worker collector and the daemon
    // reap both call removeWorkspace, so neither needs to know the suffix.
    const key = "run-under-test";
    for (const dir of [workspaceDirFor(key), platformDirFor(key), codexHomeDirFor(key)]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "marker"), "x");
    }

    await removeWorkspace(key);

    expect(existsSync(workspaceDirFor(key))).toBe(false);
    expect(existsSync(platformDirFor(key))).toBe(false);
    expect(existsSync(codexHomeDirFor(key))).toBe(false);
  });

  it("is idempotent when nothing exists", async () => {
    await removeWorkspace("never-created");
  });
});
