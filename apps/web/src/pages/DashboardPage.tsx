import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RunStatusBadge } from "../components/RunStatusBadge";
import { api } from "../lib/api";
import { formatCost, formatTime } from "../lib/format";
import type { Quota, TaskRow } from "../lib/types";

export function DashboardPage() {
  const { t } = useTranslation("runs");
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
    queryFn: () => api<{ costUsd: number; tokens: number }>(`/projects/${projectId}/usage`),
    retry: false,
    // usage endpoint lands in M1.5 — treat 404 as empty
    throwOnError: false,
  });

  const recent = (tasks.data ?? []).slice(0, 8);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              {t("dashboard.openTasks")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {
              (tasks.data ?? []).filter(
                (r) =>
                  r.runStatus &&
                  !["succeeded", "failed", "cancelled", "timed_out"].includes(r.runStatus),
              ).length
            }
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">{t("dashboard.spend")}</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {formatCost(usage.data?.costUsd)}
            {quota.data?.costLimitUsd && (
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                / {formatCost(Number(quota.data.costLimitUsd))}
              </span>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">{t("dashboard.total")}</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{tasks.data?.length ?? 0}</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>{t("dashboard.recent")}</CardTitle>
          <Button size="sm" asChild>
            <Link to="/projects/$projectId/catalog" params={{ projectId }}>
              {t("dashboard.newTask")}
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("dashboard.empty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("table.title")}</TableHead>
                  <TableHead>{t("table.status")}</TableHead>
                  <TableHead>{t("table.created")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((task) => (
                  <TableRow key={task.id}>
                    <TableCell>
                      {task.latestRunId ? (
                        <Link
                          to="/projects/$projectId/runs/$runId"
                          params={{ projectId, runId: task.latestRunId }}
                          className="font-medium hover:underline"
                        >
                          {task.title}
                        </Link>
                      ) : (
                        task.title
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
    </div>
  );
}
