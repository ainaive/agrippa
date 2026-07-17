import { isTerminalRunStatus, type RunStatus } from "@agrippa/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

export type RunEvent = {
  seq: number;
  type: string;
  payload: Record<string, unknown> & { stepId?: string; phaseId?: string };
};

/**
 * Opens the run's SSE stream (EventSource handles Last-Event-ID reconnects),
 * accumulates events, and invalidates the run queries so the timeline and
 * status stay live. Closes itself once a terminal event arrives.
 */
export function useRunEvents(runId: string, status: RunStatus | undefined) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const queryClient = useQueryClient();
  const sourceRef = useRef<EventSource | null>(null);
  // Read through a ref so a status transition doesn't tear down the stream
  // (recreating the EventSource wiped accumulated events on every transition).
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    setEvents([]);
    const source = new EventSource(`/api/v1/runs/${runId}/events`);
    sourceRef.current = source;
    let refreshQueued = false;

    const refresh = () => {
      if (refreshQueued) return;
      refreshQueued = true;
      setTimeout(() => {
        refreshQueued = false;
        void queryClient.invalidateQueries({ queryKey: ["run", runId] });
      }, 300);
    };

    const onAnyEvent = (raw: MessageEvent) => {
      try {
        const parsed = JSON.parse(raw.data as string) as RunEvent;
        setEvents((prev) => (prev.some((e) => e.seq === parsed.seq) ? prev : [...prev, parsed]));
        if (
          parsed.type.startsWith("run.") ||
          parsed.type.startsWith("step.") ||
          parsed.type.startsWith("phase.") ||
          parsed.type.startsWith("approval.") ||
          parsed.type === "artifact"
        ) {
          refresh();
        }
        if (parsed.type.startsWith("run.") && parsed.type !== "run.started") {
          const terminal = parsed.type.slice(4) as RunStatus;
          if (isTerminalRunStatus(terminal)) source.close();
        }
      } catch {
        // ignore malformed frames
      }
    };

    // named SSE events: subscribe to everything we emit
    const types = [
      "run.started",
      "run.resumed",
      "run.succeeded",
      "run.failed",
      "run.cancelled",
      "run.timed_out",
      "phase.started",
      "phase.completed",
      "step.started",
      "step.completed",
      "step.failed",
      "step.skipped",
      "step.retrying",
      "step.continued",
      "approval.required",
      "approval.decided",
      "workspace.ready",
      "message.delta",
      "message.completed",
      "tool.started",
      "tool.completed",
      "usage",
      "artifact",
      "subagent.started",
      "subagent.completed",
    ];
    for (const type of types) source.addEventListener(type, onAnyEvent);
    source.onmessage = onAnyEvent;
    source.onerror = () => {
      const current = statusRef.current;
      if (current && isTerminalRunStatus(current)) source.close();
    };

    return () => source.close();
  }, [runId, queryClient]);

  return events;
}
