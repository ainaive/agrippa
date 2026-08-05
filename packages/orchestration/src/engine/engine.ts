import {
  type CheckpointStoredResponse,
  INTERACTION_ARTIFACT_MAX_BYTES,
  isCredentialGatedExecutor,
  isTerminalRunStatus,
  type ProviderCatalog,
  providerAuthPolicy,
  type Question,
  questionsArtifactSchema,
  type ReviewFinding,
  type ReviewReport,
  type RunStatus,
  reviewReportSchema,
  type StepStatus,
} from "@agrippa/core";
import {
  artifacts,
  checkpoints,
  fabri,
  loadProviderCatalog,
  projectQuotas,
  projects,
  runEvents,
  runSteps,
  runs,
  tasks,
  templateVersions,
  tokenUsage,
  users,
} from "@agrippa/db";
import {
  collectEnvSecretValues,
  createSecretRedactor,
  type ExecutionContext,
  type Executor,
  type ExecutorEvent,
  type PriorStepSummary,
  type ProviderAuth,
  type ResolvedMcpServer,
  type ResolvedModel,
  type ResumeOutcome,
  type SecretRedactor,
  type StepExecutionRequest,
  type UsageDelta,
  UsageLimitExceededError,
  UsageMeter,
} from "@agrippa/executor-core";
import { and, eq, gte, inArray, max, ne, sql } from "drizzle-orm";
import { upgradeCompiledTemplate } from "../compile";
import { evaluateCondition, evaluateExpression, interpolate } from "../expression";
import {
  FOLLOWUP_STEER_STEP_ID,
  type FollowupSeed,
  followupSeed,
  followupTemplate,
} from "../followup";
import type { ModelResolutionEntry } from "../resolve";
import {
  type CompiledTemplate,
  durationToMinutes,
  flattenPhases,
  isLoopNode,
  type LoopNode,
  type TemplatePhaseV2,
  type TemplateStepV2,
} from "../template-schema";
import {
  type EngineDeps,
  ProviderCredentialError,
  type RunControlHandle,
  type RunOutcome,
} from "./deps";
import {
  appendRunEvent,
  claimRunLease,
  finalizeRun,
  RUN_LEASE_TTL_MS,
  releaseRunLease,
  transitionRun,
} from "./run-lifecycle";

type RunRow = typeof runs.$inferSelect;
type StepRow = typeof runSteps.$inferSelect;
type CheckpointRow = typeof checkpoints.$inferSelect;
type AgentStep = TemplateStepV2 & { kind: "agent" };
type SystemStep = TemplateStepV2 & { kind: "system" };
type CheckpointStep = TemplateStepV2 & { kind: "checkpoint" };

type AbortReason = "cancelled" | "timed_out" | "usage_limit_exceeded" | "drained" | "lease_lost";

/**
 * Told to an agent whose session could not be resumed (ADR-0018 Decision 6).
 * It goes into the step's `instructions` — the volatile channel — and never
 * into `systemPrompt` (a registry row shared across runs) or a workspace file
 * (reset before every attempt, so it would be erased before it was read).
 */
export const CONTEXT_LOSS_DISCLOSURE =
  "Your previous conversation for this step could not be restored, so you are starting " +
  "without it. Treat nothing from that conversation as known, and say so if that leaves " +
  "you unable to continue.";

/** Appended only when there IS prior context — see withContextLossDisclosure. */
export const CONTEXT_LOSS_PRIOR_CONTEXT_HINT =
  " Re-read the workspace and the prior step summaries above before acting.";

/**
 * Compose the disclosure into a step's instructions. Concatenation, not
 * interpolation: whatever the instructions contain is already fully resolved,
 * and re-scanning them here would evaluate template syntax that a later
 * feature (an operator's steering message) legitimately puts in this string.
 *
 * The "prior step summaries above" clause is conditional, because it was
 * written for a crash-resume — which always has them — and a follow-up's own
 * run has a single step. Telling an agent to consult something that is not
 * there is how a disclosure meant to be honest becomes noise.
 */
export function withContextLossDisclosure(instructions: string, hasPriorContext: boolean): string {
  const disclosure = hasPriorContext
    ? CONTEXT_LOSS_DISCLOSURE + CONTEXT_LOSS_PRIOR_CONTEXT_HINT
    : CONTEXT_LOSS_DISCLOSURE;
  return `${disclosure}\n\n${instructions}`;
}

/** A run's per-slot execution binding, resolved once at pickup. */
type SlotBinding = {
  faberId: string;
  executorId: string;
  systemPrompt: string;
  executor: Executor;
};

class RunFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcome: "failed" | "cancelled" | "timed_out" = "failed",
  ) {
    super(message);
    this.name = "RunFailure";
  }
}

/**
 * Raised when this worker loses the run-claim to another still-active worker.
 * We must not finalize or execute — the owner is running the run — so execute()
 * catches it and exits without touching the run.
 */
class RunClaimLost extends Error {
  constructor() {
    super("run is owned by another worker");
    this.name = "RunClaimLost";
  }
}

/**
 * Raised when this engine must stop WITHOUT finalizing: a graceful drain
 * (SIGTERM) or a lost lease. The in-flight step row is recorded like a crash
 * (`code: "crashed"`) so the next owner's resume grants the recovery attempt
 * and reuses the executor session — a drain is deliberately indistinguishable
 * from a crash to the next owner, just faster and typed.
 */
class RunDrained extends Error {
  constructor(readonly reason: "drained" | "lease_lost") {
    super(`run released mid-execution (${reason})`);
    this.name = "RunDrained";
  }
}

/**
 * Raised when a run's binding names an executor THIS worker didn't register —
 * possible in heterogeneous fleets (registrations are deployment-wide, jobs
 * are not routed per executor). Thrown before any status transition, so the
 * worker can decline the job and let the sweepers hand the run to a capable
 * worker instead of burning pg-boss retries. Carries a stable `code` so the
 * worker can match without an instanceof across bundle boundaries.
 */
export class ExecutorUnavailableError extends Error {
  readonly code = "executor_unavailable_on_worker";
  constructor(
    readonly executorId: string,
    reason = "is not registered on this worker",
  ) {
    super(`executor '${executorId}' ${reason}`);
    this.name = "ExecutorUnavailableError";
  }
}

/**
 * Raised when a follow-up's workspace is not on THIS host and might still be
 * on another (ADR-0018 Consequences: central host affinity).
 *
 * Remote runs are pinned, so affinity is free for them. A central run has no
 * pin, and workspaces are host-local — so on a multi-worker fleet the run can
 * land on a worker that does not hold the directory. Declining lets the
 * sweeper re-enqueue and another worker try, which is bounded on purpose: past
 * the grace window the honest answer is that nobody has it, and the engine
 * fails `workspace_lost` rather than ping-ponging the run forever. The real
 * fix is a per-host queue, the same route-by-capability shape Phase B took.
 */
export class WorkspaceElsewhereError extends Error {
  readonly code = "workspace_on_another_host";
  constructor(runId: string) {
    super(`run ${runId}: its workspace is not on this host — declining so a host that has it can`);
    this.name = "WorkspaceElsewhereError";
  }
}

/**
 * How long a central follow-up may bounce between workers looking for its
 * workspace. The straggler sweep re-enqueues a queued run every ~30s, so this
 * is roughly ten attempts across the fleet — enough for every worker to have
 * had a turn, short enough that a directory nobody has fails quickly.
 */
const WORKSPACE_AFFINITY_GRACE_MS = 5 * 60_000;

/** Normalize runs.model_resolution (flat legacy or slot-keyed) to one slot's entries. */
function slotResolutionEntries(raw: Record<string, unknown>, slot: string): ModelResolutionEntry[] {
  const values = Object.values(raw ?? {});
  const flat = values.every(
    (v) => v !== null && typeof v === "object" && "providerModelId" in (v as object),
  );
  if (flat) return values as ModelResolutionEntry[];
  const bySlot = raw as Record<string, Record<string, ModelResolutionEntry>>;
  const resolution = bySlot[slot] ?? Object.values(bySlot)[0] ?? {};
  return Object.values(resolution);
}

/** The credential values a resolved MCP server injects, for secret redaction. */
function mcpSecretValues(server: ResolvedMcpServer): string[] {
  if (server.transport === "stdio") return Object.values(server.env);
  const values: string[] = [];
  for (const header of Object.values(server.headers)) {
    values.push(header);
    const bearer = /^Bearer\s+(.+)$/i.exec(header);
    if (bearer) values.push(bearer[1] as string);
  }
  return values;
}

/** Inline artifact values may be stored as JSON text (disk store) or raw values. */
function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Executes (or resumes) one run to its next stopping point: a terminal state
 * or a waiting_approval pause. Steps are the idempotency unit — on resume,
 * succeeded/skipped steps are skipped and the usage meter re-initializes
 * from persisted token_usage totals (docs/design/04-execution-runtime.md).
 */
