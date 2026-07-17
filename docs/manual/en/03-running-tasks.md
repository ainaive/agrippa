# Running Tasks

## Submitting

Open **Catalog** in the project sidebar — task types are grouped by scenario and searchable. Pick one and fill in the form. The form is generated from the template's parameter schema — text fields, selects, switches, and repository pickers appear exactly as the template author declared them; required fields are marked `*`. The **summary panel** beside the form shows who will execute the task (the Faber), the exact template version, and the run's **budget** (max cost and duration) — review it before submitting.

Submission can be rejected up front with a specific reason: a required skill or MCP server isn't granted to the project, no granted model satisfies a required tier, parameters fail validation, or a hard-stop quota is exhausted. Fix the cause under Settings and resubmit — nothing is persisted on a rejected submission.

## Watching a run

Submitting lands you on the **run detail** page, which updates live:

- **Timeline** (left): steps grouped by the template's **phases**, each with status, duration, cost, attempt count, and the model role that executed it; approval checkpoints appear inline in their phase. Steps can be *skipped* (a condition was false or an optional integration is unavailable) — that's normal, not an error.
- **Budget** panel: live meters of cost against the cost limit and elapsed time against the time limit, plus any per-phase caps.
- **Details** panel: the pinned template version, the executor, and the frozen model resolution (which concrete model serves each role).
- **Output** tab: the agent's streaming text while a step executes; after completion, each step's final output.
- **Artifacts** tab: deliverables appear as they're produced; download any of them (reports as Markdown, code changes as patches, links as URLs).
- **Parameters** tab: the exact input snapshot the run executes with.
- The header shows live **cost** and total duration.

If you close the page, nothing is lost — reopening replays the full event history and re-attaches to the live stream.

## Approvals

When a run reaches a checkpoint it pauses with an amber **approval banner** naming the checkpoint and presenting the relevant artifacts (e.g. the proposed fix plan). Any project *member* or *admin* can **Approve** (the run resumes where it paused) or **Reject** (the run fails with `approval_rejected`), optionally with a comment. Unattended checkpoints expire after the template's timeout — typically cancelling the run.

The top-bar **Approvals** page is your cross-project inbox: every run waiting on you, in one list.

## Cancel, retry, and failures

- **Cancel** (members+) stops a run — immediately for queued/paused runs, at the next safe point for executing ones.
- **Retry** appears on finished runs: it creates a fresh run (#2, #3…) with the same parameters, pinned to the same template version.
- **Failures** always carry a reason: `budget_exceeded` (run budget or project quota), `approval_rejected`, `contract_violation` (a required artifact was never produced), `timed_out`, or a step error. Partial progress — steps, outputs, artifacts produced before the failure — remains visible and downloadable.
