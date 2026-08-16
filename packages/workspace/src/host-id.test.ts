import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { workspaceHostId } from "./index";

describe("workspaceHostId", () => {
  let savedRoot: string | undefined;

  beforeEach(() => {
    savedRoot = process.env.WORKSPACE_ROOT;
    process.env.WORKSPACE_ROOT = mkdtempSync(path.join(tmpdir(), "agrippa-hostid-"));
  });

  afterEach(() => {
    if (savedRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = savedRoot;
  });

  it("mints once and returns the same id thereafter", async () => {
    const first = await workspaceHostId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await workspaceHostId()).toBe(first);
    // the identity IS the file: what a replacement container reads back
    expect(
      readFileSync(
        path.join(process.env.WORKSPACE_ROOT as string, ".agrippa-host-id"),
        "utf8",
      ).trim(),
    ).toBe(first);
  });

  it("adopts an id that is already on the volume", async () => {
    // a redeployed container mounting an existing volume is the same host
    writeFileSync(
      path.join(process.env.WORKSPACE_ROOT as string, ".agrippa-host-id"),
      "pre-existing-host\n",
    );
    expect(await workspaceHostId()).toBe("pre-existing-host");
  });

  it("two concurrent boots on one fresh volume converge on one id", async () => {
    const [a, b] = await Promise.all([workspaceHostId(), workspaceHostId()]);
    expect(a).toBe(b);
  });
});
