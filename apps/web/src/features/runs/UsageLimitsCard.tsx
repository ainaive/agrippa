import { useTranslation } from "react-i18next";
import { Progress } from "@/components/ui/progress";
import { formatDuration, formatTokens, formatTokensCompact } from "@/lib/format";
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

export function UsageLimitsCard({ run }: { run: Run }) {
  const { t } = useTranslation("runs");
  const limits = run.template?.limits ?? null;
  const used = run.usageTotals?.tokens ?? 0;
  const tokenLimit = limits?.maxTokens ?? null;

  const elapsedMs = run.startedAt
    ? (run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now()) -
      new Date(run.startedAt).getTime()
    : 0;
  const durationLimit = limits?.maxDurationMinutes ?? null;
  const perPhase = Object.entries(limits?.perPhase ?? {});

  return (
    <div className="space-y-3">
      <Meter
        label={t("limits.tokens")}
        valueText={`${formatTokens(used)}${tokenLimit ? ` / ${formatTokens(tokenLimit)}` : ""}`}
        pct={tokenLimit ? (used / tokenLimit) * 100 : null}
      />
      <Meter
        label={t("limits.duration")}
        valueText={`${run.startedAt ? formatDuration(run.startedAt, run.finishedAt) : "—"}${
          durationLimit ? ` / ${durationLimit}m` : ""
        }`}
        pct={durationLimit ? (elapsedMs / (durationLimit * 60_000)) * 100 : null}
      />
      {perPhase.length > 0 ? (
        <div className="space-y-1 border-t pt-2">
          <p className="text-xs font-medium text-muted-foreground">{t("limits.perPhase")}</p>
          {perPhase.map(([phaseId, cap]) => (
            <div key={phaseId} className="flex justify-between text-xs text-muted-foreground">
              <span className="truncate">{phaseId}</span>
              <span className="tabular-nums">{formatTokensCompact(cap.maxTokens)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
