import type { RunStatus, StepStatus } from "@agrippa/core";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";

const VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  queued: "outline",
  pending: "outline",
  running: "default",
  waiting_approval: "secondary",
  succeeded: "secondary",
  failed: "destructive",
  cancelled: "outline",
  timed_out: "destructive",
  skipped: "outline",
};

const DOT: Record<string, string> = {
  running: "bg-blue-500 animate-pulse",
  waiting_approval: "bg-amber-500",
  succeeded: "bg-emerald-500",
  failed: "bg-red-500",
  timed_out: "bg-red-500",
  cancelled: "bg-neutral-400",
  queued: "bg-neutral-400",
  pending: "bg-neutral-300",
  skipped: "bg-neutral-300",
};

export function RunStatusBadge({ status }: { status: RunStatus | StepStatus }) {
  const { t } = useTranslation("runs");
  return (
    <Badge variant={VARIANTS[status] ?? "outline"} className="gap-1.5">
      <span className={`size-1.5 rounded-full ${DOT[status] ?? "bg-neutral-400"}`} />
      {t(`status.${status}`)}
    </Badge>
  );
}
