import { realpath } from "node:fs/promises";
import path from "node:path";
import { providerDefaultBaseUrl, type WireProtocol } from "@agrippa/core";
import type { ProviderAuth } from "./types";

/**
 * Execution-isolation seam (docs/design/03 §Sandboxing, ADR-0005).
 *
 * One enforceable place for the workspace containment rules the SDK adapter
 * applies to every tool call, plus the environment-scrubbing rule for the
 * subprocess it spawns. Kept pure and synchronous so the same logic backs the
 * adapter and its tests — the adapter must not re-implement any of it.
 *
 * What this layer can and cannot do: it statically contains the file-writing
 * and file-reading tools (Write/Edit/Read/Grep/Glob) to the workspace and
 * refuses shell in read-only workspaces, and it redacts known secret values
 * from event payloads. It does **not** contain what a shell command reads or
 * writes in a read-write workspace — that requires OS-level isolation (the SDK
 * `sandbox` option / a non-root worker / a container), layered on top by the
 * adapter — and it cannot isolate one run from another at the OS level.
 */

export type WorkspaceAccess = "readOnly" | "readWrite";

/** Artifact convention directory (relative to the workspace root). */
export const ARTIFACT_SUBDIR = ".agrippa/artifacts";

/** Tools that write to the filesystem through a file_path / path arg. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** Tools that read the filesystem through a file_path / path arg. */
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "NotebookRead"]);
/** Tools that execute arbitrary commands (uncontainable by static rules). */
const EXEC_TOOLS = new Set(["Bash", "BashOutput", "KillShell", "KillBash"]);

/** Whether a tool writes to the filesystem through a path argument. */
export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

/** Whether a tool reads the filesystem through a path argument. */
export function isReadTool(toolName: string): boolean {
  return READ_TOOLS.has(toolName);
}

/** The filesystem path argument a tool targets, if any. */
export function pathArgOf(input: Record<string, unknown>): string | undefined {
  return (input.file_path ?? input.path ?? input.notebook_path) as string | undefined;
}

/** @deprecated use {@link pathArgOf}; kept for the write-tool call site. */
export const writeTargetOf = pathArgOf;

export type ToolDecision = { behavior: "allow" } | { behavior: "deny"; message: string };

/**
 * Is `child` the same path as, or nested under, `parent`? Boundary-safe:
 * `/work/run` does NOT contain `/work/run-evil` (the naive `startsWith`
 * prefix test does, which is the bug this replaces).
 */
export function isWithin(parent: string, child: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return c === p || c.startsWith(p + path.sep);
}

/**
 * Decide a single tool call against the workspace policy.
 *
 * - read-only workspace: file writes are confined to the artifact directory
 *   (the agent still has to emit its declared artifacts) and shell is denied;
 * - read-write workspace: file writes must stay within the workspace root;
 *   shell is allowed (contained by the OS sandbox when available);
 * - reads (Read/Grep/Glob) with an explicit path must stay within the workspace,
 *   so the agent can't read `/proc/self/environ`, another run's directory, or the
 *   shared artifact store. A read with no path argument defaults to the cwd
 *   (the workspace) and is allowed.
 */
export function evaluateToolCall(
  policy: { access: WorkspaceAccess; writeRoot: string },
  workspaceDir: string,
  toolName: string,
  input: Record<string, unknown>,
): ToolDecision {
  const writeRoot = path.resolve(policy.writeRoot);

  if (EXEC_TOOLS.has(toolName)) {
    if (policy.access === "readOnly") {
      return {
        behavior: "deny",
        message: `shell commands are not permitted in a read-only workspace (${toolName})`,
      };
    }
    return { behavior: "allow" };
  }

  if (WRITE_TOOLS.has(toolName)) {
    const target = pathArgOf(input);
    if (target === undefined) return { behavior: "allow" };
    const resolved = path.resolve(workspaceDir, target);
    if (!isWithin(writeRoot, resolved)) {
      return {
        behavior: "deny",
        message: `writes outside the run workspace are not permitted (${target})`,
      };
    }
    if (
      policy.access === "readOnly" &&
      !isWithin(path.join(writeRoot, ARTIFACT_SUBDIR), resolved)
    ) {
      return {
        behavior: "deny",
        message: `read-only workspace: writes are confined to ${ARTIFACT_SUBDIR} (${target})`,
      };
    }
  }

  if (READ_TOOLS.has(toolName)) {
    const target = pathArgOf(input);
    if (target === undefined) return { behavior: "allow" }; // defaults to the workspace cwd
    const resolved = path.resolve(workspaceDir, target);
    if (!isWithin(writeRoot, resolved)) {
      return {
        behavior: "deny",
        message: `reads outside the run workspace are not permitted (${target})`,
      };
    }
  }

  return { behavior: "allow" };
}

/**
 * Symlink-safe containment for a read or write target. `evaluateToolCall` is
 * purely lexical, so a symlink component (e.g. `workspace/link -> /app`) would
 * slip a target past it; this canonicalizes the nearest existing ancestor of the
 * target (the file itself may not exist yet, e.g. a fresh write) and confirms it
 * stays inside `root`. Fail-closed on any resolution error.
 */
export async function realContained(root: string, target: string): Promise<boolean> {
  let realRoot: string;
  try {
    realRoot = await realpath(path.resolve(root));
  } catch {
    return false;
  }
  let dir = path.resolve(target);
  for (;;) {
    try {
      const real = await realpath(dir);
      return real === realRoot || real.startsWith(realRoot + path.sep);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return false; // reached filesystem root without a hit
      dir = parent;
    }
  }
}

