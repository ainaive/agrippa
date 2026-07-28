import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CpuIcon, PencilIcon, PlusIcon, TrashIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/LoadingSkeletons";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { toastApiError } from "@/lib/toast";
import type { ModelRow, ProviderCatalogRow } from "@/lib/types";
import { FormDialog } from "./shared";

const TIERS = ["strong", "balanced", "fast"];

function ModelDialog({
  model,
  open,
  onOpenChange,
}: {
  model: ModelRow | null; // null → create
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const queryClient = useQueryClient();
  const catalog = useQuery({
    queryKey: ["provider-catalog"],
    queryFn: () => api<ProviderCatalogRow[]>("/provider-catalog"),
  });
  const activeCatalog = (catalog.data ?? []).filter((p) => p.status === "active");
  const [provider, setProvider] = useState(activeCatalog[0]?.providerId ?? "anthropic");
  const [providerModelId, setProviderModelId] = useState("");
  const [displayName, setDisplayName] = useState(model?.displayName ?? "");
  const [tier, setTier] = useState(model?.tier ?? "balanced");
  const [rank, setRank] = useState(model ? String(model.rank) : "");
  const [status, setStatus] = useState(model?.status ?? "active");

  const save = useMutation({
    mutationFn: () =>
      model
        ? api(`/models/${model.id}`, {
            method: "PATCH",
            json: {
              displayName,
              tier,
              rank: rank === "" ? undefined : Number(rank),
              status,
            },
          })
        : api("/models", {
            method: "POST",
            json: {
              provider,
              providerModelId,
              displayName,
              tier,
              rank: rank === "" ? undefined : Number(rank),
            },
          }),
    onSuccess: () => {
      toast.success(t(model ? "common:feedback.saved" : "common:feedback.created"));
      void queryClient.invalidateQueries({ queryKey: ["models"] });
      onOpenChange(false);
    },
    onError: toastApiError,
  });

  return (
    <FormDialog
      title={model ? t("admin:crud.editModel") : t("admin:crud.newModel")}
      open={open}
      onOpenChange={onOpenChange}
      onSubmit={() => save.mutate()}
      pending={save.isPending}
      submitLabel={model ? t("common:actions.save") : t("common:actions.create")}
    >
      {!model ? (
        <>
          <div className="space-y-2">
            <Label>{t("admin:crud.provider")}</Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {activeCatalog.map((p) => (
                  <SelectItem key={p.providerId} value={p.providerId}>
                    {p.label} ({p.providerId})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="model-id">{t("admin:crud.providerModelId")}</Label>
            <Input
              id="model-id"
              value={providerModelId}
              onChange={(e) => setProviderModelId(e.target.value)}
              className="font-mono"
              required
            />
          </div>
        </>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="model-name">{t("admin:columns.name")}</Label>
        <Input
          id="model-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
        />
      </div>
      <div className="space-y-2">
        <Label>{t("admin:columns.tier")}</Label>
        <Select value={tier} onValueChange={setTier}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIERS.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="model-rank">{t("admin:crud.rank")}</Label>
        <Input
          id="model-rank"
          type="number"
          step="1"
          min="0"
          max="2147483647"
          className="w-40"
          value={rank}
          onChange={(e) => setRank(e.target.value)}
        />
      </div>
      {model ? (
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

export function ModelsPage() {
  const { t } = useTranslation(["admin", "common"]);
  const models = useQuery({ queryKey: ["models"], queryFn: () => api<ModelRow[]>("/models") });
  const [editing, setEditing] = useState<ModelRow | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const openDialog = (model: ModelRow | null) => {
    setEditing(model);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("admin:tabs.models")}
        actions={
          <Button onClick={() => openDialog(null)}>
            <PlusIcon />
            {t("admin:crud.newModel")}
          </Button>
        }
      />
      {models.isLoading ? (
        <TableSkeleton rows={4} />
      ) : (models.data ?? []).length === 0 ? (
        <EmptyState icon={CpuIcon} title={t("common:empty.generic")} />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("admin:columns.name")}</TableHead>
                <TableHead>{t("admin:columns.tier")}</TableHead>
                <TableHead>{t("admin:columns.rank")}</TableHead>
                <TableHead>{t("admin:columns.status")}</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(models.data ?? []).map((model) => (
                <TableRow key={model.id}>
                  <TableCell className="max-w-96">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate font-medium">{model.displayName}</span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {model.providerModelId}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{model.tier}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular-nums">
                    {model.rank}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={model.status} />
                  </TableCell>
                  <TableCell>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("common:actions.edit")}
                      onClick={() => openDialog(model)}
                    >
                      <PencilIcon />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {dialogOpen ? (
        <ModelDialog
          key={editing?.id ?? "new"}
          model={editing}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      ) : null}
      <ProvidersSection />
    </div>
  );
}

function ProviderDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const queryClient = useQueryClient();
  const [providerId, setProviderId] = useState("");
  const [label, setLabel] = useState("");
  const [anthropicUrl, setAnthropicUrl] = useState("");
  const [openaiUrl, setOpenaiUrl] = useState("");
  const [auth, setAuth] = useState<"project" | "env">("project");
  const [hosts, setHosts] = useState("");

  const baseUrls = {
    ...(anthropicUrl ? { anthropic: anthropicUrl } : {}),
    ...(openaiUrl ? { openai: openaiUrl } : {}),
  };
  const baseUrlHosts = hosts.trim()
    ? hosts
        .split("\n")
        .map((h) => h.trim())
        .filter(Boolean)
    : null;

  const save = useMutation({
    mutationFn: () =>
      api("/provider-catalog", {
        method: "POST",
        json: { providerId, label, baseUrls, auth, baseUrlHosts },
      }),
    onSuccess: () => {
      toast.success(t("common:feedback.created"));
      void queryClient.invalidateQueries({ queryKey: ["provider-catalog"] });
      onOpenChange(false);
    },
    onError: toastApiError,
  });

  return (
    <FormDialog
      title={t("admin:crud.newProvider")}
      open={open}
      onOpenChange={onOpenChange}
      onSubmit={() => save.mutate()}
      pending={save.isPending}
      submitLabel={t("common:actions.create")}
    >
      <div className="space-y-2">
        <Label htmlFor="provider-id">{t("admin:crud.providerId")}</Label>
        <Input
          id="provider-id"
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
          placeholder="deepseek"
          className="font-mono"
          required
        />
        <p className="text-xs text-muted-foreground">{t("admin:crud.providerIdHint")}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="provider-label">{t("admin:crud.label")}</Label>
        <Input
          id="provider-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="provider-anthropic">{t("admin:crud.baseUrlAnthropic")}</Label>
        <Input
          id="provider-anthropic"
          type="url"
          placeholder="https://api.deepseek.com/anthropic"
          value={anthropicUrl}
          onChange={(e) => setAnthropicUrl(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="provider-openai">{t("admin:crud.baseUrlOpenai")}</Label>
        <Input
          id="provider-openai"
          type="url"
          placeholder="https://api.deepseek.com/v1"
          value={openaiUrl}
          onChange={(e) => setOpenaiUrl(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label>{t("admin:crud.authPolicy")}</Label>
        <Select value={auth} onValueChange={(v) => setAuth(v as "project" | "env")}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="project">{t("admin:crud.authProject")}</SelectItem>
            <SelectItem value="env">{t("admin:crud.authEnv")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="provider-hosts">{t("admin:crud.baseUrlHosts")}</Label>
        <Textarea
          id="provider-hosts"
          rows={3}
          value={hosts}
          onChange={(e) => setHosts(e.target.value)}
          placeholder="api.deepseek.com"
        />
        <p className="text-xs text-muted-foreground">{t("admin:crud.baseUrlHostsHint")}</p>
      </div>
    </FormDialog>
  );
}

function ProvidersSection() {
  const { t } = useTranslation(["admin", "common"]);
  const queryClient = useQueryClient();
  const catalog = useQuery({
    queryKey: ["provider-catalog"],
    queryFn: () => api<ProviderCatalogRow[]>("/provider-catalog"),
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [removing, setRemoving] = useState<ProviderCatalogRow | null>(null);

  const remove = useMutation({
    mutationFn: (providerId: string) =>
      api(`/provider-catalog/${providerId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(t("common:feedback.removed"));
      void queryClient.invalidateQueries({ queryKey: ["provider-catalog"] });
    },
    onError: toastApiError,
  });

  const rows = catalog.data ?? [];
  const customs = rows.filter((r) => r.orgId !== null);

  const endpointSummary = (r: ProviderCatalogRow): string => {
    const eps: string[] = [];
    if (r.baseUrls.anthropic) eps.push("anthropic");
    if (r.baseUrls.openai) eps.push("openai");
    return eps.length > 0 ? eps.join(", ") : t("admin:providers.none");
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">{t("admin:providers.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("admin:providers.hint")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
          <PlusIcon />
          {t("admin:crud.newProvider")}
        </Button>
      </div>
      {catalog.isLoading ? (
        <TableSkeleton rows={3} />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("admin:crud.label")}</TableHead>
                <TableHead>{t("admin:crud.providerId")}</TableHead>
                <TableHead>{t("admin:providers.endpoints")}</TableHead>
                <TableHead>{t("admin:crud.authPolicy")}</TableHead>
                <TableHead>{t("admin:columns.status")}</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">
                    {row.label}{" "}
                    <Badge variant="outline" className="ml-1 text-xs">
                      {row.orgId === null ? t("admin:crud.builtin") : t("admin:crud.custom")}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{row.providerId}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {endpointSummary(row)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.auth === "project" ? t("admin:crud.authProject") : t("admin:crud.authEnv")}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={row.status} />
                  </TableCell>
                  <TableCell>
                    {row.orgId !== null ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("common:actions.remove")}
                        onClick={() => setRemoving(row)}
                      >
                        <TrashIcon />
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {customs.length === 0 && !catalog.isLoading ? (
        <p className="text-xs text-muted-foreground">{t("admin:providers.empty")}</p>
      ) : null}
      {dialogOpen ? <ProviderDialog open={dialogOpen} onOpenChange={setDialogOpen} /> : null}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`${t("admin:crud.providerId")}: ${removing?.providerId ?? ""}`}
        confirmLabel={t("common:actions.remove")}
        destructive
        onConfirm={() => {
          if (removing) remove.mutate(removing.providerId);
          setRemoving(null);
        }}
      />
    </div>
  );
}
