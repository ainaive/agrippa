import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "../lib/api";
import { lt } from "../lib/format";
import type { TemplateInputSpec } from "../lib/types";

type RepoConnection = { id: string; url: string; defaultBranch: string };

export type ParamsValue = Record<string, unknown>;

export function defaultParams(inputs: TemplateInputSpec[]): ParamsValue {
  const value: ParamsValue = {};
  for (const input of inputs) {
    if (input.default !== undefined) value[input.key] = input.default;
    else if (input.type === "boolean") value[input.key] = false;
  }
  return value;
}

export function missingRequired(inputs: TemplateInputSpec[], value: ParamsValue): string[] {
  return inputs
    .filter((input) => {
      if (!input.required) return false;
      const v = value[input.key];
      if (v === undefined || v === null || v === "") return true;
      if (input.type === "repoRef") return !(v as { repoConnectionId?: string }).repoConnectionId;
      return false;
    })
    .map((input) => input.key);
}

/**
 * The auto-generated submission form (docs/design/06): rendered directly from
 * the compiled template inputs, so publishing a new template version changes
 * the form with zero frontend work. The API re-validates from the same schema.
 */
export function TaskParamsForm({
  projectId,
  inputs,
  value,
  onChange,
}: {
  projectId: string;
  inputs: TemplateInputSpec[];
  value: ParamsValue;
  onChange: (next: ParamsValue) => void;
}) {
  const { t } = useTranslation("catalog");
  const repos = useQuery({
    queryKey: ["repos", projectId],
    queryFn: () => api<RepoConnection[]>(`/projects/${projectId}/repos`),
    enabled: inputs.some((input) => input.type === "repoRef"),
  });

  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v });

  return (
    <div className="space-y-5">
      {inputs.map((input) => {
        const label = () => (
          <Label htmlFor={input.key}>
            {lt(input.label)}
            {input.required && <span className="text-destructive"> *</span>}
          </Label>
        );
        const help = () =>
          input.help ? <p className="text-xs text-muted-foreground">{lt(input.help)}</p> : null;

        switch (input.type) {
          case "text":
            return (
              <div key={input.key} className="space-y-2">
                {label()}
                <Textarea
                  id={input.key}
                  rows={Number(input.ui?.rows ?? 5)}
                  value={String(value[input.key] ?? "")}
                  onChange={(e) => set(input.key, e.target.value)}
                />
                {help()}
              </div>
            );
          case "number":
            return (
              <div key={input.key} className="space-y-2">
                {label()}
                <Input
                  id={input.key}
                  type="number"
                  value={value[input.key] === undefined ? "" : String(value[input.key])}
                  onChange={(e) =>
                    set(input.key, e.target.value === "" ? undefined : Number(e.target.value))
                  }
                />
                {help()}
              </div>
            );
          case "boolean":
            return (
              <div key={input.key} className="flex items-center justify-between gap-4">
                <div>
                  {label()}
                  {help()}
                </div>
                <Switch
                  id={input.key}
                  checked={Boolean(value[input.key])}
                  onCheckedChange={(checked) => set(input.key, checked)}
                />
              </div>
            );
          case "select":
            return (
              <div key={input.key} className="space-y-2">
                {label()}
                <Select
                  value={String(value[input.key] ?? "")}
                  onValueChange={(v) => set(input.key, v)}
                >
                  <SelectTrigger id={input.key}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(input.options ?? []).map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {lt(option.label)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {help()}
              </div>
            );
          case "repoRef": {
            const selected = (value[input.key] as { repoConnectionId?: string } | undefined)
              ?.repoConnectionId;
            return (
              <div key={input.key} className="space-y-2">
                {label()}
                {repos.data && repos.data.length === 0 ? (
                  <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                    {t("form.noRepos")}
                  </p>
                ) : (
                  <Select
                    value={selected ?? ""}
                    onValueChange={(v) => set(input.key, { repoConnectionId: v })}
                  >
                    <SelectTrigger id={input.key}>
                      <SelectValue placeholder={t("form.selectRepo")} />
                    </SelectTrigger>
                    <SelectContent>
                      {(repos.data ?? []).map((repo) => (
                        <SelectItem key={repo.id} value={repo.id}>
                          {repo.url}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {help()}
              </div>
            );
          }
          case "docRef":
            return (
              <div key={input.key} className="space-y-2">
                {label()}
                <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  {t("form.docsUnsupported")}
                </p>
              </div>
            );
          default:
            return (
              <div key={input.key} className="space-y-2">
                {label()}
                <Input
                  id={input.key}
                  value={String(value[input.key] ?? "")}
                  onChange={(e) => set(input.key, e.target.value)}
                />
                {help()}
              </div>
            );
        }
      })}
    </div>
  );
}