export async function executeRun(
  deps: EngineDeps,
  runId: string,
  control?: {
    onStarted?: (handle: RunControlHandle) => void;
    /**
     * Awaited immediately after the claim CAS succeeds — under the lease,
     * before ANY other initialization side effect (startedAt, events, the
     * crash scan, workspace checks). Return false to release the claim as a
     * drain (nothing finalizes; the caller re-enqueues). The consumer uses
     * this to verify its pre-lease routing decision against the persisted
     * pin: deps were constructed from that decision, and proceeding with
     * wrong deps could finalize a resume `workspace_lost` or dispatch a step
     * to the wrong host.
     */
    postClaim?: () => Promise<boolean>;
  },
): Promise<RunOutcome> {
  const { db } = deps;

  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  if (isTerminalRunStatus(run.status)) return "already_terminal";

  const [versionRow] = await db
    .select()
    .from(templateVersions)
    .where(eq(templateVersions.id, run.templateVersionId));
  if (!versionRow) throw new Error(`template version for run ${runId} not found`);
  const base = upgradeCompiledTemplate(versionRow.compiled);
  // A follow-up executes a synthetic flow built from the base template, never
  // the compiled flow itself (ADR-0018 Decision 7): re-entry would replay
  // answered checkpoints, reopen closed loops, and — in the obvious target
  // templates — reach `git.push` again.
  //
  // Keyed on `kind` ALONE, deliberately. Pairing it with a parent-id check
  // reads as defensive and is the opposite: a follow-up row with no parent
  // would fall through to the base flow and re-run the whole pipeline inside
  // an ancestor's workspace, publishing included. Missing parentage costs the
  // inherited session (an honest fresh start); it must never cost the flow.
  const seed = run.kind === "followup" ? await followupSeed(db, run.parentRunId, base) : null;
  const template = seed ? followupTemplate(base, seed) : base;

  const [task] = await db.select().from(tasks).where(eq(tasks.id, run.taskId));
  const [project] = await db.select().from(projects).where(eq(projects.id, run.projectId));
  if (!task || !project) throw new Error(`run ${runId}: task/project missing`);

  // merged provider catalog (builtins + this org's customs) — drives runtime
  // auth-policy for custom providers (a custom with auth "project" must keep
  // its credential the way dashscope does).
  const catalog = await loadProviderCatalog(db, project.orgId);

  // Per-slot bindings: stored on the run at submit (agrippa/v2); slots without
  // a stored binding — every run submitted before slots existed — fall back to
  // the run's primary faber/executor, which preserves v1 behavior exactly.
  const stored = run.agentBindings ?? {};
  const slotIds = Object.keys(template.spec.agents);
  const faberIds = [...new Set(slotIds.map((slot) => stored[slot]?.faberId ?? run.faberId))];
  const faberRows = await db.select().from(fabri).where(inArray(fabri.id, faberIds));
  const fabersById = new Map(faberRows.map((f) => [f.id, f]));

  const bindings: Record<string, SlotBinding> = {};
  for (const slot of slotIds) {
    const faberId = stored[slot]?.faberId ?? run.faberId;
    const executorId = stored[slot]?.executorId ?? run.executorId;
    const executor = deps.executors[executorId];
    if (!executor) throw new ExecutorUnavailableError(executorId);
    const faber = fabersById.get(faberId);
    if (!faber) throw new Error(`run ${runId}: faber ${faberId} for slot '${slot}' missing`);
    bindings[slot] = { faberId, executorId, systemPrompt: faber.systemPrompt, executor };
  }

  // A registered executor may still lack usable auth for this run's providers
  // (a keyless codex worker serving a project without its own credential).
  // Same decline path as an unregistered executor: throw before any status
  // transition so the worker defers and an authed worker picks the run up.
  // ONLY in the pre-claim states the worker actually declines — a crashed
  // `running` run proceeds and the per-step gate in providerAuthFor fails it
  // actionably instead of this throw burning pg-boss retries into `internal`
  // (and if retries do exhaust, the lease sweeper re-enqueues it after
  // expiry rather than stranding it).
  if (run.status === "queued" || run.status === "waiting_approval") {
    for (const [slot, binding] of Object.entries(bindings)) {
      const envAuth = binding.executor.envAuthProviders;
      if (envAuth === undefined) continue; // fake/demo/custom executors: no gating
      for (const entry of slotResolutionEntries(run.modelResolution, slot)) {
        if (providerAuthPolicy(entry.provider, catalog) !== "env") continue; // project-policy → per-step check
        if (envAuth.includes(entry.provider)) continue;
        const hasCredential = await deps.resources.hasProviderCredential(
          run.projectId,
          entry.provider,
        );
        if (!hasCredential) {
          throw new ExecutorUnavailableError(
            binding.executorId,
            `has no usable auth for provider '${entry.provider}' on this worker (no project credential, no worker env auth)`,
          );
        }
      }
    }
  }

  // Central host affinity (ADR-0018). A follow-up continues a directory that
  // exists on exactly one host; remote runs carry a pin, central ones do not.
  // Probed BEFORE the claim so a decline costs nothing — no status change, no
  // retry burned — and bounded, so a workspace nobody holds becomes an honest
  // `workspace_lost` from the check inside initialize rather than a run that
  // circulates forever.
  if (
    run.kind === "followup" &&
    run.runtimeId === null &&
    template.spec.workspace !== undefined &&
    run.status === "queued" &&
    Date.now() - run.queuedAt.getTime() < WORKSPACE_AFFINITY_GRACE_MS &&
    !(await deps.workspace.isIntact(run.id))
  ) {
    throw new WorkspaceElsewhereError(run.id);
  }

  const engine = new RunEngine(
    deps,
    run,
    template,
    bindings,
    {
      orgId: task.orgId,
      taskTitle: task.title,
      project: { id: project.id, slug: project.slug, name: project.name },
    },
    catalog,
    seed,
  );
  return await engine.execute(control);
}

class RunEngine {
  private meter!: UsageMeter;
  private readonly abort = new AbortController();
  private abortReason: AbortReason | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeControl: (() => void) | null = null;
  private workspaceDir = "";
  private stepRows = new Map<string, StepRow>(); // `${stepId}#${iteration}` → latest attempt row
  private stepOutputs: Record<string, { outputs: Record<string, unknown> }> = {};
  /** providerModelId → registry model id, for attributing token_usage rows. */
  private modelIds = new Map<string, string>();
  private currentStepRowId: string | null = null;
  private currentIteration = 1;
  private producedArtifacts = new Set<string>();
  /** Store-time sha256 per artifact key — the integrity anchor for content too large to sit in artifactValues. */
  private artifactDigests: Record<string, string> = {};
  /** Latest inline value per artifact key — the `artifacts.<key>` expression root. */
  private artifactValues: Record<string, unknown> = {};
  /** Latest decided response per checkpoint id — the `checkpoints.<id>` root. */
  private checkpointResponses: Record<string, CheckpointStoredResponse> = {};
  /** Artifact keys that drive an input/review-gate checkpoint — validated at store time. */
  private interactionSources = new Map<string, "input" | "review-gate">();
  // rowKey → crashed-attempt count + last executor session, for crash resume
  private crashRecovery = new Map<string, { crashed: number; sessionId: string | null }>();
  // scrubs known secret values from event payloads before persist/publish
  private readonly redactor: SecretRedactor = createSecretRedactor(collectEnvSecretValues());
  /** Lease identity: the worker's container id, or a per-engine fallback. */
  private readonly leaseOwner: string;
  private readonly leaseTtlMs: number;

  constructor(
    private readonly deps: EngineDeps,
    private readonly run: RunRow,
    private readonly template: CompiledTemplate,
    private readonly bindings: Record<string, SlotBinding>,
    private readonly refs: {
      orgId: string;
      taskTitle: string;
      project: { id: string; slug: string; name: string };
    },
    private readonly catalog: ProviderCatalog,
    /**
     * What this follow-up continues (ADR-0018): the parent's last executor
     * session, handed to the steer step's first attempt, and the parent's step
     * outputs, which become the follow-up's prior context. Null for everything
     * else — and a follow-up whose parent left no session starts honestly
     * fresh rather than pretending otherwise.
     */
    private readonly followup: FollowupSeed | null = null,
  ) {
    this.leaseOwner = deps.lease?.owner ?? `engine-${Bun.randomUUIDv7()}`;
    this.leaseTtlMs = deps.lease?.ttlMs ?? RUN_LEASE_TTL_MS;
    for (const entry of this.allResolutionEntries()) {
      this.modelIds.set(entry.providerModelId, entry.modelId);
    }
    for (const { phase } of flattenPhases(template.spec.phases)) {
      for (const step of phase.steps) {
        if (step.kind === "checkpoint" && step.checkpoint.kind !== "approval") {
          this.interactionSources.set(step.checkpoint.source, step.checkpoint.kind);
        }
      }
    }
  }

  private get db() {
    return this.deps.db;
  }

  private rowKey(stepId: string, iteration = this.currentIteration): string {
    return `${stepId}#${iteration}`;
  }

  /**
   * runs.model_resolution is flat (role → entry) for runs submitted before
   * slots existed, slot-keyed (slot → role → entry) afterwards. Normalize on
   * read so both shapes execute identically.
   */
  private resolutionFor(slot: string): Record<string, ModelResolutionEntry> {
    const raw = this.run.modelResolution as Record<string, unknown>;
    const values = Object.values(raw);
    const flat = values.every(
      (v) => v !== null && typeof v === "object" && "providerModelId" in (v as object),
    );
    if (flat) return raw as Record<string, ModelResolutionEntry>;
    const bySlot = raw as Record<string, Record<string, ModelResolutionEntry>>;
    return bySlot[slot] ?? (Object.values(bySlot)[0] as Record<string, ModelResolutionEntry>) ?? {};
  }

  private allResolutionEntries(): ModelResolutionEntry[] {
    const raw = this.run.modelResolution as Record<string, unknown>;
    const entries: ModelResolutionEntry[] = [];
    for (const value of Object.values(raw)) {
      if (value === null || typeof value !== "object") continue;
      if ("providerModelId" in (value as object)) {
        entries.push(value as ModelResolutionEntry);
      } else {
        entries.push(...Object.values(value as Record<string, ModelResolutionEntry>));
      }
    }
    return entries;
  }

  async execute(control?: {
    onStarted?: (handle: RunControlHandle) => void;
    postClaim?: () => Promise<boolean>;
  }): Promise<RunOutcome> {
    try {
      await this.initialize(control);
      const outcome = await this.runFlow();
      return outcome;
    } catch (err) {
      // another worker owns the run — leave it entirely to them, finalize nothing
      if (err instanceof RunClaimLost) return "already_terminal";
      if (err instanceof RunDrained) {
        // nothing finalized: the run stays `running`, the in-flight step row
        // is a recorded crash, and releasing the lease makes it immediately
        // claimable (the worker re-enqueues; the sweeper is the backstop)
        await releaseRunLease(this.db, this.run.id, this.leaseOwner);
        return "drained";
      }
      return await this.handleFailure(err);
    } finally {
      if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
      this.unsubscribeControl?.();
    }
  }

  // ── Setup ────────────────────────────────────────────────────────────────────

