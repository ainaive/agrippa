import { isTerminalRunStatus, type RunStatus, type StepStatus } from "@agrippa/core";
import {
  approvals,
  artifacts,
  fabri,
  projectQuotas,
  projects,
  runEvents,
  runSteps,
  runs,
  tasks,
  templateVersions,
  tokenUsage,
} from "@agrippa/db";
import {
  BudgetExceededError,
  BudgetMeter,
  type ExecutionContext,
  type Executor,
  type ExecutorEvent,
  type PriorStepSummary,
  type ResolvedModel,
  type StepExecutionRequest,
  type UsageDelta,
} from "@agrippa/executor-core";
import { and, eq, gte, max, ne, sql } from "drizzle-orm";
import { evaluateCondition, evaluateExpression, interpolate } from "../expression";
import type { ModelResolution } from "../resolve";
import {
  durationToMinutes,
  type TemplateDoc,
  type TemplatePhase,
  type TemplateStep,
} from "../template-schema";
import type { EngineDeps, RunOutcome } from "./deps";
import { appendRunEvent, transitionRun } from "./run-lifecycle";

type RunRow = typeof runs.$inferSelect;
type StepRow = typeof runSteps.$inferSelect;

type AbortReason = "cancelled" | "timed_out" | "budget_exceeded";

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
 * Executes (or resumes) one run to its next stopping point: a terminal state
 * or a waiting_approval pause. Steps are the idempotency unit — on resume,
 * succeeded/skipped steps are skipped and the budget meter re-initializes
 * from persisted token_usage totals (docs/design/04-execution-runtime.md).
 */
export async function executeRun(deps: EngineDeps, runId: string): Promise<RunOutcome> {
  const { db } = deps;

  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  if (isTerminalRunStatus(run.status)) return "already_terminal";

  const [versionRow] = await db
    .select()
    .from(templateVersions)
    .where(eq(templateVersions.id, run.templateVersionId));
  if (!versionRow) throw new Error(`template version for run ${runId} not found`);
  const template = versionRow.compiled as unknown as TemplateDoc;

  const [task] = await db.select().from(tasks).where(eq(tasks.id, run.taskId));
  const [project] = await db.select().from(projects).where(eq(projects.id, run.projectId));
  const [faber] = await db.select().from(fabri).where(eq(fabri.id, run.faberId));
  if (!task || !project || !faber) throw new Error(`run ${runId}: task/project/faber missing`);

  const executor = deps.executors[run.executorId];
  if (!executor) throw new Error(`executor '${run.executorId}' not registered`);

  const engine = new RunEngine(deps, executor, run, template, {
    orgId: task.orgId,
    project: { id: project.id, slug: project.slug, name: project.name },
    faberSystemPrompt: faber.systemPrompt,
  });
  return await engine.execute();
}

class RunEngine {
  private meter!: BudgetMeter;
  private readonly abort = new AbortController();
  private abortReason: AbortReason | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeControl: (() => void) | null = null;
  private workspaceDir = "";
  private stepRows = new Map<string, StepRow>(); // stepId → latest attempt row
  private stepOutputs: Record<string, { outputs: Record<string, unknown> }> = {};
  private modelPrices = new Map<string, { input: number; output: number; modelId?: string }>();
  private currentStepRowId: string | null = null;
  private producedArtifacts = new Set<string>();
  // stepId → crashed-attempt count + last executor session, for crash resume
  private crashRecovery = new Map<string, { crashed: number; sessionId: string | null }>();

  constructor(
    private readonly deps: EngineDeps,
    private readonly executor: Executor,
    private readonly run: RunRow,
    private readonly template: TemplateDoc,
    private readonly refs: {
      orgId: string;
      project: { id: string; slug: string; name: string };
      faberSystemPrompt: string;
    },
  ) {
    const resolution = run.modelResolution as unknown as ModelResolution;
    for (const entry of Object.values(resolution)) {
      this.modelPrices.set(entry.providerModelId, {
        input: entry.inputCostPerMtok,
        output: entry.outputCostPerMtok,
        modelId: entry.modelId,
      });
    }
  }

  private get db() {
    return this.deps.db;
  }