/**
 * SDK/CLI authentication variables the agent subprocess legitimately needs.
 * Everything else that looks like a secret is dropped, even in the Anthropic /
 * Claude namespaces — so an admin/private variable can't ride along.
 */
const SDK_AUTH_ALLOW = new Set([
  // Anthropic (Claude Agent SDK)
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  // OpenAI (Codex CLI)
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "CODEX_HOME",
]);

/**
 * System variables the CLI/agent legitimately needs (locale, temp dir, TLS trust
 * roots). Notably absent: `NODE_OPTIONS`/`BUN_*`, which can inject code into the
 * subprocess, and anything not enumerated here.
 */
const SYSTEM_ENV_ALLOW = new Set([
  "PATH",
  "HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "TERM",
  "USER",
  "LOGNAME",
  "HOSTNAME",
  "PWD",
  "SHELL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CURL_CA_BUNDLE",
]);

/** Build the non-secret system environment shared by executors and platform tools. */
export function buildSystemEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && SYSTEM_ENV_ALLOW.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Platform secrets whose VALUES are redacted from event payloads (below). The
 * env allow-list already keeps these out of the subprocess; this set feeds the
 * redactor so their values can't be echoed back through SSE either.
 */
const SECRET_ENV_KEYS = new Set([
  "AGRIPPA_SECRET_KEY",
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "REDIS_URL",
]);

/**
 * Build the subprocess environment for the agent. The SDK's `env` option
 * REPLACES the child environment wholesale, so we **allow-list**: only the SDK
 * auth variables and a fixed set of system essentials pass through, and
 * everything else — platform secrets, DSNs, `NODE_OPTIONS`, and any future
 * variable — is dropped. (A denylist would silently forward the next injection
 * vector or credential that doesn't match a name heuristic.)
 */
export function buildScrubbedEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out = buildSystemEnv(source);
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (SDK_AUTH_ALLOW.has(key)) out[key] = value;
  }
  return out;
}

/**
 * The complete auth-var family per wire protocol. overlayProviderAuth deletes
 * the whole family before setting the mapped vars — leaving any member behind
 * would let a worker-env credential outrank the project's (the SDK prefers
 * some vars over others), which inverts the documented precedence.
 */
const PROTOCOL_AUTH_VARS: Record<WireProtocol, readonly string[]> = {
  anthropic: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ],
  openai: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_HOME"],
};

/** The endpoint a credential points at: explicit override ?? catalog default. */
export function effectiveBaseUrl(
  auth: ProviderAuth | undefined,
  protocol: WireProtocol,
): string | undefined {
  if (!auth) return undefined;
  return auth.baseUrl ?? providerDefaultBaseUrl(auth.provider, protocol);
}

/**
 * Apply a project provider credential on top of an already-scrubbed env.
 * The project credential wins by construction: the protocol's auth-var family
 * is removed wholesale, then exactly the mapped vars are set. No-op without
 * a credential, so the worker-env fallback keeps working unchanged.
 */
export function overlayProviderAuth(
  env: Record<string, string>,
  auth: ProviderAuth | undefined,
  protocol: WireProtocol,
): Record<string, string> {
  if (!auth) return env;
  const out = { ...env };
  for (const key of PROTOCOL_AUTH_VARS[protocol]) delete out[key];
  const baseUrl = effectiveBaseUrl(auth, protocol);
  if (protocol === "anthropic") {
    // The native API authenticates with x-api-key (ANTHROPIC_API_KEY);
    // Anthropic-compatible gateways (Bailian) document bearer auth
    // (ANTHROPIC_AUTH_TOKEN).
    if (auth.provider === "anthropic") out.ANTHROPIC_API_KEY = auth.apiKey;
    else out.ANTHROPIC_AUTH_TOKEN = auth.apiKey;
    if (baseUrl !== undefined) out.ANTHROPIC_BASE_URL = baseUrl;
  } else {
    out.OPENAI_API_KEY = auth.apiKey;
    if (baseUrl !== undefined) out.OPENAI_BASE_URL = baseUrl;
  }
  return out;
}

/**
 * Secret VALUES worth redacting from anything the agent can surface (event
 * payloads, tool output). Covers the platform secrets plus the provider auth
 * variables that the subprocess legitimately keeps but must never be echoed
 * back through SSE/the timeline.
 */
export function collectEnvSecretValues(
  source: Record<string, string | undefined> = process.env,
): string[] {
  const keys = [
    ...SECRET_ENV_KEYS,
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
  ];
  return keys
    .map((k) => source[k])
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

export type SecretRedactor = {
  /** Add more secret values to redact (e.g. per-step resolved MCP tokens). */
  add(values: Array<string | undefined>): void;
  /** Deep-replace every known secret value with a placeholder. */
  redact<T>(value: T): T;
};

const REDACTION_PLACEHOLDER = "[REDACTED]";
/** Below this length a "secret" would match innocuous substrings and corrupt output. */
const MIN_SECRET_LEN = 8;

/**
 * Redacts known secret values from event payloads before they are persisted or
 * streamed. Values shorter than {@link MIN_SECRET_LEN} are ignored so a short or
 * empty token can't blank out unrelated text.
 */
export function createSecretRedactor(initial: Array<string | undefined> = []): SecretRedactor {
  const secrets = new Set<string>();
  const add = (values: Array<string | undefined>) => {
    for (const v of values) if (v && v.length >= MIN_SECRET_LEN) secrets.add(v);
  };
  add(initial);
  const redactString = (s: string): string => {
    let out = s;
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTION_PLACEHOLDER);
    }
    return out;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v);
      return out;
    }
    return value;
  };
  return { add, redact: (value) => walk(value) as typeof value };
}
