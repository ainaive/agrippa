/**
 * Stand-in for the Codex CLI in executor tests: replays canned `exec --json`
 * JSONL streams (shapes pinned against codex-cli 0.145.0). The scenario comes
 * from a `.fake-codex-scenario` file in the cwd — the executor scrubs the
 * subprocess env, so an env var can't carry it.
 */

const emit = (event: Record<string, unknown>): void => {
  console.log(JSON.stringify(event));
};

const scenarioFile = Bun.file(".fake-codex-scenario");
const scenario = (await scenarioFile.exists()) ? (await scenarioFile.text()).trim() : "happy";
const stdin = await new Response(Bun.stdin.stream()).text();

const USAGE = {
  input_tokens: 1500,
  cached_input_tokens: 500,
  cache_write_input_tokens: 0,
  output_tokens: 42,
  reasoning_output_tokens: 0,
};

switch (scenario) {
  case "happy": {
    emit({ type: "thread.started", thread_id: "sess-1" });
    emit({ type: "turn.started" });
    emit({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "First note" },
    });
    emit({
      type: "item.started",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "/bin/zsh -lc 'bun test'",
        aggregated_output: "",
        exit_code: null,
        status: "in_progress",
      },
    });
    emit({
      type: "item.completed",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "/bin/zsh -lc 'bun test'",
        aggregated_output: "all green\n",
        exit_code: 0,
        status: "completed",
      },
    });
    emit({
      type: "item.completed",
      item: { id: "item_2", type: "agent_message", text: "All done" },
    });
    emit({ type: "turn.completed", usage: USAGE });
    break;
  }
  case "argv": {
    emit({ type: "thread.started", thread_id: "sess-argv" });
    emit({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: JSON.stringify(process.argv.slice(2)) },
    });
    emit({ type: "turn.completed", usage: USAGE });
    break;
  }
  case "echo-prompt": {
    emit({ type: "thread.started", thread_id: "sess-echo" });
    emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: stdin } });
    emit({ type: "turn.completed", usage: USAGE });
    break;
  }
  case "env": {
    emit({ type: "thread.started", thread_id: "sess-env" });
    emit({
      type: "item.completed",
      item: {
        id: "item_0",
        type: "agent_message",
        text: JSON.stringify({
          secret: process.env.AGRIPPA_SECRET_KEY ?? null,
          nodeOptions: process.env.NODE_OPTIONS ?? null,
          openai: process.env.OPENAI_API_KEY ?? null,
        }),
      },
    });
    emit({ type: "turn.completed", usage: USAGE });
    break;
  }
  case "readonly-report": {
    emit({ type: "thread.started", thread_id: "sess-ro" });
    const report = {
      summary: "one issue",
      findings: [{ id: "f1", severity: "major", title: "Bug", detail: "boom" }],
    };
    emit({
      type: "item.completed",
      item: {
        id: "item_0",
        type: "agent_message",
        text: `Review complete.\n\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``,
      },
    });
    emit({ type: "turn.completed", usage: USAGE });
    break;
  }
  case "write-artifact": {
    emit({ type: "thread.started", thread_id: "sess-wa" });
    await Bun.write(".agrippa/artifacts/report.md", "# Written by codex\n");
    emit({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "Wrote the report" },
    });
    emit({ type: "turn.completed", usage: USAGE });
    break;
  }
  case "fail": {
    emit({ type: "thread.started", thread_id: "sess-fail" });
    emit({ type: "error", message: "quota exceeded for gpt-5-codex" });
    process.exit(1);
    break;
  }
  case "hang": {
    emit({ type: "thread.started", thread_id: "sess-hang" });
    // stay alive until SIGTERM (default handler exits)
    await new Promise(() => {});
    break;
  }
  default:
    console.error(`unknown scenario ${scenario}`);
    process.exit(2);
}