  async execute(): Promise<RunOutcome> {
    try {
      await this.initialize();
      const outcome = await this.runPhases();
      return outcome;
    } catch (err) {
      // another worker owns the run — leave it entirely to them, finalize nothing
      if (err instanceof RunClaimLost) return "already_terminal";
      return await this.handleFailure(err);
    } finally {
      if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
      this.unsubscribeControl?.();
    }
  }

  // ── Setup ────────────────────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    const { run, db } = this;

    const [maxSeq] = await db
      .select({ v: max(runEvents.seq) })
      .from(runEvents)
      .where(eq(runEvents.runId, run.id));
    const resuming = (maxSeq?.v ?? 0) > 0;

    if (!(await this.transition(run.status, "running"))) {
      // another worker/path advanced the run between our read and here
      const [current] = await db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, run.id));
      if (current && current.status === "cancelled") {
        throw new RunFailure("cancelled", "run cancelled", "cancelled");
      }
      // it's terminal (another worker finished it) or already `running` under
      // another live worker — either way this worker must not proceed and
      // duplicate side effects; the owner (or a later re-delivery) drives it
      throw new RunClaimLost();
    }
    if (run.startedAt === null) {
      await db.update(runs).set({ startedAt: new Date() }).where(eq(runs.id, run.id));
      this.run.startedAt = new Date();
    }
    await this.emit(resuming ? "run.resumed" : "run.started", {
      taskId: run.taskId,
      number: run.number,
    });

    // steps already recorded (resume)
    const existing = await db.select().from(runSteps).where(eq(runSteps.runId, run.id));
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
        const rec = this.crashRecovery.get(row.stepId) ?? { crashed: 0, sessionId: null };
        rec.crashed += 1;
        if (row.executorSessionId) rec.sessionId = row.executorSessionId;
        this.crashRecovery.set(row.stepId, rec);
      }
      const current = this.stepRows.get(row.stepId);
      if (!current || row.attempt > current.attempt) this.stepRows.set(row.stepId, row);
      if (row.status === "succeeded") {
        this.stepOutputs[row.stepId] = { outputs: { result: row.output ?? "" } };
      }
    }
    const priorArtifacts = await db
      .select({ key: artifacts.artifactKey })
      .from(artifacts)
      .where(eq(artifacts.runId, run.id));
    for (const a of priorArtifacts) this.producedArtifacts.add(a.key);

    // budget meter from persisted totals — no double counting across resume
    const [usageTotals] = await db
      .select({
        cost: sql<string>`coalesce(sum(${tokenUsage.costUsd}), 0)`,
        tokens: sql<string>`coalesce(sum(${tokenUsage.inputTokens} + ${tokenUsage.outputTokens}), 0)`,
      })
      .from(tokenUsage)
      .where(eq(tokenUsage.runId, run.id));
    const budgets = this.template.spec.budgets;
    const quota = await this.quotaHeadroom();
    this.meter = new BudgetMeter(
      {
        maxCostUsd: budgets.maxCostUsd,
        perPhaseCostUsd: Object.fromEntries(
          Object.entries(budgets.perPhase).map(([k, v]) => [k, v.maxCostUsd]),
        ),
        quotaCostUsd: quota.costUsd,
        quotaTokens: quota.tokens,
      },
      { costUsd: Number(usageTotals?.cost ?? 0), tokens: Number(usageTotals?.tokens ?? 0) },
    );

    // duration budget survives resume: deadline anchors to the original start
    if (budgets.maxDurationMinutes && this.run.startedAt) {
      const deadline =
        this.run.startedAt.getTime() + budgets.maxDurationMinutes * 60_000 - Date.now();
      if (deadline <= 0)
        throw new RunFailure("timeout", "run duration budget exhausted", "timed_out");
      this.timeoutTimer = setTimeout(() => this.triggerAbort("timed_out"), deadline);
    }

    this.unsubscribeControl = this.deps.bus.subscribeControl(run.id, (message) => {
      if (message === "cancel") this.triggerAbort("cancelled");
    });
    if (run.cancelRequested) this.triggerAbort("cancelled");

    this.workspaceDir = await this.deps.workspace.ensureDir(run.id);
  }

  /**
   * Remaining project quota headroom for *this* run, refreshed at each step
   * boundary so concurrent runs see each other's spend. Counts the current
   * month (matching the submit-time gate in apps/api usage.ts) and excludes
   * this run's own persisted usage — the meter already carries that, so
   * including it here would double-count on resume.
   */
  private async quotaHeadroom(): Promise<{ costUsd?: number; tokens?: number }> {
    const [quota] = await this.db
      .select()
      .from(projectQuotas)
      .where(eq(projectQuotas.projectId, this.run.projectId));
    if (!quota?.hardStop) return {};
    const [spent] = await this.db
      .select({
        cost: sql<string>`coalesce(sum(${tokenUsage.costUsd}), 0)`,
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
    const headroom: { costUsd?: number; tokens?: number } = {};
    if (quota.costLimitUsd !== null) {
      headroom.costUsd = Math.max(0, Number(quota.costLimitUsd) - Number(spent?.cost ?? 0));
    }
    if (quota.tokenLimit !== null) {
      headroom.tokens = Math.max(0, quota.tokenLimit - Number(spent?.tokens ?? 0));
    }
    return headroom;
  }

  // ── Main loop ────────────────────────────────────────────────────────────────

  private async runPhases(): Promise<RunOutcome> {
    for (const phase of this.template.spec.phases) {
      await this.checkInterrupts();

      if (phase.approval) {
        const gate = await this.approvalGate(phase);
        if (gate === "waiting") return await this.pauseForApproval(phase);
        if (gate === "rejected") {
          throw new RunFailure(
            "approval_rejected",
            `checkpoint ${phase.approval.checkpoint} rejected`,
          );
        }
      }

      this.meter.enterPhase(phase.id);
      const phaseSteps = phase.steps.filter((s) => this.stepRows.get(s.id)?.status !== "succeeded");
      if (phaseSteps.length > 0) await this.emit("phase.started", { phaseId: phase.id });

      for (const step of phase.steps) {
        const existing = this.stepRows.get(step.id);
        if (existing && (existing.status === "succeeded" || existing.status === "skipped")) {
          continue;
        }
        await this.checkInterrupts();
        // re-read project quota each step so concurrent runs can't collectively
        // overspend by each checking only a stale start-of-run snapshot
        const quota = await this.quotaHeadroom();
        this.meter.refreshQuota(quota.costUsd, quota.tokens);
        this.meter.check();
        await this.executeStepWithRetry(phase, step);
      }
      await this.emit("phase.completed", { phaseId: phase.id });
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

  // ── Approvals ────────────────────────────────────────────────────────────────

  private async approvalGate(phase: TemplatePhase): Promise<"approved" | "waiting" | "rejected"> {
    const approval = phase.approval;
    if (!approval) return "approved";
    const [row] = await this.db
      .select()
      .from(approvals)
      .where(
        and(eq(approvals.runId, this.run.id), eq(approvals.checkpointId, approval.checkpoint)),
      );
    if (!row) return "waiting";
    if (row.status === "approved") return "approved";
    if (row.status === "rejected") return "rejected";
    if (row.status === "expired") {
      if (approval.onTimeout === "approve") return "approved";
      if (approval.onTimeout === "reject") return "rejected";
      throw new RunFailure("approval_expired", "approval checkpoint expired", "cancelled");
    }
    return "waiting"; // pending
  }

  private async pauseForApproval(phase: TemplatePhase): Promise<RunOutcome> {
    const approval = phase.approval;
    if (!approval) throw new Error("pauseForApproval without approval spec");
    const [existing] = await this.db
      .select()
      .from(approvals)
      .where(
        and(eq(approvals.runId, this.run.id), eq(approvals.checkpointId, approval.checkpoint)),
      );
    if (!existing) {
      await this.db.insert(approvals).values({
        runId: this.run.id,
        checkpointId: approval.checkpoint,
        payload: {
          title: approval.title,
          present: approval.present,
          phaseId: phase.id,
          timeoutMinutes: durationToMinutes(approval.timeout),
          onTimeout: approval.onTimeout,
        },
      });
      await this.emit("approval.required", {
        checkpointId: approval.checkpoint,
        phaseId: phase.id,
        title: approval.title,
        present: approval.present,
      });
    }
    await this.transition("running", "waiting_approval");
    return "waiting_approval";
  }

  // ── Steps ────────────────────────────────────────────────────────────────────

  private async executeStepWithRetry(phase: TemplatePhase, step: TemplateStep): Promise<void> {
    // crashes don't consume the retry budget — each adds one extra attempt so a
    // no-retry step that died mid-run still re-executes instead of silently
    // being skipped (its loop would otherwise be `for (2; 2 <= 1)`)
    const recovery = this.crashRecovery.get(step.id);
    const maxAttempts = (step.retry?.max ?? 0) + 1 + (recovery?.crashed ?? 0);
    const startAttempt = (this.stepRows.get(step.id)?.attempt ?? 0) + 1;

    // conditional / requires gating
    if (step.when && !evaluateCondition(step.when, this.expressionContext())) {
      await this.markSkipped(phase, step, "when_false");
      return;
    }
    if (step.requires) {
      const authorized = this.authorizedMcpRefs(step.requires.mcpServers);
      const ungranted = step.requires.mcpServers.filter((ref) => !authorized.includes(ref));
      const { missing } = await this.deps.resources.mcpServers(authorized);
      const unavailable = [...ungranted, ...missing];
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
      // resume the crashed executor session on the first recovery attempt only
      const resumeSessionId = attempt === startAttempt ? (recovery?.sessionId ?? null) : null;
      const row = await this.insertStepRow(phase, step, attempt, resumeSessionId);
      this.currentStepRowId = row.id;
      try {
        if (step.kind === "system") {
          await this.runSystemStep(step);
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
              attempt,
              error: err.errorPayload,
            });
            continue;
          }
          if (step.onFailure === "continue") {
            await this.emit("step.continued", { phaseId: phase.id, stepId: step.id });
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

  private async runSystemStep(step: TemplateStep & { kind: "system" }): Promise<void> {
    if (step.action === "workspace.checkout") {
      const spec = this.template.spec.workspace;
      if (!spec) return;
      // `repo: ${inputs.repo}` resolves to the structured repoRef value, not a string
      const wrapped = /^\$\{(.*)\}$/.exec(spec.repo.trim());
      const repo = wrapped
        ? evaluateExpression(wrapped[1] as string, this.expressionContext())
        : spec.repo;
      const ref = spec.ref ? interpolate(spec.ref, this.expressionContext()) : undefined;
      await this.deps.workspace.checkout(this.run.id, {
        repo,
        ref,
        access: spec.access,
        projectId: this.run.projectId,
      });
      await this.emit("workspace.ready", { ref });
    }
  }

  private async runAgentStep(
    phase: TemplatePhase,
    step: TemplateStep & { kind: "agent" },
    row: StepRow,
    attempt: number,
  ): Promise<string> {
    const request = await this.buildRequest(step, row, attempt);
    const ctx: ExecutionContext = {
      signal: this.abort.signal,
      budget: {
        record: () => {}, // engine records via usage events; executors may also call this
      },
      secrets: async () => {
        throw new Error("secret resolution is handled by the resource materializer");
      },
      logger: this.deps.logger,
    };

    let output: string | null = null;
    let failure: StepFailed | null = null;

    for await (const event of this.executor.executeStep(request, ctx)) {
      await this.persistExecutorEvent(phase, step, row, event);
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
          if (err instanceof BudgetExceededError) {
            this.triggerAbort("budget_exceeded");
          } else {
            throw err;
          }
        }
      }
    }

    if (failure) throw failure;
    if (output === null) {
      throw new StepFailed("executor stream ended without a terminal event", {
        code: "internal",
        message: "executor stream ended without step.completed/step.failed",
      });
    }

    // engine-side patch artifacts: produced keys of kind patch the executor didn't emit
    for (const key of step.produces) {
      if (this.producedArtifacts.has(key)) continue;
      const contract = this.template.spec.outputs.artifacts.find((a) => a.key === key);
      if (contract?.kind === "patch") {
        const diff = await this.deps.workspace.diff(this.run.id);
        await this.storeArtifact(row, { key, kind: "patch", inline: diff });
      }
    }

    this.stepOutputs[step.id] = { outputs: { result: output } };
    return output;
  }

  private async buildRequest(
    step: TemplateStep & { kind: "agent" },
    row: StepRow,
    _attempt: number,
  ): Promise<StepExecutionRequest> {
    const ctx = this.expressionContext();
    const resolution = this.run.modelResolution as unknown as ModelResolution;

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

    // resolve only what the run is authorized for — ungranted optional
    // resources are dropped here, never resolved from the global registry
    const skills = await this.deps.resources.skills(
      this.authorizedSkillRefs(step.skills),
      this.workspaceDir,
    );
    const { resolved: mcpServers, missing } = await this.deps.resources.mcpServers(
      this.authorizedMcpRefs(step.mcpServers),
    );
    const optionalRefs = new Set(
      this.template.spec.resources.mcpServers.filter((m) => m.optional).map((m) => m.ref),
    );
    const hardMissing = missing.filter((ref) => !optionalRefs.has(ref));
    if (hardMissing.length > 0) {
      throw new StepFailed(`required MCP servers unavailable: ${hardMissing.join(", ")}`, {
        code: "tool_error",
        message: `required MCP servers unavailable: ${hardMissing.join(", ")}`,
      });
    }

    const priorContext: PriorStepSummary[] = Object.entries(this.stepOutputs).map(
      ([stepId, value]) => ({
        stepId,
        output: String(value.outputs.result ?? ""),
        artifactKeys: [],
      }),
    );

    return {
      runId: this.run.id,
      stepId: step.id,
      instructions: interpolate(step.instructions, ctx),
      systemPrompt: this.refs.faberSystemPrompt,
      model: modelFor(step.model.role),
      subagents,
      skills,
      mcpServers,
      // no workspace repo → scratch dir with nothing to protect (readWrite);
      // a repo checkout carries the template's declared access (default readOnly)
      toolPolicy: {
        writeRoot: this.workspaceDir,
        access: this.template.spec.workspace?.access ?? "readWrite",
      },
      limits: { maxTurns: 50 },
      workspaceDir: this.workspaceDir,
      resumeSessionId: row.executorSessionId ?? undefined,
      priorContext,
      expectedArtifacts: step.produces.map((key) => ({
        key,
        kind: this.template.spec.outputs.artifacts.find((a) => a.key === key)?.kind ?? "markdown",
      })),
    };
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
      run: { id: this.run.id, number: this.run.number },
      project: this.refs.project,
    };
  }

  // ── Event & row bookkeeping ─────────────────────────────────────────────────

  private async persistExecutorEvent(
    phase: TemplatePhase,
    step: TemplateStep,
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
    await this.emit(type, { phaseId: phase.id, stepId: step.id, ...payload }, row.id);
    if (event.type === "step.started" && event.sessionId) {
      await this.db
        .update(runSteps)
        .set({ executorSessionId: event.sessionId })
        .where(eq(runSteps.id, row.id));
    }
  }

  private async storeArtifact(
    row: StepRow,
    event: { key: string; kind: string; path?: string; inline?: unknown },
  ): Promise<void> {
    const stored = await this.deps.artifacts.store(
      this.run.id,
      event.key,
      event.kind as never,
      { inline: event.inline, path: event.path },
      this.workspaceDir,
    );
    // a missing/empty source produced no bytes — don't create a zero-byte row
    // (and don't mark the key produced, so a required artifact still fails)
    if (stored.inline === null && stored.storageRef === null) return;
    await this.db.insert(artifacts).values({
      runId: this.run.id,
      stepId: row.id,
      artifactKey: event.key,
      kind: event.kind as never,
      name: event.key,
      mime: stored.mime,
      size: stored.size,
      storageRef: stored.storageRef,
      inline: stored.inline ?? null,
    });
    this.producedArtifacts.add(event.key);
  }

  private async recordUsage(event: UsageDelta, row: StepRow, attempt: number): Promise<void> {
    const prices = this.modelPrices.get(event.model);
    const costUsd =
      ((prices?.input ?? 0) * event.inputTokens + (prices?.output ?? 0) * event.outputTokens) /
      1_000_000;
    // persisted first: the meter re-initializes from these rows on resume
    await this.db.insert(tokenUsage).values({
      orgId: this.refs.orgId,
      projectId: this.run.projectId,
      runId: this.run.id,
      stepId: row.id,
      attempt,
      modelId: prices?.modelId ?? null,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheWriteTokens: event.cacheWriteTokens,
      costUsd: costUsd.toFixed(6),
    });
    this.meter.record({ ...event, costUsd });
  }

  private async insertStepRow(
    phase: TemplatePhase,
    step: TemplateStep,
    attempt: number,
    resumeSessionId: string | null = null,
  ): Promise<StepRow> {
    const [row] = await this.db
      .insert(runSteps)
      .values({
        runId: this.run.id,
        phaseId: phase.id,
        stepId: step.id,
        attempt,
        seq: this.stepSeq(step.id),
        status: "running",
        agentRef: step.kind === "agent" ? step.model.role : step.action,
        // carry the crashed attempt's session so buildRequest can resume it
        executorSessionId: resumeSessionId,
        startedAt: new Date(),
      })
      .returning();
    if (!row) throw new Error("run_steps insert returned no row");
    this.stepRows.set(step.id, row);
    return row;
  }

  private stepSeq(stepId: string): number {
    let index = 0;
    for (const phase of this.template.spec.phases) {
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
    await this.db
      .update(runSteps)
      .set({ status, error: failure.errorPayload, finishedAt: new Date() })
      .where(eq(runSteps.id, row.id));
    row.status = status;
  }

  private async markSkipped(
    phase: TemplatePhase,
    step: TemplateStep,
    reason: string,
  ): Promise<void> {
    const [row] = await this.db
      .insert(runSteps)
      .values({
        runId: this.run.id,
        phaseId: phase.id,
        stepId: step.id,
        attempt: (this.stepRows.get(step.id)?.attempt ?? 0) + 1,
        seq: this.stepSeq(step.id),
        status: "skipped",
        finishedAt: new Date(),
      })
      .returning();
    if (row) this.stepRows.set(step.id, row);
    await this.emit("step.skipped", { phaseId: phase.id, stepId: step.id, reason });
  }

  private async emit(
    type: string,
    payload: Record<string, unknown>,
    stepRowId?: string,
  ): Promise<void> {
    // seq is allocated by the database (run-lifecycle.appendRunEvent), not from
    // an in-memory counter that a concurrent writer could collide with
    const { seq, createdAt } = await appendRunEvent(this.db, {
      runId: this.run.id,
      stepId: stepRowId ?? this.currentStepRowId,
      type,
      payload,
    });
    await this.deps.bus.publish({
      runId: this.run.id,
      seq,
      type,
      payload,
      createdAt: createdAt.toISOString(),
    });
  }

  // ── Interrupts & terminal states ────────────────────────────────────────────

  private triggerAbort(reason: AbortReason): void {
    if (this.abortReason) return;
    this.abortReason = reason;
    this.abort.abort(reason);
  }

  private abortFailure(): RunFailure {
    switch (this.abortReason) {
      case "cancelled":
        return new RunFailure("cancelled", "run cancelled", "cancelled");
      case "timed_out":
        return new RunFailure("timeout", "run duration budget exhausted", "timed_out");
      default:
        return new RunFailure("budget_exceeded", "budget exhausted");
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
    if (err instanceof BudgetExceededError) {
      await this.finalize("failed", { code: "budget_exceeded", message: err.message });
      return "failed";
    }
    // Unexpected errors (infra blips, crashes) rethrow: the run stays
    // 'running' and pg-boss retries the job, which resumes step-granularly.
    // The worker marks the run failed only when retries exhaust.
    this.deps.logger.error("engine internal error — rethrowing for queue retry", {
      err: String(err),
    });
    throw err;
  }

  private async finalize(
    status: RunStatus,
    error: { code: string; message: string } | null,
  ): Promise<void> {
    const snapshot = this.meter?.snapshot() ?? { costUsd: 0, tokens: 0, perPhaseCostUsd: {} };
    // CAS: if another path (e.g. a concurrent cancel) already finalized the run,
    // do not overwrite its terminal status/error with ours
    if (!(await this.transition(this.run.status, status))) return;
    await this.db
      .update(runs)
      .set({
        finishedAt: new Date(),
        error: error ?? null,
        usageTotals: {
          costUsd: snapshot.costUsd,
          tokens: snapshot.tokens,
          perPhaseCostUsd: snapshot.perPhaseCostUsd,
        },
      })
      .where(eq(runs.id, this.run.id));
    await this.emit(`run.${status}`, error ? { error } : {});
    try {
      await this.deps.workspace.cleanup(this.run.id);
    } catch (err) {
      this.deps.logger.warn("workspace cleanup failed", { err: String(err) });
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
