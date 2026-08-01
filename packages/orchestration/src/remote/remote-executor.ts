import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  DISPATCH_EVIDENCE_KEY,
  DISPATCH_WORKSPACE_PLACEHOLDER,
  type DispatchPayload,
  type DispatchSkillContent,
  type DispatchWorkspaceSpec,
} from "@agrippa/core";
import { type Db, dispatchEvents, dispatches, runSteps } from "@agrippa/db";
import type {
  ExecutionContext,
  Executor,
  ExecutorCapabilities,
  ExecutorEvent,
  Logger,
  StepExecutionRequest,
} from "@agrippa/executor-core";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";

/** How often the engine-side stream polls dispatch_events / dispatch status. */
const POLL_MS = 500;
/**
 * No daemon contact for this long fails the dispatch typed instead of hanging
 * the engine: 2× the worst gap a healthy daemon can produce (its keepalive
 * cadence is 5s, its heartbeat 15s), with generous margin for network wobble.
 */
const DEADMAN_MS = 120_000;

export type RemoteExecutorOpts = {
  db: Db;
  runtimeId: string;
  /** Proxied executor identity — the engine binds slots by this id. */
  executorId: string;
  capabilities: ExecutorCapabilities;
  /** The runtime's advertised env auth for this executor (drives the engine's auth gate). */
  envAuthProviders?: readonly string[];
  /** Resolved by the remote workspace manager at checkout; null = no repo workspace. */
  workspaceSpec: () => Promise<DispatchWorkspaceSpec | null>;
  logger: Logger;
  pollMs?: number;
  deadmanMs?: number;
};

/**
 * The remote transport as an Executor (ADR-0017 Decision 2): serializes the
 * StepExecutionRequest into a dispatch row addressed to the run's pinned
 * runtime, then yields the daemon's reported events — in seq order, exactly
 * once (the (dispatch, seq) unique index dedupes at-least-once delivery) — as
 * the AsyncIterable the engine already consumes. ctx.signal maps to the
 * dispatch abort flag; a silent daemon trips the deadman into a typed
 * step.failed, which the template's retry policy then owns.
 */
export class RemoteExecutor implements Executor {
  readonly id: string;
  readonly capabilities: ExecutorCapabilities;
  readonly envAuthProviders?: readonly string[];

  constructor(private readonly opts: RemoteExecutorOpts) {
    this.id = opts.executorId;
    this.capabilities = opts.capabilities;
    if (opts.envAuthProviders) this.envAuthProviders = opts.envAuthProviders;
  }

