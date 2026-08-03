import {
  projectRoleAtLeast,
  SCHEDULE_CONCURRENCY_POLICIES,
  SCHEDULE_TOKENS,
  type ScheduleConcurrencyPolicy,
} from "@agrippa/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  AlertCircleIcon,
  CalendarClockIcon,
  CheckCircle2Icon,
  CopyIcon,
  WebhookIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FaberAvatar } from "@/components/FaberAvatar";
import { DetailSkeleton } from "@/components/LoadingSkeletons";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { type AgentOverrides, AgentSlotPicker } from "../components/submit/AgentSlotPicker";
import {
  defaultParams,
  missingRequired,
  type ParamsValue,
  TaskParamsForm,
} from "../components/TaskParamsForm";
import { useMe } from "../features/me";
import { api } from "../lib/api";
import { formatTokensCompact, lt } from "../lib/format";
import { toastApiError } from "../lib/toast";
import type { Preflight, PreflightCheck, TaskTypeDetail, TriggerCreated } from "../lib/types";

/**
 * Turn the form the user just filled in into a recurring schedule.
 *
 * This lives on the submit page rather than in project settings because the
 * parameter form, the preflight check, and the agent-slot picker are all
 * already here — and because the mental model is "this task, repeatedly"
 * rather than "reconstruct a task from scratch somewhere else". Settings
 * stays the management view: list, pause, delete, see why one stopped.
 */
