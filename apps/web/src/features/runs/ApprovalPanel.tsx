import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CirclePauseIcon } from "lucide-react";
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
  onDecided,
}: {
  runId: string;
  approval: Approval;
  artifacts: Artifact[];
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

  const presented = (approval.payload.present ?? [])
    .map((key) => artifacts.find((a) => a.artifactKey === key))
    .filter((a): a is Artifact => a !== undefined);

  return (
    <Card className="border-status-warning/40 bg-status-warning/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CirclePauseIcon className="size-4 text-status-warning" />
          {approval.payload.title ? lt(approval.payload.title) : approval.checkpointId}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("runs:approval.hint")}</p>
        {presented.length > 0 ? (
          <div className="space-y-3">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t("runs:approval.presented")}
            </p>
            {presented.map((artifact) => (
              <div key={artifact.id}>
                <p className="mb-1 text-sm font-medium">{artifact.artifactKey}</p>
                <ArtifactPreview artifact={artifact} />
              </div>
            ))}
          </div>
        ) : null}
        <Textarea
          rows={2}
          placeholder={t("runs:approval.commentPlaceholder")}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <div className="flex gap-2">
          <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate("approved")}>
            {t("runs:approval.approve")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={decide.isPending}
            onClick={() => decide.mutate("rejected")}
          >
            {t("runs:approval.reject")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
