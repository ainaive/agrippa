import { useTranslation } from "react-i18next";
import { RunStatusIcon } from "@/components/RunStatusBadge";
import { formatCost, formatDuration, lt } from "@/lib/format";
import type { Checkpoint, RunStep, RunTemplate } from "@/lib/types";
import { cn } from "@/lib/utils";

type PhaseGroup = {
  id: string;
  name: string;
  round: string | null;
  steps: RunStep[];
  plannedCheckpoints: Array<{ id: string; title: string; checkpoint?: Checkpoint }>;
};

/** Latest attempt per (stepId, iteration), preserving seq/iteration order. */
function latestAttempts(steps: RunStep[]): Map<string, RunStep> {
  const byStep = new Map<string, RunStep>();
  const sorted = [...steps].sort(
    (a, b) => a.iteration - b.iteration || a.seq - b.seq || a.attempt - b.attempt,
  );
  for (const row of sorted) byStep.set(`${row.stepId}#${row.iteration}`, row);
  return byStep;
}

/**
 * Group executed steps under the pinned template's phase plan. Loop phases
 * repeat per round: each iteration that has rows gets its own group with a
 * round chip. Steps the plan doesn't know fall back to grouping by phaseId.
 */
function groupPhases(
  template: RunTemplate | null,
  steps: RunStep[],
  checkpoints: Checkpoint[],
  t: (key: string, opts?: Record<string, unknown>) => string,
): PhaseGroup[] {
  const byStep = latestAttempts(steps);
  const groups: PhaseGroup[] = [];
  const claimed = new Set<string>();

  for (const phase of template?.phases ?? []) {
    const iterations = new Set<number>([1]);
    for (const row of byStep.values()) {
      if (phase.stepIds.includes(row.stepId)) iterations.add(row.iteration);
    }
    for (const iteration of [...iterations].sort((a, b) => a - b)) {
      const phaseSteps = phase.stepIds
        .map((stepId) => byStep.get(`${stepId}#${iteration}`))
        .filter((s): s is RunStep => s !== undefined);
      if (iteration > 1 && phaseSteps.length === 0) continue;
      for (const s of phaseSteps) claimed.add(`${s.stepId}#${s.iteration}`);
      groups.push({
        id: `${phase.id}#${iteration}`,
        name: lt(phase.name),
        round: phase.loop
          ? t("rounds.ofMax", { round: iteration, max: phase.loop.maxIterations })
          : null,
        steps: phaseSteps,
        // planned checkpoints only matter before their step row exists
        plannedCheckpoints: phase.checkpoints
          .filter((ckpt) => !phaseSteps.some((s) => s.stepId === ckpt.id))
          .map((ckpt) => ({
            id: ckpt.id,
            title: lt(ckpt.title),
            checkpoint: checkpoints.find(
              (row) => row.checkpointId === ckpt.id && row.iteration === iteration,
            ),
          })),
      });
    }
  }

  for (const row of byStep.values()) {
    if (claimed.has(`${row.stepId}#${row.iteration}`)) continue;
    let group = groups.find((g) => g.id === `${row.phaseId}#${row.iteration}`);
    if (!group) {
      group = {
        id: `${row.phaseId}#${row.iteration}`,
        name: row.phaseId,
        round: null,
        steps: [],
        plannedCheckpoints: [],
      };
      groups.push(group);
    }
    group.steps.push(row);
  }

  return groups;
}

function StepRow({ step, attempts }: { step: RunStep; attempts: number }) {
  const { t } = useTranslation("runs");
  return (
    <li className="flex items-center gap-2.5 py-1.5">
      <RunStatusIcon status={step.status} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{step.stepId}</p>
        <p className="text-xs text-muted-foreground">
          {step.startedAt ? formatDuration(step.startedAt, step.finishedAt) : "—"}
          {step.usage.costUsd ? ` · ${formatCost(step.usage.costUsd)}` : ""}
          {attempts > 1 ? ` · ${t("steps.attempts", { count: attempts })}` : ""}
        </p>
      </div>
      {step.agentRef ? (
        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {step.agentRef}
        </span>
      ) : null}
    </li>
  );
}

export function PhaseTimeline({
  template,
  steps,
  checkpoints,
}: {
  template: RunTemplate | null;
  steps: RunStep[];
  checkpoints: Checkpoint[];
}) {
  const { t } = useTranslation("runs");
  const groups = groupPhases(template, steps, checkpoints, t);
  const attemptCounts = new Map<string, number>();
  for (const row of steps) {
    const key = `${row.stepId}#${row.iteration}`;
    attemptCounts.set(key, Math.max(attemptCounts.get(key) ?? 0, row.attempt));
  }

  // A queued run with a template embed has groups but no steps yet — still
  // show the planned phases (each renders "Not started yet") and checkpoints.
  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("noSteps")}</p>;
  }

  return (
    <div className="space-y-4">
      {groups.map((group, index) => {
        const started = group.steps.length > 0;
        return (
          <div key={group.id} className={cn(!started && "opacity-50")}>
            <p className="mb-1 flex items-baseline gap-2 text-xs font-medium tracking-wider text-muted-foreground uppercase tabular-nums">
              <span>{String(index + 1).padStart(2, "0")}</span>
              <span className="truncate">{group.name}</span>
              {group.round ? <span className="normal-case">{group.round}</span> : null}
            </p>
            <ol className="border-l border-border/70 pl-3">
              {group.steps.map((step) => (
                <StepRow
                  key={`${step.stepId}#${step.iteration}`}
                  step={step}
                  attempts={attemptCounts.get(`${step.stepId}#${step.iteration}`) ?? 1}
                />
              ))}
              {group.steps.length === 0 ? (
                <li className="py-1.5 text-xs text-muted-foreground">{t("phases.notStarted")}</li>
              ) : null}
              {group.plannedCheckpoints.map(({ id, title, checkpoint }) => (
                <li key={id} className="flex items-center gap-2.5 py-1.5">
                  <RunStatusIcon
                    status={
                      checkpoint?.status === "approved"
                        ? "succeeded"
                        : checkpoint?.status === "rejected" || checkpoint?.status === "expired"
                          ? "failed"
                          : checkpoint
                            ? "waiting_approval"
                            : "pending"
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{title}</p>
                    <p className="text-xs text-muted-foreground">{t("phases.checkpoint")}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        );
      })}
    </div>
  );
}
