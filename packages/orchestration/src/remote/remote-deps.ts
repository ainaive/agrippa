import { EXECUTOR_CATALOG, isExecutorId, requiredExecutorIds } from "@agrippa/core";
import type { runs } from "@agrippa/db";
import type { Executor, ExecutorCapabilities } from "@agrippa/executor-core";
import type { EngineDeps } from "../engine/deps";
import { RemoteExecutor } from "./remote-executor";
import { RemoteWorkspaceManager } from "./remote-workspace";
import type { RuntimeRow } from "./routing";

const NO_CAPABILITIES: ExecutorCapabilities = {
  subagents: false,
  mcp: false,
  skills: false,
  resume: false,
  streaming: false,
};

/**
 * Per-run EngineDeps for a daemon-routed run: every executor slot binds a
 * RemoteExecutor proxy (capabilities from the static catalog; env auth from
 * the DAEMON's advertisement, so the engine's pre-claim auth gate evaluates
 * the machine that will actually execute), and the workspace manager becomes
 * the remote variant. Everything else — db, bus, artifacts, scm, resources —
 * stays the platform's: quotas, checkpoints, audit, and publication never
 * left (ADR-0017 Decision 1).
 */
export function remoteEngineDeps(
  base: EngineDeps,
  run: typeof runs.$inferSelect,
  runtime: RuntimeRow,
): EngineDeps {
  const workspace = new RemoteWorkspaceManager(base.db, runtime.id);
  const ads = new Map((runtime.executors ?? []).map((e) => [e.id, e]));
  const executors: Record<string, Executor> = {};
  for (const executorId of requiredExecutorIds(run)) {
    const capabilities = isExecutorId(executorId)
      ? EXECUTOR_CATALOG[executorId].capabilities
      : (base.executors[executorId]?.capabilities ?? NO_CAPABILITIES);
    const envAuthProviders = ads.get(executorId)?.envAuthProviders;
    executors[executorId] = new RemoteExecutor({
      db: base.db,
      runtimeId: runtime.id,
      executorId,
      capabilities,
      ...(envAuthProviders !== undefined ? { envAuthProviders } : {}),
      workspaceSpec: () => workspace.workspaceSpec(run.id),
      logger: base.logger,
    });
  }
  return { ...base, workspace, executors };
}
