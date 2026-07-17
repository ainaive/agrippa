import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { createTwoFilesPatch } from "diff";
import { ArrowRightIcon, GitCompareArrowsIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { PatchView } from "@/components/artifacts/PatchView";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DetailSkeleton } from "@/components/LoadingSkeletons";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { defaultParams, TaskParamsForm } from "../components/TaskParamsForm";
import { ApiError, api } from "../lib/api";
import { lt } from "../lib/format";
import { toastApiError } from "../lib/toast";
import type { TemplateInputSpec } from "../lib/types";
import { cn } from "../lib/utils";

type VersionRow = { id: string; version: number; status: string; publishedAt: string | null };

type TemplateDetail = {
  id: string;
  slug: string;
  nameI18n: Record<string, string>;
  versions: VersionRow[];
};

type VersionDetail = {
  version: number;
  status: string;
  sourceYaml: string;
  compiled: { spec: { inputs: TemplateInputSpec[] } };
};

function useVersionSource(templateId: string, version: number | null) {
  return useQuery({
    queryKey: ["template", templateId, "version", version],
    queryFn: () => api<VersionDetail>(`/templates/${templateId}/versions/${version}`),
    enabled: version !== null,
  });
}

function CompareDialog({
  templateId,
  slug,
  versions,
  open,
  onOpenChange,
}: {
  templateId: string;
  slug: string;
  versions: VersionRow[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("admin");
  const numbers = versions.map((v) => v.version);
  const [from, setFrom] = useState<number | null>(numbers[1] ?? null);
  const [to, setTo] = useState<number | null>(numbers[0] ?? null);
  const fromDetail = useVersionSource(templateId, from);
  const toDetail = useVersionSource(templateId, to);

  const diffText =
    fromDetail.data && toDetail.data
      ? createTwoFilesPatch(
          `${slug}@v${fromDetail.data.version}`,
          `${slug}@v${toDetail.data.version}`,
          fromDetail.data.sourceYaml,
          toDetail.data.sourceYaml,
        )
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("editor.compare")}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Select
            value={from !== null ? String(from) : ""}
            onValueChange={(value) => setFrom(Number(value))}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {numbers.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  v{n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground" />
          <Select
            value={to !== null ? String(to) : ""}
            onValueChange={(value) => setTo(Number(value))}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {numbers.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  v{n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {diffText ? <PatchView text={diffText} className="max-h-[55vh]" /> : null}
      </DialogContent>
    </Dialog>
  );
}

export function TemplateEditorPage() {
  const { t } = useTranslation(["admin", "common"]);
  const { templateId } = useParams({ strict: false }) as { templateId: string };
  const queryClient = useQueryClient();

  const template = useQuery({
    queryKey: ["template", templateId],
    queryFn: () => api<TemplateDetail>(`/templates/${templateId}`),
  });
  const versions = template.data?.versions ?? [];
  const latest = versions[0];

  // which version the editor is based on; null until data arrives → latest
  const [selected, setSelected] = useState<number | null>(null);
  const baseVersion = selected ?? latest?.version ?? null;
  const versionDetail = useVersionSource(templateId, baseVersion);

  const [edited, setEdited] = useState<string | null>(null);
  const sourceValue = edited ?? versionDetail.data?.sourceYaml ?? "";

  const selectVersion = (version: number) => {
    setSelected(version);
    setEdited(null);
    setValidation(null);
  };

  const [validation, setValidation] = useState<{
    valid: boolean;
    issues?: string[];
    inputs?: TemplateInputSpec[];
  } | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState<number | null>(null);
  const [confirmDeprecate, setConfirmDeprecate] = useState<number | null>(null);

  const validate = useMutation({
    mutationFn: () =>
      api<{ valid: boolean; compiled: { spec: { inputs: TemplateInputSpec[] } } }>(
        "/templates/validate",
        { method: "POST", json: { sourceYaml: sourceValue } },
      ),
    onSuccess: (result) => {
      setValidation({ valid: true, inputs: result.compiled.spec.inputs });
    },
    onError: (err) => {
      if (
        err instanceof ApiError &&
        Array.isArray((err.details as { issues?: string[] })?.issues)
      ) {
        setValidation({ valid: false, issues: (err.details as { issues: string[] }).issues });
      } else {
        setValidation({ valid: false, issues: [String(err)] });
      }
    },
  });

  const saveDraft = useMutation({
    mutationFn: () =>
      api<{ version: number }>(`/templates/${templateId}/versions`, {
        method: "POST",
        json: { sourceYaml: sourceValue },
      }),
    onSuccess: (created) => {
      toast.success(t("common:feedback.created"));
      void queryClient.invalidateQueries({ queryKey: ["template", templateId] });
      setSelected(created.version);
      setEdited(null);
    },
    onError: toastApiError,
  });

  const transition = useMutation({
    mutationFn: ({ version, action }: { version: number; action: "publish" | "deprecate" }) =>
      api(`/templates/${templateId}/versions/${version}/${action}`, { method: "POST" }),
    onSuccess: () => {
      toast.success(t("common:feedback.saved"));
      void queryClient.invalidateQueries({ queryKey: ["template", templateId] });
    },
    onError: toastApiError,
  });

  if (!template.data) return <DetailSkeleton />;

  return (
    <div className="space-y-6">
      <PageHeader
        title={lt(template.data.nameI18n)}
        meta={<span className="font-mono text-sm text-muted-foreground">{template.data.slug}</span>}
        actions={
          versions.length > 1 ? (
            <Button size="sm" variant="outline" onClick={() => setCompareOpen(true)}>
              <GitCompareArrowsIcon />
              {t("admin:editor.compare")}
            </Button>
          ) : null
        }
      />

      <div className="grid items-start gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>{t("admin:editor.source")}</CardTitle>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!sourceValue || validate.isPending}
                onClick={() => validate.mutate()}
              >
                {t("admin:editor.validate")}
              </Button>
              <Button
                size="sm"
                disabled={!sourceValue || saveDraft.isPending}
                onClick={() => saveDraft.mutate()}
              >
                {t("admin:editor.saveDraft")}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {baseVersion !== null ? (
              <p className="text-xs text-muted-foreground">
                {t("admin:editor.baseVersion", { version: baseVersion })}
              </p>
            ) : null}
            <Textarea
              className="min-h-96 font-mono text-xs leading-5"
              value={sourceValue}
              onChange={(e) => setEdited(e.target.value)}
              spellCheck={false}
            />
            {validation && !validation.valid && (
              <ul className="list-disc space-y-1 rounded-md border border-destructive/40 bg-destructive/5 py-3 pr-3 pl-7 text-xs text-destructive">
                {(validation.issues ?? []).map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
            {validation?.valid && (
              <p className="text-sm text-status-success">{t("admin:editor.valid")}</p>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("admin:editor.versions")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1">
                {versions.map((version) => (
                  <li
                    key={version.id}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm",
                      version.version === baseVersion && "bg-muted",
                    )}
                  >
                    <button
                      type="button"
                      className="flex items-center gap-1.5 hover:underline"
                      onClick={() => selectVersion(version.version)}
                    >
                      v{version.version}
                      <Badge
                        variant={version.status === "published" ? "secondary" : "outline"}
                        className={cn(
                          version.status === "deprecated" && "text-muted-foreground line-through",
                        )}
                      >
                        {version.status}
                      </Badge>
                    </button>
                    {version.status === "draft" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={transition.isPending}
                        onClick={() => setConfirmPublish(version.version)}
                      >
                        {t("admin:editor.publish")}
                      </Button>
                    ) : version.status === "published" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground"
                        disabled={transition.isPending}
                        onClick={() => setConfirmDeprecate(version.version)}
                      >
                        {t("admin:editor.deprecate")}
                      </Button>
                    ) : null}
                  </li>
                ))}
                {versions.length === 0 && (
                  <p className="text-xs text-muted-foreground">{t("admin:editor.noVersions")}</p>
                )}
              </ul>
            </CardContent>
          </Card>

          {validation?.valid && validation.inputs && (
            <Card>
              <CardHeader>
                <CardTitle>{t("admin:editor.formPreview")}</CardTitle>
              </CardHeader>
              <CardContent>
                <TaskParamsForm
                  projectId=""
                  inputs={validation.inputs}
                  value={defaultParams(validation.inputs)}
                  onChange={() => {}}
                />
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <CompareDialog
        templateId={templateId}
        slug={template.data.slug}
        versions={versions}
        open={compareOpen}
        onOpenChange={setCompareOpen}
      />
      <ConfirmDialog
        open={confirmPublish !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmPublish(null);
        }}
        title={t("admin:editor.publishConfirm", { version: confirmPublish })}
        description={t("admin:editor.publishHint")}
        confirmLabel={t("admin:editor.publish")}
        onConfirm={() => {
          if (confirmPublish !== null) {
            transition.mutate({ version: confirmPublish, action: "publish" });
          }
          setConfirmPublish(null);
        }}
      />
      <ConfirmDialog
        open={confirmDeprecate !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDeprecate(null);
        }}
        title={t("admin:editor.deprecateConfirm", { version: confirmDeprecate })}
        description={t("admin:editor.deprecateHint")}
        confirmLabel={t("admin:editor.deprecate")}
        destructive
        onConfirm={() => {
          if (confirmDeprecate !== null) {
            transition.mutate({ version: confirmDeprecate, action: "deprecate" });
          }
          setConfirmDeprecate(null);
        }}
      />
    </div>
  );
}
