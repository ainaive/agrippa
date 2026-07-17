import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  ActivityIcon,
  ArrowRightIcon,
  CircleDollarSignIcon,
  CirclePauseIcon,
  InboxIcon,
  ListChecksIcon,
  PlusIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/LoadingSkeletons";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { usePendingApprovals } from "@/features/usePendingApprovals";
import { RunStatusBadge } from "../components/RunStatusBadge";
import { api } from "../lib/api";
import { formatCost, formatTime } from "../lib/format";
import type { Quota, TaskRow } from "../lib/types";

const TERMINAL = ["succeeded", "failed", "cancelled", "timed_out"];

export function DashboardPage() {
  const { t } = useTranslation(["runs", "common"]);
  const { projectId } = useParams({ strict: false }) as { projectId: string };

  const tasks = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => api<TaskRow[]>(`/projects/${projectId}/tasks`),
  });
  const quota = useQuery({
    queryKey: ["quota", projectId],
    queryFn: () => api<Quota>(`/projects/${projectId}/quota`),
  });
  const usage = useQuery({
    queryKey: ["usage", projectId],
    queryFn: () =>
      api<{
        costUsd: number;
        tokens: number;
        byModel: Array<{ model: string; costUsd: number; tokens: number }>;
      }>(`/projects/${projectId}/usage`),
  });

  const all = tasks.data ?? [];
  const active = all.filter((r) => r.runStatus && !TERMINAL.includes(r.runStatus));
  const waiting = (usePendingApprovals().data ?? []).filter((a) => a.projectId === projectId);
  const recent = all.slice(0, 8);

  const costLimit = quota.data?.costLimitUsd ? Number(quota.data.costLimitUsd) : null;
  const spent = usage.data?.costUsd ?? 0;
  const quotaPct = costLimit ? Math.min(100, (spent / costLimit) * 100) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("common:nav.dashboard")}
        actions={
          <Button asChild>
            <Link to="/projects/$projectId/catalog" params={{ projectId }}>
              <PlusIcon />
              {t("runs:dashboard.newTask")}
            </Link>
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title={t("runs:dashboard.openTasks")} icon={ActivityIcon} value={active.length} />

        <StatCard
          title={t("runs:dashboard.pendingApprovals")}
          icon={CirclePauseIcon}
          value={waiting.length}
        >
          {waiting.length > 0 ? (
            <Link
              to="/approvals"
              className="inline-flex items-center gap-1 text-xs text-primary transition-colors hover:underline"
            >
              {t("runs:approvalsInbox.title")}
              <ArrowRightIcon className="size-3" />
            </Link>
          ) : null}
        </StatCard>

        <StatCard
          title={t("runs:dashboard.spend")}
          icon={CircleDollarSignIcon}
          value={
            <>
              {formatCost(spent)}
              {costLimit ? (
                <span className="ml-1 text-sm font-normal text-muted-foreground">
                  / {formatCost(costLimit)}
                </span>
              ) : null}
            </>
          }
        >
          {quotaPct !== null ? <Progress value={quotaPct} className="h-1.5" /> : null}
          <p className="text-xs text-muted-foreground tabular-nums">
            {t("runs:dashboard.tokensCount", {
              count: usage.data?.tokens ?? 0,
              formattedCount: (usage.data?.tokens ?? 0).toLocaleString(),
            })}
          </p>
        </StatCard>

        <StatCard title={t("runs:dashboard.total")} icon={ListChecksIcon} value={all.length} />
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[1fr_280px]">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>{t("runs:dashboard.recent")}</CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/projects/$projectId/tasks" params={{ projectId }}>
                {t("runs:dashboard.viewAll")}
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {tasks.isLoading ? (
              <TableSkeleton rows={4} />
            ) : recent.length === 0 ? (
              <EmptyState
                icon={InboxIcon}
                title={t("runs:dashboard.empty")}
                className="border-none"
                action={
                  <Button size="sm" asChild>
                    <Link to="/projects/$projectId/catalog" params={{ projectId }}>
                      <PlusIcon />
                      {t("runs:dashboard.newTask")}
                    </Link>
                  </Button>
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("runs:table.title")}</TableHead>
                    <TableHead>{t("runs:table.status")}</TableHead>
                    <TableHead>{t("runs:table.created")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recent.map((task) => (
                    <TableRow key={task.id}>
                      <TableCell className="max-w-96">
                        {task.latestRunId ? (
                          <Link
                            to="/projects/$projectId/runs/$runId"
                            params={{ projectId, runId: task.latestRunId }}
                            className="block truncate font-medium hover:underline"
                          >
                            {task.title}
                          </Link>
                        ) : (
                          <span className="block truncate">{task.title}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {task.runStatus ? <RunStatusBadge status={task.runStatus} /> : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatTime(task.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t("runs:dashboard.byModel")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(usage.data?.byModel ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("runs:dashboard.noSpend")}</p>
            ) : (
              (usage.data?.byModel ?? []).map((row) => (
                <div key={row.model} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate text-muted-foreground">{row.model}</span>
                  <span className="font-medium tabular-nums">{formatCost(row.costUsd)}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
