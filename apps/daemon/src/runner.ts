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
  /** Runs executing here right now — never reap one of these. */
  private readonly activeRunIds = new Set<string>();
  /**
   * Already deleted this process, so a run named on every poll for the rest of
   * its 24-hour window costs one `has` rather than an `rm -rf` each time.
   * Bounded by that window; a restart simply re-reaps, which is a no-op.
   */
  private readonly reaped = new Set<string>();
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
      await this.reapWorkspaces(claim.reapableRunIds ?? []);
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
    this.activeRunIds.add(dispatch.runId);
    try {
      const executor = this.opts.executors[dispatch.payload.executorId];
      if (!executor) {
        throw new Error(`executor '${dispatch.payload.executorId}' is not available here`);
      }

      const runId = dispatch.runId;
      const workspaceDir = workspaceDirFor(runId);
      if (dispatch.payload.workspace) {
        const spec = dispatch.payload.workspace;
        if (!(await workspaceIntact(runId))) {
          logger.info(`cloning ${spec.repoUrl} for run ${runId} (ambient git auth)`);
          await checkoutFromUrl(runId, {
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
          const snapshot = await stagePlatformSnapshot(runId);
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
        .fail(dispatch.id, { code: "internal", message: String(err).slice(0, 1000) })
        .catch((failErr) => logger.warn("fail() report lost", { err: String(failErr) }));
    } finally {
      this.activeAborts.delete(dispatch.id);
      this.activeRunIds.delete(dispatch.runId);
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
  private async reapWorkspaces(runIds: readonly string[]): Promise<void> {
    for (const runId of runIds) {
      if (this.activeRunIds.has(runId) || this.reaped.has(runId)) continue;
      try {
        await removeWorkspace(runId);
        this.reaped.add(runId);
      } catch (err) {
        this.opts.logger.warn(`workspace reap failed for run ${runId}`, { err: String(err) });
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
