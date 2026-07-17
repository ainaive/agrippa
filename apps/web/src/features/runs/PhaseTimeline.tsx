import { useTranslation } from "react-i18next";
import { RunStatusIcon } from "@/components/RunStatusBadge";
import { formatCost, formatDuration, lt } from "@/lib/format";
import type { Approval, RunStep, RunTemplate } from "@/lib/types";
import { cn } from "@/lib/utils";

type PhaseGroup = {
  id: string;
  name: string;
  steps: RunStep[];
  approval: { checkpoint: string; title: string } | null;
};

/** Latest attempt per stepId, preserving seq order. */
function latestAttempts(steps: RunStep[]): Map<string, RunStep> {
  const byStep = new Map<string, RunStep>();
  for (const row of [...steps].sort((a, b) => a.seq - b.seq || a.attempt - b.attempt)) {
    byStep.set(row.stepId, row);
  }
  return byStep;
}

/**
 * Group executed steps under the pinned template's phase plan; steps the plan
 * doesn't know (or runs without an embed) fall back to grouping by phaseId.
 */
function groupPhases(template: RunTemplate | null, steps: RunStep[]): PhaseGroup[] {
  const byStep = latestAttempts(steps);
  const groups: PhaseGroup[] = [];
  const claimed = new Set<string>();

  for (const phase of template?.phases ?? []) {
    const phaseSteps = phase.stepIds
      .map((stepId) => byStep.get(stepId))
      .filter((s): s is RunStep => s !== undefined);
    for (const s of phaseSteps) claimed.add(s.stepId);
    groups.push({
      id: phase.id,
      name: lt(phase.name),
      steps: phaseSteps,
      approval: phase.approval
        ? { checkpoint: phase.approval.checkpoint, title: lt(phase.approval.title) }
        : null,
    });
  }

  for (const row of byStep.values()) {
    if (claimed.has(row.stepId)) continue;
    let group = groups.find((g) => g.id === row.phaseId);
    if (!group) {
      group = { id: row.phaseId, name: row.phaseId, steps: [], approval: null };
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
  approvals,
}: {
  template: RunTemplate | null;
  steps: RunStep[];
  approvals: Approval[];
}) {
  const { t } = useTranslation("runs");
  const groups = groupPhases(template, steps);
  const attemptCounts = new Map<string, number>();
  for (const row of steps) {
    attemptCounts.set(row.stepId, Math.max(attemptCounts.get(row.stepId) ?? 0, row.attempt));
  }

  if (groups.length === 0 || steps.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("noSteps")}</p>;
  }

  return (
    <div className="space-y-4">
      {groups.map((group, index) => {
        const started = group.steps.length > 0;
        const checkpointApproval = group.approval
          ? approvals.find((a) => a.checkpointId === group.approval?.checkpoint)
          : undefined;
        return (
          <div key={group.id} className={cn(!started && "opacity-50")}>
            <p className="mb-1 flex items-baseline gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              <span>{String(index + 1).padStart(2, "0")}</span>
              <span className="truncate">{group.name}</span>
            </p>
            <ol className="border-l border-border/70 pl-3">
              {group.steps.map((step) => (
                <StepRow
                  key={step.stepId}
                  step={step}
                  attempts={attemptCounts.get(step.stepId) ?? 1}
                />
              ))}
              {group.steps.length === 0 ? (
                <li className="py-1.5 text-xs text-muted-foreground">{t("phases.notStarted")}</li>
              ) : null}
              {group.approval ? (
                <li className="flex items-center gap-2.5 py-1.5">
                  <RunStatusIcon
                    status={
                      checkpointApproval?.status === "approved"
                        ? "succeeded"
                        : checkpointApproval?.status === "rejected" ||
                            checkpointApproval?.status === "expired"
                          ? "failed"
                          : checkpointApproval
                            ? "waiting_approval"
                            : "pending"
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{group.approval.title}</p>
                    <p className="text-xs text-muted-foreground">{t("phases.checkpoint")}</p>
                  </div>
                </li>
              ) : null}
            </ol>
          </div>
        );
      })}
    </div>
  );
}
