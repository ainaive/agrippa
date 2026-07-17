import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
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
import { formatTime } from "../lib/format";
import type { TaskRow } from "../lib/types";

export function TasksPage() {
  const { t } = useTranslation("runs");
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const tasks = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => api<TaskRow[]>(`/projects/${projectId}/tasks`),
    refetchInterval: 5000,
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" asChild>
          <Link to="/projects/$projectId/catalog" params={{ projectId }}>
            {t("dashboard.newTask")}
          </Link>
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("table.title")}</TableHead>
            <TableHead>{t("table.run")}</TableHead>
            <TableHead>{t("table.status")}</TableHead>
            <TableHead>{t("table.created")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(tasks.data ?? []).map((task) => (
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
              <TableCell className="text-muted-foreground">#{task.runNumber ?? "—"}</TableCell>
              <TableCell>
                {task.runStatus ? <RunStatusBadge status={task.runStatus} /> : "—"}
              </TableCell>
              <TableCell className="text-muted-foreground">{formatTime(task.createdAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {tasks.data?.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">{t("dashboard.empty")}</p>
      )}
    </div>
  );
}
