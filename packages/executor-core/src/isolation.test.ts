import { describe, expect, it } from "bun:test";
import path from "node:path";
import { buildScrubbedEnv, evaluateToolCall, isWithin } from "./isolation";

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
  it("drops platform secrets but keeps Anthropic auth and system vars", () => {
    const env = buildScrubbedEnv({
      PATH: "/usr/bin",
      HOME: "/home/bun",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      AGRIPPA_SECRET_KEY: "master",
      DATABASE_URL: "postgres://secret",
      BETTER_AUTH_SECRET: "s",
      REDIS_URL: "redis://x",
      GITHUB_TOKEN: "ghp_x",
      SOME_PASSWORD: "p",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/bun");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
    expect(env.AGRIPPA_SECRET_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SOME_PASSWORD).toBeUndefined();
  });
});
