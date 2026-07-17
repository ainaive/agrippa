import { useTranslation } from "react-i18next";
import { Progress } from "@/components/ui/progress";
import { formatCost, formatDuration } from "@/lib/format";
import type { Run } from "@/lib/types";
import { cn } from "@/lib/utils";

function Meter({
  label,
  valueText,
  pct,
}: {
  label: string;
  valueText: string;
  pct: number | null;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{valueText}</span>
      </div>
      {pct !== null ? (
        <Progress
          value={Math.min(100, pct)}
          className={cn(
            "h-1.5",
            pct >= 90 && "[&>[data-slot=progress-indicator]]:bg-status-danger",
          )}
        />
      ) : null}
    </div>
  );
}

export function BudgetMeter({ run }: { run: Run }) {
  const { t } = useTranslation("runs");
  const budgets = run.template?.budgets ?? run.budget;
  const spent = run.usageTotals?.costUsd ?? 0;
  const costLimit = budgets?.maxCostUsd ?? null;

  const elapsedMs = run.startedAt
    ? (run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now()) -
      new Date(run.startedAt).getTime()
    : 0;
  const durationLimit = budgets?.maxDurationMinutes ?? null;
  const perPhase = Object.entries(budgets?.perPhase ?? {});

  return (
    <div className="space-y-3">
      <Meter
        label={t("budget.cost")}
        valueText={`${formatCost(spent)}${costLimit ? ` / ${formatCost(costLimit)}` : ""}`}
        pct={costLimit ? (spent / costLimit) * 100 : null}
      />
      <Meter
        label={t("budget.duration")}
        valueText={`${run.startedAt ? formatDuration(run.startedAt, run.finishedAt) : "—"}${
          durationLimit ? ` / ${durationLimit}m` : ""
        }`}
        pct={durationLimit ? (elapsedMs / (durationLimit * 60_000)) * 100 : null}
      />
      {perPhase.length > 0 ? (
        <div className="space-y-1 border-t pt-2">
          <p className="text-xs font-medium text-muted-foreground">{t("budget.perPhase")}</p>
          {perPhase.map(([phaseId, cap]) => (
            <div key={phaseId} className="flex justify-between text-xs text-muted-foreground">
              <span className="truncate">{phaseId}</span>
              <span className="tabular-nums">{formatCost(cap.maxCostUsd)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
