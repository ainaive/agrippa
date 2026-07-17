import type { LocalizedText } from "@agrippa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { FileCode2Icon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/LoadingSkeletons";
import { LocalizedTextFields } from "@/components/LocalizedTextFields";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { lt } from "@/lib/format";
import { toastApiError } from "@/lib/toast";
import type { Scenario, TemplateRow } from "@/lib/types";
import { FormDialog } from "./shared";

function NewTemplateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [slug, setSlug] = useState("");
  const [scenarioSlug, setScenarioSlug] = useState("");
  const [nameI18n, setNameI18n] = useState<LocalizedText>({ en: "", "zh-CN": "" });

  const scenarios = useQuery({
    queryKey: ["scenarios"],
    queryFn: () => api<Scenario[]>("/scenarios"),
  });

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>("/templates", {
        method: "POST",
        json: { slug, scenarioSlug, nameI18n },
      }),
    onSuccess: (created) => {
      toast.success(t("common:feedback.created"));
      void queryClient.invalidateQueries({ queryKey: ["templates"] });
      onOpenChange(false);
      void navigate({ to: "/admin/templates/$templateId", params: { templateId: created.id } });
    },
    onError: toastApiError,
  });

  return (
    <FormDialog
      title={t("admin:crud.newTemplate")}
      open={open}
      onOpenChange={onOpenChange}
      onSubmit={() => create.mutate()}
      pending={create.isPending}
      submitLabel={t("common:actions.create")}
    >
      <div className="space-y-2">
        <Label htmlFor="tpl-slug">{t("admin:columns.slug")}</Label>
        <Input
          id="tpl-slug"
          value={slug}
          placeholder="scenario.template-name"
          onChange={(e) => setSlug(e.target.value)}
          required
        />
      </div>
      <div className="space-y-2">
        <Label>{t("admin:columns.scenario")}</Label>
        <Select value={scenarioSlug} onValueChange={setScenarioSlug}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(scenarios.data ?? []).map((scenario) => (
              <SelectItem key={scenario.id} value={scenario.slug}>
                {lt(scenario.nameI18n)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <LocalizedTextFields
        idPrefix="tpl-name"
        label={t("admin:columns.name")}
        value={nameI18n}
        onChange={setNameI18n}
        required
      />
    </FormDialog>
  );
}

export function TemplatesListPage() {
  const { t } = useTranslation("admin");
  const [createOpen, setCreateOpen] = useState(false);
  const templates = useQuery({
    queryKey: ["templates"],
    queryFn: () => api<TemplateRow[]>("/templates"),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("tabs.templates")}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon />
            {t("crud.newTemplate")}
          </Button>
        }
      />
      {templates.isLoading ? (
        <TableSkeleton rows={5} />
      ) : (templates.data ?? []).length === 0 ? (
        <EmptyState icon={FileCode2Icon} title={t("common:empty.generic")} />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.name")}</TableHead>
                <TableHead>{t("columns.slug")}</TableHead>
                <TableHead>{t("columns.scenario")}</TableHead>
                <TableHead>{t("columns.status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(templates.data ?? []).map((template) => (
                <TableRow key={template.id}>
                  <TableCell className="max-w-80">
                    <Link
                      to="/admin/templates/$templateId"
                      params={{ templateId: template.id }}
                      className="block truncate font-medium hover:underline"
                    >
                      {lt(template.nameI18n)}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{template.slug}</TableCell>
                  <TableCell className="text-muted-foreground">{template.scenarioSlug}</TableCell>
                  <TableCell>
                    <Badge variant={template.latestPublishedVersionId ? "secondary" : "outline"}>
                      {template.latestPublishedVersionId
                        ? t("template.published")
                        : t("template.draft")}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <NewTemplateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