  private async initialize(control?: {
    onStarted?: (handle: RunControlHandle) => void;
    postClaim?: () => Promise<boolean>;
  }): Promise<void> {
    const { run, db } = this;

    const [maxSeq] = await db
      .select({ v: max(runEvents.seq) })
      .from(runEvents)
      .where(eq(runEvents.runId, run.id));
    const resuming = (maxSeq?.v ?? 0) > 0;

    // Claim = status CAS + execution lease in one UPDATE (ADR-0017 Decision 4).
    // Claimable: queued/waiting_approval, or running with a NULL/expired lease
    // (crash and drain recovery). A live lease blocks re-entry — the hole the
    // old transitionRun(status → "running") self-transition left open.
    if (!(await claimRunLease(db, run.id, this.leaseOwner, this.leaseTtlMs))) {
      // another worker/path advanced the run between our read and here
      const [current] = await db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, run.id));
      if (current && current.status === "cancelled") {
        throw new RunFailure("cancelled", "run cancelled", "cancelled");
      }
      // it's terminal (another worker finished it) or `running` under a live
      // lease — either way this worker must not proceed and duplicate side
      // effects; the owner (or the lease sweeper) drives it
      throw new RunClaimLost();
    }
    // Hand out the control handle the moment the claim exists: the caller's
    // renewal loop keys on it, and the lease must stay renewable through the
    // postClaim gate and the (potentially slow) reconstruction below — an
    // unrenewable lease here would let the sweeper hand the run to another
    // worker while this one blindly finishes initializing. This also lets
    // SIGTERM's drain reach a run that is still initializing.
    control?.onStarted?.({
      drain: () => this.triggerAbort("drained"),
      lostLease: () => this.triggerAbort("lease_lost"),
    });
    // The caller's routing decision was made BEFORE the lease existed and the
    // deps were built from it. Now that the claim holds — and round-3's
    // lease-aware pin CAS guarantees the pin can no longer move — this is the
    // one moment a stale decision is provably detectable, and it must be
    // caught before ANY side effect below (startedAt, events, the crash scan,
    // workspace checks): proceeding with wrong deps could finalize a resume
    // `workspace_lost` or dispatch a step to the wrong host. A false answer
    // drains: lease released, nothing finalized, caller re-enqueues.
    if (control?.postClaim && !(await control.postClaim())) {
      throw new RunDrained("drained");
    }
    this.run.status = "running";
    if (run.startedAt === null) {
      await db.update(runs).set({ startedAt: new Date() }).where(eq(runs.id, run.id));
      this.run.startedAt = new Date();
    }
    await this.emit(resuming ? "run.resumed" : "run.started", {
      taskId: run.taskId,
      number: run.number,
    });

    // steps already recorded (resume) — ascending (iteration, attempt) so the
    // latest iteration's output wins in stepOutputs
    const existing = await db.select().from(runSteps).where(eq(runSteps.runId, run.id));
    existing.sort((a, b) => a.iteration - b.iteration || a.attempt - b.attempt);
    for (const row of existing) {
      // a row still 'running' means the previous worker died mid-step
      if (row.status === "running") {
        await db
          .update(runSteps)
          .set({
            status: "failed",
            error: { code: "crashed", message: "worker died mid-step" },
            finishedAt: new Date(),
          })
          .where(eq(runSteps.id, row.id));
        row.status = "failed";
        row.error = { code: "crashed", message: "worker died mid-step" };
      }
      // a crash is an interrupted attempt, not a consumed retry: track it so the
      // step gets an extra attempt and resumes the executor session
      if (row.status === "failed" && (row.error as { code?: string } | null)?.code === "crashed") {
        const key = `${row.stepId}#${row.iteration}`;
        const rec = this.crashRecovery.get(key) ?? { crashed: 0, sessionId: null };
        rec.crashed += 1;
        if (row.executorSessionId) rec.sessionId = row.executorSessionId;
        this.crashRecovery.set(key, rec);
      }
      const key = `${row.stepId}#${row.iteration}`;
      const current = this.stepRows.get(key);
      if (!current || row.attempt > current.attempt) this.stepRows.set(key, row);
      if (row.status === "succeeded") {
        this.stepOutputs[row.stepId] = { outputs: { result: row.output ?? "" } };
      }
    }
    const priorArtifacts = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.runId, run.id))
      .orderBy(artifacts.createdAt);
    for (const a of priorArtifacts) {
      this.producedArtifacts.add(a.artifactKey);
      this.artifactValues[a.artifactKey] = a.inline ?? "";
      if (a.sha256) this.artifactDigests[a.artifactKey] = a.sha256;
    }
    // decided checkpoint responses re-enter the expression context on resume
    const decidedCheckpoints = await db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.runId, run.id), eq(checkpoints.status, "approved")))
      .orderBy(checkpoints.iteration);
    for (const row of decidedCheckpoints) {
      this.checkpointResponses[row.checkpointId] = this.responseOf(row);
    }

    // usage meter from persisted totals — no double counting across resume
    const [usageTotals] = await db
      .select({
        tokens: sql<string>`coalesce(sum(${tokenUsage.inputTokens} + ${tokenUsage.outputTokens}), 0)`,
      })
      .from(tokenUsage)
      .where(eq(tokenUsage.runId, run.id));
    // per-phase consumption, rebuilt by phase so per-phase limits survive a
    // resume (usage rows carry a step id; run_steps carries the phase)
    const perPhaseRows = await db
      .select({
        phaseId: runSteps.phaseId,
        tokens: sql<string>`coalesce(sum(${tokenUsage.inputTokens} + ${tokenUsage.outputTokens}), 0)`,
      })
      .from(tokenUsage)
      .innerJoin(runSteps, eq(tokenUsage.stepId, runSteps.id))
      .where(eq(tokenUsage.runId, run.id))
      .groupBy(runSteps.phaseId);
    const perPhaseUsed = Object.fromEntries(perPhaseRows.map((r) => [r.phaseId, Number(r.tokens)]));
    const limits = this.template.spec.limits;
    const quota = await this.quotaHeadroom();
    this.meter = new UsageMeter(
      {
        maxTokens: limits.maxTokens,
        perPhaseTokens: Object.fromEntries(
          Object.entries(limits.perPhase).map(([k, v]) => [k, v.maxTokens]),
        ),
        quotaTokens: quota.tokens,
      },
      {
        tokens: Number(usageTotals?.tokens ?? 0),
        perPhaseTokens: perPhaseUsed,
      },
    );

    // duration limit survives resume: deadline anchors to the original start
    if (limits.maxDurationMinutes && this.run.startedAt) {
      const deadline =
        this.run.startedAt.getTime() + limits.maxDurationMinutes * 60_000 - Date.now();
      if (deadline <= 0)
        throw new RunFailure("timeout", "run duration limit exhausted", "timed_out");
      this.timeoutTimer = setTimeout(() => this.triggerAbort("timed_out"), deadline);
    }

    this.unsubscribeControl = this.deps.bus.subscribeControl(run.id, (message) => {
      if (message === "cancel") this.triggerAbort("cancelled");
    });
    if (run.cancelRequested) this.triggerAbort("cancelled");

    this.workspaceDir = await this.deps.workspace.ensureDir(run.id);

    // Workspaces are host-local. A resume that landed on a different host
    // sees the checkout step row as succeeded (so it will never re-run) while
    // ensureDir() above just made an empty directory — every subsequent step
    // would silently operate on nothing. Re-provisioning can't help either:
    // a fresh clone lacks the work branch and all agent commits. Fail fast
    // with the real reason instead.
    const checkoutSucceeded = [...this.stepRows.values()].some(
      (row) => row.status === "succeeded" && this.isCheckoutStep(row.stepId),
    );
    // A follow-up never checks out — it attaches to the workspace its ancestor
    // left (ADR-0018 Decision 7). Same assertion, one step earlier: without it
    // the agent would work in an empty directory and report success, which is
    // the failure mode the whole feature is built to avoid.
    const attaches = this.run.kind === "followup" && this.template.spec.workspace !== undefined;
    if ((checkoutSucceeded || attaches) && !(await this.deps.workspace.isIntact(run.id))) {
      throw new RunFailure(
        "workspace_lost",
        attaches
          ? "the workspace this follow-up continues is gone (collected, or the host changed) — submit a new task instead"
          : "the run's workspace is gone (worker host changed or files were removed) — it cannot resume here",
      );
    }
  }

  private isCheckoutStep(stepId: string): boolean {
    for (const { phase } of flattenPhases(this.template.spec.phases)) {
      for (const step of phase.steps) {
        if (step.id === stepId && step.kind === "system" && step.action === "workspace.checkout") {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Remaining project quota headroom for *this* run, refreshed at each step
   * boundary so concurrent runs see each other's consumption. Counts the current
   * month (matching the submit-time gate in apps/api usage.ts) and excludes
   * this run's own persisted usage — the meter already carries that, so
   * including it here would double-count on resume.
   */
  private async quotaHeadroom(): Promise<{ tokens?: number }> {
    const [quota] = await this.db
      .select()
      .from(projectQuotas)
      .where(eq(projectQuotas.projectId, this.run.projectId));
    if (!quota?.hardStop || quota.tokenLimit === null) return {};
    const [spent] = await this.db
      .select({
        tokens: sql<string>`coalesce(sum(${tokenUsage.inputTokens} + ${tokenUsage.outputTokens}), 0)`,
      })
      .from(tokenUsage)
      .where(
        and(
          eq(tokenUsage.projectId, this.run.projectId),
          ne(tokenUsage.runId, this.run.id),
          gte(tokenUsage.occurredAt, sql`date_trunc('month', now())`),
        ),
      );
    return { tokens: Math.max(0, quota.tokenLimit - Number(spent?.tokens ?? 0)) };
  }

  // ── Main loop ────────────────────────────────────────────────────────────────

  private async runFlow(): Promise<RunOutcome> {
    for (const node of this.template.spec.phases) {
      await this.checkInterrupts();
      const outcome = isLoopNode(node)
        ? await this.runLoop(node)
        : await this.runPhase(node, 1, null);
      if (outcome === "waiting") return await this.pauseRun();
    }

    // output contract — succeeded must mean "produced the contracted outputs"
    const missing = this.template.spec.outputs.artifacts
      .filter((a) => a.required && !this.producedArtifacts.has(a.key))
      .map((a) => a.key);
    if (missing.length > 0) {
      throw new RunFailure(
        "contract_violation",
        `required artifacts missing: ${missing.join(", ")}`,
      );
    }

    await this.finalize("succeeded", null);
    return "succeeded";
  }

  private async runLoop(node: LoopNode): Promise<"done" | "waiting"> {
    const loopStepIds = node.phases.flatMap((p) => p.steps.map((s) => s.id));
    // derive the resume iteration from persisted rows — no extra state table
    let startIter = 1;
    for (const [key, row] of this.stepRows) {
      const stepId = key.slice(0, key.lastIndexOf("#"));
      if (loopStepIds.includes(stepId)) startIter = Math.max(startIter, row.iteration);
    }
    // a loop closes exactly once per run — resumes that walk back through a
    // finished loop must not re-emit its lifecycle events
    const lifecycleRows = await this.db
      .select({ payload: runEvents.payload })
      .from(runEvents)
      .where(
        and(
          eq(runEvents.runId, this.run.id),
          inArray(runEvents.type, ["loop.completed", "loop.exhausted"]),
        ),
      );
    const alreadyClosed = lifecycleRows.some(
      (e) => (e.payload as { loopId?: string }).loopId === node.id,
    );

    for (let iter = startIter; iter <= node.maxIterations; iter++) {
      const announced = loopStepIds.some((id) => this.stepRows.has(`${id}#${iter}`));
      if (!announced) {
        await this.emit("loop.iteration.started", {
          loopId: node.id,
          iteration: iter,
          maxIterations: node.maxIterations,
        });
      }
      for (const phase of node.phases) {
        const outcome = await this.runPhase(phase, iter, node);
        if (outcome === "waiting") return "waiting";
      }
      if (evaluateCondition(node.until, this.expressionContext())) {
        if (!alreadyClosed) {
          await this.emit("loop.completed", { loopId: node.id, iterations: iter });
        }
        this.currentIteration = 1;
        return "done";
      }
      if (iter === node.maxIterations) {
        if (!alreadyClosed) {
          await this.emit("loop.exhausted", { loopId: node.id, iterations: iter });
        }
        if (node.onMaxIterations === "fail") {
          throw new RunFailure(
            "loop_exhausted",
            `loop ${node.id} exhausted after ${iter} iterations`,
          );
        }
      }
    }
    this.currentIteration = 1;
    return "done";
  }

  private async runPhase(
    phase: TemplatePhaseV2,
    iteration: number,
    loop: LoopNode | null,
  ): Promise<"done" | "waiting"> {
    this.currentIteration = iteration;
    this.meter.enterPhase(phase.id);
    const pending = phase.steps.filter((s) => {
      const row = this.stepRows.get(this.rowKey(s.id));
      return !(row && (row.status === "succeeded" || row.status === "skipped"));
    });
    if (pending.length > 0) {
      await this.emit("phase.started", { phaseId: phase.id, iteration });
    }

    for (const step of phase.steps) {
      const existing = this.stepRows.get(this.rowKey(step.id));
      if (existing && (existing.status === "succeeded" || existing.status === "skipped")) {
        continue;
      }
      await this.checkInterrupts();
      // re-read project quota each step so concurrent runs can't collectively
      // exceed it by each checking only a stale start-of-run snapshot
      const quota = await this.quotaHeadroom();
      this.meter.refreshQuota(quota.tokens);
      this.meter.check();
      if (step.kind === "checkpoint") {
        const outcome = await this.runCheckpointStep(phase, step, iteration, loop);
        if (outcome === "waiting") return "waiting";
        continue;
      }
      await this.executeStepWithRetry(phase, step);
    }
    await this.emit("phase.completed", { phaseId: phase.id, iteration });
    return "done";
  }

  private async pauseRun(): Promise<RunOutcome> {
    await this.transition("running", "waiting_approval");
    // a parked run holds no lease — the next decision's pickup claims fresh
    await releaseRunLease(this.db, this.run.id, this.leaseOwner);
    return "waiting_approval";
  }

  // ── Checkpoints ──────────────────────────────────────────────────────────────

  /** The response a decided row carries; synthesizes one for legacy approval rows. */
  private responseOf(row: CheckpointRow): CheckpointStoredResponse {
    if (row.response) return row.response;
    if (row.kind === "input") return { kind: "input", outcome: "pass" };
    if (row.kind === "review-gate") {
      return {
        kind: "review-gate",
        outcome: "pass",
        selectedFindings: [],
        acceptedFindings: [],
        acceptedFindingIds: [],
      };
    }
    return {
      kind: "approval",
      outcome: row.status === "rejected" ? "rejected" : "approved",
      comment: row.comment ?? undefined,
    };
  }

  /**
   * Read and validate a checkpoint's source artifact. The primary validation
   * happens at store time (the producing step fails, retryably); this re-check
   * protects resumed runs whose artifact rows predate that validation. A gate
   * must never pass on missing or unreadable evidence, so every non-ok state
   * for a review-gate (and invalid/too-large for input) fails the run.
   */
  private readInteractionSource(
    spec: Exclude<CheckpointStep["checkpoint"], { kind: "approval" }>,
    checkpointId: string,
  ): { questions: Question[] } | ReviewReport {
    const produced = this.producedArtifacts.has(spec.source);
    const raw = this.artifactValues[spec.source];
    if (produced && raw === "") {
      // stored, but too large to inline — never classify as "absent"
      throw new RunFailure(
        "contract_violation",
        `checkpoint ${checkpointId}: source artifact '${spec.source}' exceeds the inline limit and cannot drive the checkpoint`,
      );
    }
    if (!produced) {
      if (spec.kind === "input") return { questions: [] }; // no questions is the designed signal
      throw new RunFailure(
        "contract_violation",
        `checkpoint ${checkpointId}: review gate has no '${spec.source}' report — a gate without evidence cannot pass`,
      );
    }
    const value = jsonValue(raw);
    const parsed =
      spec.kind === "input"
        ? questionsArtifactSchema.safeParse(value)
        : reviewReportSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new RunFailure(
        "contract_violation",
        `checkpoint ${checkpointId}: source artifact '${spec.source}' is invalid — ${issue?.message ?? "schema mismatch"}`,
      );
    }
    return parsed.data as { questions: Question[] } | ReviewReport;
  }

  /** Auto-pass response when the source artifact is legitimately empty; null = must pause. */
  private autoPassResponse(
    spec: CheckpointStep["checkpoint"],
    checkpointId: string,
  ): CheckpointStoredResponse | null {
    if (spec.kind === "approval") return null;
    const source = this.readInteractionSource(spec, checkpointId);
    if ("questions" in source) {
      return source.questions.length === 0 ? { kind: "input", outcome: "pass", auto: true } : null;
    }
    return source.findings.length === 0
      ? {
          kind: "review-gate",
          outcome: "pass",
          selectedFindings: [],
          acceptedFindings: [],
          acceptedFindingIds: [],
          auto: true,
        }
      : null;
  }

  /** The parsed source content snapshotted into the pending row for the UI. */
  private sourceSnapshot(
    spec: CheckpointStep["checkpoint"],
    checkpointId: string,
  ): Record<string, unknown> {
    if (spec.kind === "approval") return {};
    const source = this.readInteractionSource(spec, checkpointId);
    if ("questions" in source) return { questions: source.questions };
    return { summary: source.summary, findings: source.findings };
  }

  /**
   * One checkpoint step of one iteration. No row yet → auto-pass (empty
   * source) or insert pending + pause. Pending → pause again (re-delivery).
   * Decided → fold the response into the context and mark the step done.
   * Pausing completes the job — no worker slot is held while humans decide.
   */
  private async runCheckpointStep(
    phase: TemplatePhaseV2,
    step: CheckpointStep,
    iteration: number,
    loop: LoopNode | null,
  ): Promise<"done" | "waiting"> {
    const spec = step.checkpoint;
    if (step.when && !evaluateCondition(step.when, this.expressionContext())) {
      await this.markSkipped(phase, step, "when_false");
      return "done";
    }

    const [row] = await this.db
      .select()
      .from(checkpoints)
      .where(
        and(
          eq(checkpoints.runId, this.run.id),
          eq(checkpoints.checkpointId, step.id),
          eq(checkpoints.iteration, iteration),
        ),
      );

    if (!row) {
      const auto = this.autoPassResponse(spec, step.id);
      if (auto) {
        await this.db.insert(checkpoints).values({
          runId: this.run.id,
          checkpointId: step.id,
          kind: spec.kind,
          iteration,
          status: "approved",
          response: auto,
          decidedAt: new Date(),
          payload: { title: spec.title, phaseId: phase.id, iteration, auto: true },
        });
        this.checkpointResponses[step.id] = auto;
        const prior = this.stepRows.get(this.rowKey(step.id));
        const stepRow = await this.insertStepRow(phase, step, (prior?.attempt ?? 0) + 1, null);
        await this.completeStep(stepRow, JSON.stringify(auto));
        await this.emit("checkpoint.decided", {
          checkpointId: step.id,
          kind: spec.kind,
          phaseId: phase.id,
          iteration,
          outcome: auto.outcome,
          auto: true,
        });
        return "done";
      }
      const snapshot = this.sourceSnapshot(spec, step.id);
      await this.db.insert(checkpoints).values({
        runId: this.run.id,
        checkpointId: step.id,
        kind: spec.kind,
        iteration,
        payload: {
          kind: spec.kind,
          title: spec.title,
          present: spec.present,
          phaseId: phase.id,
          loopId: loop?.id ?? null,
          iteration,
          timeoutMinutes: durationToMinutes(spec.timeout),
          onTimeout: spec.onTimeout,
          ...snapshot,
        },
      });
      await this.ensureWaitingStepRow(phase, step);
      await this.emit("checkpoint.required", {
        checkpointId: step.id,
        kind: spec.kind,
        phaseId: phase.id,
        iteration,
        title: spec.title,
        present: spec.present,
        ...snapshot,
      });
      return "waiting";
    }

    if (row.status === "pending") {
      // re-delivery while the human still hasn't decided — pause again
      await this.ensureWaitingStepRow(phase, step);
      return "waiting";
    }

    if (row.status === "rejected") {
      await this.resolveWaitingStepRow(phase, step, "failed", {
        code: "approval_rejected",
        message: `checkpoint ${step.id} rejected`,
      });
      throw new RunFailure("approval_rejected", `checkpoint ${step.id} rejected`);
    }

    if (row.status === "expired") {
      if (spec.kind === "approval" && spec.onTimeout === "approve") {
        const response: CheckpointStoredResponse = { kind: "approval", outcome: "approved" };
        this.checkpointResponses[step.id] = response;
        await this.resolveWaitingStepRow(phase, step, "succeeded", null, JSON.stringify(response));
        return "done";
      }
      if (spec.kind === "approval" && spec.onTimeout === "reject") {
        await this.resolveWaitingStepRow(phase, step, "failed", {
          code: "approval_rejected",
          message: `checkpoint ${step.id} expired (onTimeout: reject)`,
        });
        throw new RunFailure("approval_rejected", `checkpoint ${step.id} expired`);
      }
      await this.resolveWaitingStepRow(phase, step, "cancelled", {
        code: "approval_expired",
        message: `checkpoint ${step.id} expired`,
      });
      throw new RunFailure("approval_expired", "approval checkpoint expired", "cancelled");
    }

    // approved
    const response = this.responseOf(row);
    this.checkpointResponses[step.id] = response;
    await this.resolveWaitingStepRow(phase, step, "succeeded", null, JSON.stringify(response));
    return "done";
  }

  /** Pending checkpoints keep a waiting_approval step row so the timeline shows the pause. */
  private async ensureWaitingStepRow(phase: TemplatePhaseV2, step: CheckpointStep): Promise<void> {
    const existing = this.stepRows.get(this.rowKey(step.id));
    if (existing && existing.status === "waiting_approval") return;
    const row = await this.insertStepRow(phase, step, (existing?.attempt ?? 0) + 1, null);
    await this.db
      .update(runSteps)
      .set({ status: "waiting_approval" })
      .where(eq(runSteps.id, row.id));
    row.status = "waiting_approval";
  }

  /** Settle the checkpoint's step row once the human (or expiry) decided. */
  private async resolveWaitingStepRow(
    phase: TemplatePhaseV2,
    step: CheckpointStep,
    status: Extract<StepStatus, "succeeded" | "failed" | "cancelled">,
    error: { code: string; message: string } | null,
    output?: string,
  ): Promise<void> {
    let row = this.stepRows.get(this.rowKey(step.id));
    if (!row) row = await this.insertStepRow(phase, step, 1, null);
    else if (row.status !== "waiting_approval") {
      row = await this.insertStepRow(phase, step, row.attempt + 1, null);
    }
    await this.db
      .update(runSteps)
      .set({ status, output: output ?? null, error, finishedAt: new Date() })
      .where(eq(runSteps.id, row.id));
    row.status = status;
    if (output !== undefined) row.output = output;
  }

  // ── Steps ────────────────────────────────────────────────────────────────────

  private async executeStepWithRetry(
    phase: TemplatePhaseV2,
    step: AgentStep | SystemStep,
  ): Promise<void> {
    // crashes don't consume the retry budget — each adds one extra attempt so a
    // no-retry step that died mid-run still re-executes instead of silently
    // being skipped (its loop would otherwise be `for (2; 2 <= 1)`)
    const recovery = this.crashRecovery.get(this.rowKey(step.id));
    const maxAttempts = (step.retry?.max ?? 0) + 1 + (recovery?.crashed ?? 0);
    const startAttempt = (this.stepRows.get(this.rowKey(step.id))?.attempt ?? 0) + 1;

    // conditional / requires gating
    if (step.when && !evaluateCondition(step.when, this.expressionContext())) {
      await this.markSkipped(phase, step, "when_false");
      return;
    }
    // Resource availability checks materialize skills. Clear any project
    // configuration left by the preceding agent before that path can touch
    // .claude; buildRequest repeats this immediately before each attempt.
    if (step.kind === "agent" && step.requires?.skills.length) {
      await this.deps.resources.prepareWorkspace(this.workspaceDir);
    }
    if (step.requires) {
      const authorizedMcp = this.authorizedMcpRefs(step.requires.mcpServers);
      const ungrantedMcp = step.requires.mcpServers.filter((ref) => !authorizedMcp.includes(ref));
      const { missing: missingMcp } = await this.deps.resources.mcpServers(authorizedMcp);
      // a required skill must be BOTH authorized (in the manifest) and available
      // (has an active version) — otherwise the step runs without what it needs
      const authorizedSkills = this.authorizedSkillRefs(step.requires.skills);
      const ungrantedSkills = step.requires.skills.filter((ref) => !authorizedSkills.includes(ref));
      const { missing: missingSkills } = await this.deps.resources.skills(
        authorizedSkills,
        this.workspaceDir,
      );
      const unavailable = [...ungrantedMcp, ...missingMcp, ...ungrantedSkills, ...missingSkills];
      if (unavailable.length > 0) {
        await this.markSkipped(
          phase,
          step,
          `missing optional resources: ${unavailable.join(", ")}`,
        );
        return;
      }
    }

    for (let attempt = startAttempt; attempt <= maxAttempts; attempt++) {
      await this.checkInterrupts();
      // Resume the crashed executor session on the first recovery attempt
      // only — or, on a follow-up's steer step, the PARENT's session, which
      // is the whole point of steering (ADR-0018). A later attempt starts
      // fresh either way: whatever went wrong, the conversation is suspect.
      const inherited =
        attempt === startAttempt && step.id === FOLLOWUP_STEER_STEP_ID
          ? (this.followup?.sessionId ?? null)
          : null;
      const resumeSessionId = attempt === startAttempt ? (recovery?.sessionId ?? inherited) : null;
      const row = await this.insertStepRow(phase, step, attempt, resumeSessionId);
      this.currentStepRowId = row.id;
      try {
        if (step.kind === "system") {
          await this.runSystemStep(phase, step, row);
          await this.completeStep(row, "");
        } else {
          const output = await this.runAgentStep(phase, step, row, attempt);
          await this.completeStep(row, output);
        }
        return;
      } catch (err) {
        if (err instanceof StepFailed) {
          await this.failStepRow(row, err);
          if (this.abortReason) throw this.abortFailure();
          if (attempt < maxAttempts) {
            await this.emit("step.retrying", {
              phaseId: phase.id,
              stepId: step.id,
              iteration: this.currentIteration,
              attempt,
              error: err.errorPayload,
            });
            continue;
          }
          if (step.onFailure === "continue") {
            await this.emit("step.continued", {
              phaseId: phase.id,
              stepId: step.id,
              iteration: this.currentIteration,
            });
            return;
          }
          throw new RunFailure(err.errorPayload.code, `step ${step.id}: ${err.message}`);
        }
        throw err;
      } finally {
        this.currentStepRowId = null;
      }
    }
  }

  /** The workspace's resolved repoRef input value (what checkout used). */
  private workspaceRepoValue(): unknown {
    const spec = this.template.spec.workspace;
    if (!spec) return null;
    const wrapped = /^\$\{(.*)\}$/.exec(spec.repo.trim());
    return wrapped ? evaluateExpression(wrapped[1] as string, this.expressionContext()) : spec.repo;
  }

  private async runSystemStep(
    phase: TemplatePhaseV2,
    step: SystemStep,
    row: StepRow,
  ): Promise<void> {
    const ctx = this.expressionContext();

    if (step.action === "workspace.checkout") {
      const spec = this.template.spec.workspace;
      if (!spec) return;
      const ref = spec.ref ? interpolate(spec.ref, ctx) : undefined;
      await this.deps.workspace.checkout(this.run.id, {
        repo: this.workspaceRepoValue(),
        ref,
        access: spec.access,
        projectId: this.run.projectId,
      });
      await this.emit("workspace.ready", { ref });
      return;
    }

    const scm = this.deps.scm;
    if (!scm) {
      throw new StepFailed(`${step.action} requires an SCM service`, {
        code: "internal",
        message: `worker has no SCM service configured for ${step.action}`,
      });
    }

    if (step.action === "git.branch") {
      // the default includes the run id's random tail: run.number is only
      // unique per TASK, so "agrippa/run-1" would collide across tasks
      const name = interpolate(step.with.name ?? "agrippa/run-${run.number}-${run.shortId}", ctx);
      await this.wrapScm(step, () => scm.createBranch(this.run.id, name));
      await this.db.update(runs).set({ workBranch: name }).where(eq(runs.id, this.run.id));
      this.run.workBranch = name;
      await this.emit("branch.created", { branch: name });
      return;
    }

    const branch = this.run.workBranch;
    if (!branch) {
      throw new StepFailed(`${step.action} needs a work branch (run git.branch first)`, {
        code: "internal",
        message: "runs.work_branch is not set",
      });
    }

    if (step.action === "git.push") {
      // Evidence-drift guard: the workspace at push time must equal the last
      // stored patch artifact — that patch is what humans reviewed and gates
      // decided on. Publishing anything else would ship unapproved changes,
      // so drift FAILS the run (it is never silently refreshed: refreshed
      // evidence is not approved evidence). In the shipped templates this is
      // unreachable — the reviewer runs readOnly and every patch-producing
      // step re-stores its diff — so any hit is a real violation.
      const patchContracts = this.template.spec.outputs.artifacts.filter(
        (a) => a.kind === "patch" && this.producedArtifacts.has(a.key),
      );
      let expectedPatch: string | undefined;
      if (patchContracts.length > 0) {
        const current = await this.wrapScm(step, () => this.deps.workspace.diff(this.run.id));
        for (const contract of patchContracts) {
          this.assertPatchEvidenceMatches(contract.key, current);
          // proven byte-identical to the reviewed patch, so it can serve as
          // the SCM adapter's expected snapshot
          expectedPatch ??= current;
        }
      }
      const result = await this.wrapScm(step, () =>
        scm.push(this.run.id, {
          projectId: this.run.projectId,
          repo: this.workspaceRepoValue(),
          branch,
          ...(expectedPatch === undefined ? {} : { expectedPatch }),
        }),
      );
      if (result.status === "evidence_mismatch") {
        throw new RunFailure(
          "contract_violation",
          "workspace changed while preparing the approved snapshot — refusing to publish",
        );
      }
      await this.emit("branch.pushed", { branch });
      return;
    }

    // pr.open
    const base =
      interpolate(step.with.base ?? "", ctx) ||
      (this.template.spec.workspace?.ref
        ? interpolate(this.template.spec.workspace.ref, ctx)
        : "main");
    const title = interpolate(step.with.title ?? "", ctx) || this.refs.taskTitle;
    const body = await this.composePrBody(step, ctx);
    const { url } = await this.wrapScm(step, () =>
      scm.openPullRequest(this.run.id, {
        projectId: this.run.projectId,
        repo: this.workspaceRepoValue(),
        head: branch,
        base,
        title,
        body,
      }),
    );
    const key = step.produces[0] as string;
    await this.emit(
      "artifact",
      {
        phaseId: phase.id,
        stepId: step.id,
        iteration: this.currentIteration,
        key,
        kind: "link",
      },
      row.id,
    );
    await this.storeArtifact(row, { key, kind: "link", inline: url });
    await this.emit("pr.opened", { url, branch, base });
  }

  /** SCM failures are step failures (retryable per the template), not engine crashes. */
  private async wrapScm<T>(step: SystemStep, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new StepFailed(`${step.action} failed: ${String(err)}`, {
        code: "tool_error",
        message: `${step.action}: ${String((err as Error).message ?? err).slice(0, 500)}`,
      });
    }
  }

  /**
   * PR body = the template's interpolated `with.body` plus an explicit waiver
   * section: findings the team accepted instead of fixing, with who accepted
   * them — honest to human reviewers, and already part of the run record.
   */
  private async composePrBody(step: SystemStep, ctx: Record<string, unknown>): Promise<string> {
    let body = interpolate(step.with.body ?? "", ctx);
    const gateRows = await this.db
      .select({ row: checkpoints, deciderName: users.name, deciderEmail: users.email })
      .from(checkpoints)
      .leftJoin(users, eq(checkpoints.decidedBy, users.id))
      .where(
        and(
          eq(checkpoints.runId, this.run.id),
          eq(checkpoints.kind, "review-gate"),
          eq(checkpoints.status, "approved"),
        ),
      )
      .orderBy(checkpoints.iteration);
    // Waivers accumulate across rounds: a finding accepted in round N stays
    // waived unless a later round selected it for fixing. Walking iterations
    // in order keeps the last human decision per finding id.
    const waiverById = new Map<string, { finding: ReviewFinding; acceptedBy: string }>();
    for (const entry of gateRows) {
      const response = entry.row.response;
      if (response?.kind !== "review-gate") continue;
      const acceptedBy = entry.deciderName ?? entry.deciderEmail ?? "Agrippa";
      for (const finding of response.acceptedFindings) {
        waiverById.set(finding.id, { finding, acceptedBy });
      }
      for (const finding of response.selectedFindings) waiverById.delete(finding.id);
    }
    const waivers = [...waiverById.values()];
    if (waivers.length > 0) {
      const lines = waivers.map(({ finding, acceptedBy }) => {
        const where = finding.file
          ? ` (\`${finding.file}${finding.line ? `:${finding.line}` : ""}\`)`
          : "";
        return `- **${finding.severity}** ${finding.title}${where} — accepted by ${acceptedBy}`;
      });
      body += `\n\n## Accepted review findings\n\n${lines.join("\n")}`;
    }
    return body.trim();
  }

  private async runAgentStep(
    phase: TemplatePhaseV2,
    step: AgentStep,
    row: StepRow,
    attempt: number,
  ): Promise<string> {
    const binding = this.bindingFor(step);
    const request = await this.buildRequest(step, row, attempt);

    let result = await this.invokeExecutor(phase, step, row, attempt, binding, request);

    // Resume accounting, only for an invocation that was actually handed a
    // session id — which by the gate in buildRequest means a `verified`
    // executor, from which a report is mandatory.
    if (request.resumeSessionId !== undefined && !result.failure) {
      if (result.resumed === "rejected") {
        this.deps.logger.warn("executor session did not resume — disclosing context loss", {
          runId: this.run.id,
          stepId: step.id,
          executorId: binding.executorId,
        });
        // One re-invocation, told plainly that its context is gone, and with
        // the dead session id withheld so it cannot be re-offered. The first
        // invocation was aborted the moment it reported the rejection, so this
        // is a second start rather than a second full step.
        const { resumeSessionId: _dead, ...fresh } = request;
        result = await this.invokeExecutor(phase, step, row, attempt, binding, {
          ...fresh,
          instructions: withContextLossDisclosure(
            request.instructions,
            request.priorContext.length > 0,
          ),
        });
      } else if (result.resumed === undefined) {
        // Fails closed: an executor that claims `verified`, is given a session
        // id, and reports nothing has told us only that we cannot know whether
        // the conversation continued. Proceeding would be exactly the silent
        // fresh-start-as-continuity this capability exists to prevent.
        throw new StepFailed(`executor '${binding.executorId}' did not report a resume outcome`, {
          code: "contract_violation",
          message: `executor '${binding.executorId}' advertises verified resume but reported no outcome for a resumed session`,
        });
      }
    }

    if (result.failure) throw result.failure;
    const output = result.output;
    if (output === null) {
      throw new StepFailed("executor stream ended without a terminal event", {
        code: "internal",
        message: "executor stream ended without step.completed/step.failed",
      });
    }

    // engine-side patch artifacts: produced keys of kind patch the executor didn't emit
    for (const key of step.produces) {
      if (await this.stepProducedArtifact(step.id, key)) continue;
      const contract = this.template.spec.outputs.artifacts.find((a) => a.key === key);
      if (contract?.kind === "patch") {
        let diff: string;
        try {
          diff = await this.deps.workspace.diff(this.run.id);
        } catch (err) {
          throw new StepFailed(`workspace diff failed for patch '${key}'`, {
            code: "tool_error",
            message: `workspace diff failed: ${String((err as Error).message ?? err).slice(0, 500)}`,
          });
        }
        // fail the producing step (retryable) instead of letting the run march
        // on to push/pr.open and only die at the end-of-flow contract check
        if (!diff && contract.required) {
          throw new StepFailed(`step produced no changes for required patch '${key}'`, {
            code: "contract_violation",
            message: `the workspace diff for required artifact '${key}' is empty — no changes were made`,
          });
        }
        await this.storeArtifact(row, { key, kind: "patch", inline: diff });
      }
    }

    this.stepOutputs[step.id] = { outputs: { result: output } };
    return output;
  }

  /**
   * One executor invocation: persist its events, meter its usage, and report
   * how it ended. Separate from the step because a rejected resume costs a
   * second invocation of the SAME attempt — the retry budget belongs to work
   * that failed, and losing a conversation is not the step failing.
   *
   * The signal is per-invocation and chained to the run's, so a rejected
   * resume can be stopped without aborting the run. Stopping it immediately
   * matters: `step.started` arrives before the model does any work, so the
   * abandoned invocation costs a process start rather than a whole step.
   */
  private async invokeExecutor(
    phase: TemplatePhaseV2,
    step: AgentStep,
    row: StepRow,
    attempt: number,
    binding: SlotBinding,
    request: StepExecutionRequest,
  ): Promise<{ output: string | null; failure: StepFailed | null; resumed?: ResumeOutcome }> {
    const invocation = new AbortController();
    const onRunAbort = () => invocation.abort();
    if (this.abort.signal.aborted) invocation.abort();
    this.abort.signal.addEventListener("abort", onRunAbort, { once: true });

    // narrowed to { signal, logger } by ADR-0017 Decision 2: usage flows only
    // through usage events, secrets only through the resource materializer
    const ctx: ExecutionContext = {
      signal: invocation.signal,
      logger: this.deps.logger,
    };

    let output: string | null = null;
    let failure: StepFailed | null = null;
    let resumed: ResumeOutcome | undefined;

    try {
      for await (const event of binding.executor.executeStep(request, ctx)) {
        await this.persistExecutorEvent(phase, step, row, event);
        if (event.type === "step.started" && event.resumed) {
          resumed = event.resumed;
          if (event.resumed === "rejected") {
            // whatever it does next, it does without the context this step
            // was built on — stop it here and start again, disclosed
            invocation.abort();
            break;
          }
        }
        if (event.type === "step.completed") output = event.output;
        if (event.type === "step.failed") {
          failure = new StepFailed(event.error.message, {
            code: event.error.code,
            message: event.error.message,
          });
        }
        if (event.type === "usage") {
          try {
            await this.recordUsage(event, row, attempt);
          } catch (err) {
            // Abort so the executor stops streaming, then propagate as a step
            // failure. Propagating matters because the step-boundary
            // checkInterrupts is NOT reached after the run's final step (runFlow
            // goes straight to finalize), so swallowing this would let a run that
            // blew its limit finish as 'succeeded'. Propagating *as StepFailed*
            // matters because that is the only branch executeStepWithRetry closes
            // the row out on — and its abortReason check fires before the retry
            // and onFailure:continue branches, so a blown limit is never retried
            // nor shrugged off.
            if (err instanceof UsageLimitExceededError) {
              this.triggerAbort("usage_limit_exceeded");
              throw new StepFailed(err.message, {
                code: "usage_limit_exceeded",
                message: err.message,
              });
            }
            throw err;
          }
        }
      }
    } finally {
      this.abort.signal.removeEventListener("abort", onRunAbort);
    }

    return { output, failure, resumed };
  }

  /**
   * Whether THIS template step already stored the key in the current iteration
   * (executor emission just now, or an earlier attempt/resume). Keyed per step
   * so a loop's fix round re-diffs even though the key exists from before.
   */
  private async stepProducedArtifact(stepId: string, key: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: artifacts.id })
      .from(artifacts)
      .innerJoin(runSteps, eq(artifacts.stepId, runSteps.id))
      .where(
        and(
          eq(artifacts.runId, this.run.id),
          eq(artifacts.artifactKey, key),
          eq(runSteps.stepId, stepId),
          eq(runSteps.iteration, this.currentIteration),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  private bindingFor(step: AgentStep): SlotBinding {
    const slot = step.agent ?? (Object.keys(this.bindings)[0] as string);
    const binding = this.bindings[slot];
    if (!binding) throw new Error(`agent slot '${slot}' has no binding`);
    return binding;
  }

  private async buildRequest(
    step: AgentStep,
    row: StepRow,
    _attempt: number,
  ): Promise<StepExecutionRequest> {
    const ctx = this.expressionContext();
    const binding = this.bindingFor(step);
    const slot = step.agent ?? (Object.keys(this.bindings)[0] as string);
    const resolution = this.resolutionFor(slot);

    const modelFor = (role: string): ResolvedModel => {
      const entry = resolution[role];
      if (!entry) throw new Error(`model role '${role}' missing from resolution`);
      return {
        provider: entry.provider,
        providerModelId: entry.providerModelId,
        modelId: entry.modelId,
      };
    };

    const subagents = this.template.spec.resources.subagents
      .filter((s) => step.subagents.includes(s.id))
      .map((s) => ({
        id: s.id,
        description: s.description,
        prompt: s.prompt ?? "",
        tools: s.tools,
        model: modelFor(s.model.role),
      }));

    await this.deps.resources.prepareWorkspace(this.workspaceDir);

    // resolve only what the run is authorized for — ungranted optional
    // resources are dropped here, never resolved from the global registry
    const { resolved: skills, missing: missingSkills } = await this.deps.resources.skills(
      this.authorizedSkillRefs(step.skills),
      this.workspaceDir,
    );
    const { resolved: mcpServers, missing: missingMcp } = await this.deps.resources.mcpServers(
      this.authorizedMcpRefs(step.mcpServers),
    );
    // register the resolved MCP credentials so they're redacted from any event
    this.redactor.add(mcpServers.flatMap(mcpSecretValues));
    // an unavailable *required* resource fails the step; optional ones are dropped
    const optionalMcp = new Set(
      this.template.spec.resources.mcpServers.filter((m) => m.optional).map((m) => m.ref),
    );
    const optionalSkill = new Set(
      this.template.spec.resources.skills
        .filter((s) => s.optional)
        .map((s) => s.ref.split("@")[0] as string),
    );
    const hardMissing = [
      ...missingMcp.filter((ref) => !optionalMcp.has(ref)),
      ...missingSkills.filter((ref) => !optionalSkill.has(ref.split("@")[0] as string)),
    ];
    if (hardMissing.length > 0) {
      throw new StepFailed(`required resources unavailable: ${hardMissing.join(", ")}`, {
        code: "tool_error",
        message: `required resources unavailable: ${hardMissing.join(", ")}`,
      });
    }

    // A follow-up's own run has one step, so its prior context is what the
    // PARENT produced (ADR-0018). Without this a rejected resume left the
    // agent with a message and no account of the work it was continuing —
    // and the context-loss disclosure pointed at summaries that were not there.
    const priorContext: PriorStepSummary[] = [
      ...(this.followup?.priorOutputs ?? []).map((prior) => ({
        stepId: prior.stepId,
        output: prior.output,
        artifactKeys: [],
      })),
      ...Object.entries(this.stepOutputs).map(([stepId, value]) => ({
        stepId,
        output: String(value.outputs.result ?? ""),
        artifactKeys: [],
      })),
    ];

    // slot resolution is single-provider, so the step model's provider also
    // covers every subagent model in this request
    const model = modelFor(step.model.role);
    return {
      runId: this.run.id,
      stepId: step.id,
      iteration: this.currentIteration,
      agentSlot: slot,
      instructions: this.withSteeringMessage(step, interpolate(step.instructions, ctx)),
      systemPrompt: binding.systemPrompt,
      model,
      providerAuth: await this.providerAuthFor(model.provider, {
        // gate by the run's BOUND executor id (the resolution contract), not
        // the instance id — fixtures register fakes under real executor ids
        gated: isCredentialGatedExecutor(binding.executorId),
        // whether THIS worker's executor could still authenticate from env
        // if the project credential is gone (undefined advertisement = yes)
        envFallback:
          binding.executor.envAuthProviders === undefined ||
          binding.executor.envAuthProviders.includes(model.provider),
      }),
      subagents,
      skills,
      mcpServers,
      // no workspace repo → scratch dir with nothing to protect (readWrite);
      // a repo checkout carries the template's declared access (default
      // readOnly), which a step may override — e.g. a reviewer step declares
      // readOnly inside a readWrite workspace so its writes can never become
      // unreviewed published changes
      toolPolicy: {
        writeRoot: this.workspaceDir,
        access: step.access ?? this.template.spec.workspace?.access ?? "readWrite",
      },
      limits: { maxTurns: 50 },
      workspaceDir: this.workspaceDir,
      // Only a `verified` executor is trusted with a session id (ADR-0018
      // Decision 5). One that cannot prove the context loaded would present a
      // silent fresh start as continuity — so it is handed nothing, and the
      // run is honestly a fresh conversation rather than falsely a resumed one.
      resumeSessionId:
        binding.executor.capabilities.resume === "verified"
          ? (row.executorSessionId ?? undefined)
          : undefined,
      priorContext,
      expectedArtifacts: step.produces.map((key) => ({
        key,
        kind: this.template.spec.outputs.artifacts.find((a) => a.key === key)?.kind ?? "markdown",
      })),
    };
  }

  /**
   * Append the operator's steering message to a follow-up's steer step.
   *
   * AFTER interpolation, deliberately and load-bearingly (ADR-0018 Decision
   * 6): a steering message is untrusted text on the same footing as a task
   * parameter, so interpolating it would evaluate whatever `${...}` it
   * happens to contain against the run's expression context. Concatenating it
   * here means the message is delivered verbatim and read once.
   */
  private withSteeringMessage(step: AgentStep, instructions: string): string {
    if (step.id !== FOLLOWUP_STEER_STEP_ID || !this.run.steeringMessage) return instructions;
    return `${instructions}\n\n<message-from-operator>\n${this.run.steeringMessage}\n</message-from-operator>`;
  }

  /**
   * The project's credential for a provider, materialized fresh for every
   * step so a rotated (or removed/added) key applies at the next step — the
   * contract the API and manual document. The key is registered with the
   * redactor the moment it is materialized — before any request can echo it
   * into an event payload; superseded keys stay in the redactor's set.
   *
   * On a gated (real, cataloged) executor, a missing credential fails the
   * run here — before executor invocation, with the same code the
   * submit/retry gates use — whenever env auth cannot cover the gap: always
   * for project-policy providers (their env fallback cannot exist), and for
   * env-policy providers when this worker's executor advertises no env auth
   * for them (a keyless worker that claimed the run because the credential
   * existed must not invoke the executor keyless after it is deleted).
   */
  private async providerAuthFor(
    provider: string,
    opts: { gated: boolean; envFallback: boolean },
  ): Promise<ProviderAuth | undefined> {
    let cred: { apiKey: string; baseUrl?: string } | null;
    try {
      cred = await this.deps.resources.providerCredential(this.refs.project.id, provider);
    } catch (err) {
      // deterministic credential conditions (private-space base URL; a
      // credential that cannot ship to a daemon-routed run) fail the run
      // with their carried code; anything else rethrows so pg-boss retries
      if (err instanceof ProviderCredentialError) {
        throw new RunFailure(err.code, err.message, "failed");
      }
      throw err;
    }
    if (!cred) {
      const needsCredential =
        providerAuthPolicy(provider, this.catalog) === "project" || !opts.envFallback;
      if (opts.gated && needsCredential) {
        throw new RunFailure(
          "provider_credential_required",
          `provider '${provider}' requires a project credential that no longer exists` +
            (providerAuthPolicy(provider, this.catalog) === "env"
              ? " (this worker has no env auth for it)"
              : ""),
          "failed",
        );
      }
      return undefined;
    }
    this.redactor.add([cred.apiKey]);
    return { provider, apiKey: cred.apiKey, baseUrl: cred.baseUrl };
  }

  /** MCP refs the run is authorized to use (pinned at submit; see resolve.authorizeResources). */
  private authorizedMcpRefs(refs: string[]): string[] {
    const allowed = new Set(this.run.resourceManifest.mcpServers);
    return refs.filter((ref) => allowed.has(ref));
  }

  /** Skill refs whose slug the run is authorized to use. */
  private authorizedSkillRefs(refs: string[]): string[] {
    const allowed = new Set(this.run.resourceManifest.skills);
    return refs.filter((ref) => allowed.has(ref.split("@")[0] as string));
  }

  private expressionContext(): Record<string, unknown> {
    return {
      inputs: this.run.paramsSnapshot,
      steps: this.stepOutputs,
      checkpoints: this.checkpointResponses,
      artifacts: this.artifactValues,
      run: {
        id: this.run.id,
        number: this.run.number,
        // UUIDv7: the LAST 12 hex chars are 48 bits fully inside rand_b (the
        // leading chars are timestamp bits shared by every run created in the
        // same ~minute — never use those). 48 bits keeps birthday-collision
        // odds negligible at fleet scale, which pr.open's duplicate-recovery
        // by branch name depends on. (Bun's monotonic v7 counter, if any,
        // lives in rand_a — the tail stays i.i.d. random.)
        shortId: this.run.id.replaceAll("-", "").slice(-12),
        workBranch: this.run.workBranch,
        taskTitle: this.refs.taskTitle,
      },
      project: this.refs.project,
    };
  }

  // ── Event & row bookkeeping ─────────────────────────────────────────────────

  private async persistExecutorEvent(
    phase: TemplatePhaseV2,
    step: TemplateStepV2,
    row: StepRow,
    event: ExecutorEvent,
  ): Promise<void> {
    if (event.type === "artifact") {
      // validate the contract BEFORE emitting: an uncontracted artifact's inline
      // contents/path/key must not leak into run_events or the SSE stream. Emit
      // the normalized contract kind so downstream sees the declared type.
      const produces = "produces" in step ? step.produces : [];
      if (!produces.includes(event.key)) {
        this.deps.logger.warn("dropping uncontracted artifact", {
          runId: this.run.id,
          stepId: step.id,
          key: event.key,
        });
        return;
      }
      const contractKind =
        this.template.spec.outputs.artifacts.find((a) => a.key === event.key)?.kind ?? event.kind;
      await this.emit(
        "artifact",
        {
          phaseId: phase.id,
          stepId: step.id,
          iteration: this.currentIteration,
          key: event.key,
          kind: contractKind,
          path: event.path,
        },
        row.id,
      );
      await this.storeArtifact(row, { ...event, kind: contractKind });
      return;
    }

    const { type, ...payload } = event as { type: string } & Record<string, unknown>;
    await this.emit(
      type,
      {
        phaseId: phase.id,
        stepId: step.id,
        iteration: this.currentIteration,
        ...(step.kind === "agent" && step.agent ? { agentSlot: step.agent } : {}),
        ...payload,
      },
      row.id,
    );
    if (event.type === "step.started" && event.sessionId) {
      await this.db
        .update(runSteps)
        .set({ executorSessionId: event.sessionId })
        .where(eq(runSteps.id, row.id));
    }
  }

  private async storeArtifact(
    row: StepRow,
    event: { key: string; kind: string; path?: string; inline?: unknown; staged?: string },
  ): Promise<void> {
    // a checkpoint-driving artifact must inline whole in Postgres (resume
    // re-reads it from the DB row), so it gets the larger allowance sized to
    // dominate any schema-valid payload
    const interactionKind = this.interactionSources.get(event.key);
    const stored = await this.deps.artifacts.store(
      this.run.id,
      event.key,
      event.kind as never,
      { inline: event.inline, path: event.path, staged: event.staged },
      this.workspaceDir,
      interactionKind ? { inlineLimitBytes: INTERACTION_ARTIFACT_MAX_BYTES } : undefined,
    );
    // a missing OR empty source produced no bytes — don't create a zero-byte row
    // (and don't mark the key produced, so a required-but-empty artifact still
    // fails the contract rather than passing it)
    if (stored.size === 0 && stored.storageRef === null) return;
    // an artifact that drives a checkpoint must parse against its interaction
    // schema NOW, while the producing step's attempt is still open — so a
    // malformed report fails the step (template retry/onFailure apply) instead
    // of silently auto-passing the gate later
    if (interactionKind) {
      if (stored.inline === null) {
        throw new StepFailed(`interaction artifact '${event.key}' exceeds the inline limit`, {
          code: "contract_violation",
          message: `artifact '${event.key}' is too large to drive its checkpoint (${stored.size} bytes; limit ${INTERACTION_ARTIFACT_MAX_BYTES})`,
        });
      }
      const parsed =
        interactionKind === "input"
          ? questionsArtifactSchema.safeParse(jsonValue(stored.inline))
          : reviewReportSchema.safeParse(jsonValue(stored.inline));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new StepFailed(`interaction artifact '${event.key}' is invalid`, {
          code: "contract_violation",
          message: `artifact '${event.key}' does not match the ${interactionKind} schema: ${issue?.message ?? "schema mismatch"}`,
        });
      }
    }
    await this.db.insert(artifacts).values({
      runId: this.run.id,
      stepId: row.id,
      artifactKey: event.key,
      iteration: this.currentIteration,
      kind: event.kind as never,
      name: event.key,
      mime: stored.mime,
      size: stored.size,
      storageRef: stored.storageRef,
      inline: stored.inline ?? null,
      sha256: stored.sha256,
    });
    this.producedArtifacts.add(event.key);
    if (stored.sha256) this.artifactDigests[event.key] = stored.sha256;
    if (stored.inline !== null) {
      this.artifactValues[event.key] = stored.inline;
    } else {
      this.deps.logger.warn("artifact too large for the expression context", {
        runId: this.run.id,
        key: event.key,
      });
      this.artifactValues[event.key] = "";
    }
  }

  /**
   * The workspace's current diff must equal the reviewed patch byte for byte.
   * Small patches compare against the Postgres inline value directly; a patch
   * over the inline threshold compares against its store-time sha256 instead.
   * The digest lives in Postgres, which agent subprocesses hold no credentials
   * for — the spilled file shares an agent-writable volume, so bytes read back
   * from disk could be rewritten after review and are never trusted as
   * evidence. This is tamper-resistance within the documented posture, not a
   * boundary: under compose (no functional inner sandbox) a read-write agent
   * that recovers worker credentials from /proc can reach the DB and forge far
   * more than a digest — the accepted container-is-the-boundary residual
   * (design 08), closed by the VM topology's OS sandbox / M2 isolation.
   * A spilled patch without a digest (legacy row) is unverifiable and fails.
   */
  private assertPatchEvidenceMatches(key: string, current: string): void {
    const drift = (): RunFailure =>
      new RunFailure(
        "contract_violation",
        `workspace changed after the reviewed '${key}' evidence — refusing to publish unapproved changes`,
      );
    const inline = this.artifactValues[key];
    if (typeof inline === "string" && inline !== "") {
      if (inline !== current) throw drift();
      return;
    }
    const digest = this.artifactDigests[key];
    if (!digest) {
      throw new RunFailure(
        "contract_violation",
        `patch evidence '${key}' has no integrity digest — refusing to publish unverifiable changes`,
      );
    }
    if (new Bun.CryptoHasher("sha256").update(current).digest("hex") !== digest) throw drift();
  }

  private async recordUsage(event: UsageDelta, row: StepRow, attempt: number): Promise<void> {
    // persisted first: the meter re-initializes from these rows on resume
    await this.db.insert(tokenUsage).values({
      orgId: this.refs.orgId,
      projectId: this.run.projectId,
      runId: this.run.id,
      stepId: row.id,
      attempt,
      modelId: this.modelIds.get(event.model) ?? null,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheWriteTokens: event.cacheWriteTokens,
    });
    this.meter.record(event);
  }

  private async insertStepRow(
    phase: TemplatePhaseV2,
    step: TemplateStepV2,
    attempt: number,
    resumeSessionId: string | null = null,
  ): Promise<StepRow> {
    const [row] = await this.db
      .insert(runSteps)
      .values({
        runId: this.run.id,
        phaseId: phase.id,
        stepId: step.id,
        iteration: this.currentIteration,
        attempt,
        seq: this.stepSeq(step.id),
        status: "running",
        agentRef:
          step.kind === "agent"
            ? (step.agent ?? Object.keys(this.bindings)[0] ?? null)
            : step.kind === "system"
              ? step.action
              : "checkpoint",
        // carry the crashed attempt's session so buildRequest can resume it
        executorSessionId: resumeSessionId,
        startedAt: new Date(),
      })
      .returning();
    if (!row) throw new Error("run_steps insert returned no row");
    this.stepRows.set(this.rowKey(step.id), row);
    return row;
  }

  private stepSeq(stepId: string): number {
    let index = 0;
    for (const { phase } of flattenPhases(this.template.spec.phases)) {
      for (const step of phase.steps) {
        if (step.id === stepId) return index;
        index++;
      }
    }
    return index;
  }

  private async completeStep(row: StepRow, output: string): Promise<void> {
    await this.db
      .update(runSteps)
      .set({ status: "succeeded", output, finishedAt: new Date() })
      .where(eq(runSteps.id, row.id));
    row.status = "succeeded";
    row.output = output;
  }

  private async failStepRow(row: StepRow, failure: StepFailed): Promise<void> {
    const status: StepStatus = this.abortReason === "cancelled" ? "cancelled" : "failed";
    // a drain/lease-loss abort records the attempt as a crash, so the next
    // owner's resume grants the recovery attempt and reuses the executor
    // session (the same machinery a real worker death flows through)
    const error =
      this.abortReason === "drained" || this.abortReason === "lease_lost"
        ? { code: "crashed", message: `worker released the run mid-step (${this.abortReason})` }
        : failure.errorPayload;
    await this.db
      .update(runSteps)
      .set({ status, error, finishedAt: new Date() })
      .where(eq(runSteps.id, row.id));
    row.status = status;
    row.error = error;
  }

  private async markSkipped(
    phase: TemplatePhaseV2,
    step: TemplateStepV2,
    reason: string,
  ): Promise<void> {
    const [row] = await this.db
      .insert(runSteps)
      .values({
        runId: this.run.id,
        phaseId: phase.id,
        stepId: step.id,
        iteration: this.currentIteration,
        attempt: (this.stepRows.get(this.rowKey(step.id))?.attempt ?? 0) + 1,
        seq: this.stepSeq(step.id),
        status: "skipped",
        finishedAt: new Date(),
      })
      .returning();
    if (row) this.stepRows.set(this.rowKey(step.id), row);
    await this.emit("step.skipped", {
      phaseId: phase.id,
      stepId: step.id,
      iteration: this.currentIteration,
      reason,
    });
  }

  private async emit(
    type: string,
    payload: Record<string, unknown>,
    stepRowId?: string,
  ): Promise<void> {
    // redact known secret values (provider key, MCP tokens) an agent may have
    // echoed into message/tool output, so they never reach run_events or SSE
    const safePayload = this.redactor.redact(payload);
    // seq is allocated by the database (run-lifecycle.appendRunEvent), not from
    // an in-memory counter that a concurrent writer could collide with
    const { seq, createdAt } = await appendRunEvent(this.db, {
      runId: this.run.id,
      stepId: stepRowId ?? this.currentStepRowId,
      type,
      payload: safePayload,
    });
    await this.deps.bus.publish({
      runId: this.run.id,
      seq,
      type,
      payload: safePayload,
      createdAt: createdAt.toISOString(),
    });
  }

  // ── Interrupts & terminal states ────────────────────────────────────────────

  private triggerAbort(reason: AbortReason): void {
    if (this.abortReason) return;
    this.abortReason = reason;
    this.abort.abort(reason);
  }

  private abortFailure(): RunFailure | RunDrained {
    switch (this.abortReason) {
      case "cancelled":
        return new RunFailure("cancelled", "run cancelled", "cancelled");
      case "timed_out":
        return new RunFailure("timeout", "run duration limit exhausted", "timed_out");
      case "drained":
      case "lease_lost":
        // never finalizes — execute() releases the lease and reports "drained"
        return new RunDrained(this.abortReason);
      default:
        return new RunFailure("usage_limit_exceeded", "usage limit exhausted");
    }
  }

  private async checkInterrupts(): Promise<void> {
    if (!this.abortReason) {
      // the DB flag backstops a lost control message (docs/design/04)
      const [row] = await this.db
        .select({ cancelRequested: runs.cancelRequested })
        .from(runs)
        .where(eq(runs.id, this.run.id));
      if (row?.cancelRequested) this.triggerAbort("cancelled");
    }
    if (this.abortReason) throw this.abortFailure();
  }

  /**
   * Compare-and-swap the run status. Returns false when the row had already
   * moved off `from` (e.g. a concurrent cancel/finalize won the race); callers
   * that must not clobber the other outcome check the result.
   */
  private async transition(from: RunStatus, to: RunStatus): Promise<boolean> {
    const applied = await transitionRun(this.db, this.run.id, from, to);
    if (applied) this.run.status = to;
    return applied;
  }

  private async handleFailure(err: unknown): Promise<RunOutcome> {
    if (err instanceof RunFailure) {
      const status: RunStatus =
        err.outcome === "cancelled"
          ? "cancelled"
          : err.outcome === "timed_out"
            ? "timed_out"
            : "failed";
      await this.finalize(status, { code: err.code, message: err.message });
      return status;
    }
    if (err instanceof UsageLimitExceededError) {
      await this.finalize("failed", { code: "usage_limit_exceeded", message: err.message });
      return "failed";
    }
    // Unexpected errors (infra blips, crashes) rethrow: the run stays
    // 'running' and pg-boss retries the job, which resumes step-granularly.
    // The worker marks the run failed only when retries exhaust. Release the
    // lease first — this engine is alive and deliberately handing the run to
    // the retry, which must be able to claim immediately; only a DEAD worker
    // leaves a lease behind, and expiry exists for exactly that. Best-effort:
    // if the release fails too (DB outage), the sweeper recovers after TTL.
    try {
      await releaseRunLease(this.db, this.run.id, this.leaseOwner);
    } catch {}
    this.deps.logger.error("engine internal error — rethrowing for queue retry", {
      err: String(err),
    });
    throw err;
  }

  private async finalize(
    status: RunStatus,
    error: { code: string; message: string } | null,
  ): Promise<void> {
    const snapshot = this.meter?.snapshot() ?? { tokens: 0, perPhaseTokens: {} };
    const usageTotals = {
      tokens: snapshot.tokens,
      perPhaseTokens: snapshot.perPhaseTokens,
    };
    const from = this.run.status;
    let finalStatus = status;
    let eventPayload = this.redactor.redact(error ? { error } : {});

    // finalizeRun commits the status CAS + finishedAt/totals + terminal event in
    // one tx. For a success we require cancel_requested=false so a cancel that
    // landed after the last interrupt check wins atomically (no read/CAS gap).
    let result = await finalizeRun(this.db, {
      runId: this.run.id,
      from,
      to: status,
      requireNotCancelled: status === "succeeded",
      error,
      usageTotals,
      eventPayload,
    });
    if (result.outcome === "cancelled_instead") {
      finalStatus = "cancelled";
      const cancelError = { code: "cancelled", message: "run cancelled" };
      eventPayload = this.redactor.redact({ error: cancelError });
      result = await finalizeRun(this.db, {
        runId: this.run.id,
        from,
        to: "cancelled",
        error: cancelError,
        usageTotals,
        eventPayload,
      });
    }
    if (result.outcome !== "finalized") return; // another path finalized the run
    this.run.status = finalStatus;
    await this.deps.bus.publish({
      runId: this.run.id,
      seq: result.seq,
      type: `run.${finalStatus}`,
      payload: eventPayload,
      createdAt: result.createdAt.toISOString(),
    });
    // Release, don't delete (ADR-0018 Decision 4). The expiry itself was
    // stamped by finalizeRun above, inside the CAS — every finalization path
    // needs it, not just this one. What is left here is the manager dropping
    // whatever belongs to THIS run alone (a remote run's local staging dir);
    // the workspace itself is group-owned and outlives the run.
    try {
      await this.deps.workspace.release(this.run.id);
    } catch (err) {
      this.deps.logger.warn("workspace release failed", { err: String(err) });
    }
  }
}

class StepFailed extends Error {
  constructor(
    message: string,
    readonly errorPayload: { code: string; message: string },
  ) {
    super(message);
    this.name = "StepFailed";
  }
}
