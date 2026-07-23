import type { CheckpointKind, ProjectRole } from "@agrippa/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { CheckpointPayload } from "@/lib/types";

export type PendingCheckpoint = {
  id: string;
  checkpointId: string;
  kind: CheckpointKind;
  iteration: number;
  payload: CheckpointPayload;
  requestedAt: string;
  runId: string;
  runNumber: number;
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  projectRole: ProjectRole;
};

/** Cross-project pending checkpoints ("waiting on you"); shared by the inbox, the sidebar badge, and the dashboard. */
export function usePendingCheckpoints() {
  return useQuery({
    queryKey: ["checkpoints-pending"],
    queryFn: () => api<PendingCheckpoint[]>("/checkpoints/pending"),
    refetchInterval: 30_000,
  });
}
