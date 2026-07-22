import { type CheckpointKind, projectRoleAtLeast } from "@agrippa/core";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  CircleCheckBigIcon,
  ExternalLinkIcon,
  ListChecksIcon,
  type LucideIcon,
  MessageCircleQuestionIcon,
  StampIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/LoadingSkeletons";
import { PageHeader } from "@/components/PageHeader";
import { QueryErrorState } from "@/components/QueryErrorState";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { CheckpointPanel } from "@/features/runs/CheckpointPanel";
import { type PendingCheckpoint, usePendingCheckpoints } from "@/features/usePendingCheckpoints";
import { api } from "../lib/api";
import { formatTime, lt } from "../lib/format";
import type { Artifact, Checkpoint } from "../lib/types";

const KIND_ICON: Record<CheckpointKind, LucideIcon> = {
  approval: StampIcon,
  input: MessageCircleQuestionIcon,
  "review-gate": ListChecksIcon,
};

/** Expanded row: loads the run's artifacts so the panel can preview present[]. */
function InlineDecision({ item }: { item: PendingCheckpoint }) {
  const artifacts = useQuery({
    queryKey: ["run", item.runId, "artifacts"],
    queryFn: () => api<Artifact[]>(`/runs/${item.runId}/artifacts`),
  });
  const checkpoint: Checkpoint = {
    id: item.id,
    checkpointId: item.checkpointId,
    kind: item.kind,
    iteration: item.iteration,
    status: "pending",
    payload: item.payload,
    response: null,
    requestedAt: item.requestedAt,
    decidedAt: null,
    comment: null,
  };
  return (
    <CheckpointPanel
      runId={item.runId}
      checkpoint={checkpoint}
      artifacts={artifacts.data ?? []}
      artifactsStatus={artifacts.status}
    />
  );
}

function InboxRow({ item }: { item: PendingCheckpoint }) {
  const { t } = useTranslation("runs");
  const canDecide = projectRoleAtLeast(item.projectRole, "member");
  const KindIcon = KIND_ICON[item.kind] ?? StampIcon;
  return (
    <Collapsible>
      <div className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50">
        <KindIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">
            {item.taskTitle}
            <span className="ml-1.5 text-sm font-normal text-muted-foreground tabular-nums">
              #{item.runNumber}
            </span>
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {t(`inbox.kind.${item.kind}`)} ·{" "}
            {item.payload.title ? lt(item.payload.title) : item.checkpointId}
            {item.iteration > 1 ? ` · ${t("rounds.label", { round: item.iteration })}` : ""} ·{" "}
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
  const pending = usePendingCheckpoints();

  const byProject = new Map<string, { projectName: string; items: PendingCheckpoint[] }>();
  for (const item of pending.data ?? []) {
    const group = byProject.get(item.projectId) ?? { projectName: item.projectName, items: [] };
    group.items.push(item);
    byProject.set(item.projectId, group);
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t("approvalsInbox.title")} description={t("approvalsInbox.description")} />
      {pending.isLoading ? (
        <TableSkeleton rows={3} />
      ) : pending.isError ? (
        <QueryErrorState onRetry={() => void pending.refetch()} />
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
