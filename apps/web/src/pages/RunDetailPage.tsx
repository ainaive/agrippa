import { isTerminalRunStatus, projectRoleAtLeast } from "@agrippa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ChevronDownIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ArtifactPreview, isPreviewable } from "@/components/artifacts/ArtifactPreview";
import { FaberAvatar } from "@/components/FaberAvatar";
import { DetailSkeleton } from "@/components/LoadingSkeletons";
import { PageHeader } from "@/components/PageHeader";
import { QueryErrorState } from "@/components/QueryErrorState";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BudgetMeter } from "@/features/runs/BudgetMeter";
import { PhaseTimeline } from "@/features/runs/PhaseTimeline";
import { RunActivityFeed } from "@/features/runs/RunActivityFeed";
import { RunMetaCard } from "@/features/runs/RunMetaCard";
import { RunTimeline } from "@/features/runs/RunTimeline";
import { useMe } from "../features/me";
import { useRunEvents } from "../features/useRunEvents";
import { api } from "../lib/api";
import { formatCost, formatDuration, formatTime, lt } from "../lib/format";
import type { Artifact, Run, RunStep } from "../lib/types";

function ArtifactRow({ artifact }: { artifact: Artifact }) {
  const { t } = useTranslation("runs");
  return (
    <Collapsible>
      <div className="flex items-center justify-between gap-2 py-2 text-sm">
        <div className="min-w-0">
          <p className="truncate font-medium">{artifact.artifactKey}</p>
          <p className="text-xs text-muted-foreground">
            {artifact.kind} · {artifact.size ?? 0} B · {formatTime(artifact.createdAt)}
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {isPreviewable(artifact) ? (
            <CollapsibleTrigger asChild>
              <Button size="sm" variant="ghost" className="group/trigger">
                {t("artifact.preview")}
                <ChevronDownIcon className="transition-transform group-data-[state=open]/trigger:rotate-180" />
              </Button>
            </CollapsibleTrigger>
          ) : null}
          <Button size="sm" variant="outline" asChild>
            <a href={`/api/v1/artifacts/${artifact.id}/download`} target="_blank" rel="noreferrer">
              {t("actions.download")}
            </a>
          </Button>
        </div>
      </div>
      <CollapsibleContent className="pb-3">
        <ArtifactPreview artifact={artifact} />
      </CollapsibleContent>
    </Collapsible>
  );
}

export function RunDetailPage() {
  const { t } = useTranslation("runs");
  const navigate = useNavigate();
  const me = useMe();
  const { projectId, runId } = useParams({ strict: false }) as {
    projectId: string;
    runId: string;
  };
  const queryClient = useQueryClient();

  const run = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api<Run>(`/runs/${runId}`),
  });
  const live = run.data ? !isTerminalRunStatus(run.data.status) : true;
  const steps = useQuery({
    queryKey: ["run", runId, "steps"],
    queryFn: () => api<RunStep[]>(`/runs/${runId}/steps`),
    refetchInterval: live ? 3000 : false,
  });
  const artifacts = useQuery({
    queryKey: ["run", runId, "artifacts"],
    queryFn: () => api<Artifact[]>(`/runs/${runId}/artifacts`),
    refetchInterval: live ? 5000 : false,
  });

  const events = useRunEvents(runId, run.data?.status);

  const cancel = useMutation({
    mutationFn: () => api(`/runs/${runId}/cancel`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["run", runId] }),
  });
  const retry = useMutation({
    mutationFn: () =>
      api<{ runId: string }>(`/tasks/${run.data?.taskId}/retry`, { method: "POST" }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
      void navigate({
        to: "/projects/$projectId/runs/$runId",
        params: { projectId, runId: result.runId },
      });
    },
  });

  if (run.isError) return <QueryErrorState onRetry={() => void run.refetch()} />;
  if (!run.data) return <DetailSkeleton />;
  const current = run.data;
  const role = me.projects.find((p) => p.projectId === current.projectId)?.role;
  const canRespond = role !== undefined && projectRoleAtLeast(role, "member");

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="tabular-nums">
            {t("run")} #{current.number}
          </span>
        }
        meta={
          <>
            <RunStatusBadge status={current.status} />
            <span className="text-sm text-muted-foreground tabular-nums">
              {current.usageTotals?.costUsd != null
                ? `${formatCost(current.usageTotals.costUsd)} · `
                : ""}
              {formatDuration(current.startedAt, current.finishedAt)}
            </span>
            {Object.entries(current.agents ?? {}).map(([slot, binding]) => (
              <span
                key={slot}
                className="flex items-center gap-1.5 rounded-md border bg-muted/50 px-1.5 py-0.5 text-xs"
                title={
                  current.template?.agents?.[slot] ? lt(current.template.agents[slot]?.label) : slot
                }
              >
                <FaberAvatar avatar={binding.faberAvatar} size="sm" className="size-4 text-xs" />
                <span className="max-w-28 truncate">{lt(binding.faberName ?? undefined)}</span>
                <span className="text-muted-foreground">{binding.executorLabel}</span>
              </span>
            ))}
            {current.workBranch ? (
              <span className="rounded-md border bg-muted/50 px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                {current.workBranch}
              </span>
            ) : null}
          </>
        }
        actions={
          isTerminalRunStatus(current.status) ? (
            <Button
              size="sm"
              variant="outline"
              disabled={retry.isPending}
              onClick={() => retry.mutate()}
            >
              <RotateCcwIcon />
              {t("actions.retry")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              <XIcon />
              {t("actions.cancel")}
            </Button>
          )
        }
      />

      {current.error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {current.error.code}: {current.error.message}
        </p>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[340px_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("timeline")}</CardTitle>
            </CardHeader>
            <CardContent>
              <PhaseTimeline
                template={current.template}
                steps={steps.data ?? []}
                checkpoints={current.checkpoints ?? []}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("budget.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              <BudgetMeter run={current} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("meta.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              <RunMetaCard run={current} />
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="timeline">
          <TabsList>
            <TabsTrigger value="timeline">{t("tabs.timeline")}</TabsTrigger>
            <TabsTrigger value="activity">{t("tabs.activity")}</TabsTrigger>
            <TabsTrigger value="artifacts">
              {t("tabs.artifacts")} ({artifacts.data?.length ?? 0})
            </TabsTrigger>
            <TabsTrigger value="params">{t("tabs.params")}</TabsTrigger>
          </TabsList>
          <TabsContent value="timeline">
            <Card>
              <CardContent>
                <RunTimeline
                  runId={runId}
                  run={current}
                  events={events}
                  artifacts={artifacts.data ?? []}
                  artifactsStatus={artifacts.status}
                  onRetryArtifacts={() => void artifacts.refetch()}
                  canRespond={canRespond}
                />
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="activity">
            <Card>
              <CardContent>
                <RunActivityFeed events={events} />
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="artifacts">
            <Card>
              <CardContent>
                {(artifacts.data ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("noArtifacts")}</p>
                ) : (
                  <div className="divide-y">
                    {(artifacts.data ?? []).map((artifact) => (
                      <ArtifactRow key={artifact.id} artifact={artifact} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="params">
            <Card>
              <CardContent>
                <pre className="overflow-auto rounded-md bg-muted/50 p-3 text-xs">
                  {JSON.stringify(current.paramsSnapshot, null, 2)}
                </pre>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
