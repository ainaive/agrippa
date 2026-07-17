import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RunStatusBadge } from "../components/RunStatusBadge";
import { useMe } from "../features/me";
import { api } from "../lib/api";
import { formatTime } from "../lib/format";
import type { TaskRow } from "../lib/types";

/**
 * Cross-project inbox: runs waiting for approval across the user's projects.
 * M1 derives it from task lists; a dedicated endpoint can come later.
 */
export function ApprovalsPage() {
  const { t } = useTranslation("runs");
  const me = useMe();

  const perProject = useQueries({
    queries: me.projects.map((project) => ({
      queryKey: ["tasks", project.projectId],
      queryFn: () => api<TaskRow[]>(`/projects/${project.projectId}/tasks`),
      refetchInterval: 10_000,
    })),
  });

  const waiting = me.projects.flatMap((project, index) =>
    (perProject[index]?.data ?? [])
      .filter((task) => task.runStatus === "waiting_approval")
      .map((task) => ({ project, task })),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("approvalsInbox.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        {waiting.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("approvalsInbox.empty")}
          </p>
        ) : (
          <ul className="divide-y">
            {waiting.map(({ project, task }) => (
              <li key={task.id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <Link
                    to="/projects/$projectId/runs/$runId"
                    params={{
                      projectId: project.projectId,
                      runId: task.latestRunId ?? "",
                    }}
                    className="font-medium hover:underline"
                  >
                    {task.title}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {project.name} · {formatTime(task.createdAt)}
                  </p>
                </div>
                <RunStatusBadge status="waiting_approval" />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
