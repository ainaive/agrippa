import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MailIcon, TrashIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { ListSkeleton } from "@/components/LoadingSkeletons";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type InvitationCreated, type InvitationRow, invitationsApi } from "@/lib/api";
import { toastApiError } from "@/lib/toast";

export function InvitationsPage() {
  const { t } = useTranslation(["admin", "common"]);
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [lastCreated, setLastCreated] = useState<InvitationCreated | null>(null);

  const list = useQuery({
    queryKey: ["invitations"],
    queryFn: () => invitationsApi.list(),
  });

  const create = useMutation({
    mutationFn: () => invitationsApi.create(email),
    onSuccess: (created) => {
      setLastCreated(created);
      setEmail("");
      void queryClient.invalidateQueries({ queryKey: ["invitations"] });
      toast.success(t("admin:invitations.copied"));
    },
    onError: toastApiError,
  });

  const revoke = useMutation({
    mutationFn: (id: string) => invitationsApi.revoke(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["invitations"] });
      toast.success(t("common:feedback.deleted"));
    },
    onError: toastApiError,
  });

  const copyLink = (url: string) => {
    void navigator.clipboard
      .writeText(url)
      .then(() => toast.success(t("admin:invitations.copied")));
  };

  const statusOf = (row: InvitationRow) => {
    if (row.acceptedAt) return "accepted";
    if (new Date(row.expiresAt).getTime() < Date.now()) return "expired";
    return "pending";
  };

  return (
    <div className="space-y-6">
      <PageHeader title={t("admin:invitations.title")} description={t("admin:invitations.hint")} />
      <form
        className="flex flex-wrap items-end gap-3 rounded-lg border p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (email) create.mutate();
        }}
      >
        <div className="min-w-[16rem] flex-1 space-y-2">
          <Label htmlFor="inviteEmail">{t("admin:invitations.inviteEmail")}</Label>
          <Input
            id="inviteEmail"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <Button type="submit" disabled={create.isPending}>
          {t("admin:invitations.invite")}
        </Button>
      </form>

      {lastCreated ? (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-4">
          <p className="text-sm font-medium">{t("admin:invitations.inviteUrl")}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-background px-2 py-1 text-xs">
              {lastCreated.inviteUrl}
            </code>
            <Button size="sm" variant="outline" onClick={() => copyLink(lastCreated.inviteUrl)}>
              {t("common:actions.copy")}
            </Button>
          </div>
        </div>
      ) : null}

      {list.isLoading ? (
        <ListSkeleton rows={3} />
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState icon={MailIcon} title={t("admin:invitations.empty")} />
      ) : (
        <div className="divide-y overflow-hidden rounded-lg border">
          {(list.data ?? []).map((row) => {
            const status = statusOf(row);
            return (
              <div
                key={row.id}
                className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/50"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{row.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(row.createdAt).toLocaleString()} · {t(`admin:invitations.${status}`)}
                  </p>
                </div>
                <Badge variant={status === "pending" ? "secondary" : "outline"}>
                  {t(`admin:invitations.${status}`)}
                </Badge>
                {status === "pending" ? (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("admin:invitations.revoke")}
                    onClick={() => {
                      if (confirm(t("admin:invitations.revokeConfirm"))) revoke.mutate(row.id);
                    }}
                  >
                    <TrashIcon />
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
