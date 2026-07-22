import { useMutation } from "@tanstack/react-query";
import {
  CircleCheckIcon,
  CircleXIcon,
  FolderGitIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
  RepeatIcon,
  SendIcon,
  SkipForwardIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FaberAvatar } from "@/components/FaberAvatar";
import { RunStatusIcon } from "@/components/RunStatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import type { RunEvent } from "@/features/useRunEvents";
import { ApiError, api } from "@/lib/api";
import { formatTime, lt } from "@/lib/format";
import type { Artifact, Checkpoint, Run } from "@/lib/types";
import { CheckpointPanel } from "./CheckpointPanel";

type TurnItem = {
  kind: "turn";
  seq: number;
  stepId: string;
  iteration: number;
  slot: string | null;
  text: string;
  tools: string[];
  done: boolean;
  failed: boolean;
};

type TimelineItem =
  | { kind: "phase"; seq: number; label: string; round: string | null }
  | TurnItem
  | { kind: "checkpoint"; seq: number; checkpointId: string; iteration: number }
  | { kind: "comment"; seq: number; user: string; body: string }
  | { kind: "system"; seq: number; icon: "workspace" | "branch" | "loop" | "skip"; label: string }
  | { kind: "pr"; seq: number; url: string; branch: string };

function buildTimeline(
  events: RunEvent[],
  run: Run,
  t: (key: string, opts?: Record<string, unknown>) => string,
): TimelineItem[] {
  const phaseById = new Map((run.template?.phases ?? []).map((p) => [p.id, p]));
  const items: TimelineItem[] = [];
  const openTurns = new Map<string, TurnItem>();
  // a resume re-announces the phase it paused in — drop the duplicate header
  let lastPhaseKey = "";

  for (const event of events) {
    const p = event.payload;
    const stepKey = `${String(p.stepId ?? "")}#${Number(p.iteration ?? 1)}`;
    switch (event.type) {
      case "phase.started": {
        const phaseKey = `${String(p.phaseId ?? "")}#${Number(p.iteration ?? 1)}`;
        if (phaseKey === lastPhaseKey) break;
        lastPhaseKey = phaseKey;
        const phase = phaseById.get(String(p.phaseId ?? ""));
        const loop = phase?.loop ?? null;
        items.push({
          kind: "phase",
          seq: event.seq,
          label: phase ? lt(phase.name) : String(p.phaseId ?? ""),
          round: loop
            ? t("rounds.ofMax", { round: Number(p.iteration ?? 1), max: loop.maxIterations })
            : null,
        });
        break;
      }
      case "step.started": {
        const turn: TurnItem = {
          kind: "turn",
          seq: event.seq,
          stepId: String(p.stepId ?? ""),
          iteration: Number(p.iteration ?? 1),
          slot: typeof p.agentSlot === "string" ? p.agentSlot : null,
          text: "",
          tools: [],
          done: false,
          failed: false,
        };
        openTurns.set(stepKey, turn);
        items.push(turn);
        break;
      }
      case "message.delta": {
        const turn = openTurns.get(stepKey);
        if (turn) turn.text += String(p.text ?? "");
        break;
      }
      case "message.completed": {
        const turn = openTurns.get(stepKey);
        if (turn && !turn.text.endsWith("\n")) turn.text += "\n";
        break;
      }
      case "tool.started": {
        const turn = openTurns.get(stepKey);
        if (turn) turn.tools.push(String(p.toolName ?? "tool"));
        break;
      }
      case "step.completed": {
        const turn = openTurns.get(stepKey);
        if (turn) {
          turn.done = true;
          if (!turn.text && p.output) turn.text = String(p.output);
        }
        break;
      }
      case "step.failed": {
        const turn = openTurns.get(stepKey);
        if (turn) {
          turn.done = true;
          turn.failed = true;
        }
        break;
      }
      case "step.skipped":
        items.push({
          kind: "system",
          seq: event.seq,
          icon: "skip",
          label: t("timelineFeed.stepSkipped", { stepId: String(p.stepId ?? "") }),
        });
        break;
      case "checkpoint.required":
        items.push({
          kind: "checkpoint",
          seq: event.seq,
          checkpointId: String(p.checkpointId ?? ""),
          iteration: Number(p.iteration ?? 1),
        });
        break;
      case "checkpoint.decided":
        if (p.auto === true) {
          items.push({
            kind: "system",
            seq: event.seq,
            icon: "loop",
            label:
              p.kind === "review-gate"
                ? t("timelineFeed.reviewClean")
                : t("timelineFeed.noQuestions"),
          });
        }
        break;
      case "comment.added": {
        const user = p.user as { name?: string } | undefined;
        items.push({
          kind: "comment",
          seq: event.seq,
          user: user?.name ?? "?",
          body: String(p.body ?? ""),
        });
        break;
      }
      case "workspace.ready":
        items.push({
          kind: "system",
          seq: event.seq,
          icon: "workspace",
          label: `${t("activity.workspaceReady")}${p.ref ? ` · ${String(p.ref)}` : ""}`,
        });
        break;
      case "branch.created":
        items.push({
          kind: "system",
          seq: event.seq,
          icon: "branch",
          label: t("timelineFeed.branchCreated", { branch: String(p.branch ?? "") }),
        });
        break;
      case "branch.pushed":
        items.push({
          kind: "system",
          seq: event.seq,
          icon: "branch",
          label: t("timelineFeed.branchPushed", { branch: String(p.branch ?? "") }),
        });
        break;
      case "pr.opened":
        items.push({
          kind: "pr",
          seq: event.seq,
          url: String(p.url ?? ""),
          branch: String(p.branch ?? ""),
        });
        break;
      case "loop.exhausted":
        items.push({
          kind: "system",
          seq: event.seq,
          icon: "loop",
          label: t("timelineFeed.loopExhausted"),
        });
        break;
      default:
        break;
    }
  }
  return items;
}

