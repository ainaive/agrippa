import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FaberAvatar } from "@/components/FaberAvatar";
import { DetailSkeleton } from "@/components/LoadingSkeletons";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  defaultParams,
  missingRequired,
  type ParamsValue,
  TaskParamsForm,
} from "../components/TaskParamsForm";
import { api } from "../lib/api";
import { formatCost, lt } from "../lib/format";
import { toastApiError } from "../lib/toast";
import type { TaskTypeDetail } from "../lib/types";

export function SubmitTaskPage() {
  const { t } = useTranslation("catalog");
  const navigate = useNavigate();
  const { projectId, taskTypeId } = useParams({ strict: false }) as {
    projectId: string;
    taskTypeId: string;
  };

  const taskType = useQuery({
    queryKey: ["task-type", taskTypeId],
    queryFn: () => api<TaskTypeDetail>(`/task-types/${taskTypeId}`),
  });

  const [title, setTitle] = useState("");
  const [params, setParams] = useState<ParamsValue | null>(null);
  const inputs = taskType.data?.inputs ?? [];
  const value = useMemo(() => params ?? defaultParams(inputs), [params, inputs]);

  const submit = useMutation({
    mutationFn: () =>
      api<{ taskId: string; runId: string }>(`/projects/${projectId}/tasks`, {
        method: "POST",
        json: { taskTypeId, title, params: value },
      }),
    onSuccess: (result) => {
      void navigate({
        to: "/projects/$projectId/runs/$runId",
        params: { projectId, runId: result.runId },
      });
    },
    onError: toastApiError,
  });

  if (taskType.isLoading) return <DetailSkeleton />;
  if (!taskType.data) return <p className="text-destructive">{t("notFound")}</p>;
  const detail = taskType.data;
  const missing = missingRequired(inputs, value);

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[1fr_300px]">
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{lt(detail.nameI18n)}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{lt(detail.descriptionI18n)}</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("form.parameters")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="task-title">
                {t("form.title")}
                <span className="text-destructive"> *</span>
              </Label>
              <Input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <TaskParamsForm
              projectId={projectId}
              inputs={inputs}
              value={value}
              onChange={setParams}
            />
          </CardContent>
        </Card>
      </div>

      <Card className="lg:sticky lg:top-20">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {t("form.summary")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center gap-2.5">
            <FaberAvatar avatar={detail.faber?.avatar} size="lg" />
            <div className="min-w-0">
              <p className="truncate font-medium">{lt(detail.faber?.nameI18n)}</p>
              <p className="truncate text-xs text-muted-foreground">
                {detail.template?.slug}@v{detail.templateVersion?.version ?? "—"}
              </p>
            </div>
          </div>
          <Separator />
          <div className="space-y-1.5">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("form.budget")}</span>
              <span className="font-medium tabular-nums">
                {formatCost(detail.budgets?.maxCostUsd)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("form.duration")}</span>
              <span className="font-medium tabular-nums">
                {detail.budgets?.maxDurationMinutes ?? "—"} {t("form.minutes")}
              </span>
            </div>
          </div>
          <Separator />
          <Button
            className="w-full"
            disabled={!title || missing.length > 0 || submit.isPending || !detail.templateVersion}
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? t("form.submitting") : t("form.submit")}
          </Button>
          {missing.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("form.missingRequired")}: {missing.join(", ")}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
