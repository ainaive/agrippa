import { isTerminalRunStatus } from "@agrippa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { CirclePauseIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { DetailSkeleton } from "@/components/LoadingSkeletons";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { BudgetMeter } from "@/features/runs/BudgetMeter";
import { PhaseTimeline } from "@/features/runs/PhaseTimeline";
import { RunMetaCard } from "@/features/runs/RunMetaCard";
import { useRunEvents } from "../features/useRunEvents";
import { api } from "../lib/api";
import { formatCost, formatDuration, formatTime, lt } from "../lib/format";
import type { Approval, Artifact, Run, RunStep } from "../lib/types";

function ApprovalBanner({ runId, approval }: { runId: string; approval: Approval }) {
  const { t } = useTranslation("runs");
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");

  const decide = useMutation({
    mutationFn: (decision: "approved" | "rejected") =>
      api(`/runs/${runId}/approvals/${approval.id}`, {
        method: "POST",
        json: { decision, comment: comment || undefined },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["run", runId] }),
  });

  return (
    <Card className="border-status-warning/40 bg-status-warning/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CirclePauseIcon className="size-4 text-status-warning" />
          {approval.payload.title ? lt(approval.payload.title) : approval.checkpointId}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("approval.hint")}</p>
        <Textarea
          rows={2}
          placeholder={t("approval.commentPlaceholder")}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <div className="flex gap-2">
          <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate("approved")}>
            {t("approval.approve")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={decide.isPending}
            onClick={() => decide.mutate("rejected")}
          >
            {t("approval.reject")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function RunDetailPage() {
  const { t } = useTranslation("runs");
  const navigate = useNavigate();
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
  const approvals = useQuery({
    queryKey: ["run", runId, "approvals"],
    queryFn: () => api<Approval[]>(`/runs/${runId}/approvals`),
    refetchInterval: live ? 3000 : false,
  });
  const artifacts = useQuery({
    queryKey: ["run", runId, "artifacts"],
    queryFn: () => api<Artifact[]>(`/runs/${runId}/artifacts`),
    refetchInterval: live ? 5000 : false,
  });

  const events = useRunEvents(runId, run.data?.status);
  const streamText = useMemo(
    () =>
      events
        .filter((e) => e.type === "message.delta" || e.type === "message.completed")
        .map((e) => (e.type === "message.delta" ? e.payload.text : `\n`))
        .join(""),
    [events],
  );

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

  if (!run.data) return <DetailSkeleton />;
  const current = run.data;
  const pendingApproval = (approvals.data ?? []).find((a) => a.status === "pending");

  // latest attempt per step, in seq order — for the output fallback
  const latestSteps = [
    ...[...(steps.data ?? [])]
      .sort((a, b) => a.seq - b.seq || a.attempt - b.attempt)
      .reduce((acc, row) => acc.set(row.stepId, row), new Map<string, RunStep>())
      .values(),
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">
          {t("run")} #{current.number}
        </h1>
        <RunStatusBadge status={current.status} />
        <span className="text-sm text-muted-foreground">
          {formatCost(current.usageTotals?.costUsd)} ·{" "}
          {formatDuration(current.startedAt, current.finishedAt)}
        </span>
        <div className="ml-auto flex gap-2">
          {!isTerminalRunStatus(current.status) && (
            <Button
              size="sm"
              variant="outline"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              <XIcon />
              {t("actions.cancel")}
            </Button>
          )}
          {isTerminalRunStatus(current.status) && (
            <Button
              size="sm"
              variant="outline"
              disabled={retry.isPending}
              onClick={() => retry.mutate()}
            >
              <RotateCcwIcon />
              {t("actions.retry")}
            </Button>
          )}
        </div>
      </div>

      {current.error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {current.error.code}: {current.error.message}
        </p>
      )}

      {pendingApproval && <ApprovalBanner runId={runId} approval={pendingApproval} />}

      <div className="grid items-start gap-4 lg:grid-cols-[340px_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("timeline")}</CardTitle>
            </CardHeader>
            <CardContent>
              <PhaseTimeline
                template={current.template}
                steps={steps.data ?? []}
                approvals={approvals.data ?? []}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("budget.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              <BudgetMeter run={current} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("meta.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              <RunMetaCard run={current} />
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="output">
          <TabsList>
            <TabsTrigger value="output">{t("tabs.output")}</TabsTrigger>
            <TabsTrigger value="artifacts">
              {t("tabs.artifacts")} ({artifacts.data?.length ?? 0})
            </TabsTrigger>
            <TabsTrigger value="params">{t("tabs.params")}</TabsTrigger>
          </TabsList>
          <TabsContent value="output">
            <Card>
              <CardContent className="pt-4">
                <pre className="max-h-96 min-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-xs">
                  {streamText ||
                    latestSteps
                      .filter((s) => s.output)
                      .map((s) => `── ${s.stepId} ──\n${s.output}`)
                      .join("\n\n") ||
                    t("noOutput")}
                </pre>
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="artifacts">
            <Card>
              <CardContent className="pt-4">
                {(artifacts.data ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("noArtifacts")}</p>
                ) : (
                  <ul className="divide-y">
                    {(artifacts.data ?? []).map((artifact) => (
                      <li
                        key={artifact.id}
                        className="flex items-center justify-between py-2 text-sm"
                      >
                        <div>
                          <p className="font-medium">{artifact.artifactKey}</p>
                          <p className="text-xs text-muted-foreground">
                            {artifact.kind} · {artifact.size ?? 0} B ·{" "}
                            {formatTime(artifact.createdAt)}
                          </p>
                        </div>
                        <Button size="sm" variant="outline" asChild>
                          <a
                            href={`/api/v1/artifacts/${artifact.id}/download`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t("actions.download")}
                          </a>
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="params">
            <Card>
              <CardContent className="pt-4">
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
