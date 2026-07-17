import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { BarChart3Icon, CircleDollarSignIcon, CoinsIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/EmptyState";
import { DetailSkeleton } from "@/components/LoadingSkeletons";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { api } from "@/lib/api";
import { formatCost, lt } from "@/lib/format";
import type { Quota } from "@/lib/types";

type Usage = {
  costUsd: number;
  tokens: number;
  byModel: Array<{ model: string; costUsd: number; tokens: number }>;
  byTaskType: Array<{
    taskTypeNameI18n: Record<string, string> | null;
    costUsd: number;
    tokens: number;
  }>;
  byDay: Array<{ day: string; costUsd: number; tokens: number }>;
};

/** Month-to-date day keys (YYYY-MM-DD, local) so zero-usage days keep time linear. */
function monthToDateDays(): string[] {
  const now = new Date();
  const days: string[] = [];
  for (let d = 1; d <= now.getDate(); d++) {
    const date = new Date(now.getFullYear(), now.getMonth(), d);
    days.push(
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    );
  }
  return days;
}

/** Single-series daily bars: one hue, muted baseline, rounded data-ends, hover titles. */
function DailyBars({ byDay, label }: { byDay: Usage["byDay"]; label: string }) {
  const days = monthToDateDays();
  const byKey = new Map(byDay.map((row) => [row.day, row]));
  const max = Math.max(...byDay.map((row) => row.costUsd), 0.000001);

  const barWidth = 10;
  const gap = 3;
  const plotHeight = 96;
  const width = days.length * (barWidth + gap) - gap;
  const height = plotHeight + 18;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-36 w-full max-w-2xl"
      role="img"
      preserveAspectRatio="xMinYMid meet"
    >
      <title>{label}</title>
      {days.map((day, index) => {
        const row = byKey.get(day);
        const value = row?.costUsd ?? 0;
        const h = value > 0 ? Math.max((value / max) * plotHeight, 3) : 0;
        const x = index * (barWidth + gap);
        const y = plotHeight - h;
        const r = Math.min(2, h);
        return (
          <g key={day}>
            <title>{`${day} · ${formatCost(value)}`}</title>
            {/* full-height hit target so hover works on empty days too */}
            <rect x={x} y={0} width={barWidth} height={plotHeight} fill="transparent" />
            {h > 0 ? (
              <path
                className="fill-chart-1"
                d={`M ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} H ${x + barWidth - r} Q ${x + barWidth} ${y} ${x + barWidth} ${y + r} V ${plotHeight} H ${x} Z`}
              />
            ) : null}
          </g>
        );
      })}
      <line
        x1={0}
        y1={plotHeight + 0.5}
        x2={width}
        y2={plotHeight + 0.5}
        className="stroke-border"
      />
      {[0, Math.floor((days.length - 1) / 2), days.length - 1]
        .filter((v, i, arr) => arr.indexOf(v) === i)
        .map((index) => (
          <text
            key={days[index]}
            x={index * (barWidth + gap) + barWidth / 2}
            y={height - 3}
            textAnchor="middle"
            className="fill-muted-foreground text-[9px]"
          >
            {days[index]?.slice(8)}
          </text>
        ))}
    </svg>
  );
}

function BreakdownCard({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; costUsd: number; tokens: number }>;
}) {
  const { t } = useTranslation("usage");
  const max = Math.max(...rows.map((row) => row.costUsd), 0.000001);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          rows.map((row) => (
            <div key={row.label} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">{row.label}</span>
                <span className="shrink-0 font-medium tabular-nums">
                  {formatCost(row.costUsd)}
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    {row.tokens.toLocaleString()}
                  </span>
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-chart-1"
                  style={{ width: `${Math.max((row.costUsd / max) * 100, 2)}%` }}
                />
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export function UsagePage() {
  const { t, i18n } = useTranslation(["usage", "runs"]);
  const { projectId } = useParams({ strict: false }) as { projectId: string };

  const usage = useQuery({
    queryKey: ["usage", projectId],
    queryFn: () => api<Usage>(`/projects/${projectId}/usage`),
  });
  const quota = useQuery({
    queryKey: ["quota", projectId],
    queryFn: () => api<Quota>(`/projects/${projectId}/quota`),
  });

  if (usage.isLoading) return <DetailSkeleton />;
  const data = usage.data;
  if (!data) return null;

  const costLimit = quota.data?.costLimitUsd ? Number(quota.data.costLimitUsd) : null;
  const period = new Date().toLocaleDateString(i18n.language, {
    year: "numeric",
    month: "long",
  });

  return (
    <div className="space-y-6">
      <PageHeader title={t("usage:title")} description={t("usage:period", { period })} />

      {data.tokens === 0 ? (
        <EmptyState icon={BarChart3Icon} title={t("usage:noUsage")} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader className="flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {t("usage:totalCost")}
                </CardTitle>
                <CircleDollarSignIcon className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-2xl font-semibold">
                  {formatCost(data.costUsd)}
                  {costLimit ? (
                    <span className="ml-1 text-sm font-normal text-muted-foreground">
                      / {formatCost(costLimit)}
                    </span>
                  ) : null}
                </p>
                {costLimit ? (
                  <Progress
                    value={Math.min(100, (data.costUsd / costLimit) * 100)}
                    className="h-1.5"
                  />
                ) : null}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {t("usage:totalTokens")}
                </CardTitle>
                <CoinsIcon className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent className="text-2xl font-semibold">
                {data.tokens.toLocaleString()}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t("usage:daily")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <DailyBars byDay={data.byDay} label={t("usage:daily")} />
            </CardContent>
          </Card>

          <div className="grid items-start gap-4 lg:grid-cols-2">
            <BreakdownCard
              title={t("usage:byModel")}
              rows={data.byModel.map((row) => ({
                label: row.model,
                costUsd: row.costUsd,
                tokens: row.tokens,
              }))}
            />
            <BreakdownCard
              title={t("usage:byTaskType")}
              rows={data.byTaskType.map((row) => ({
                label: row.taskTypeNameI18n ? lt(row.taskTypeNameI18n) : "—",
                costUsd: row.costUsd,
                tokens: row.tokens,
              }))}
            />
          </div>
        </>
      )}
    </div>
  );
}
