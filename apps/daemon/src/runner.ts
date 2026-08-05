import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  type ClaimedDispatch,
  DAEMON_PROTOCOL_HINTS,
  type DaemonProtocolHints,
  DISPATCH_EVENT_BATCH_MAX_BYTES,
  DISPATCH_EVENT_BATCH_MAX_EVENTS,
  DISPATCH_EVIDENCE_KEY,
  DISPATCH_WORKSPACE_PLACEHOLDER,
  type RuntimeFeature,
} from "@agrippa/core";
import type { Executor, ExecutorEvent, Logger, StepExecutionRequest } from "@agrippa/executor-core";
import {
  checkoutFromUrl,
  git,
  removeWorkspace,
  resetAgentProjectConfig,
  stagePlatformSnapshot,
  workspaceDirFor,
  workspaceIntact,
} from "@agrippa/workspace";
import type { DaemonApi } from "./client";

/** Event-batch flush cadence: sub-second UI latency without per-event HTTP. */
const FLUSH_MS = 500;

/**
 * The workspace a dispatch was told to attach to is not here. Carries the code
 * the central engine uses for the same condition, so a run fails identically
 * whichever side noticed (ADR-0018).
 */
class WorkspaceLostError extends Error {
  readonly code = "workspace_lost";
  constructor(workspaceKey: string) {
    super(`workspace ${workspaceKey} is not on this machine — it cannot be continued here`);
    this.name = "WorkspaceLostError";
  }
}

/**
 * What this binary claims at register. Hard-coded rather than derived, because
 * the claim is about THIS build's behaviour: `workspace-key` says the runner
 * below keys directories by `payload.workspaceKey`, so the server may send a
 * follow-up here knowing it will continue the right workspace rather than
 * clone a fresh one and call it success (ADR-0018).
 */
const DAEMON_FEATURES: readonly RuntimeFeature[] = ["workspace-key"];

export type RunnerOpts = {
  api: DaemonApi;
  executors: Record<string, Executor>;
  hostname: string;
  version?: string;
  logger: Logger;
  /** Overridable for tests. */
  flushMs?: number;
};

/**
 * The daemon's claim–execute–report loop (ADR-0017): register with the
 * capability advertisement, long-poll `claim`, execute each dispatch with the
 * embedded executor packages against a locally owned workspace, and stream
 * events back in sequence-numbered batches. Abort arrives on batch/claim
 * responses — an empty keepalive batch every `hints.keepaliveSec` bounds the
 * latency. `complete` means the executor stream ended cleanly (success OR a
 * step.failed event — the event carries the outcome); `fail` is reserved for
 * transport-level death (executor threw, workspace unusable), which the
 * server synthesizes into a typed step failure.
 */
