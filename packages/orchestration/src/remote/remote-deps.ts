import { EXECUTOR_CATALOG, isExecutorId, requiredExecutorIds } from "@agrippa/core";
import { type Db, mcpServers, type runs } from "@agrippa/db";
import type {
  Executor,
  ExecutorCapabilities,
  ResolvedMcpServer,
  ResolvedSkill,
} from "@agrippa/executor-core";
import { and, inArray, isNotNull } from "drizzle-orm";
import {
  type EngineDeps,
  ProviderCredentialError,
  type ResourceMaterializer,
} from "../engine/deps";
import { RemoteExecutor } from "./remote-executor";
import { RemoteWorkspaceManager } from "./remote-workspace";
import type { RuntimeRow } from "./routing";

/**
 * Fail-closed secret boundary for daemon-routed runs (ADR-0017 Decision 7).
 * Routing excludes runs that resolve platform-held secrets, but the pin is
 * absolute: a credential added while a run is paused would otherwise be
 * materialized per-step (the ADR-0013 freshness contract) and serialized to
 * the daemon. This wrapper is the enforcement at the resolution boundary:
 *
 * - a project provider credential resolving for a daemon-routed run fails
 *   the run typed (`provider_credential_unroutable`) — shipping it would
 *   leak a platform secret; silently ignoring it would invert ADR-0013's
 *   "project credential wins" precedence. Neither is acceptable.
 * - an authorized MCP server with platform-held auth reports as *missing*
 *   ("the platform will not provide this resource on this host"): required →
 *   typed step failure, optional → dropped, matching resource semantics.
 */
class RemoteResourceGuard implements ResourceMaterializer {
  constructor(
    private readonly inner: ResourceMaterializer,
    private readonly db: Db,
  ) {}

  prepareWorkspace(workspaceDir: string): Promise<void> {
    return this.inner.prepareWorkspace(workspaceDir);
  }

  skills(
    refs: string[],
    workspaceDir: string,
  ): Promise<{ resolved: ResolvedSkill[]; missing: string[] }> {
    return this.inner.skills(refs, workspaceDir);
  }

  async mcpServers(refs: string[]): Promise<{ resolved: ResolvedMcpServer[]; missing: string[] }> {
    if (refs.length === 0) return this.inner.mcpServers(refs);
    const authed = await this.db
      .select({ slug: mcpServers.slug })
      .from(mcpServers)
      .where(and(inArray(mcpServers.slug, refs), isNotNull(mcpServers.authSecretRef)));
    const blocked = new Set(authed.map((r) => r.slug));
    if (blocked.size === 0) return this.inner.mcpServers(refs);
    const result = await this.inner.mcpServers(refs.filter((ref) => !blocked.has(ref)));
    return {
      resolved: result.resolved,
      missing: [
        ...result.missing,
        ...[...blocked].map(
          (slug) => `${slug} (platform-held MCP auth cannot ship to a remote runtime)`,
        ),
      ],
    };
  }

  async providerCredential(
    projectId: string,
    provider: string,
  ): Promise<{ apiKey: string; baseUrl?: string } | null> {
    const credential = await this.inner.providerCredential(projectId, provider);
    if (credential) {
      throw new ProviderCredentialError(
        `project credential for provider '${provider}' cannot ship to a remote runtime — ` +
          "this run is pinned to a daemon; cancel and retry the task to re-route centrally",
        "provider_credential_unroutable",
      );
    }
    return null;
  }

  hasProviderCredential(projectId: string, provider: string): Promise<boolean> {
    return this.inner.hasProviderCredential(projectId, provider);
  }
}

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
  const resources = new RemoteResourceGuard(base.resources, base.db);
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
  return { ...base, workspace, resources, executors };
}
