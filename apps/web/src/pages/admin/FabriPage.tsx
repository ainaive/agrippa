import type { LocalizedText } from "@agrippa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BotIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { FaberAvatar } from "@/components/FaberAvatar";
import { CardGridSkeleton } from "@/components/LoadingSkeletons";
import { LocalizedTextFields } from "@/components/LocalizedTextFields";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
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
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { lt } from "@/lib/format";
import { toastApiError } from "@/lib/toast";
import type { Faber } from "@/lib/types";
import { FormDialog } from "./shared";

type FaberDetail = Faber & { systemPrompt?: string };

function FaberDialog({
  faber,
  open,
  onOpenChange,
}: {
  faber: FaberDetail | null; // null → create
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const queryClient = useQueryClient();
  const [slug, setSlug] = useState(faber?.slug ?? "");
  const [avatar, setAvatar] = useState(faber?.avatar ?? "");
  const [nameI18n, setNameI18n] = useState<LocalizedText>(
    faber?.nameI18n ?? { en: "", "zh-CN": "" },
  );
  const [personaI18n, setPersonaI18n] = useState<LocalizedText>(
    faber?.personaI18n ?? { en: "", "zh-CN": "" },
  );
  const [systemPrompt, setSystemPrompt] = useState(faber?.systemPrompt ?? "");
  const [status, setStatus] = useState(faber?.status ?? "active");

  const save = useMutation({
    mutationFn: () =>
      faber
        ? api(`/fabri/${faber.id}`, {
            method: "PATCH",
            json: { nameI18n, personaI18n, systemPrompt, avatar: avatar || null, status },
          })
        : api("/fabri", {
            method: "POST",
            json: { slug, nameI18n, personaI18n, systemPrompt, avatar: avatar || undefined },
          }),
    onSuccess: () => {
      toast.success(t(faber ? "common:feedback.saved" : "common:feedback.created"));
      void queryClient.invalidateQueries({ queryKey: ["fabri"] });
      onOpenChange(false);
    },
    onError: toastApiError,
  });

  return (
    <FormDialog
      title={faber ? t("admin:crud.editFaber") : t("admin:crud.newFaber")}
      open={open}
      onOpenChange={onOpenChange}
      onSubmit={() => save.mutate()}
      pending={save.isPending}
      submitLabel={faber ? t("common:actions.save") : t("common:actions.create")}
    >
      {!faber ? (
        <div className="space-y-2">
          <Label htmlFor="faber-slug">{t("admin:columns.slug")}</Label>
          <Input id="faber-slug" value={slug} onChange={(e) => setSlug(e.target.value)} required />
        </div>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="faber-avatar">{t("admin:crud.avatar")}</Label>
        <Input
          id="faber-avatar"
          value={avatar}
          onChange={(e) => setAvatar(e.target.value)}
          className="w-24"
          maxLength={16}
        />
      </div>
      <LocalizedTextFields
        idPrefix="faber-name"
        label={t("admin:columns.name")}
        value={nameI18n}
        onChange={setNameI18n}
        required
      />
      <LocalizedTextFields
        idPrefix="faber-persona"
        label={t("admin:crud.persona")}
        value={personaI18n}
        onChange={setPersonaI18n}
        multiline
        required
      />
      <div className="space-y-2">
        <Label htmlFor="faber-prompt">{t("admin:crud.systemPrompt")}</Label>
        <Textarea
          id="faber-prompt"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          className="min-h-32 font-mono text-xs"
          required
        />
      </div>
      {faber ? (
        <div className="space-y-2">
          <Label>{t("admin:columns.status")}</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">{t("admin:crud.active")}</SelectItem>
              <SelectItem value="disabled">{t("admin:crud.disabled")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </FormDialog>
  );
}

export function FabriPage() {
  const { t } = useTranslation(["admin", "common"]);
  const fabri = useQuery({ queryKey: ["fabri"], queryFn: () => api<FaberDetail[]>("/fabri") });
  const [editing, setEditing] = useState<FaberDetail | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const openDialog = (faber: FaberDetail | null) => {
    setEditing(faber);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("admin:tabs.fabri")}
        actions={
          <Button onClick={() => openDialog(null)}>
            <PlusIcon />
            {t("admin:crud.newFaber")}
          </Button>
        }
      />
      {fabri.isLoading ? (
        <CardGridSkeleton count={3} />
      ) : (fabri.data ?? []).length === 0 ? (
        <EmptyState icon={BotIcon} title={t("common:empty.generic")} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(fabri.data ?? []).map((faber) => (
            <Card key={faber.id}>
              <CardHeader className="flex flex-row items-start justify-between pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <FaberAvatar avatar={faber.avatar} />
                  <span>
                    {lt(faber.nameI18n)}
                    <span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">
                      {faber.slug}
                    </span>
                  </span>
                </CardTitle>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("common:actions.edit")}
                  onClick={() => openDialog(faber)}
                >
                  <PencilIcon />
                </Button>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="line-clamp-3 text-xs text-muted-foreground">
                  {lt(faber.personaI18n)}
                </p>
                {faber.status !== "active" ? <StatusBadge status={faber.status} /> : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {dialogOpen ? (
        <FaberDialog
          key={editing?.id ?? "new"}
          faber={editing}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      ) : null}
    </div>
  );
}