export class DaemonRunner {
  private hints: DaemonProtocolHints = DAEMON_PROTOCOL_HINTS;
  private stopped = false;
  private readonly activeAborts = new Map<string, AbortController>();
  /** Workspaces being executed in right now — never reap one of these. */
  private readonly activeWorkspaceKeys = new Set<string>();
  /**
   * Already deleted this process, and when — so a workspace named on every
   * poll for the rest of its 24-hour window costs a lookup rather than an
   * `rm -rf` each time, and the map is pruned to that window rather than
   * growing with the daemon's uptime (a laptop daemon runs for weeks). A
   * restart simply re-reaps, a no-op.
   */
  private readonly reaped = new Map<string, number>();
  /** The server's own reap window — past it, remembering a key buys nothing. */
  private static readonly REAP_MEMORY_MS = 24 * 60 * 60 * 1000;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: RunnerOpts) {}

  async register(): Promise<void> {
    const { runtimeId, hints } = await this.opts.api.register({
      hostname: this.opts.hostname,
      version: this.opts.version ?? null,
      executors: Object.entries(this.opts.executors).map(([id, executor]) => ({
        id,
        ...(executor.envAuthProviders ? { envAuthProviders: [...executor.envAuthProviders] } : {}),
      })),
      // What THIS build can do, not what the protocol knows how to ask for:
      // the server refuses work whose correctness depends on a claim this
      // binary cannot make (ADR-0018).
      features: [...DAEMON_FEATURES],
    });
    this.hints = hints;
    this.opts.logger.info(`registered as runtime ${runtimeId}`, {
      executors: Object.keys(this.opts.executors),
    });
  }

  /** Register, then claim–execute until stop(). One dispatch at a time. */
  async start(): Promise<void> {
    await this.register();
    this.heartbeatTimer = setInterval(() => {
      this.opts.api
        .heartbeat([...this.activeAborts.keys()])
        .catch((err) => this.opts.logger.warn("heartbeat failed", { err: String(err) }));
    }, this.hints.heartbeatSec * 1000);

    while (!this.stopped) {
      let claim: Awaited<ReturnType<DaemonApi["claim"]>>;
      try {
        claim = await this.opts.api.claim(this.hints.claimWaitSec);
      } catch (err) {
        this.opts.logger.warn("claim failed — backing off", { err: String(err) });
        await Bun.sleep(5_000);
        continue;
      }
      for (const dispatchId of claim.abortedDispatchIds) {
        this.activeAborts.get(dispatchId)?.abort("server requested abort");
      }
      await this.reapWorkspaces(claim.reapableWorkspaceKeys ?? []);
      if (claim.dispatch) await this.executeDispatch(claim.dispatch);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const controller of this.activeAborts.values()) {
      controller.abort("daemon shutting down");
    }
  }

  async executeDispatch(dispatch: ClaimedDispatch): Promise<void> {
    const { api, logger } = this.opts;
    const controller = new AbortController();
    this.activeAborts.set(dispatch.id, controller);
    this.activeWorkspaceKeys.add(dispatch.payload.workspaceKey ?? dispatch.runId);
    try {
      const executor = this.opts.executors[dispatch.payload.executorId];
      if (!executor) {
        throw new Error(`executor '${dispatch.payload.executorId}' is not available here`);
      }

      // Directories are keyed by workspace, not by run (ADR-0018 Decision 3):
      // a follow-up inherits its parent's key so it continues that work rather
      // than cloning beside it. Equal to the run id for every other run.
      const runId = dispatch.runId;
      const workspaceKey = dispatch.payload.workspaceKey ?? runId;
      const workspaceDir = workspaceDirFor(workspaceKey);
      if (dispatch.payload.workspace) {
        const spec = dispatch.payload.workspace;
        if (!(await workspaceIntact(workspaceKey))) {
          // A follow-up ATTACHES; it never creates. Cloning here would start
          // from the pinned base and report success, silently dropping
          // everything the ancestor did — the failure mode this whole feature
          // is built to prevent, and the one the server cannot catch remotely
          // (its `isIntact` only proves this runtime is alive).
          if (dispatch.payload.mustAttach) {
            throw new WorkspaceLostError(workspaceKey);
          }
          logger.info(`cloning ${spec.repoUrl} for run ${runId} (ambient git auth)`);
          await checkoutFromUrl(workspaceKey, {
            cloneUrl: spec.repoUrl,
            displayUrl: spec.repoUrl,
            ...(spec.ref !== undefined ? { ref: spec.ref } : {}),
            // the server chose the base; this machine may not (ADR-0017)
            pinSha: spec.baseSha,
            profile: "ambient",
          });
        }
        if (spec.workBranch) {
          // idempotent: -B resets to the branch if it exists locally already
          await git(["checkout", "-B", spec.workBranch], workspaceDir, {}, "ambient");
        }
      } else if (dispatch.payload.mustAttach && !(await workspaceIntact(workspaceKey))) {
        // scratch workspaces are directories too, and a follow-up inherits one
        throw new WorkspaceLostError(workspaceKey);
      } else {
        await mkdir(workspaceDir, { recursive: true });
      }

      // the same per-invocation config isolation the central materializer
      // enforces: whatever the previous agent invocation left in .claude /
      // .mcp.json (hooks, settings, skills) must not leak into this one
      await resetAgentProjectConfig(workspaceDir);
      await this.materializeSkills(workspaceDir, dispatch);
      const request = this.rewriteRequest(dispatch, workspaceDir);

      const batcher = new EventBatcher(dispatch.id, api, this.opts.flushMs ?? FLUSH_MS, {
        keepaliveMs: this.hints.keepaliveSec * 1000,
        onAbort: () => controller.abort("server requested abort"),
        logger,
      });
      try {
        for await (const event of executor.executeStep(request, {
          signal: controller.signal,
          logger,
        })) {
          await this.forwardEvent(dispatch, workspaceDir, event, batcher);
        }
        // evidence: the canonical snapshot of the daemon-owned workspace,
        // uploaded like any artifact — the server hashes it at store time
        let result: { baseSha?: string; treeSha?: string } = {};
        if (dispatch.payload.workspace && dispatch.payload.workspace.access === "readWrite") {
          const snapshot = await stagePlatformSnapshot(workspaceKey);
          await api.uploadArtifact(dispatch.id, DISPATCH_EVIDENCE_KEY, snapshot.patch);
          result = { baseSha: snapshot.baseSha, treeSha: snapshot.treeSha };
        }
        await batcher.close();
        await api.complete(dispatch.id, result);
        logger.info(`dispatch ${dispatch.id} completed`);
      } catch (err) {
        await batcher.close().catch(() => {});
        throw err;
      }
    } catch (err) {
      logger.error(`dispatch ${dispatch.id} failed`, { err: String(err) });
      await api
        .fail(dispatch.id, {
          // a typed condition keeps its code: the server turns the dispatch
          // result into the step failure, so `workspace_lost` must survive
          code: (err as { code?: string }).code ?? "internal",
          message: String(err).slice(0, 1000),
        })
        .catch((failErr) => logger.warn("fail() report lost", { err: String(failErr) }));
    } finally {
      this.activeAborts.delete(dispatch.id);
      this.activeWorkspaceKeys.delete(dispatch.payload.workspaceKey ?? dispatch.runId);
    }
  }

  /**
   * Delete the workspaces of runs the server says have finished.
   *
   * Affinity hands this machine a run's workspace for the run's whole life
   * (ADR-0017 Decision 3), so the directory accumulates state across steps and
   * only the server — where the engine finalizes, even for a remote executor —
   * can say when it is spent. Left alone, every remote run leaves a shallow
   * clone here for good.
   *
   * Best-effort and idempotent: `removeWorkspace` is `rm -rf` on both the
   * workspace and its platform sidecar, so a repeated id costs a syscall, and
   * a failure just means the next poll tries again. The active-run guard is
   * belt and braces — the server only names terminal runs — but it keeps a
   * stale response from deleting a directory out from under a live dispatch.
   */
  private async reapWorkspaces(workspaceKeys: readonly string[]): Promise<void> {
    const cutoff = Date.now() - DaemonRunner.REAP_MEMORY_MS;
    for (const [key, at] of this.reaped) {
      if (at < cutoff) this.reaped.delete(key);
    }
    for (const key of workspaceKeys) {
      if (this.activeWorkspaceKeys.has(key) || this.reaped.has(key)) continue;
      try {
        await removeWorkspace(key);
        this.reaped.set(key, Date.now());
      } catch (err) {
        this.opts.logger.warn(`workspace reap failed for ${key}`, { err: String(err) });
      }
    }
  }

  /**
   * Skill content arrives inline (the daemon has no database), each with the
   * workspace-relative directory the server materialized it under — written
   * verbatim so the request's skills[].localPath always points at real files.
   */
  private async materializeSkills(workspaceDir: string, dispatch: ClaimedDispatch): Promise<void> {
    for (const skill of dispatch.payload.skills) {
      const skillDir = path.resolve(workspaceDir, skill.dir);
      // containment: shipped paths are platform-produced, but verify anyway
      if (!skillDir.startsWith(path.resolve(workspaceDir) + path.sep)) {
        throw new Error(`skill directory escapes the workspace: ${skill.dir}`);
      }
      for (const file of skill.files) {
        const target = path.join(skillDir, file.path);
        if (!path.resolve(target).startsWith(skillDir + path.sep)) {
          throw new Error(`skill file escapes its directory: ${file.path}`);
        }
        await mkdir(path.dirname(target), { recursive: true });
        await Bun.write(target, Buffer.from(file.contentBase64, "base64"));
      }
    }
  }

  /** Symbolic placeholder → this machine's actual workspace directory. */
  private rewriteRequest(dispatch: ClaimedDispatch, workspaceDir: string): StepExecutionRequest {
    const localize = (value: string): string =>
      value.startsWith(DISPATCH_WORKSPACE_PLACEHOLDER)
        ? workspaceDir + value.slice(DISPATCH_WORKSPACE_PLACEHOLDER.length)
        : value;
    const wire = dispatch.payload.request as unknown as StepExecutionRequest;
    return {
      ...wire,
      workspaceDir: localize(wire.workspaceDir),
      toolPolicy: { ...wire.toolPolicy, writeRoot: localize(wire.toolPolicy.writeRoot) },
      skills: wire.skills.map((skill) => ({ ...skill, localPath: localize(skill.localPath) })),
    };
  }

  /** Artifact bytes upload BEFORE the event ships, so the staged ref resolves. */
  private async forwardEvent(
    dispatch: ClaimedDispatch,
    workspaceDir: string,
    event: ExecutorEvent,
    batcher: EventBatcher,
  ): Promise<void> {
    if (event.type === "artifact" && event.path !== undefined && event.inline === undefined) {
      const file = Bun.file(path.resolve(workspaceDir, event.path));
      if (await file.exists()) {
        await this.opts.api.uploadArtifact(dispatch.id, event.key, await file.bytes());
      }
    }
    await batcher.push(event as unknown as Record<string, unknown>);
  }
}

