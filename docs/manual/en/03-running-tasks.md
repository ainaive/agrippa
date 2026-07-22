# Running Tasks

## Submitting

Open **Catalog** in the project sidebar — task types are grouped by scenario and searchable. Pick one and fill in the form. The form is generated from the template's parameter schema — text fields, selects, switches, and repository pickers appear exactly as the template author declared them; required fields are marked `*`. Templates with agent slots (e.g. **Requirement Delivery**) also show an **Agents** card: one row per slot (Implementer, Reviewer …) where you can swap the persona and the engine (Claude Code / OpenAI Codex) on overridable slots — the defaults are the template author's choice. The **summary panel** beside the form shows who will execute the task, the exact template version, and the run's **budget** (max cost and duration) — review it before submitting.

Submission can be rejected up front with a specific reason: a required skill or MCP server isn't granted to the project, no granted model satisfies a required tier, parameters fail validation, or a hard-stop quota is exhausted. Fix the cause under Settings and resubmit — nothing is persisted on a rejected submission.

## Watching a run

Submitting lands you on the **run detail** page, which updates live:

- **Timeline** tab (the default): the run as a conversation — phase headers (loop phases labeled "Round 2/3"), each agent's streaming output tagged with its persona and engine, interaction cards exactly where the run paused for you, teammates' comments, and — for delivery workflows — the branch, push, and final **pull request card** with an open button. A comment box sits at the bottom for members.
- **Phases** rail (left): steps grouped by the template's phases (loop rounds repeated with round chips), each with status, duration, cost, attempts, and its agent slot; checkpoints show their decision state. Steps can be *skipped* (a condition was false or an optional integration is unavailable) — that's normal, not an error.
- **Budget** panel: live meters of cost against the cost limit and elapsed time against the time limit, plus any per-phase caps.
- **Details** panel: the pinned template version, the executor(s), and the frozen model resolution. The page header shows each agent slot's persona + engine and the platform-created work branch.
- **Activity** tab: the raw live event feed — tool calls, subagent spawns, workspace checkout, retries.
- **Artifacts** tab: deliverables appear as they're produced and preview inline — Markdown rendered, patches colorized, JSON pretty-printed, links clickable; anything can also be downloaded.
- **Parameters** tab: the exact input snapshot the run executes with.
- The header shows live **cost** and total duration.

If you close the page, nothing is lost — reopening replays the full event history and re-attaches to the live stream.

## Responding to checkpoints

When a run pauses, an amber **checkpoint card** appears in the timeline (and in the inbox). What it asks depends on its kind — any project *member* or *admin* can respond:

- **Approvals** present the material (e.g. the implementation plan) with **Approve** / **Reject** and an optional comment. Plan confirmations inside a loop add **Request changes**: write what should be different and the agent revises the plan — up to the loop's round limit, where only approve/reject remain.
- **Question forms** render the agent's clarifying questions. Each carries the agent's *recommended answer* — accept it in one click, or answer yourself; **Accept all recommendations** fills everything at once. If the agent has nothing to ask, the run continues without pausing.
- **Review gates** show the reviewer's findings with severities and file references. Tick the ones the implementer should fix (**Fix selected**) — the unticked remainder is *explicitly accepted* and listed in the pull request description as waivers — or **Accept all & continue** to skip the fix round entirely. When the reviewer comes back clean, the gate passes automatically.

Unattended checkpoints expire after the template's timeout — typically cancelling the run.

The sidebar's **Approvals** page is your cross-project **"waiting on you"** inbox: every pending checkpoint across your projects, labeled by kind (Confirm / Answer questions / Review findings) and grouped by project, with a live count badge. Expand **Review** on any row to respond right there — no need to open the run.

## Working as a team

Everyone in the project sees the same live timeline; whoever responds to a checkpoint first wins (a second response gets a friendly conflict). Decided checkpoints show **who** responded and when. Members can comment anywhere in the run's timeline — questions, context, "shipping it" — and comments appear instantly for every watcher. Accepted review findings are never silent: they appear in the PR body with the accepter's name.

## Cancel, retry, and failures

- **Cancel** (members+) stops a run — immediately for queued/paused runs, at the next safe point for executing ones.
- **Retry** appears on finished runs: it creates a fresh run (#2, #3…) with the same parameters, pinned to the same template version.
- **Failures** always carry a reason: `budget_exceeded` (run budget or project quota), `approval_rejected`, `contract_violation` (a required artifact was never produced), `timed_out`, or a step error. Partial progress — steps, outputs, artifacts produced before the failure — remains visible and downloadable.
