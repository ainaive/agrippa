import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { defaultParams, TaskParamsForm } from "../components/TaskParamsForm";
import { ApiError, api } from "../lib/api";
import { lt } from "../lib/format";
import type { TemplateInputSpec } from "../lib/types";

type TemplateDetail = {
  id: string;
  slug: string;
  nameI18n: Record<string, string>;
  versions: Array<{ id: string; version: number; status: string; publishedAt: string | null }>;
};

type VersionDetail = {
  version: number;
  status: string;
  sourceYaml: string;
  compiled: { spec: { inputs: TemplateInputSpec[] } };
};

export function TemplateEditorPage() {
  const { t } = useTranslation("admin");
  const { templateId } = useParams({ strict: false }) as { templateId: string };
  const queryClient = useQueryClient();

  const template = useQuery({
    queryKey: ["template", templateId],
    queryFn: () => api<TemplateDetail>(`/templates/${templateId}`),
  });
  const latestVersion = template.data?.versions[0];
  const versionDetail = useQuery({
    queryKey: ["template", templateId, latestVersion?.version],
    queryFn: () =>
      api<VersionDetail>(`/templates/${templateId}/versions/${latestVersion?.version}`),
    enabled: latestVersion !== undefined,
  });

  const [source, setSource] = useState<string | null>(null);
  const sourceValue = source ?? versionDetail.data?.sourceYaml ?? "";
  useEffect(() => {
    setSource(null);
  }, []);

  const [validation, setValidation] = useState<{
    valid: boolean;
    issues?: string[];
    inputs?: TemplateInputSpec[];
  } | null>(null);

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
      } else if (err instanceof ApiError && err.status === 400) {
        // validate endpoint returns {valid:false, issues} with 400
        setValidation({ valid: false, issues: [(err.message || "invalid").toString()] });
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["template", templateId] }),
  });

  const publish = useMutation({
    mutationFn: (version: number) =>
      api(`/templates/${templateId}/versions/${version}/publish`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["template", templateId] }),
  });

  if (!template.data) return <p className="text-muted-foreground">…</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold">{lt(template.data.nameI18n)}</h2>
        <span className="font-mono text-sm text-muted-foreground">{template.data.slug}</span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">{t("editor.source")}</CardTitle>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!sourceValue || validate.isPending}
                onClick={() => validate.mutate()}
              >
                {t("editor.validate")}
              </Button>
              <Button
                size="sm"
                disabled={!sourceValue || saveDraft.isPending}
                onClick={() => saveDraft.mutate()}
              >
                {t("editor.saveDraft")}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              className="min-h-96 font-mono text-xs"
              value={sourceValue}
              onChange={(e) => setSource(e.target.value)}
              spellCheck={false}
            />
            {validation && !validation.valid && (
              <ul className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                {(validation.issues ?? []).map((issue) => (
                  <li key={issue}>• {issue}</li>
                ))}
              </ul>
            )}
            {validation?.valid && <p className="text-sm text-emerald-600">{t("editor.valid")}</p>}
            {saveDraft.isError && (
              <p className="text-sm text-destructive">{(saveDraft.error as Error).message}</p>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("editor.versions")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {template.data.versions.map((version) => (
                  <li key={version.id} className="flex items-center justify-between text-sm">
                    <span>
                      v{version.version}{" "}
                      <Badge
                        variant={version.status === "published" ? "secondary" : "outline"}
                        className="ml-1"
                      >
                        {version.status}
                      </Badge>
                    </span>
                    {version.status === "draft" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={publish.isPending}
                        onClick={() => publish.mutate(version.version)}
                      >
                        {t("editor.publish")}
                      </Button>
                    )}
                  </li>
                ))}
                {template.data.versions.length === 0 && (
                  <p className="text-xs text-muted-foreground">{t("editor.noVersions")}</p>
                )}
              </ul>
            </CardContent>
          </Card>

          {validation?.valid && validation.inputs && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("editor.formPreview")}</CardTitle>
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
    </div>
  );
}
