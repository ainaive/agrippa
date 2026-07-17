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

type StatusStyle = { icon: LucideIcon; text: string; badge: string; spin?: boolean };

const FALLBACK: StatusStyle = {
  icon: ClockIcon,
  text: "text-status-neutral",
  badge: "bg-status-neutral/10",
};

const STYLES: Record<string, StatusStyle> = {
  queued: FALLBACK,
  pending: { icon: ClockIcon, text: "text-status-neutral", badge: "bg-status-neutral/10" },
  running: {
    icon: Loader2Icon,
    text: "text-status-info",
    badge: "bg-status-info/10",
    spin: true,
  },
  waiting_approval: {
    icon: CirclePauseIcon,
    text: "text-status-warning",
    badge: "bg-status-warning/15",
  },
  succeeded: { icon: CircleCheckIcon, text: "text-status-success", badge: "bg-status-success/10" },
  failed: { icon: CircleXIcon, text: "text-status-danger", badge: "bg-status-danger/10" },
  timed_out: { icon: HourglassIcon, text: "text-status-danger", badge: "bg-status-danger/10" },
  cancelled: { icon: CircleMinusIcon, text: "text-status-neutral", badge: "bg-status-neutral/10" },
  skipped: { icon: CircleSlashIcon, text: "text-status-neutral", badge: "bg-status-neutral/10" },
};

export function RunStatusBadge({ status }: { status: RunStatus | StepStatus }) {
  const { t } = useTranslation("runs");
  const style = STYLES[status] ?? FALLBACK;
  const Icon = style.icon;
  return (
    <Badge variant="outline" className={cn("gap-1 border-transparent", style.badge, style.text)}>
      <Icon className={cn(style.spin && "animate-spin")} />
      {t(`status.${status}`)}
    </Badge>
  );
}

/** Icon-only variant for dense rows (timeline steps, checkpoint markers). */
export function RunStatusIcon({
  status,
  className,
}: {
  status: RunStatus | StepStatus;
  className?: string;
}) {
  const { t } = useTranslation("runs");
  const style = STYLES[status] ?? FALLBACK;
  const Icon = style.icon;
  return (
    <Icon
      aria-label={t(`status.${status}`)}
      className={cn("size-4 shrink-0", style.text, style.spin && "animate-spin", className)}
    />
  );
}
