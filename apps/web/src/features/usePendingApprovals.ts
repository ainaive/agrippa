import type { LocalizedText, ProjectRole } from "@agrippa/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type PendingApproval = {
  id: string;
  checkpointId: string;
  payload: { title?: LocalizedText; present?: string[] };
  requestedAt: string;
  runId: string;
  runNumber: number;
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  projectRole: ProjectRole;
};

/** Cross-project pending approvals; shared by the inbox, the sidebar badge, and the dashboard. */
export function usePendingApprovals() {
  return useQuery({
    queryKey: ["approvals-pending"],
    queryFn: () => api<PendingApproval[]>("/approvals/pending"),
    refetchInterval: 30_000,
  });
}
