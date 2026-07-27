import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { AlertCircleIcon, CheckCircle2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FaberAvatar } from "@/components/FaberAvatar";
import { DetailSkeleton } from "@/components/LoadingSkeletons";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { type AgentOverrides, AgentSlotPicker } from "../components/submit/AgentSlotPicker";
import {
  defaultParams,
  missingRequired,
  type ParamsValue,
  TaskParamsForm,
} from "../components/TaskParamsForm";
import { api } from "../lib/api";
import { formatCost, lt } from "../lib/format";
import { toastApiError } from "../lib/toast";
import type { Preflight, PreflightCheck, TaskTypeDetail } from "../lib/types";

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

  // best-effort readiness check — surfaces config gaps (missing tier, missing
  // credential, missing skill, no repo) before the submit round-trip. Only
  // meaningful once the template is published; a 409 means it isn't.
  const preflight = useQuery({
    queryKey: ["preflight", projectId, taskTypeId],
    queryFn: async (): Promise<Preflight | null> => {
      const res = await api<Preflight | null>(
        `/projects/${projectId}/task-types/${taskTypeId}/preflight`,
        { method: "GET" },
      );
      return res;
    },
    enabled: !!taskType.data?.templateVersion,
    retry: false,
  });

  const [title, setTitle] = useState("");
  const [params, setParams] = useState<ParamsValue | null>(null);
  const [agentOverrides, setAgentOverrides] = useState<AgentOverrides>({});
  const inputs = taskType.data?.inputs ?? [];
  const value = useMemo(() => params ?? defaultParams(inputs), [params, inputs]);

  const submit = useMutation({
    mutationFn: () =>
      api<{ taskId: string; runId: string }>(`/projects/${projectId}/tasks`, {
        method: "POST",
        json: {
          taskTypeId,
          title,
          params: value,
          agents: Object.keys(agentOverrides).length > 0 ? agentOverrides : undefined,
        },
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
  // the picker only earns its space when the user can actually change something
  const showAgents =
    detail.agents !== null && Object.values(detail.agents).some((slot) => slot.overridable);

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[1fr_300px]">
      <div className="space-y-4">
        <PageHeader title={lt(detail.nameI18n)} description={lt(detail.descriptionI18n)} />

        <Card>
          <CardHeader>
            <CardTitle>{t("form.parameters")}</CardTitle>
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

        {showAgents && detail.agents ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("form.agents")}</CardTitle>
            </CardHeader>
            <CardContent>
              <AgentSlotPicker
                agents={detail.agents}
                fabriOptions={detail.fabriOptions}
                availableExecutorIds={detail.availableExecutorIds}
                value={agentOverrides}
                onChange={setAgentOverrides}
              />
            </CardContent>
          </Card>
        ) : null}
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
          {preflight.data ? (
            <PreflightChecklist projectId={projectId} data={preflight.data} />
          ) : null}
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

function PreflightChecklist({ projectId, data }: { projectId: string; data: Preflight }) {
  const { t } = useTranslation("catalog");
  const navigate = useNavigate();
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        {data.ready ? t("preflight.ready") : t("preflight.notReady")}
      </p>
      <ul className="space-y-1">
        {data.checks.map((check) => (
          <PreflightRow
            key={check.key}
            check={check}
            onFix={
              check.fixPath
                ? () =>
                    navigate({
                      to: "/projects/$projectId/settings",
                      params: { projectId },
                      search: { tab: check.fixPath as string },
                    })
                : undefined
            }
          />
        ))}
      </ul>
    </div>
  );
}

function PreflightRow({ check, onFix }: { check: PreflightCheck; onFix?: () => void }) {
  const { t } = useTranslation("catalog");
  return (
    <li className="flex items-start justify-between gap-2">
      <div className="flex min-w-0 items-start gap-1.5">
        {check.ok ? (
          <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
        ) : (
          <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
        )}
        <div className="min-w-0">
          <span className="font-medium">{t(`preflight.${check.key}`)}</span>
          <p className="truncate text-xs text-muted-foreground" title={check.detail}>
            {check.detail}
          </p>
        </div>
      </div>
      {!check.ok && onFix ? (
        <Button size="sm" variant="link" className="h-auto shrink-0 px-0" onClick={onFix}>
          {t("preflight.configure")}
        </Button>
      ) : null}
    </li>
  );
}
