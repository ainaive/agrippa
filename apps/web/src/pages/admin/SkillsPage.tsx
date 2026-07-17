import type { LocalizedText } from "@agrippa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { TableSkeleton } from "@/components/LoadingSkeletons";
import { LocalizedTextFields } from "@/components/LocalizedTextFields";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { lt } from "@/lib/format";
import type { SkillRow } from "@/lib/types";
import { FormDialog, toastApiError } from "./shared";

function NewSkillDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const queryClient = useQueryClient();
  const [slug, setSlug] = useState("");
  const [source, setSource] = useState("git");
  const [nameI18n, setNameI18n] = useState<LocalizedText>({ en: "", "zh-CN": "" });
  const [descriptionI18n, setDescriptionI18n] = useState<LocalizedText>({ en: "", "zh-CN": "" });

  const create = useMutation({
    mutationFn: () =>
      api("/skills", { method: "POST", json: { slug, source, nameI18n, descriptionI18n } }),
    onSuccess: () => {
      toast.success(t("common:feedback.created"));
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
      onOpenChange(false);
    },
    onError: toastApiError,
  });

  return (
    <FormDialog
      title={t("admin:crud.newSkill")}
      open={open}
      onOpenChange={onOpenChange}
      onSubmit={() => create.mutate()}
      pending={create.isPending}
      submitLabel={t("common:actions.create")}
    >
      <div className="space-y-2">
        <Label htmlFor="skill-slug">{t("admin:columns.slug")}</Label>
        <Input id="skill-slug" value={slug} onChange={(e) => setSlug(e.target.value)} required />
      </div>
      <div className="space-y-2">
        <Label>{t("admin:crud.source")}</Label>
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="builtin">builtin</SelectItem>
            <SelectItem value="git">git</SelectItem>
            <SelectItem value="upload">upload</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <LocalizedTextFields
        idPrefix="skill-name"
        label={t("admin:columns.name")}
        value={nameI18n}
        onChange={setNameI18n}
        required
      />
      <LocalizedTextFields
        idPrefix="skill-desc"
        label={t("admin:crud.description")}
        value={descriptionI18n}
        onChange={setDescriptionI18n}
        multiline
        required
      />
    </FormDialog>
  );
}

function NewVersionDialog({
  skill,
  open,
  onOpenChange,
}: {
  skill: SkillRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const queryClient = useQueryClient();
  const [version, setVersion] = useState("");
  const [contentRef, setContentRef] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api(`/skills/${skill.id}/versions`, { method: "POST", json: { version, contentRef } }),
    onSuccess: () => {
      toast.success(t("common:feedback.created"));
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
      onOpenChange(false);
    },
    onError: toastApiError,
  });

  return (
    <FormDialog
      title={`${t("admin:crud.newVersion")} · ${skill.slug}`}
      open={open}
      onOpenChange={onOpenChange}
      onSubmit={() => create.mutate()}
      pending={create.isPending}
      submitLabel={t("common:actions.create")}
    >
      <div className="space-y-2">
        <Label htmlFor="sv-version">{t("admin:crud.version")}</Label>
        <Input
          id="sv-version"
          value={version}
          placeholder="1.0.0"
          onChange={(e) => setVersion(e.target.value)}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="sv-content">{t("admin:crud.contentRef")}</Label>
        <Input
          id="sv-content"
          value={contentRef}
          onChange={(e) => setContentRef(e.target.value)}
          className="font-mono"
          required
        />
      </div>
    </FormDialog>
  );
}

export function SkillsPage() {
  const { t } = useTranslation(["admin", "common"]);
  const skills = useQuery({ queryKey: ["skills"], queryFn: () => api<SkillRow[]>("/skills") });
  const [createOpen, setCreateOpen] = useState(false);
  const [versionFor, setVersionFor] = useState<SkillRow | null>(null);

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("admin:tabs.skills")}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon />
            {t("admin:crud.newSkill")}
          </Button>
        }
      />
      {skills.isLoading ? (
        <TableSkeleton rows={3} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {(skills.data ?? []).map((skill) => (
            <Card key={skill.id}>
              <CardHeader className="flex-row items-start justify-between pb-2">
                <CardTitle className="text-sm">
                  {lt(skill.nameI18n)}
                  <span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">
                    {skill.slug}
                  </span>
                </CardTitle>
                <Button size="sm" variant="outline" onClick={() => setVersionFor(skill)}>
                  <PlusIcon />
                  {t("admin:crud.newVersion")}
                </Button>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-1.5">
                  {skill.versions.length === 0 ? (
                    <span className="text-xs text-muted-foreground">
                      {t("admin:skills.noVersions")}
                    </span>
                  ) : (
                    skill.versions.map((v) => (
                      <Badge key={v.id} variant="outline" className="font-mono">
                        {v.version}
                      </Badge>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <NewSkillDialog open={createOpen} onOpenChange={setCreateOpen} />
      {versionFor ? (
        <NewVersionDialog
          key={versionFor.id}
          skill={versionFor}
          open={versionFor !== null}
          onOpenChange={(open) => {
            if (!open) setVersionFor(null);
          }}
        />
      ) : null}
    </div>
  );
}
