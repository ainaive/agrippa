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
  /**
   * Whether a previously checked-out workspace is actually present here.
   * Workspaces are host-local; a resume that landed on a different host sees
   * a succeeded checkout step but no repository, and must fail fast rather
   * than run against an empty directory.
   */
  isIntact(runId: string): Promise<boolean>;
  cleanup(runId: string): Promise<void>;
}

export interface ResourceMaterializer {
  /**
   * Remove executor project configuration left by a prior agent invocation.
   * Called before every attempt/resume, before trusted skills are materialized.
   */
  prepareWorkspace(workspaceDir: string): Promise<void>;
  /** Materialize the step's skills into the workspace; missing = unregistered or no active version. */
  skills(
    refs: string[],
    workspaceDir: string,
  ): Promise<{ resolved: ResolvedSkill[]; missing: string[] }>;
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

export type PullRequestSpec = {
  /** The run's project — the repo credential is loaded scoped to it. */
  projectId: string;
  /** Resolved repoRef input value (same shape as WorkspaceSpec.repo). */
  repo: unknown;
  head: string;
  base: string;
  title: string;
  body: string;
};

export type PushSpec = {
  projectId: string;
  repo: unknown;
  branch: string;
  /** Exact patch evidence approved by the workflow, when one exists. */
  expectedPatch?: string;
};

export type PushResult = { status: "pushed"; commitSha: string } | { status: "evidence_mismatch" };

/**
 * Platform-side git write-path (ADR-0011): branch creation before the
 * implementer runs, credentialed push, and PR creation via the provider REST
 * API — deterministic, never delegated to an agent.
 */
export interface ScmService {
  /** `git checkout -b <name>` inside the run workspace. */
  createBranch(runId: string, name: string): Promise<void>;
  /**
   * Publish one platform-owned snapshot commit using the stored credential.
   * Evidence mismatch is a typed result; operational failures reject.
   */
  push(runId: string, spec: PushSpec): Promise<PushResult>;
  /** Open a PR/MR; returns its web URL. */
  openPullRequest(runId: string, spec: PullRequestSpec): Promise<{ url: string }>;
}

export type EngineDeps = {
  db: Db;
  executors: Record<string, Executor>;
  bus: RunEventBus;
  workspace: WorkspaceManager;
  resources: ResourceMaterializer;
  artifacts: ArtifactStore;
  /** Required for templates using git.branch / git.push / pr.open steps. */
  scm?: ScmService;
  logger: Logger;
};

export type RunOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "waiting_approval"
  | "already_terminal";
