import { hostname } from "node:os";
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
// The claude executor embeds the Agent SDK (always available in the binary);
// codex only registers when its CLI is usable, same probe as the worker.
const executors: Record<string, Executor> = {
  "claude-agent-sdk": createClaudeExecutor(),
};
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