const SYSTEM_ICON = {
  workspace: FolderGitIcon,
  branch: GitBranchIcon,
  loop: RepeatIcon,
  skip: SkipForwardIcon,
};

function TurnBlock({ turn, run }: { turn: TurnItem; run: Run }) {
  const { t } = useTranslation("runs");
  const [expanded, setExpanded] = useState(false);
  const binding = turn.slot ? run.agents[turn.slot] : undefined;
  const collapsed = turn.done && !expanded && turn.text.length > 600;
  const shown = collapsed ? `${turn.text.slice(0, 600)}…` : turn.text;
  return (
    <div className="flex gap-2.5">
      <FaberAvatar avatar={binding?.faberAvatar} size="sm" className="mt-0.5" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {binding ? lt(binding.faberName ?? undefined) || turn.stepId : turn.stepId}
          </span>
          {binding ? <span>{binding.executorLabel}</span> : null}
          <span className="font-mono">{turn.stepId}</span>
          {turn.failed ? <CircleXIcon className="size-3.5 text-status-danger" /> : null}
          {turn.done && !turn.failed ? (
            <CircleCheckIcon className="size-3.5 text-status-success" />
          ) : null}
        </p>
        {turn.tools.length > 0 ? (
          <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
            <WrenchIcon className="size-3 shrink-0" />
            {turn.tools.slice(-8).join(" · ")}
          </p>
        ) : null}
        {shown ? (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2.5 text-xs">
            {shown}
          </pre>
        ) : null}
        {collapsed || (turn.done && turn.text.length > 600 && expanded) ? (
          <button
            type="button"
            className="text-xs text-primary hover:underline"
            onClick={() => setExpanded((v) => !v)}
          >
            {collapsed ? t("timelineFeed.expand") : t("timelineFeed.collapse")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DecidedCheckpointChip({ checkpoint }: { checkpoint: Checkpoint }) {
  const { t } = useTranslation("runs");
  const outcome = checkpoint.response?.outcome ?? checkpoint.status;
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <RunStatusIcon
        status={
          checkpoint.status === "approved"
            ? "succeeded"
            : checkpoint.status === "pending"
              ? "waiting_approval"
              : "failed"
        }
      />
      <span className="min-w-0 flex-1 truncate">
        {checkpoint.payload.title ? lt(checkpoint.payload.title) : checkpoint.checkpointId}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {t(`checkpoint.outcome.${outcome}`, { defaultValue: outcome })}
        {checkpoint.deciderName ? ` · ${checkpoint.deciderName}` : ""}
        {checkpoint.decidedAt ? ` · ${formatTime(checkpoint.decidedAt)}` : ""}
      </span>
    </div>
  );
}

/**
 * The run's conversational spine, derived from the (fully replayed) event
 * stream: phase headers with loop rounds, streaming agent turns, interaction
 * cards at every checkpoint, teammate comments, and the PR card at the end.
 */
export function RunTimeline({
  runId,
  run,
  events,
  artifacts,
  artifactsStatus,
  canRespond,
}: {
  runId: string;
  run: Run;
  events: RunEvent[];
  artifacts: Artifact[];
  artifactsStatus: "pending" | "error" | "success";
  canRespond: boolean;
}) {
  const { t } = useTranslation(["runs", "common"]);
  const [comment, setComment] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);
  const items = useMemo(() => buildTimeline(events, run, t), [events, run, t]);
  // slot names live on run_steps.agentRef; the event stream carries them too —
  // enrich turns from the steps the run detail already has
  const checkpointByKey = useMemo(
    () => new Map(run.checkpoints.map((ckpt) => [`${ckpt.checkpointId}#${ckpt.iteration}`, ckpt])),
    [run.checkpoints],
  );

  const postComment = useMutation({
    mutationFn: () => api(`/runs/${runId}/comments`, { method: "POST", json: { body: comment } }),
    onSuccess: () => setComment(""),
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : String(error));
    },
  });

  const itemCount = items.length;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, []);

  return (
    <div className="space-y-3">
      {itemCount === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">{t("runs:activity.empty")}</p>
      ) : null}
      {items.map((item) => {
        switch (item.kind) {
          case "phase":
            return (
              <p
                key={item.seq}
                className="flex items-baseline gap-2 border-b pt-2 pb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase"
              >
                <span>{item.label}</span>
                {item.round ? <span className="normal-case">{item.round}</span> : null}
              </p>
            );
          case "turn":
            return <TurnBlock key={item.seq} turn={item} run={run} />;
          case "checkpoint": {
            const checkpoint = checkpointByKey.get(`${item.checkpointId}#${item.iteration}`);
            if (!checkpoint) return null;
            if (checkpoint.status === "pending" && canRespond) {
              return (
                <CheckpointPanel
                  key={item.seq}
                  runId={runId}
                  checkpoint={checkpoint}
                  artifacts={artifacts}
                  artifactsStatus={artifactsStatus}
                />
              );
            }
            return <DecidedCheckpointChip key={item.seq} checkpoint={checkpoint} />;
          }
          case "comment":
            return (
              <div key={item.seq} className="flex gap-2.5">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10">
                  <MessageSquareIcon className="size-3.5 text-primary" />
                </span>
                <div className="min-w-0 flex-1 rounded-md border bg-card px-3 py-2">
                  <p className="text-xs font-medium">{item.user}</p>
                  <p className="text-sm whitespace-pre-wrap">{item.body}</p>
                </div>
              </div>
            );
          case "system": {
            const Icon = SYSTEM_ICON[item.icon];
            return (
              <p key={item.seq} className="flex items-center gap-2 text-xs text-muted-foreground">
                <Icon className="size-3.5 shrink-0" />
                {item.label}
              </p>
            );
          }
          case "pr":
            return (
              <Card key={item.seq} className="border-status-success/40 bg-status-success/5">
                <CardContent className="flex items-center gap-3 py-3">
                  <GitPullRequestIcon className="size-5 shrink-0 text-status-success" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{t("runs:pr.opened")}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {item.branch}
                    </p>
                  </div>
                  <Button size="sm" asChild>
                    <a href={item.url} target="_blank" rel="noreferrer">
                      {t("runs:pr.open")}
                    </a>
                  </Button>
                </CardContent>
              </Card>
            );
          default:
            return null;
        }
      })}
      <div ref={endRef} />
      {canRespond ? (
        <div className="flex items-end gap-2 border-t pt-3">
          <Textarea
            rows={1}
            className="min-h-9"
            placeholder={t("runs:comments.placeholder")}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && comment.trim()) {
                postComment.mutate();
              }
            }}
          />
          <Button
            size="sm"
            disabled={!comment.trim() || postComment.isPending}
            onClick={() => postComment.mutate()}
          >
            <SendIcon />
            {t("runs:comments.send")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
