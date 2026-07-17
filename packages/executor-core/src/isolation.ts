import path from "node:path";

/**
 * Execution-isolation seam (docs/design/03 §Sandboxing, ADR-0005).
 *
 * One enforceable place for the workspace containment rules the SDK adapter
 * applies to every tool call, plus the environment-scrubbing rule for the
 * subprocess it spawns. Kept pure and synchronous so the same logic backs the
 * adapter and its tests — the adapter must not re-implement any of it.
 *
 * What this layer can and cannot do: it statically contains the file-writing
 * tools (Write/Edit/NotebookEdit) and refuses shell in read-only workspaces.
 * It does **not** contain arbitrary writes a shell command makes in a
 * read-write workspace — that requires OS-level isolation (the SDK `sandbox`
 * option / a non-root worker / a container), layered on top by the adapter.
 */

export type WorkspaceAccess = "readOnly" | "readWrite";

/** Artifact convention directory (relative to the workspace root). */
export const ARTIFACT_SUBDIR = ".agrippa/artifacts";

/** Tools that write to the filesystem through a file_path / path arg. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** Tools that execute arbitrary commands (uncontainable by static rules). */
const EXEC_TOOLS = new Set(["Bash", "BashOutput", "KillShell", "KillBash"]);

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
 *   shell is allowed (contained by the OS sandbox when available).
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
    const target = (input.file_path ?? input.path ?? input.notebook_path) as string | undefined;
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

  return { behavior: "allow" };
}

/**
 * Environment variables that must never reach the agent subprocess: leaking
 * `AGRIPPA_SECRET_KEY` decrypts every stored credential, and the datastore
 * URLs grant direct access to run/tenant data. The Anthropic/Claude vars the
 * SDK needs to authenticate are preserved.
 */
const SECRET_ENV_KEYS = new Set([
  "AGRIPPA_SECRET_KEY",
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "REDIS_URL",
]);

/** Heuristic secret-name match, minus the Anthropic/Claude auth vars we keep. */
function looksSecret(key: string): boolean {
  if (/^(ANTHROPIC_|CLAUDE_)/.test(key)) return false;
  return /(SECRET|PASSWORD|PRIVATE_KEY|_TOKEN$|_KEY$)/i.test(key);
}

/**
 * Build the subprocess environment for the agent, dropping platform secrets.
 * The SDK's `env` option REPLACES the child environment wholesale, so we start
 * from the worker env and remove what the agent must not see, rather than
 * allow-listing (which would starve the CLI of PATH/HOME/locale it needs).
 */
export function buildScrubbedEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (SECRET_ENV_KEYS.has(key) || looksSecret(key)) continue;
    out[key] = value;
  }
  return out;
}
