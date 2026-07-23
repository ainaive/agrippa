import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { lstat, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetAgentProjectConfig } from "./resources";

const dirs: string[] = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("per-step agent project configuration", () => {
  it("removes settings, hooks, and MCP config before every invocation", async () => {
    const workspace = freshDir("agrippa-resource-ws-");
    await Bun.write(path.join(workspace, ".claude", "settings.json"), '{"hooks":{}}\n');
    await Bun.write(path.join(workspace, ".claude", "hooks", "start.sh"), "#!/bin/sh\n");
    await Bun.write(path.join(workspace, ".mcp.json"), '{"mcpServers":{}}\n');

    await resetAgentProjectConfig(workspace);

    expect(await Bun.file(path.join(workspace, ".claude", "settings.json")).exists()).toBe(false);
    expect(await Bun.file(path.join(workspace, ".claude", "hooks", "start.sh")).exists()).toBe(
      false,
    );
    expect(await Bun.file(path.join(workspace, ".mcp.json")).exists()).toBe(false);
    expect((await lstat(path.join(workspace, ".claude", "skills"))).isDirectory()).toBe(true);
  });

  it("replaces a symlinked .claude without touching its target", async () => {
    const workspace = freshDir("agrippa-resource-ws-");
    const outside = freshDir("agrippa-resource-outside-");
    await mkdir(path.join(outside, "hooks"), { recursive: true });
    await Bun.write(path.join(outside, "hooks", "sentinel"), "keep\n");
    await symlink(outside, path.join(workspace, ".claude"));

    await resetAgentProjectConfig(workspace);

    expect(await Bun.file(path.join(outside, "hooks", "sentinel")).text()).toBe("keep\n");
    expect((await lstat(path.join(workspace, ".claude", "skills"))).isDirectory()).toBe(true);
  });
});
