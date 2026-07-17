import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  defaultParams,
  missingRequired,
  type ParamsValue,
  TaskParamsForm,
} from "../components/TaskParamsForm";
import { ApiError, api } from "../lib/api";
import { formatCost, lt } from "../lib/format";
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
  });

  if (taskType.isLoading) return <p className="text-muted-foreground">…</p>;
  if (!taskType.data) return <p className="text-destructive">{t("notFound")}</p>;
  const detail = taskType.data;
  const missing = missingRequired(inputs, value);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <span aria-hidden>{detail.faber?.avatar ?? "🤖"}</span>
          {lt(detail.nameI18n)}
        </h2>
        <p className="text-sm text-muted-foreground">{lt(detail.descriptionI18n)}</p>
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

      <div className="flex items-center justify-between rounded-md border bg-muted/40 px-4 py-3 text-sm">
        <span className="text-muted-foreground">
          {t("form.budget")}: {formatCost(detail.budgets?.maxCostUsd)} ·{" "}
          {detail.budgets?.maxDurationMinutes ?? "—"} {t("form.minutes")}
        </span>
        <span className="text-muted-foreground">
          {detail.template?.slug}@v{detail.templateVersion?.version ?? "—"}
        </span>
      </div>

      {submit.isError && (
        <p className="text-sm text-destructive">
          {submit.error instanceof ApiError
            ? `${submit.error.code}: ${submit.error.message}`
            : String(submit.error)}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button
          disabled={!title || missing.length > 0 || submit.isPending || !detail.templateVersion}
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? t("form.submitting") : t("form.submit")}
        </Button>
      </div>
      {missing.length > 0 && (
        <p className="text-right text-xs text-muted-foreground">
          {t("form.missingRequired")}: {missing.join(", ")}
        </p>
      )}
    </div>
  );
}
