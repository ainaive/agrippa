import type { LocalizedText } from "@agrippa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PencilIcon, PlugIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { ListSkeleton } from "@/components/LoadingSkeletons";
import { LocalizedTextFields } from "@/components/LocalizedTextFields";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { lt } from "@/lib/format";
import { toastApiError } from "@/lib/toast";
import type { McpServerRow } from "@/lib/types";
import { FormDialog } from "./shared";

type McpDetail = McpServerRow & { config?: Record<string, unknown> };

function McpDialog({
  server,
  open,
  onOpenChange,
}: {
  server: McpDetail | null; // null → create
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const queryClient = useQueryClient();
  const [slug, setSlug] = useState("");
  const [transport, setTransport] = useState(server?.transport ?? "stdio");
  const [nameI18n, setNameI18n] = useState<LocalizedText>(
    server?.nameI18n ?? { en: "", "zh-CN": "" },
  );
  const [configText, setConfigText] = useState(
    server?.config ? JSON.stringify(server.config, null, 2) : "{}",
  );
  const [authToken, setAuthToken] = useState("");
  const [clearAuth, setClearAuth] = useState(false);
  const [status, setStatus] = useState(server?.status ?? "active");
  const [configError, setConfigError] = useState(false);

  const save = useMutation({
    mutationFn: () => {
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(configText) as Record<string, unknown>;
        setConfigError(false);
      } catch {
        setConfigError(true);
        throw new Error(t("admin:crud.invalidJson"));
      }
      return server
        ? api(`/mcp-servers/${server.id}`, {
            method: "PATCH",
            json: {
              nameI18n,
              config,
              status,
              // write-only secret: empty input keeps the stored token
              authToken: clearAuth ? null : authToken || undefined,
            },
          })
        : api("/mcp-servers", {
            method: "POST",
            json: { slug, transport, nameI18n, config, authToken: authToken || undefined },
          });
    },
    onSuccess: () => {
      toast.success(t(server ? "common:feedback.saved" : "common:feedback.created"));
      void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      onOpenChange(false);
    },
    onError: toastApiError,
  });

  return (
    <FormDialog
      title={server ? t("admin:crud.editMcp") : t("admin:crud.newMcp")}
      open={open}
      onOpenChange={onOpenChange}
      onSubmit={() => save.mutate()}
      pending={save.isPending}
      submitLabel={server ? t("common:actions.save") : t("common:actions.create")}
    >
      {!server ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="mcp-slug">{t("admin:columns.slug")}</Label>
            <Input id="mcp-slug" value={slug} onChange={(e) => setSlug(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label>{t("admin:crud.transport")}</Label>
            <Select value={transport} onValueChange={setTransport}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">stdio</SelectItem>
                <SelectItem value="http">http</SelectItem>
                <SelectItem value="sse">sse</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </>
      ) : null}
      <LocalizedTextFields
        idPrefix="mcp-name"
        label={t("admin:columns.name")}
        value={nameI18n}
        onChange={setNameI18n}
        required
      />
      <div className="space-y-2">
        <Label htmlFor="mcp-config">{t("admin:crud.config")}</Label>
        <Textarea
          id="mcp-config"
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          className="min-h-28 font-mono text-xs"
          aria-invalid={configError}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="mcp-token">{t("admin:crud.authToken")}</Label>
        <Input
          id="mcp-token"
          type="password"
          value={authToken}
          onChange={(e) => setAuthToken(e.target.value)}
          placeholder={server?.hasAuth ? "••••••••" : ""}
          disabled={clearAuth}
          autoComplete="new-password"
        />
        <p className="text-xs text-muted-foreground">{t("admin:crud.authTokenHint")}</p>
        {server?.hasAuth ? (
          <div className="flex items-center gap-2">
            <Switch id="mcp-clear-auth" checked={clearAuth} onCheckedChange={setClearAuth} />
            <Label htmlFor="mcp-clear-auth" className="font-normal">
              {t("admin:crud.clearAuth")}
            </Label>
          </div>
        ) : null}
      </div>
      {server ? (
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

export function McpServersPage() {
  const { t } = useTranslation(["admin", "common"]);
  const servers = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => api<McpDetail[]>("/mcp-servers"),
  });
  const [editing, setEditing] = useState<McpDetail | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const openDialog = (server: McpDetail | null) => {
    setEditing(server);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("admin:tabs.mcp")}
        actions={
          <Button onClick={() => openDialog(null)}>
            <PlusIcon />
            {t("admin:crud.newMcp")}
          </Button>
        }
      />
      {servers.isLoading ? (
        <ListSkeleton rows={3} />
      ) : (servers.data ?? []).length === 0 ? (
        <EmptyState icon={PlugIcon} title={t("admin:mcp.empty")} />
      ) : (
        <div className="divide-y overflow-hidden rounded-lg border">
          {(servers.data ?? []).map((server) => (
            <div
              key={server.id}
              className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/50"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium">{lt(server.nameI18n)}</p>
                <p className="text-xs text-muted-foreground">
                  {server.slug} · {server.transport}
                </p>
              </div>
              {server.status !== "active" ? <StatusBadge status={server.status} /> : null}
              <Badge variant={server.hasAuth ? "secondary" : "outline"}>
                {server.hasAuth ? t("admin:mcp.authed") : t("admin:mcp.noAuth")}
              </Badge>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("common:actions.edit")}
                onClick={() => openDialog(server)}
              >
                <PencilIcon />
              </Button>
            </div>
          ))}
        </div>
      )}
      {dialogOpen ? (
        <McpDialog
          key={editing?.id ?? "new"}
          server={editing}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      ) : null}
    </div>
  );
}
