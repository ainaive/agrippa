import type { RunStatus, StepStatus } from "@agrippa/core";
import {
  CircleCheckIcon,
  CircleMinusIcon,
  CirclePauseIcon,
  CircleSlashIcon,
  CircleXIcon,
  ClockIcon,
  HourglassIcon,
  Loader2Icon,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type StatusStyle = { icon: LucideIcon; className: string; spin?: boolean };

const FALLBACK: StatusStyle = {
  icon: ClockIcon,
  className: "bg-status-neutral/10 text-status-neutral",
};

const STYLES: Record<string, StatusStyle> = {
  queued: FALLBACK,
  pending: { icon: ClockIcon, className: "bg-status-neutral/10 text-status-neutral" },
  running: { icon: Loader2Icon, className: "bg-status-info/10 text-status-info", spin: true },
  waiting_approval: {
    icon: CirclePauseIcon,
    className: "bg-status-warning/15 text-status-warning",
  },
  succeeded: { icon: CircleCheckIcon, className: "bg-status-success/10 text-status-success" },
  failed: { icon: CircleXIcon, className: "bg-status-danger/10 text-status-danger" },
  timed_out: { icon: HourglassIcon, className: "bg-status-danger/10 text-status-danger" },
  cancelled: { icon: CircleMinusIcon, className: "bg-status-neutral/10 text-status-neutral" },
  skipped: { icon: CircleSlashIcon, className: "bg-status-neutral/10 text-status-neutral" },
};

export function RunStatusBadge({ status }: { status: RunStatus | StepStatus }) {
  const { t } = useTranslation("runs");
  const style = STYLES[status] ?? FALLBACK;
  const Icon = style.icon;
  return (
    <Badge variant="outline" className={cn("gap-1 border-transparent", style.className)}>
      <Icon className={cn(style.spin && "animate-spin")} />
      {t(`status.${status}`)}
    </Badge>
  );
}
