import type { CheckpointRespondInput } from "@agrippa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CirclePauseIcon, Loader2Icon, TriangleAlertIcon, Undo2Icon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArtifactPreview } from "@/components/artifacts/ArtifactPreview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api } from "@/lib/api";
import { lt } from "@/lib/format";
import type { Artifact, Checkpoint } from "@/lib/types";
import { FindingsTable } from "./FindingsTable";
import { QuestionsForm } from "./QuestionsForm";

/**
 * Pending-checkpoint panel — the run's interaction card. The body depends on
 * the checkpoint kind: approve / request-changes / reject for approvals, the
 * question form for input checkpoints, and the findings decision table for
 * review gates. `present` artifacts render inline so the responder can decide
 * without leaving the page. Reused by the run detail page and the inbox.
 */
export function CheckpointPanel({
  runId,
  checkpoint,
  artifacts,
  artifactsStatus,
  onResponded,
}: {
  runId: string;
  checkpoint: Checkpoint;
  artifacts: Artifact[];
  /** Status of the artifacts query — evidence must load before approving. */
  artifactsStatus: "pending" | "error" | "success";
  onResponded?: () => void;
}) {
  const { t } = useTranslation(["runs", "common"]);
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");

  const respond = useMutation({
    mutationFn: (input: CheckpointRespondInput) =>
      api(`/runs/${runId}/checkpoints/${checkpoint.id}/respond`, {
        method: "POST",
        json: input,
      }),
    onSuccess: () => {
      toast.success(t("common:feedback.saved"));
      void queryClient.invalidateQueries({ queryKey: ["run", runId] });
      void queryClient.invalidateQueries({ queryKey: ["checkpoints-pending"] });
      onResponded?.();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : String(error));
    },
  });

  const presentKeys = checkpoint.payload.present ?? [];
  const presented = presentKeys.map((key) => ({
    key,
    // loop rounds re-produce the same key — present the LATEST row, not the
    // first (the API returns rows in creation order)
    artifact: artifacts.findLast((a) => a.artifactKey === key),
  }));
  // Evidence gating only matters when the checkpoint presents something:
  // while it loads, no decision; if it failed, approving blind is forbidden
  // but rejecting must stay possible or a broken run deadlocks its checkpoint.
  const evidencePending = presentKeys.length > 0 && artifactsStatus === "pending";
  const evidenceFailed = presentKeys.length > 0 && artifactsStatus === "error";
  const busy = respond.isPending || evidencePending;

  return (
    <Card className="border-status-warning/40 bg-status-warning/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CirclePauseIcon className="size-4 text-status-warning" />
          {checkpoint.payload.title ? lt(checkpoint.payload.title) : checkpoint.checkpointId}
          {checkpoint.iteration > 1 ? (
            <Badge variant="outline">
              {t("runs:rounds.label", { round: checkpoint.iteration })}
            </Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {t(`runs:checkpoint.hint.${checkpoint.kind}`)}
        </p>
        {evidencePending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            {t("runs:approval.loadingArtifacts")}
          </p>
        ) : evidenceFailed ? (
          <p className="flex items-center gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-sm">
            <TriangleAlertIcon className="size-4 shrink-0 text-status-warning" />
            {t("runs:approval.artifactsUnavailable")}
          </p>
        ) : presented.length > 0 ? (
          <div className="space-y-3">
            <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
              {t("runs:approval.presented")}
            </p>
            {presented.map(({ key, artifact }) =>
              artifact ? (
                <div key={key}>
                  <p className="mb-1 text-sm font-medium">{artifact.artifactKey}</p>
                  <ArtifactPreview artifact={artifact} />
                </div>
              ) : (
                <p key={key} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <TriangleAlertIcon className="size-4 shrink-0 text-status-warning" />
                  <span className="font-medium">{key}</span>
                  {t("runs:approval.artifactMissing")}
                </p>
              ),
            )}
          </div>
        ) : null}

        {checkpoint.kind === "input" ? (
          <QuestionsForm
            questions={checkpoint.payload.questions ?? []}
            disabled={busy}
            onSubmit={(answers) => respond.mutate({ kind: "input", answers })}
          />
        ) : checkpoint.kind === "review-gate" ? (
          <FindingsTable
            summary={checkpoint.payload.summary}
            findings={checkpoint.payload.findings ?? []}
            disabled={busy || evidenceFailed}
            onFix={(selectedFindingIds) =>
              respond.mutate({ kind: "review-gate", outcome: "fix", selectedFindingIds })
            }
            onAccept={() =>
              respond.mutate({ kind: "review-gate", outcome: "accept", selectedFindingIds: [] })
            }
          />
        ) : (
          <>
            <Textarea
              rows={2}
              placeholder={t("runs:approval.commentPlaceholder")}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy || evidenceFailed}
                onClick={() =>
                  respond.mutate({
                    kind: "approval",
                    decision: "approved",
                    comment: comment || undefined,
                  })
                }
              >
                {t("runs:approval.approve")}
              </Button>
              {checkpoint.payload.loopId ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || evidenceFailed || comment.length === 0}
                  onClick={() =>
                    respond.mutate({ kind: "approval", decision: "request_changes", comment })
                  }
                >
                  <Undo2Icon />
                  {t("runs:checkpoint.requestChanges")}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  respond.mutate({
                    kind: "approval",
                    decision: "rejected",
                    comment: comment || undefined,
                  })
                }
              >
                {t("runs:approval.reject")}
              </Button>
            </div>
            {checkpoint.payload.loopId ? (
              <p className="text-xs text-muted-foreground">
                {t("runs:checkpoint.requestChangesHint")}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
