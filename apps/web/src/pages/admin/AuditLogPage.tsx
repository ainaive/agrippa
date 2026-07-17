import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, ScrollTextIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/LoadingSkeletons";
import { PageHeader } from "@/components/PageHeader";
import { SearchInput } from "@/components/SearchInput";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/format";

type AuditRow = {
  id: string;
  projectId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  payload: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
  actorEmail: string | null;
  actorName: string | null;
};

type ProjectRow = { id: string; name: string };

function AuditRowItem({ row, projectName }: { row: AuditRow; projectName?: string }) {
  const hasPayload = Object.keys(row.payload ?? {}).length > 0;
  return (
    <Collapsible>
      <div className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/50">
        <div className="min-w-0 flex-1">
          <p className="truncate">
            <span className="font-medium">{row.actorName ?? row.actorEmail ?? "—"}</span>
            <Badge variant="outline" className="mx-1.5 font-mono text-[10px]">
              {row.action}
            </Badge>
            <span className="text-muted-foreground">{row.resourceType}</span>
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {projectName ? `${projectName} · ` : ""}
            {formatTime(row.createdAt)}
            {row.ip ? ` · ${row.ip}` : ""}
          </p>
        </div>
        {hasPayload ? (
          <CollapsibleTrigger asChild>
            <Button size="icon-sm" variant="ghost" className="group/trigger">
              <ChevronDownIcon className="transition-transform group-data-[state=open]/trigger:rotate-180" />
            </Button>
          </CollapsibleTrigger>
        ) : null}
      </div>
      {hasPayload ? (
        <CollapsibleContent className="px-4 pb-3">
          <pre className="overflow-auto rounded-md bg-muted/40 p-3 font-mono text-xs">
            {JSON.stringify(row.payload, null, 2)}
          </pre>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}

export function AuditLogPage() {
  const { t } = useTranslation(["admin", "common"]);
  const [projectId, setProjectId] = useState("all");
  const [action, setAction] = useState("");

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<ProjectRow[]>("/projects"),
  });
  const logs = useQuery({
    queryKey: ["audit-logs", projectId, action],
    queryFn: () => {
      const params = new URLSearchParams();
      if (projectId !== "all") params.set("projectId", projectId);
      if (action) params.set("action", action);
      params.set("limit", "200");
      return api<AuditRow[]>(`/audit-logs?${params}`);
    },
  });

  const projectNames = new Map((projects.data ?? []).map((p) => [p.id, p.name]));

  return (
    <div className="space-y-6">
      <PageHeader title={t("admin:audit.title")} description={t("admin:audit.hint")} />

      <div className="flex flex-wrap items-center gap-2">
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("admin:audit.allProjects")}</SelectItem>
            {(projects.data ?? []).map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <SearchInput
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder={t("admin:audit.actionFilter")}
          className="w-64 font-mono text-xs"
        />
      </div>

      {logs.isLoading ? (
        <TableSkeleton rows={8} />
      ) : (logs.data ?? []).length === 0 ? (
        <EmptyState icon={ScrollTextIcon} title={t("admin:audit.empty")} />
      ) : (
        <div className="divide-y overflow-hidden rounded-lg border">
          {(logs.data ?? []).map((row) => (
            <AuditRowItem
              key={row.id}
              row={row}
              projectName={row.projectId ? projectNames.get(row.projectId) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