/**
 * Sequence-numbered batching with the keepalive contract: flush on cadence,
 * count, or size; when nothing flushed for `keepaliveMs`, POST an empty batch
 * so the abort flag has a response to ride (ADR-0017 Decision 3).
 */
class EventBatcher {
  private seq = 0;
  private buffer: Array<{ seq: number; event: Record<string, unknown> }> = [];
  private bufferBytes = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  private lastPost = Date.now();
  private flushing = Promise.resolve();

  constructor(
    private readonly dispatchId: string,
    private readonly api: DaemonApi,
    flushMs: number,
    private readonly opts: {
      keepaliveMs: number;
      onAbort: () => void;
      logger: Logger;
    },
  ) {
    this.timer = setInterval(() => {
      const idleFor = Date.now() - this.lastPost;
      if (this.buffer.length > 0 || idleFor >= this.opts.keepaliveMs) {
        this.enqueueFlush();
      }
    }, flushMs);
  }

  async push(event: Record<string, unknown>): Promise<void> {
    this.seq += 1;
    this.buffer.push({ seq: this.seq, event });
    this.bufferBytes += JSON.stringify(event).length;
    if (
      this.buffer.length >= DISPATCH_EVENT_BATCH_MAX_EVENTS ||
      this.bufferBytes >= DISPATCH_EVENT_BATCH_MAX_BYTES / 2
    ) {
      this.enqueueFlush();
      await this.flushing;
    }
  }

  /** Flush the tail and stop the timer; the terminal event must land. */
  async close(): Promise<void> {
    clearInterval(this.timer);
    this.enqueueFlush();
    await this.flushing;
  }

  private enqueueFlush(): void {
    this.flushing = this.flushing.then(() => this.flushNow());
  }

  private async flushNow(): Promise<void> {
    const batch = this.buffer;
    this.buffer = [];
    this.bufferBytes = 0;
    this.lastPost = Date.now();
    try {
      const { abort } = await this.api.postEvents(this.dispatchId, batch);
      if (abort) this.opts.onAbort();
    } catch (err) {
      // the client already retried; put the batch back so the next flush
      // (or close) retries again — seq dedupe makes replays harmless
      this.buffer = [...batch, ...this.buffer];
      this.opts.logger.warn("event batch flush failed — will retry", { err: String(err) });
    }
  }
}
