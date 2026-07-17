import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CpuIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
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
import { api } from "@/lib/api";
import { toastApiError } from "@/lib/toast";
import type { ModelRow } from "@/lib/types";
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
  const [provider, setProvider] = useState("anthropic");
  const [providerModelId, setProviderModelId] = useState("");
  const [displayName, setDisplayName] = useState(model?.displayName ?? "");
  const [tier, setTier] = useState(model?.tier ?? "balanced");
  const [inputCost, setInputCost] = useState(model?.inputCostPerMtok ?? "");
  const [outputCost, setOutputCost] = useState(model?.outputCostPerMtok ?? "");
  const [status, setStatus] = useState(model?.status ?? "active");

  const save = useMutation({
    mutationFn: () =>
      model
        ? api(`/models/${model.id}`, {
            method: "PATCH",
            json: {
              displayName,
              tier,
              inputCostPerMtok: inputCost === "" ? null : Number(inputCost),
              outputCostPerMtok: outputCost === "" ? null : Number(outputCost),
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
              inputCostPerMtok: inputCost === "" ? undefined : Number(inputCost),
              outputCostPerMtok: outputCost === "" ? undefined : Number(outputCost),
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
            <Label htmlFor="model-provider">{t("admin:crud.provider")}</Label>
            <Input
              id="model-provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              required
            />
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
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="model-in">{t("admin:crud.inputCost")}</Label>
          <Input
            id="model-in"
            type="number"
            step="0.01"
            min="0"
            value={inputCost ?? ""}
            onChange={(e) => setInputCost(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="model-out">{t("admin:crud.outputCost")}</Label>
          <Input
            id="model-out"
            type="number"
            step="0.01"
            min="0"
            value={outputCost ?? ""}
            onChange={(e) => setOutputCost(e.target.value)}
          />
        </div>
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
                <TableHead>{t("admin:columns.pricing")}</TableHead>
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
                  <TableCell className="text-xs text-muted-foreground">
                    ${model.inputCostPerMtok}/M in · ${model.outputCostPerMtok}/M out
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={model.status} />
                  </TableCell>
                  <TableCell>
                    <Button size="icon-sm" variant="ghost" onClick={() => openDialog(model)}>
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
    </div>
  );
}
