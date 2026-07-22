import { spawnSync } from "node:child_process";

/**
 * Probe the Codex CLI. Returns its version string, or null when the binary is
 * missing/broken — the worker registers the executor only on success.
 */
export function probeCodexCli(command: string[] = ["codex"]): string | null {
  try {
    const result = spawnSync(command[0] as string, [...command.slice(1), "--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status !== 0) return null;
    const version = result.stdout.trim();
    return version.length > 0 ? version : null;
  } catch {
    return null;
  }
}
