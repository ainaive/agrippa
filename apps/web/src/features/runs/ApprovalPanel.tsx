import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CirclePauseIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArtifactPreview } from "@/components/artifacts/ArtifactPreview";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api } from "@/lib/api";
import { lt } from "@/lib/format";
import type { Approval, Artifact } from "@/lib/types";

/**
 * Pending-checkpoint panel: renders the checkpoint's `present` artifacts
 * inline so the reviewer can decide without leaving the page. Reused by the
 * run detail page and the cross-project approvals inbox.
 */
export function ApprovalPanel({
  runId,
  approval,
  artifacts,
  artifactsStatus,
  onDecided,
}: {
  runId: string;
  approval: Approval;
  artifacts: Artifact[];
  /** Status of the artifacts query — evidence must load before approving. */
  artifactsStatus: "pending" | "error" | "success";
  onDecided?: () => void;
}) {
  const { t } = useTranslation(["runs", "common"]);
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");

  const decide = useMutation({
    mutationFn: (decision: "approved" | "rejected") =>
      api(`/runs/${runId}/approvals/${approval.id}`, {
        method: "POST",
        json: { decision, comment: comment || undefined },
      }),
    onSuccess: () => {
      toast.success(t("common:feedback.saved"));
      void queryClient.invalidateQueries({ queryKey: ["run", runId] });
      void queryClient.invalidateQueries({ queryKey: ["approvals-pending"] });
      onDecided?.();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : String(error));
    },
  });

  const presentKeys = approval.payload.present ?? [];
  const presented = presentKeys.map((key) => ({
    key,
    artifact: artifacts.find((a) => a.artifactKey === key),
  }));
  // Evidence gating only matters when the checkpoint presents something:
  // while it loads, no decision; if it failed, approving blind is forbidden
  // but rejecting must stay possible or a broken run deadlocks its checkpoint.
  const evidencePending = presentKeys.length > 0 && artifactsStatus === "pending";
  const evidenceFailed = presentKeys.length > 0 && artifactsStatus === "error";

  return (
    <Card className="border-status-warning/40 bg-status-warning/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CirclePauseIcon className="size-4 text-status-warning" />
          {approval.payload.title ? lt(approval.payload.title) : approval.checkpointId}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("runs:approval.hint")}</p>
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
        <Textarea
          rows={2}
          placeholder={t("runs:approval.commentPlaceholder")}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={decide.isPending || evidencePending || evidenceFailed}
            onClick={() => decide.mutate("approved")}
          >
            {t("runs:approval.approve")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={decide.isPending || evidencePending}
            onClick={() => decide.mutate("rejected")}
          >
            {t("runs:approval.reject")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
