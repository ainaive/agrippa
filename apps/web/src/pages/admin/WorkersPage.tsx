import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CopyIcon, ServerIcon, TrashIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/LoadingSkeletons";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { toastApiError } from "@/lib/toast";

type ExecutorAd = { id: string; envAuthProviders?: string[] };

type FleetWorker = {
  containerId: string;
  startedAt: string;
  consumersReadyAt: string | null;
  heartbeatAt: string;
  executors: ExecutorAd[];
  version: string | null;
  status: "live" | "stale";
};

type RuntimeRow = {
  id: string;
  name: string;
  tokenPrefix: string;
  status: "active" | "revoked";
  hostname: string | null;
  version: string | null;
  executors: ExecutorAd[];
  lastSeenAt: string | null;
  registeredAt: string | null;
};

type RuntimeCreated = RuntimeRow & { token: string };

/** Runtime liveness mirrors the daemon protocol's 60s routing window. */
const RUNTIME_LIVE_WINDOW_MS = 60_000;

function ExecutorBadges({ executors }: { executors: ExecutorAd[] }) {
  return (
    <>
      {executors.map((executor) => (
        <Badge key={executor.id} variant="outline" className="font-mono text-[10px]">
          {executor.id}
          {executor.envAuthProviders?.length ? ` (${executor.envAuthProviders.join(", ")})` : ""}
        </Badge>
      ))}
    </>
  );
}

export function WorkersPage() {
  const { t } = useTranslation(["admin", "common"]);
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [lastToken, setLastToken] = useState<RuntimeCreated | null>(null);

  const fleet = useQuery({
    queryKey: ["fleet-workers"],
    queryFn: () => api<{ workers: FleetWorker[] }>("/fleet/workers"),
    refetchInterval: 10_000,
  });
  const runtimes = useQuery({
    queryKey: ["runtimes"],
    queryFn: () => api<RuntimeRow[]>("/runtimes"),
    refetchInterval: 10_000,
  });

  const create = useMutation({
    mutationFn: () => api<RuntimeCreated>("/runtimes", { method: "POST", json: { name } }),
    onSuccess: (created) => {
      setLastToken(created);
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["runtimes"] });
    },
    onError: toastApiError,
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/runtimes/${id}/revoke`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["runtimes"] });
      toast.success(t("common:feedback.deleted"));
    },
    onError: toastApiError,
  });

  const copyToken = (token: string) => {
    void navigator.clipboard
      .writeText(token)
      .then(() => toast.success(t("admin:workers.runtimes.copied")));
  };

  const runtimeLive = (row: RuntimeRow) =>
    row.lastSeenAt !== null &&
    Date.now() - new Date(row.lastSeenAt).getTime() < RUNTIME_LIVE_WINDOW_MS;

  return (
    <div className="space-y-6">
      <PageHeader title={t("admin:workers.title")} description={t("admin:workers.hint")} />

      {fleet.isLoading ? (
        <TableSkeleton />
      ) : !fleet.data || fleet.data.workers.length === 0 ? (
        <EmptyState
          icon={ServerIcon}
          title={t("admin:workers.empty")}
          description={t("admin:workers.emptyHint")}
        />
      ) : (
        <div className="divide-y rounded-lg border">
          {fleet.data.workers.map((worker) => (
            <div key={worker.containerId} className="flex items-center gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate">
                  <span className="font-mono font-medium">{worker.containerId}</span>
                  {worker.version ? (
                    <span className="ml-2 text-xs text-muted-foreground">{worker.version}</span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {t("admin:workers.lastBeat", { time: formatTime(worker.heartbeatAt) })}
                  {worker.consumersReadyAt === null ? ` · ${t("admin:workers.notReady")}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ExecutorBadges executors={worker.executors} />
                <Badge variant={worker.status === "live" ? "default" : "destructive"}>
                  {t(`admin:workers.status.${worker.status}`)}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      )}

      <PageHeader
        title={t("admin:workers.runtimes.title")}
        description={t("admin:workers.runtimes.hint")}
      />

      <form
        className="flex max-w-md items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("admin:workers.runtimes.namePlaceholder")}
        />
        <Button type="submit" disabled={create.isPending || !name.trim()}>
          {t("admin:workers.runtimes.create")}
        </Button>
      </form>

      {lastToken ? (
        <div className="max-w-xl rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">
            {t("admin:workers.runtimes.tokenOnce", { name: lastToken.name })}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-muted/60 px-2 py-1 font-mono text-xs">
              {lastToken.token}
            </code>
            <Button size="icon-sm" variant="ghost" onClick={() => copyToken(lastToken.token)}>
              <CopyIcon />
            </Button>
          </div>
        </div>
      ) : null}

      {runtimes.isLoading ? (
        <TableSkeleton />
      ) : !runtimes.data || runtimes.data.length === 0 ? (
        <EmptyState
          icon={ServerIcon}
          title={t("admin:workers.runtimes.empty")}
          description={t("admin:workers.runtimes.emptyHint")}
        />
      ) : (
        <div className="divide-y rounded-lg border">
          {runtimes.data.map((row) => (
            <div key={row.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate">
                  <span className="font-medium">{row.name}</span>
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {row.tokenPrefix}…
                  </span>
                  {row.hostname ? (
                    <span className="ml-2 text-xs text-muted-foreground">{row.hostname}</span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {row.lastSeenAt
                    ? t("admin:workers.runtimes.lastSeen", { time: formatTime(row.lastSeenAt) })
                    : t("admin:workers.runtimes.neverConnected")}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ExecutorBadges executors={row.executors} />
                {row.status === "revoked" ? (
                  <Badge variant="outline">{t("admin:workers.runtimes.revoked")}</Badge>
                ) : (
                  <Badge variant={runtimeLive(row) ? "default" : "secondary"}>
                    {runtimeLive(row)
                      ? t("admin:workers.status.live")
                      : t("admin:workers.runtimes.offline")}
                  </Badge>
                )}
                {row.status === "active" ? (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("admin:workers.runtimes.revoke")}
                    onClick={() => revoke.mutate(row.id)}
                  >
                    <TrashIcon />
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
