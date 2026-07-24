import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildScrubbedEnv,
  createSecretRedactor,
  effectiveBaseUrl,
  evaluateToolCall,
  isWithin,
  overlayProviderAuth,
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
  it("allow-lists only SDK auth + system vars, dropping everything else", () => {
    const env = buildScrubbedEnv({
      PATH: "/usr/bin",
      HOME: "/home/bun",
      LANG: "en_US.UTF-8",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      AGRIPPA_SECRET_KEY: "master",
      DATABASE_URL: "postgres://secret",
      BETTER_AUTH_SECRET: "s",
      REDIS_URL: "redis://x",
      GITHUB_TOKEN: "ghp_x",
      SOME_PASSWORD: "p",
      ANTHROPIC_PRIVATE_KEY: "leak",
      CLAUDE_ADMIN_TOKEN: "leak",
      // a code-injection vector that a name-heuristic denylist would have missed
      NODE_OPTIONS: "--require /tmp/evil.js",
      // an arbitrary non-secret var still must not pass through
      SOME_INTERNAL_URL: "http://internal",
    });
    // kept: system essentials + explicit SDK auth
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/bun");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
    // dropped: secrets, namespaced secrets, NODE_OPTIONS, and any unlisted var
    expect(env.AGRIPPA_SECRET_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SOME_PASSWORD).toBeUndefined();
    expect(env.ANTHROPIC_PRIVATE_KEY).toBeUndefined();
    expect(env.CLAUDE_ADMIN_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.SOME_INTERNAL_URL).toBeUndefined();
  });
});

describe("overlayProviderAuth", () => {
  const scrubbed = () =>
    buildScrubbedEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-worker-env",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-worker-env",
      OPENAI_API_KEY: "sk-openai-worker-env",
      CODEX_HOME: "/home/worker/.codex",
    });

  it("is a no-op without a credential (worker env fallback)", () => {
    const env = scrubbed();
    expect(overlayProviderAuth(env, undefined, "anthropic")).toBe(env);
  });

  it("project credential wins: the whole protocol auth family is replaced", () => {
    const env = overlayProviderAuth(
      scrubbed(),
      { provider: "dashscope", apiKey: "sk-bailian-project" },
      "anthropic",
    );
    // gateway credential → bearer token + catalog default base URL
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-bailian-project");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://dashscope.aliyuncs.com/apps/anthropic");
    // every other family member is gone — nothing for the SDK to prefer
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    // the openai family and system vars are untouched
    expect(env.OPENAI_API_KEY).toBe("sk-openai-worker-env");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("native anthropic credential uses ANTHROPIC_API_KEY with no base URL", () => {
    const env = overlayProviderAuth(
      scrubbed(),
      { provider: "anthropic", apiKey: "sk-ant-project" },
      "anthropic",
    );
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-project");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("row baseUrl overrides the catalog default (regional endpoint)", () => {
    const env = overlayProviderAuth(
      scrubbed(),
      {
        provider: "dashscope",
        apiKey: "sk-bailian-intl",
        baseUrl: "https://ws-1.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
      },
      "anthropic",
    );
    expect(env.ANTHROPIC_BASE_URL).toBe(
      "https://ws-1.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
    );
  });

  it("openai protocol clears CODEX_HOME so ambient codex auth cannot outrank", () => {
    const env = overlayProviderAuth(
      scrubbed(),
      { provider: "openai", apiKey: "sk-openai-project", baseUrl: "https://proxy.example.com/v1" },
      "openai",
    );
    expect(env.OPENAI_API_KEY).toBe("sk-openai-project");
    expect(env.OPENAI_BASE_URL).toBe("https://proxy.example.com/v1");
    expect(env.CODEX_HOME).toBeUndefined();
    // the anthropic family is untouched
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-worker-env");
  });

  it("unknown provider gets the key with no base URL default", () => {
    const env = overlayProviderAuth(
      scrubbed(),
      { provider: "some-gateway", apiKey: "sk-gateway" },
      "openai",
    );
    expect(env.OPENAI_API_KEY).toBe("sk-gateway");
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });
});

describe("effectiveBaseUrl", () => {
  it("prefers the row override, falls back to the catalog default", () => {
    expect(effectiveBaseUrl({ provider: "dashscope", apiKey: "k" }, "anthropic")).toBe(
      "https://dashscope.aliyuncs.com/apps/anthropic",
    );
    expect(
      effectiveBaseUrl({ provider: "dashscope", apiKey: "k", baseUrl: "https://x" }, "anthropic"),
    ).toBe("https://x");
    expect(effectiveBaseUrl({ provider: "anthropic", apiKey: "k" }, "anthropic")).toBeUndefined();
    expect(effectiveBaseUrl(undefined, "anthropic")).toBeUndefined();
  });

  it("never applies an override to a protocol the provider does not serve", () => {
    // dashscope is anthropic-protocol only — even an explicit row override
    // must not leak onto the openai family (one baseUrl, one protocol)
    expect(effectiveBaseUrl({ provider: "dashscope", apiKey: "k" }, "openai")).toBeUndefined();
    expect(
      effectiveBaseUrl({ provider: "dashscope", apiKey: "k", baseUrl: "https://x" }, "openai"),
    ).toBeUndefined();
    // unknown providers carry no restriction
    expect(
      effectiveBaseUrl({ provider: "some-gateway", apiKey: "k", baseUrl: "https://x" }, "openai"),
    ).toBe("https://x");
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
