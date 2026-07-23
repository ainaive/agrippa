import {
  BotIcon,
  CircleCheckIcon,
  CirclePauseIcon,
  CircleXIcon,
  FolderGitIcon,
  HourglassIcon,
  type LucideIcon,
  PlayIcon,
  RotateCcwIcon,
  WrenchIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { RunEvent } from "@/features/useRunEvents";
import { cn } from "@/lib/utils";

type FeedItem = {
  seq: number;
  icon: LucideIcon;
  label: string;
  stepId?: string;
  tone?: "success" | "danger" | "warning";
};

function buildFeed(events: RunEvent[], t: (key: string) => string): FeedItem[] {
  const toolErrors = new Set(
    events
      .filter((e) => e.type === "tool.completed" && e.payload.isError === true)
      .map((e) => e.payload.toolUseId as string),
  );

  const items: FeedItem[] = [];
  for (const event of events) {
    const stepId = event.payload.stepId;
    switch (event.type) {
      case "workspace.ready":
        items.push({
          seq: event.seq,
          icon: FolderGitIcon,
          label: `${t("activity.workspaceReady")}${event.payload.ref ? ` · ${event.payload.ref}` : ""}`,
        });
        break;
      case "step.started":
        items.push({ seq: event.seq, icon: PlayIcon, label: t("activity.stepStarted"), stepId });
        break;
      case "step.completed":
        items.push({
          seq: event.seq,
          icon: CircleCheckIcon,
          label: t("activity.stepCompleted"),
          stepId,
          tone: "success",
        });
        break;
      case "step.failed":
        items.push({
          seq: event.seq,
          icon: CircleXIcon,
          label: t("activity.stepFailed"),
          stepId,
          tone: "danger",
        });
        break;
      case "step.retrying":
        items.push({
          seq: event.seq,
          icon: RotateCcwIcon,
          label: t("activity.stepRetrying"),
          stepId,
          tone: "warning",
        });
        break;
      case "tool.started": {
        const isError = toolErrors.has(event.payload.toolUseId as string);
        items.push({
          seq: event.seq,
          icon: WrenchIcon,
          label: String(event.payload.toolName ?? "tool"),
          stepId,
          tone: isError ? "danger" : undefined,
        });
        break;
      }
      case "subagent.started":
        items.push({
          seq: event.seq,
          icon: BotIcon,
          label: `${t("activity.subagent")} · ${String(event.payload.subagentId ?? "")}`,
          stepId,
        });
        break;
      case "approval.required":
        items.push({
          seq: event.seq,
          icon: CirclePauseIcon,
          label: t("activity.approvalRequired"),
          stepId,
          tone: "warning",
        });
        break;
      case "run.deferred":
        items.push({
          seq: event.seq,
          icon: HourglassIcon,
          label: t("activity.runDeferred"),
          tone: "warning",
        });
        break;
      default:
        break;
    }
  }
  return items;
}

const TONE_CLASS = {
  success: "text-status-success",
  danger: "text-status-danger",
  warning: "text-status-warning",
};

export function RunActivityFeed({ events }: { events: RunEvent[] }) {
  const { t } = useTranslation("runs");
  const items = buildFeed(events, t);

  if (items.length === 0) {
    return <p className="py-4 text-sm text-muted-foreground">{t("activity.empty")}</p>;
  }

  return (
    <ol className="max-h-96 space-y-0.5 overflow-auto">
      {items.map((item) => (
        <li key={item.seq} className="flex items-center gap-2 rounded px-1 py-1 text-sm">
          <item.icon
            className={cn(
              "size-4 shrink-0 text-muted-foreground",
              item.tone && TONE_CLASS[item.tone],
            )}
          />
          <span className={cn("min-w-0 truncate", item.tone && TONE_CLASS[item.tone])}>
            {item.label}
          </span>
          {item.stepId ? (
            <span className="ml-auto shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {item.stepId}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
