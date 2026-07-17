import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildScrubbedEnv,
  createSecretRedactor,
  evaluateToolCall,
  isWithin,
  realContained,
} from "./isolation";

const ROOT = "/work/runs/run-1";
const rw = { access: "readWrite" as const, writeRoot: ROOT };
const ro = { access: "readOnly" as const, writeRoot: ROOT };

describe("isWithin", () => {
  it("accepts the root and nested paths, rejects siblings and escapes", () => {
    expect(isWithin(ROOT, ROOT)).toBe(true);
    expect(isWithin(ROOT, `${ROOT}/src/a.ts`)).toBe(true);
    // the sibling-prefix bug: /work/runs/run-1 must NOT contain /work/runs/run-1-evil
    expect(isWithin(ROOT, `${ROOT}-evil/a.ts`)).toBe(false);
    expect(isWithin(ROOT, "/etc/passwd")).toBe(false);
    expect(isWithin(ROOT, `${ROOT}/../run-2/a.ts`)).toBe(false);
  });
});

describe("evaluateToolCall — read-write workspace", () => {
  it("allows in-workspace writes and shell, denies escaping writes", () => {
    expect(evaluateToolCall(rw, ROOT, "Write", { file_path: `${ROOT}/a.ts` }).behavior).toBe(
      "allow",
    );
    expect(evaluateToolCall(rw, ROOT, "Bash", { command: "ls" }).behavior).toBe("allow");
    expect(evaluateToolCall(rw, ROOT, "Write", { file_path: "/etc/cron.d/x" }).behavior).toBe(
      "deny",
    );
    // relative path resolves against the workspace, escaping is denied
    expect(evaluateToolCall(rw, ROOT, "Edit", { file_path: "../run-2/a" }).behavior).toBe("deny");
  });

  it("confines reads to the workspace (blocks /proc, other runs, artifact store)", () => {
    // in-workspace reads and no-path reads (default cwd) are fine
    expect(evaluateToolCall(rw, ROOT, "Read", { file_path: `${ROOT}/src/a.ts` }).behavior).toBe(
      "allow",
    );
    expect(evaluateToolCall(rw, ROOT, "Grep", { pattern: "TODO" }).behavior).toBe("allow");
    // escaping reads are denied
    expect(evaluateToolCall(rw, ROOT, "Read", { file_path: "/proc/self/environ" }).behavior).toBe(
      "deny",
    );
    expect(
      evaluateToolCall(rw, ROOT, "Read", { file_path: "/work/runs/run-2/secret" }).behavior,
    ).toBe("deny");
    expect(evaluateToolCall(rw, ROOT, "Glob", { path: "/work/artifacts" }).behavior).toBe("deny");
  });
});

describe("evaluateToolCall — read-only workspace", () => {
  it("denies shell and repo writes, permits artifact writes", () => {
    expect(evaluateToolCall(ro, ROOT, "Bash", { command: "ls" }).behavior).toBe("deny");
    expect(evaluateToolCall(ro, ROOT, "Write", { file_path: `${ROOT}/src/a.ts` }).behavior).toBe(
      "deny",
    );
    expect(
      evaluateToolCall(ro, ROOT, "Write", {
        file_path: path.join(ROOT, ".agrippa/artifacts/report.md"),
      }).behavior,
    ).toBe("allow");
    // reads are always fine
    expect(evaluateToolCall(ro, ROOT, "Read", { file_path: `${ROOT}/src/a.ts` }).behavior).toBe(
      "allow",
    );
  });
});

describe("buildScrubbedEnv", () => {
  it("drops platform secrets but keeps allow-listed SDK auth and system vars", () => {
    const env = buildScrubbedEnv({
      PATH: "/usr/bin",
      HOME: "/home/bun",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      AGRIPPA_SECRET_KEY: "master",
      DATABASE_URL: "postgres://secret",
      BETTER_AUTH_SECRET: "s",
      REDIS_URL: "redis://x",
      GITHUB_TOKEN: "ghp_x",
      SOME_PASSWORD: "p",
      // namespaced secrets must NOT ride along just because of their prefix
      ANTHROPIC_PRIVATE_KEY: "leak",
      CLAUDE_ADMIN_TOKEN: "leak",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/bun");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
    expect(env.AGRIPPA_SECRET_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SOME_PASSWORD).toBeUndefined();
    expect(env.ANTHROPIC_PRIVATE_KEY).toBeUndefined();
    expect(env.CLAUDE_ADMIN_TOKEN).toBeUndefined();
  });
});

describe("realContained", () => {
  const dirs: string[] = [];
  const ws = () => {
    const d = mkdtempSync(path.join(tmpdir(), "iso-ws-"));
    dirs.push(d);
    return d;
  };

  it("allows a new file in the workspace and rejects a symlink escape", async () => {
    const root = ws();
    await mkdir(path.join(root, "src"), { recursive: true });
    // a not-yet-existing file under a real dir is contained
    expect(await realContained(root, path.join(root, "src/new.ts"))).toBe(true);
    // a symlinked directory pointing outside defeats the lexical check
    const outside = ws();
    symlinkSync(outside, path.join(root, "escape"));
    expect(await realContained(root, path.join(root, "escape/x.ts"))).toBe(false);

    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
});

describe("createSecretRedactor", () => {
  it("replaces known secret values anywhere in a payload, ignoring short values", () => {
    const r = createSecretRedactor(["sk-ant-supersecretvalue"]);
    r.add(["ghp_anotherlongtoken12345", "b"]); // "b" is too short → ignored
    const out = r.redact({
      text: "leaked sk-ant-supersecretvalue here",
      nested: ["ghp_anotherlongtoken12345", { k: "safe b value" }],
      num: 7,
    }) as { text: string; nested: [string, { k: string }]; num: number };
    expect(out.text).toBe("leaked [REDACTED] here");
    expect(out.nested[0]).toBe("[REDACTED]");
    expect(out.nested[1].k).toBe("safe b value"); // short "b" not redacted
    expect(out.num).toBe(7);
  });
});
