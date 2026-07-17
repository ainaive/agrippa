import type { ArtifactKind } from "@agrippa/core";
import type { Db } from "@agrippa/db";
import type { Executor, Logger, ResolvedMcpServer, ResolvedSkill } from "@agrippa/executor-core";
import type { RunEventBus } from "./bus";

/**
 * Everything environment-specific the engine needs, injected so the engine
 * integration suite runs against fakes and the worker wires the real thing.
 */

export type WorkspaceSpec = {
  /** Resolved repoRef input value (e.g. { repoConnectionId }). */
  repo: unknown;
  ref?: string;
  access: "readOnly" | "readWrite";
  /** The run's project — repo connections are loaded scoped to it, never by raw id. */
  projectId: string;
};

export interface WorkspaceManager {
  /** Scratch directory for the run; must be idempotent across resume. */
  ensureDir(runId: string): Promise<string>;
  /** Clone the repo into the run directory (system step workspace.checkout). */
  checkout(runId: string, spec: WorkspaceSpec): Promise<void>;
  /** git diff against the checkout base — engine-side patch artifacts. */
  diff(runId: string): Promise<string>;
  /** Empty the artifact convention dir before an attempt, so a failed attempt's
   *  stale file can't be re-collected by a later successful attempt. */
  clearArtifacts(runId: string): Promise<void>;
  cleanup(runId: string): Promise<void>;
}

export interface ResourceMaterializer {
  /** Materialize the step's skills into the workspace; returns their disk locations. */
  skills(refs: string[], workspaceDir: string): Promise<ResolvedSkill[]>;
  /** Resolve step MCP refs against the registry + secrets; missing = unregistered/disabled. */
  mcpServers(refs: string[]): Promise<{ resolved: ResolvedMcpServer[]; missing: string[] }>;
}

export type StoredArtifact = {
  inline: unknown | null;
  storageRef: string | null;
  size: number;
  mime: string | null;
};

export interface ArtifactStore {
  /** Persist artifact content (inline value or a workspace-relative file path). */
  store(
    runId: string,
    key: string,
    kind: ArtifactKind,
    source: { inline?: unknown; path?: string },
    workspaceDir: string,
  ): Promise<StoredArtifact>;
}

export type EngineDeps = {
  db: Db;
  executors: Record<string, Executor>;
  bus: RunEventBus;
  workspace: WorkspaceManager;
  resources: ResourceMaterializer;
  artifacts: ArtifactStore;
  logger: Logger;
};

export type RunOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "waiting_approval"
  | "already_terminal";