function ScheduleDialog({
  open,
  onOpenChange,
  projectId,
  taskTypeId,
  title,
  params,
  agentOverrides,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  taskTypeId: string;
  title: string;
  params: ParamsValue;
  agentOverrides: AgentOverrides;
}) {
  const { t } = useTranslation(["catalog", "settings", "common"]);
  const navigate = useNavigate();
  const [cron, setCron] = useState("0 9 * * 1");
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [policy, setPolicy] = useState<ScheduleConcurrencyPolicy>("skip");

  const create = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/schedules`, {
        method: "POST",
        json: {
          name: title,
          taskTypeId,
          params,
          agents: agentOverrides,
          cron,
          timezone,
          concurrencyPolicy: policy,
        },
      }),
    onSuccess: () => {
      toast.success(t("catalog:schedule.created"));
      onOpenChange(false);
      void navigate({
        to: "/projects/$projectId/settings",
        params: { projectId },
        search: { tab: "schedules" },
      });
    },
    onError: toastApiError,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("catalog:schedule.title")}</DialogTitle>
          <DialogDescription>{t("catalog:schedule.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="schedule-cron">{t("settings:schedules.cron")}</Label>
            <Input
              id="schedule-cron"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">{t("settings:schedules.cronHint")}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="schedule-tz">{t("settings:schedules.timezone")}</Label>
            <Input
              id="schedule-tz"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>{t("settings:schedules.policy")}</Label>
            <Select value={policy} onValueChange={(v) => setPolicy(v as ScheduleConcurrencyPolicy)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCHEDULE_CONCURRENCY_POLICIES.map((p) => (
                  <SelectItem key={p} value={p}>
                    {t(`settings:schedules.policies.${p}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t(`settings:schedules.policyHints.${policy}`)}
            </p>
          </div>
          {/* the whole reason a schedule differs from a submission: its
              parameters are frozen unless they say otherwise */}
          <div className="rounded-md border bg-muted/40 p-3">
            <p className="text-xs font-medium">{t("catalog:schedule.tokensTitle")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("catalog:schedule.tokensHint")}</p>
            <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {SCHEDULE_TOKENS.map((token) => `{{${token}}}`).join("  ")}
            </p>
          </div>
        </div>
        <DialogFooter className="mt-5">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button disabled={create.isPending || !cron.trim()} onClick={() => create.mutate()}>
            {t("catalog:schedule.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Create a webhook trigger from this form's parameters.
 *
 * Here for the same reason the schedule dialog is: a trigger submits a real
 * task, so it needs the real parameter form. The difference is what it hands
 * back — a URL that exists exactly once, so the dialog stays open on success
 * and shows it rather than navigating away from the only copy.
 */
function TriggerDialog({
  open,
  onOpenChange,
  projectId,
  taskTypeId,
  title,
  params,
  agentOverrides,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  taskTypeId: string;
  title: string;
  params: ParamsValue;
  agentOverrides: AgentOverrides;
}) {
  const { t } = useTranslation(["catalog", "settings", "common"]);
  const [secret, setSecret] = useState("");
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [created, setCreated] = useState<TriggerCreated | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api<TriggerCreated>(`/projects/${projectId}/triggers`, {
        method: "POST",
        json: { name: title, taskTypeId, params, agents: agentOverrides, secret, timezone },
      }),
    onSuccess: setCreated,
    onError: toastApiError,
  });

  const url = created ? `${window.location.origin}/api/triggers/${created.token}` : "";
  const close = () => {
    setCreated(null);
    setSecret("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("catalog:trigger.title")}</DialogTitle>
          <DialogDescription>{t("catalog:trigger.description")}</DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              <p className="font-medium">{t("catalog:trigger.urlOnce")}</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-muted/60 px-2 py-1 font-mono text-xs">
                  {url}
                </code>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("catalog:trigger.copy")}
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(url)
                      .then(() => toast.success(t("catalog:trigger.copied")));
                  }}
                >
                  <CopyIcon />
                </Button>
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium">{t("catalog:trigger.howToSign")}</p>
              <pre className="overflow-x-auto rounded bg-muted/60 p-2 text-[11px] leading-relaxed">
                {`ts=$(date +%s)
body='{"event":"ci.passed"}'
sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -X POST '${url}' \\
  -H "x-agrippa-timestamp: $ts" \\
  -H "x-agrippa-signature: v1=$sig" \\
  -H 'content-type: application/json' -d "$body"`}
              </pre>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="trigger-secret">{t("catalog:trigger.secret")}</Label>
              <Input
                id="trigger-secret"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={t("catalog:trigger.secretPlaceholder")}
              />
              <p className="text-xs text-muted-foreground">{t("catalog:trigger.secretHint")}</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="trigger-tz">{t("settings:schedules.timezone")}</Label>
              <Input
                id="trigger-tz"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("catalog:trigger.timezoneHint")}</p>
            </div>
          </div>
        )}
        <DialogFooter className="mt-5">
          <Button type="button" variant="outline" onClick={close}>
            {created ? t("common:actions.close") : t("common:actions.cancel")}
          </Button>
          {created ? null : (
            <Button
              disabled={create.isPending || secret.length < 16}
              onClick={() => create.mutate()}
            >
              {t("catalog:trigger.create")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
  const [scheduling, setScheduling] = useState(false);
  const [triggering, setTriggering] = useState(false);
  // creating a schedule is a project-admin action (it commits the project to
  // recurring token spend), so the affordance matches what the API allows
  const me = useMe();
  const canSchedule = projectRoleAtLeast(
    me.projects.find((p) => p.projectId === projectId)?.role ?? "viewer",
    "admin",
  );
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
              <span className="text-muted-foreground">{t("form.tokenLimit")}</span>
              <span className="font-medium tabular-nums">
                {formatTokensCompact(detail.limits?.maxTokens)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("form.duration")}</span>
              <span className="font-medium tabular-nums">
                {detail.limits?.maxDurationMinutes ?? "—"} {t("form.minutes")}
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
          {canSchedule ? (
            <Button
              variant="outline"
              className="w-full"
              disabled={!title || missing.length > 0 || !detail.templateVersion}
              onClick={() => setScheduling(true)}
            >
              <CalendarClockIcon />
              {t("form.schedule")}
            </Button>
          ) : null}
          {canSchedule ? (
            <Button
              variant="outline"
              className="w-full"
              disabled={!title || missing.length > 0 || !detail.templateVersion}
              onClick={() => setTriggering(true)}
            >
              <WebhookIcon />
              {t("form.trigger")}
            </Button>
          ) : null}
          {missing.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("form.missingRequired")}: {missing.join(", ")}
            </p>
          ) : null}
          <TriggerDialog
            open={triggering}
            onOpenChange={setTriggering}
            projectId={projectId}
            taskTypeId={taskTypeId}
            title={title}
            params={value}
            agentOverrides={agentOverrides}
          />
          <ScheduleDialog
            open={scheduling}
            onOpenChange={setScheduling}
            projectId={projectId}
            taskTypeId={taskTypeId}
            title={title}
            params={value}
            agentOverrides={agentOverrides}
          />
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
