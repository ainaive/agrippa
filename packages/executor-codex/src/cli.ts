import { spawnSync } from "node:child_process";

export type CodexProbe = { ok: true; version: string } | { ok: false; reason: string };

/**
 * Probe the Codex CLI. Registration requires not just a working binary but a
 * version that supports the config-isolation flags — an older CLI would fail
 * every step on "unexpected argument", and silently running WITHOUT
 * `--ignore-user-config` is the vulnerability the flag exists to close.
 */
export function probeCodexCli(command: string[] = ["codex"]): CodexProbe {
  const bin = command[0] as string;
  try {
    const version = spawnSync(bin, [...command.slice(1), "--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (version.status !== 0) return { ok: false, reason: "codex --version failed" };
    const versionString = version.stdout.trim();
    if (versionString.length === 0) return { ok: false, reason: "codex --version was empty" };

    const help = spawnSync(bin, [...command.slice(1), "exec", "--help"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (help.status !== 0) return { ok: false, reason: "codex exec --help failed" };
    for (const flag of ["--ignore-user-config", "--ignore-rules"]) {
      if (!help.stdout.includes(flag)) {
        return { ok: false, reason: `codex CLI too old: no ${flag} support` };
      }
    }
    return { ok: true, version: versionString };
  } catch (err) {
    return { ok: false, reason: `codex CLI missing: ${String(err).slice(0, 200)}` };
  }
}
