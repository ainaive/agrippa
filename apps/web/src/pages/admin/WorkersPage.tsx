import { useQuery } from "@tanstack/react-query";
import { ServerIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/LoadingSkeletons";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/format";

type FleetWorker = {
  containerId: string;
  startedAt: string;
  consumersReadyAt: string | null;
  heartbeatAt: string;
  executors: Array<{ id: string; envAuthProviders?: string[] }>;
  version: string | null;
  status: "live" | "stale";
};

export function WorkersPage() {
  const { t } = useTranslation("admin");

  const fleet = useQuery({
    queryKey: ["fleet-workers"],
    queryFn: () => api<{ workers: FleetWorker[] }>("/fleet/workers"),
    refetchInterval: 10_000,
  });

  return (
    <div className="space-y-6">
      <PageHeader title={t("workers.title")} description={t("workers.hint")} />

      {fleet.isLoading ? (
        <TableSkeleton />
      ) : !fleet.data || fleet.data.workers.length === 0 ? (
        <EmptyState
          icon={ServerIcon}
          title={t("workers.empty")}
          description={t("workers.emptyHint")}
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
                  {t("workers.lastBeat", { time: formatTime(worker.heartbeatAt) })}
                  {worker.consumersReadyAt === null ? ` · ${t("workers.notReady")}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                {worker.executors.map((executor) => (
                  <Badge key={executor.id} variant="outline" className="font-mono text-[10px]">
                    {executor.id}
                    {executor.envAuthProviders?.length
                      ? ` (${executor.envAuthProviders.join(", ")})`
                      : ""}
                  </Badge>
                ))}
                <Badge variant={worker.status === "live" ? "default" : "destructive"}>
                  {t(`workers.status.${worker.status}`)}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
