import { hostname } from "node:os";
import path from "node:path";
import { createClaudeExecutor } from "@agrippa/executor-claude";
import { createCodexExecutor, probeCodexCli } from "@agrippa/executor-codex";
import type { Executor, Logger } from "@agrippa/executor-core";
import { HttpDaemonApi } from "./client";
import { loadConfig } from "./config";
import { DaemonRunner } from "./runner";

const logger: Logger = {
  info: (msg, extra) => console.log(`[daemon] ${msg}`, extra ?? ""),
  warn: (msg, extra) => console.warn(`[daemon] ${msg}`, extra ?? ""),
  error: (msg, extra) => console.error(`[daemon] ${msg}`, extra ?? ""),
};

const config = await loadConfig();
// per-run workspaces under the daemon's own root, not the system temp dir
process.env.WORKSPACE_ROOT = config.workspaceRoot;

// Detect what THIS machine can execute — the advertisement routing scores.
// The compiled binary embeds the Agent SDK's JS but NOT its native claude
// executable (a platform-specific optional dependency bun's compiler cannot
// bundle), so claude registers only when the machine's own Claude Code CLI
// is discoverable — CLAUDE_CODE_EXECUTABLE, then PATH. A source-run daemon
// (dev: `bun apps/daemon/src/index.ts`) still has node_modules and falls
// back to the SDK's bundled executable. Codex probes its CLI the same way
// the worker does.
const compiled = path.basename(process.execPath) !== "bun";
const claudeExecutablePath = process.env.CLAUDE_CODE_EXECUTABLE ?? Bun.which("claude") ?? undefined;
const executors: Record<string, Executor> = {};
if (claudeExecutablePath || !compiled) {
  executors["claude-agent-sdk"] = createClaudeExecutor(undefined, { claudeExecutablePath });
  if (claudeExecutablePath) logger.info(`claude executor uses ${claudeExecutablePath}`);
} else {
  logger.info(
    "claude executor not available (no `claude` CLI found — install Claude Code or set CLAUDE_CODE_EXECUTABLE)",
  );
}
const codexProbe = probeCodexCli();
if (codexProbe.ok) {
  executors["codex-cli"] = createCodexExecutor();
  logger.info(`codex executor detected (${codexProbe.version})`);
} else {
  logger.info(`codex executor not available (${codexProbe.reason})`);
}

const runner = new DaemonRunner({
  api: new HttpDaemonApi(config.serverUrl, config.token),
  executors,
  hostname: hostname(),
  version: process.env.AGRIPPA_VERSION ?? undefined,
  logger,
});

const shutdown = (signal: string) => {
  logger.info(`${signal} — aborting in-flight dispatch and exiting`);
  // in-flight dispatches abort; their fail() report tells the server to
  // redispatch (template retry policy applies server-side)
  runner.stop();
  setTimeout(() => process.exit(0), 2_000);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

logger.info(`agrippa-daemon connecting to ${config.serverUrl}`);
await runner.start();
