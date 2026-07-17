import type { RunStatus } from "@agrippa/core";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { InboxIcon, PlusIcon, SearchXIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/LoadingSkeletons";
import { PageHeader } from "@/components/PageHeader";
import { SearchInput } from "@/components/SearchInput";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

const STATUSES: RunStatus[] = [
  "queued",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
];

export function TasksPage() {
  const { t } = useTranslation(["runs", "common"]);
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("all");

  const tasks = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => api<TaskRow[]>(`/projects/${projectId}/tasks`),
    refetchInterval: 5000,
  });

  const all = tasks.data ?? [];
  const visible = all.filter(
    (task) =>
      (status === "all" || task.runStatus === status) &&
      (query === "" || task.title.toLowerCase().includes(query.toLowerCase())),
  );
  const filtered = query !== "" || status !== "all";

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("common:nav.tasks")}
        actions={
          <Button asChild>
            <Link to="/projects/$projectId/catalog" params={{ projectId }}>
              <PlusIcon />
              {t("runs:dashboard.newTask")}
            </Link>
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("common:actions.search")}
        />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("runs:table.allStatuses")}</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {t(`runs:status.${s}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {tasks.isLoading ? (
        <TableSkeleton rows={6} />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={filtered ? SearchXIcon : InboxIcon}
          title={filtered ? t("runs:table.noMatches") : t("runs:dashboard.empty")}
          action={
            filtered ? null : (
              <Button size="sm" asChild>
                <Link to="/projects/$projectId/catalog" params={{ projectId }}>
                  <PlusIcon />
                  {t("runs:dashboard.newTask")}
                </Link>
              </Button>
            )
          }
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("runs:table.title")}</TableHead>
                <TableHead>{t("runs:table.run")}</TableHead>
                <TableHead>{t("runs:table.status")}</TableHead>
                <TableHead>{t("runs:table.created")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((task) => (
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
                  <TableCell className="text-muted-foreground">
                    {formatTime(task.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
