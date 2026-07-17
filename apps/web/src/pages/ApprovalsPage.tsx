import { projectRoleAtLeast } from "@agrippa/core";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, CircleCheckBigIcon, ExternalLinkIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/LoadingSkeletons";
import { PageHeader } from "@/components/PageHeader";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ApprovalPanel } from "@/features/runs/ApprovalPanel";
import { type PendingApproval, usePendingApprovals } from "@/features/usePendingApprovals";
import { api } from "../lib/api";
import { formatTime, lt } from "../lib/format";
import type { Approval, Artifact } from "../lib/types";

/** Expanded row: loads the run's artifacts so the panel can preview present[]. */
function InlineDecision({ item }: { item: PendingApproval }) {
  const artifacts = useQuery({
    queryKey: ["run", item.runId, "artifacts"],
    queryFn: () => api<Artifact[]>(`/runs/${item.runId}/artifacts`),
  });
  const approval: Approval = {
    id: item.id,
    checkpointId: item.checkpointId,
    status: "pending",
    payload: item.payload,
    requestedAt: item.requestedAt,
    comment: null,
  };
  return <ApprovalPanel runId={item.runId} approval={approval} artifacts={artifacts.data ?? []} />;
}

function InboxRow({ item }: { item: PendingApproval }) {
  const { t } = useTranslation("runs");
  const canDecide = projectRoleAtLeast(item.projectRole, "member");
  return (
    <Collapsible>
      <div className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">
            {item.taskTitle}
            <span className="ml-1.5 text-sm font-normal text-muted-foreground tabular-nums">
              #{item.runNumber}
            </span>
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {item.payload.title ? lt(item.payload.title) : item.checkpointId} ·{" "}
            {formatTime(item.requestedAt)}
          </p>
        </div>
        <RunStatusBadge status="waiting_approval" />
        <Button size="sm" variant="ghost" asChild>
          <Link
            to="/projects/$projectId/runs/$runId"
            params={{ projectId: item.projectId, runId: item.runId }}
          >
            <ExternalLinkIcon />
            {t("approvalsInbox.openRun")}
          </Link>
        </Button>
        {canDecide ? (
          <CollapsibleTrigger asChild>
            <Button size="sm" variant="outline" className="group/trigger">
              {t("approvalsInbox.review")}
              <ChevronDownIcon className="transition-transform group-data-[state=open]/trigger:rotate-180" />
            </Button>
          </CollapsibleTrigger>
        ) : null}
      </div>
      <CollapsibleContent className="px-4 pb-3">
        <InlineDecision item={item} />
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ApprovalsPage() {
  const { t } = useTranslation("runs");
  const pending = usePendingApprovals();

  const byProject = new Map<string, { projectName: string; items: PendingApproval[] }>();
  for (const item of pending.data ?? []) {
    const group = byProject.get(item.projectId) ?? { projectName: item.projectName, items: [] };
    group.items.push(item);
    byProject.set(item.projectId, group);
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t("approvalsInbox.title")} />
      {pending.isLoading ? (
        <TableSkeleton rows={3} />
      ) : (pending.data ?? []).length === 0 ? (
        <EmptyState icon={CircleCheckBigIcon} title={t("approvalsInbox.empty")} />
      ) : (
        [...byProject.entries()].map(([projectId, group]) => (
          <section key={projectId}>
            <h2 className="mb-1.5 text-xs font-medium tracking-wider text-muted-foreground uppercase">
              {group.projectName}
            </h2>
            <div className="divide-y overflow-hidden rounded-lg border">
              {group.items.map((item) => (
                <InboxRow key={item.id} item={item} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
