# @agrippa/executor-codex

Executor adapter for the OpenAI Codex CLI (`codex exec` non-interactive mode).
One step = one `codex exec` invocation (ADR-0005); the review slot of the
requirement-delivery workflow is its first user (ADR-0011).

## CLI contract (pinned against codex-cli 0.145.0)

Invocation:

```
codex exec --json --skip-git-repo-check --cd <workspace> \
  --sandbox <workspace-write|read-only> --model <providerModelId> \
  -c approval_policy=never -c sandbox_workspace_write.network_access=false \
  [resume <sessionId>] -        # prompt on stdin
```

JSONL events observed (probe samples):

```json
{"type":"thread.started","thread_id":"…"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"…","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"…","aggregated_output":"…","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"…"}}
{"type":"turn.completed","usage":{"input_tokens":30961,"cached_input_tokens":25088,"cache_write_input_tokens":0,"output_tokens":129,"reasoning_output_tokens":0}}
```

Notes:

- `input_tokens` **includes** `cached_input_tokens`; the mapper splits them so
  pricing never double-charges cache reads.
- `thread_id` is the resume handle (`codex exec resume <id>`), used only for
  retry/crash-resume of the same step per ADR-0005.
- Unknown event/item kinds (reasoning, web_search, todo_list…) are ignored.

## Capabilities & isolation

`capabilities: { subagents: false, mcp: false, skills: false, resume: true,
streaming: true }` — the compiler rejects template steps that assign
subagents/skills/MCP to a slot bound to this executor.

Containment (ADR-0011): Codex's native OS sandbox (macOS Seatbelt / Linux
Landlock) enforces read-only vs workspace-write and blocks command network
access; `approval_policy=never` removes interactive escalation; the subprocess
env goes through `executor-core`'s allow-list scrubber (OPENAI_API_KEY /
CODEX_API_KEY pass, platform secrets and NODE_OPTIONS never do). NOT
enforceable here: the per-tool-call `evaluateToolCall` hook — `codex exec` has
no callback surface.

## Artifacts

- `workspace-write` steps follow the shared `.agrippa/artifacts/<key><ext>`
  file convention (collected for contracted keys only).
- `read-only` steps (the reviewer) cannot write files: a declared `json`
  artifact is synthesized from the final message's last fenced ```json block,
  a `markdown` artifact from the final message itself.

## Auth

Two sources, either works (ADR-0013):

- **Project provider credential** — arrives per step on the request
  (`providerAuth`); the adapter replaces the openai env family with the
  project key, points `CODEX_HOME` at a per-run directory (so an ambient
  `auth.json` can never outrank the project key), and routes an explicit
  base-URL override through a synthesized `model_providers` entry (`-c`
  overrides survive `--ignore-user-config`; the CLI's `responses` wire-API
  default applies, so chat-completions-only gateways can't run here).
- **Worker env fallback** — `OPENAI_API_KEY` (or `CODEX_API_KEY`), or
  `CODEX_HOME` pointing at a directory holding a ChatGPT-login `auth.json`.

Registration requires only a successful CLI probe (`probeCodexCli`) — a
keyless worker is a valid codex host. The executor advertises whether env
auth exists (`envAuthProviders`), and the engine declines — before claiming —
any run whose providers neither a project credential nor this worker's env
can authenticate, so such runs defer to a capable worker instead of failing
mid-run.
