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
  /**
   * This run is finished with the workspace (ADR-0018 Decision 4). NOT a
   * delete: the directory is owned by the workspace key, which a follow-up
   * inherits, so the engine stamps an expiry and the collector removes it once
   * every run sharing the key has released it. Implementations drop only what
   * belongs to this run alone — a remote run's local staging dir, say.
   */
  release(runId: string): Promise<void>;
}

/**
 * Deterministic provider-credential misconfiguration (e.g. a base URL whose
 * host resolves to private address space) — or, with an explicit code, any
 * credential condition that must fail the run rather than retry (a project
 * credential resolving for a daemon-routed run, ADR-0017 Decision 7). The
 * engine converts this into a run failure with the carried code.
 */
export class ProviderCredentialError extends Error {
  constructor(
    message: string,
    readonly code: string = "base_url_invalid",
  ) {
    super(message);
    this.name = "ProviderCredentialError";
  }
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
  /**
   * Whether the project has a usable stored credential row + secret for this
   * provider. This presence-only probe must not resolve endpoints or decrypt
   * the key; it is safe to call before a worker claims the run.
   */
  hasProviderCredential(projectId: string, provider: string): Promise<boolean>;
  /**
   * The project's decrypted credential for a model provider, or null when the
   * project has none (worker env auth then applies). Materialized fresh per
   * step and registered with the redactor before it reaches a request.
   */
  providerCredential(
    projectId: string,
    provider: string,
  ): Promise<{ apiKey: string; baseUrl?: string } | null>;
}

export type StoredArtifact = {
  inline: unknown | null;
  storageRef: string | null;
  size: number;
  mime: string | null;
  /**
   * Hex sha256 of the stored bytes, computed at store time. The integrity
   * anchor for patch evidence at git.push: it lives in Postgres, which agent
   * subprocesses are never given credentials for, while the disk store shares
   * a writable volume with them. Posture-level tamper resistance, not an
   * integrity boundary — an agent that recovers worker credentials can reach
   * the database anyway (see the sandboxing residual in docs/design/08).
   * Null only for empty stores.
   */
  sha256: string | null;
};

export interface ArtifactStore {
  /**
   * Persist artifact content (inline value or a workspace-relative file path).
   * `opts.inlineLimitBytes` overrides the store's inline threshold — the
   * engine passes INTERACTION_ARTIFACT_MAX_BYTES for checkpoint-driving
   * artifacts, which must inline whole (resume re-reads them from the DB row).
   */
  store(
    runId: string,
    key: string,
    kind: ArtifactKind,
    source: { inline?: unknown; path?: string; staged?: string },
    workspaceDir: string,
    opts?: { inlineLimitBytes?: number },
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
  /**
   * Execution-lease identity (ADR-0017 Decision 4). Workers pass their
   * container id so renewal and release can target every run they hold.
   * Absent (tests, ad-hoc callers), each engine claims under a random
   * per-instance owner — leases still serialize execution, only cross-process
   * renewal is unavailable.
   */
  lease?: { owner: string; ttlMs?: number };
};

export type RunOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "waiting_approval"
  /** Deliberately released mid-run (drain / lost lease): nothing finalized, resume elsewhere. */
  | "drained"
  | "already_terminal";

/**
 * Handle to a live engine, surfaced through executeRun's `onStarted` callback
 * once the run claim succeeds. Both triggers abort in-flight executor work
 * WITHOUT finalizing the run — the in-flight step is recorded like a crash so
 * the next owner resumes step-granularly with the executor session id.
 */
export type RunControlHandle = {
  /** Graceful shutdown: stop this run here; it re-enqueues immediately. */
  drain(): void;
  /** Lease renewal failed: another owner may exist; stop without re-enqueue. */
  lostLease(): void;
};