  async *executeStep(
    request: StepExecutionRequest,
    ctx: ExecutionContext,
  ): AsyncIterable<ExecutorEvent> {
    const { db } = this.opts;
    const pollMs = this.opts.pollMs ?? POLL_MS;
    const deadmanMs = this.opts.deadmanMs ?? DEADMAN_MS;

    const stepRowId = await this.currentStepRowId(request);
    // a live predecessor for this run (a drained attempt's dispatch the old
    // engine never terminated) must not keep executing beside the new one
    await this.abortStalePredecessors(request.runId, stepRowId);

    const payload = await this.buildPayload(request);
    const [dispatch] = await db
      .insert(dispatches)
      .values({
        runId: request.runId,
        stepRowId,
        runtimeId: this.opts.runtimeId,
        payload: payload as unknown as Record<string, unknown>,
      })
      .returning({ id: dispatches.id });
    if (!dispatch) throw new Error("dispatch insert returned no row");
    const dispatchId = dispatch.id;

    const onAbort = () => {
      void db
        .update(dispatches)
        .set({ abortRequested: true })
        .where(eq(dispatches.id, dispatchId))
        .catch((err: unknown) => {
          this.opts.logger.warn("failed to flag dispatch abort", { err: String(err) });
        });
    };
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });

    try {
      let watermark = 0;
      let sawTerminalEvent = false;
      for (;;) {
        const events = await db
          .select()
          .from(dispatchEvents)
          .where(and(eq(dispatchEvents.dispatchId, dispatchId), gt(dispatchEvents.seq, watermark)))
          .orderBy(asc(dispatchEvents.seq));
        for (const row of events) {
          watermark = row.seq;
          const event = this.adoptEvent(dispatchId, row.event as unknown as ExecutorEvent);
          if (event.type === "step.completed" || event.type === "step.failed") {
            sawTerminalEvent = true;
          }
          yield event;
        }

        const [state] = await db
          .select({
            status: dispatches.status,
            result: dispatches.result,
            lastContactAt: dispatches.lastContactAt,
            createdAt: dispatches.createdAt,
          })
          .from(dispatches)
          .where(eq(dispatches.id, dispatchId));
        if (!state) throw new Error(`dispatch ${dispatchId} vanished`);

        if (state.status === "completed" || state.status === "failed") {
          // drain any events that landed between the read above and terminal
          const tail = await db
            .select()
            .from(dispatchEvents)
            .where(
              and(eq(dispatchEvents.dispatchId, dispatchId), gt(dispatchEvents.seq, watermark)),
            )
            .orderBy(asc(dispatchEvents.seq));
          for (const row of tail) {
            watermark = row.seq;
            const event = this.adoptEvent(dispatchId, row.event as unknown as ExecutorEvent);
            if (event.type === "step.completed" || event.type === "step.failed") {
              sawTerminalEvent = true;
            }
            yield event;
          }
          if (!sawTerminalEvent) {
            // daemon terminated the dispatch without a terminal event (crash
            // path) — synthesize the failure so the engine contract holds
            const result = (state.result ?? {}) as { code?: string; message?: string };
            yield {
              type: "step.failed",
              error: {
                code: (result.code as never) ?? "internal",
                message: result.message ?? "remote dispatch ended without a terminal event",
                retryable: true,
              },
            } as ExecutorEvent;
          }
          return;
        }

        const lastContact = state.lastContactAt ?? state.createdAt;
        if (Date.now() - lastContact.getTime() > deadmanMs) {
          // kill it so a zombie daemon reviving later can't resurrect the
          // dispatch under an engine that has moved on
          await db
            .update(dispatches)
            .set({
              status: "failed",
              result: { code: "runtime_offline", message: "runtime stopped reporting" },
              finishedAt: sql`now()`,
            })
            .where(
              and(
                eq(dispatches.id, dispatchId),
                inArray(dispatches.status, ["pending", "claimed"]),
              ),
            );
          yield {
            type: "step.failed",
            error: {
              code: "internal",
              message: `runtime ${this.opts.runtimeId} stopped reporting (deadman ${Math.round(deadmanMs / 1000)}s)`,
              retryable: true,
            },
          } as ExecutorEvent;
          return;
        }

        await Bun.sleep(pollMs);
      }
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
    }
  }

  /** The engine inserts the attempt row (status running) before invoking us. */
  private async currentStepRowId(request: StepExecutionRequest): Promise<string> {
    const [row] = await this.opts.db
      .select({ id: runSteps.id })
      .from(runSteps)
      .where(
        and(
          eq(runSteps.runId, request.runId),
          eq(runSteps.stepId, request.stepId),
          eq(runSteps.iteration, request.iteration ?? 1),
          eq(runSteps.status, "running"),
        ),
      )
      .orderBy(desc(runSteps.attempt))
      .limit(1);
    if (!row) {
      throw new Error(
        `no running step row for ${request.runId}/${request.stepId}#${request.iteration}`,
      );
    }
    return row.id;
  }

  private async abortStalePredecessors(runId: string, currentStepRowId: string): Promise<void> {
    const { db } = this.opts;
    // never-claimed leftovers just die; claimed ones get the abort flag the
    // daemon will observe on its next batch/claim response
    await db
      .update(dispatches)
      .set({
        status: "failed",
        result: { code: "superseded", message: "a newer attempt was dispatched" },
        finishedAt: sql`now()`,
      })
      .where(
        and(
          eq(dispatches.runId, runId),
          eq(dispatches.status, "pending"),
          sql`${dispatches.stepRowId} <> ${currentStepRowId}`,
        ),
      );
    await db
      .update(dispatches)
      .set({ abortRequested: true })
      .where(
        and(
          eq(dispatches.runId, runId),
          eq(dispatches.status, "claimed"),
          sql`${dispatches.stepRowId} <> ${currentStepRowId}`,
        ),
      );
  }

  /**
   * Serialize the request for the wire: daemon-local paths become the
   * symbolic placeholder, and skill content (materialized on THIS host by the
   * ordinary materializer) ships inline — the daemon has no database.
   */
  private async buildPayload(request: StepExecutionRequest): Promise<DispatchPayload> {
    const root = request.workspaceDir;
    const symbolic = (p: string): string =>
      p === root || p.startsWith(`${root}${path.sep}`)
        ? p.replace(root, DISPATCH_WORKSPACE_PLACEHOLDER)
        : p;

    const skills: DispatchSkillContent[] = [];
    for (const skill of request.skills) {
      skills.push({
        slug: skill.slug,
        version: skill.version,
        files: await readSkillFiles(skill.localPath),
      });
    }

    const wireRequest = {
      ...request,
      workspaceDir: DISPATCH_WORKSPACE_PLACEHOLDER,
      toolPolicy: { ...request.toolPolicy, writeRoot: symbolic(request.toolPolicy.writeRoot) },
      skills: request.skills.map((s) => ({ ...s, localPath: symbolic(s.localPath) })),
    };

    return {
      request: wireRequest as unknown as Record<string, unknown>,
      workspace: await this.opts.workspaceSpec(),
      skills,
    };
  }

  /**
   * Daemon artifact events reference files the daemon already uploaded to the
   * staging area — rewrite `path` to the opaque `staged` ref so the engine's
   * store adopts the uploaded bytes instead of touching its own filesystem.
   */
  private adoptEvent(dispatchId: string, event: ExecutorEvent): ExecutorEvent {
    if (event.type !== "artifact" || event.inline !== undefined || event.path === undefined) {
      return event;
    }
    const key = event.path === DISPATCH_EVIDENCE_KEY ? DISPATCH_EVIDENCE_KEY : event.key;
    return { ...event, path: undefined, staged: `${dispatchId}/${key}` };
  }
}

/** Recursively read a materialized skill directory into wire files. */
async function readSkillFiles(
  dir: string,
): Promise<Array<{ path: string; contentBase64: string }>> {
  const files: Array<{ path: string; contentBase64: string }> = [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const abs = path.join(entry.parentPath ?? dir, entry.name);
    const rel = path.relative(dir, abs);
    const bytes = await Bun.file(abs).bytes();
    files.push({ path: rel, contentBase64: Buffer.from(bytes).toString("base64") });
  }
  return files;
}
