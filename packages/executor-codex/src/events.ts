import type { ExecutorEvent } from "@agrippa/executor-core";

/**
 * The Codex CLI's `exec --json` JSONL event stream, pinned against
 * codex-cli 0.145.0 (probed 2026-07; see the package README for samples).
 * Unknown event/item types are ignored on purpose — the CLI adds kinds
 * (reasoning, web_search, todo_list) faster than we care to render them.
 */

export type CodexUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
};

export type CodexItem = {
  id?: string;
  type?: string;
  text?: string;
  message?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
};

export type CodexThreadEvent = {
  type?: string;
  thread_id?: string;
  usage?: CodexUsage;
  item?: CodexItem;
  message?: string;
  error?: { message?: string };
};

/**
 * The CLI forwards backend failures as a JSON blob in the message field
 * (`{"type":"error","status":400,"error":{"message":"…"}}`) — pull the human
 * sentence out so the step error reads as prose, not wire format.
 */
function humanMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string }; message?: string };
    return parsed.error?.message ?? parsed.message ?? raw;
  } catch {
    return raw;
  }
}

/**
 * Stateful JSONL → ExecutorEvent mapper for one step. Tracks the session id,
 * the final agent message (the step output), and two error channels: fatal
 * stream errors (`turn.failed`, top-level `error`) that must fail the step,
 * and item-level error items, which the CLI also uses for non-fatal warnings
 * ("Model metadata … not found. Defaulting to fallback") before carrying on —
 * those only color the message of a failure the exit code already signals.
 */
export class CodexEventCollector {
  sessionId: string | null = null;
  lastAgentMessage = "";
  /** First fatal error (`turn.failed` / `error`) — usually the same failure twice. */
  fatalMessage: string | null = null;
  /** Last item-level error text — the item nearest the death is the most specific. */
  itemErrorMessage: string | null = null;

  constructor(
    private readonly providerModelId: string,
    /** The thread this invocation asked to continue, if any — see thread.started. */
    private readonly resumeSessionId?: string | undefined,
  ) {}

  mapLine(line: string): ExecutorEvent[] {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return []; // CLI banners / cwd notices
    let event: CodexThreadEvent;
    try {
      event = JSON.parse(trimmed) as CodexThreadEvent;
    } catch {
      return [];
    }
    return this.map(event);
  }

  map(event: CodexThreadEvent): ExecutorEvent[] {
    switch (event.type) {
      case "thread.started": {
        this.sessionId = event.thread_id ?? null;
        // `codex resume <thread>` announces the thread it actually opened, so
        // resume is verifiable by comparison (ADR-0018 Decision 5): a
        // different id means the CLI started a new thread and the
        // conversation is gone, whatever the exit code says afterwards.
        return [
          {
            type: "step.started",
            sessionId: event.thread_id,
            ...(this.resumeSessionId
              ? { resumed: event.thread_id === this.resumeSessionId ? "honored" : "rejected" }
              : {}),
          },
        ];
      }
      case "item.started": {
        const item = event.item;
        if (item?.type === "command_execution") {
          return [
            {
              type: "tool.started",
              toolName: "shell",
              input: { command: item.command },
              toolUseId: item.id ?? "",
            },
          ];
        }
        return [];
      }
      case "item.completed": {
        const item = event.item;
        if (!item) return [];
        if (item.type === "agent_message" && item.text) {
          this.lastAgentMessage = item.text;
          return [{ type: "message.completed", role: "assistant", text: item.text }];
        }
        if (item.type === "command_execution") {
          return [
            {
              type: "tool.completed",
              toolUseId: item.id ?? "",
              output: item.aggregated_output ?? "",
              isError: (item.exit_code ?? 0) !== 0,
            },
          ];
        }
        if (item.type === "error") {
          // codex-cli 0.145 puts the text in `message` (older shapes used `text`)
          const text = item.message ?? item.text;
          if (text !== undefined) this.itemErrorMessage = text;
        }
        return [];
      }
      case "turn.completed": {
        const usage = event.usage ?? {};
        const cached = usage.cached_input_tokens ?? 0;
        return [
          {
            type: "usage",
            model: this.providerModelId,
            // codex reports input_tokens INCLUSIVE of the cached portion;
            // subtract it and report it as cacheReadTokens instead. The usage
            // meter counts input + output only, so cached input is tracked but
            // never charged against a run's token limit.
            inputTokens: Math.max(0, (usage.input_tokens ?? 0) - cached),
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: cached,
            cacheWriteTokens: usage.cache_write_input_tokens ?? 0,
          },
        ];
      }
      case "turn.failed": {
        this.fatalMessage ??= humanMessage(event.error?.message ?? "codex turn failed");
        return [];
      }
      case "error": {
        this.fatalMessage ??= humanMessage(event.message ?? "codex error");
        return [];
      }
      default:
        return [];
    }
  }
}

/** The last fenced ```json block of a message, parsed — or undefined. */
export function lastFencedJson(text: string): unknown {
  const matches = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  const raw = matches.at(-1)?.[1];
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
