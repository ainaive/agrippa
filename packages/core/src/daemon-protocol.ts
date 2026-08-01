import { z } from "zod";

/**
 * Wire contract for remote runtime daemons (ADR-0017 Decision 3). Lives in
 * core because both sides need it and the daemon may import neither
 * `@agrippa/db` nor `@agrippa/orchestration` (dependency direction).
 */

/**
 * Protocol hints served by `register`: the daemon paces itself from these
 * rather than hardcoding cadences, so the server can retune a fleet without
 * shipping new binaries.
 */
export const DAEMON_PROTOCOL_HINTS = {
  /** Server-side long-poll bound for `claim` (under common 30s proxy timeouts). */
  claimWaitSec: 25,
  /** Idle liveness cadence; the 60s routing window tolerates three misses. */
  heartbeatSec: 15,
  /**
   * Max gap between event batches during an active dispatch — an empty batch
   * is a keepalive. Abort rides batch responses, so this bounds abort latency.
   */
  keepaliveSec: 5,
} as const;

export type DaemonProtocolHints = {
  claimWaitSec: number;
  heartbeatSec: number;
  keepaliveSec: number;
};

/**
 * Executor ids a daemon may advertise. Advertised ids become pg-boss queue
 * name segments on every worker (`run.execute.<ids joined by '.'>`), so the
 * charset must stay inside pg-boss's `[\w.\-/]` with `.` excluded (it is the
 * joiner) — an unconstrained id would crash queue creation fleet-wide.
 */
export const EXECUTOR_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const daemonExecutorAdSchema = z.object({
  id: z.string().regex(EXECUTOR_ID_PATTERN, "executor id must match [a-z0-9][a-z0-9_-]{0,63}"),
  envAuthProviders: z.array(z.string().min(1).max(100)).max(20).optional(),
});

export const daemonRegisterSchema = z.object({
  hostname: z.string().min(1).max(255),
  version: z.string().max(100).nullish(),
  executors: z.array(daemonExecutorAdSchema).max(16),
});
export type DaemonRegisterBody = z.infer<typeof daemonRegisterSchema>;

export const daemonHeartbeatSchema = z.object({
  /** Dispatches the daemon is still executing — bumps their contact deadline. */
  activeDispatchIds: z.array(z.uuid()).max(64).default([]),
});
export type DaemonHeartbeatBody = z.infer<typeof daemonHeartbeatSchema>;

// ── Dispatch wire types ───────────────────────────────────────────────────────

/** Bounds for one events POST; an empty batch is a legal keepalive. */
export const DISPATCH_EVENT_BATCH_MAX_EVENTS = 100;
export const DISPATCH_EVENT_BATCH_MAX_BYTES = 256 * 1024;
/** Total skills content shipped inline per dispatch (skills are small text). */
export const DISPATCH_SKILLS_MAX_BYTES = 1024 * 1024;

/**
 * Symbolic path placeholder: the server builds the request with this token
 * where daemon-local absolute paths belong (workspaceDir, writeRoot,
 * skills[].localPath); the daemon rewrites it to its real workspace directory
 * before invoking the executor.
 */
export const DISPATCH_WORKSPACE_PLACEHOLDER = "${workspaceDir}";

export type DispatchWorkspaceSpec = {
  /** Clone URL WITHOUT platform credentials — the daemon uses its machine's ambient git auth. */
  repoUrl: string;
  ref?: string;
  /**
   * The SERVER-pinned base commit (resolved by ls-remote at checkout). The
   * daemon must materialize exactly this commit, and publication applies the
   * approved patch against exactly this commit — a daemon-chosen base could
   * smuggle any other reachable commit's contents past the approval.
   */
  baseSha: string;
  access: "readOnly" | "readWrite";
  /** Platform-created work branch the daemon checks out (git.branch ran centrally). */
  workBranch?: string;
};

export type DispatchSkillContent = {
  slug: string;
  version: string;
  /**
   * Workspace-relative directory the files belong in — derived from the
   * resolved skill's actual localPath, so the daemon reproduces the central
   * materializer's layout exactly (namespaced slugs use the basename:
   * `builtin/git-workflow` lives at `.claude/skills/git-workflow`) and the
   * request's `skills[].localPath` always points at real files.
   */
  dir: string;
  files: Array<{ path: string; contentBase64: string }>;
};

/**
 * What crosses the wire for one step execution: the serialized
 * StepExecutionRequest (paths symbolic, no providerAuth — routing guarantees
 * central execution for credentialed runs), the workspace spec, and inline
 * skill content (the daemon cannot read the platform database).
 */
export type DispatchPayload = {
  /** Which of the daemon's executors runs this step. */
  executorId: string;
  request: Record<string, unknown>;
  workspace: DispatchWorkspaceSpec | null;
  skills: DispatchSkillContent[];
};

export type ClaimedDispatch = {
  id: string;
  runId: string;
  payload: DispatchPayload;
};

export type DaemonClaimResponse = {
  dispatch: ClaimedDispatch | null;
  /** Piggybacked abort flags for this runtime's other live dispatches. */
  abortedDispatchIds: string[];
};

export const dispatchEventBatchSchema = z.object({
  batch: z
    .array(
      z.object({
        seq: z.number().int().min(1),
        event: z.record(z.string(), z.unknown()),
      }),
    )
    .max(DISPATCH_EVENT_BATCH_MAX_EVENTS),
});
export type DispatchEventBatch = z.infer<typeof dispatchEventBatchSchema>;

export const dispatchCompleteSchema = z.object({
  /** Clone-base sha the daemon's workspace checked out (repo runs only). */
  baseSha: z.string().max(80).optional(),
  /** The daemon's staged snapshot tree (informational; server never trusts it). */
  treeSha: z.string().max(80).optional(),
});
export type DispatchCompleteBody = z.infer<typeof dispatchCompleteSchema>;

export const dispatchFailSchema = z.object({
  code: z.string().min(1).max(100),
  message: z.string().max(2000),
});
export type DispatchFailBody = z.infer<typeof dispatchFailSchema>;

/** Reserved artifact key carrying the evidence patch (workspace diff). */
export const DISPATCH_EVIDENCE_KEY = ".workspace-diff";
