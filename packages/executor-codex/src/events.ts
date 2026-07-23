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
 * Stateful JSONL → ExecutorEvent mapper for one step. Tracks the session id,
 * the final agent message (the step output), and the first error message.
 */
export class CodexEventCollector {
  sessionId: string | null = null;
  lastAgentMessage = "";
  errorMessage: string | null = null;

  constructor(private readonly providerModelId: string) {}

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
        return [{ type: "step.started", sessionId: event.thread_id }];
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
          this.errorMessage ??= item.text ?? "codex reported an error";
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
            // split it so pricing charges cache reads separately (as zero
            // unless the model row prices them)
            inputTokens: Math.max(0, (usage.input_tokens ?? 0) - cached),
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: cached,
            cacheWriteTokens: usage.cache_write_input_tokens ?? 0,
          },
        ];
      }
      case "turn.failed": {
        this.errorMessage ??= event.error?.message ?? "codex turn failed";
        return [];
      }
      case "error": {
        this.errorMessage ??= event.message ?? "codex error";
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
