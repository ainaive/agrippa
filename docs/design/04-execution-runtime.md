# 04 — Execution Runtime

> Status: draft for review · Last updated: 2026-07-17

How a submitted task becomes a finished run: queueing, the run state machine, resumability, approvals, cancellation, budgets, and live progress. Queue: **pg-boss** ([ADR-0003](../adr/0003-pg-boss-over-bullmq.md)); live progress: **SSE** ([ADR-0007](../adr/0007-sse-over-websocket.md)).

## Submission (transactional)

`POST /projects/:id/tasks` validates params against the compiled template inputs, verifies each `repoRef` points at a repo connection **owned by the project**, checks resource grants and quota headroom, then in **one Postgres transaction**:

1. insert `tasks` row,
2. insert `runs` row (`status = queued`, pinned `template_version_id`, `params_snapshot`, frozen `model_resolution`, a pinned `resource_manifest` of the skills/MCP the run is authorized to use, computed `budget`),
3. enqueue pg-boss job `run.execute({runId})`.

The `resource_manifest` is the authorization boundary: required grants are enforced at submit and optional resources are included **only when granted**, so the worker resolves skills/MCP strictly from the manifest and never re-reads the mutable global registry — an ungranted optional resource is simply unavailable (see [ADR-0009](../adr/0009-security-correctness-deep-modules.md)).

Because pg-boss stores jobs in Postgres, there is no dual-write window: either the run and its job both exist, or neither does. This is the primary reason for pg-boss over a Redis-backed queue.

## Run State Machine

Pure function in `@agrippa/core` (`transition(state, event) → state | error`); every transition is persisted and audited. The persist step is a **compare-and-swap** on the expected `from` status (`run-lifecycle.transitionRun`), so a late worker finalize can't overwrite a status another path (e.g. a concurrent cancel) already moved on from — the loser of the race simply doesn't write.

```
                    ┌────────────────────────────┐
 queued ──start──► running ──all steps ok──► succeeded
   │                │  ▲                └─contract/step failure──► failed
   │                │  └─approval decided /                └─duration cap──► timed_out
   │                │      resume
   │                ├──approval required──► waiting_approval
   │                │                          │
   └──cancel──────► cancelled ◄──cancel────────┘
                       ▲──cancel── running
```

Legal transitions: `queued → running | cancelled`; `running → succeeded | failed | timed_out | waiting_approval | cancelled`; `waiting_approval → running | cancelled | failed(expired→per-template onTimeout)`. Terminal: `succeeded, failed, cancelled, timed_out`.

Step statuses mirror this at finer grain: `pending | running | waiting_approval | succeeded | failed | skipped | cancelled` (`skipped` = `when:` false or `requires:` unmet on an optional resource).

## Worker Lifecycle

`apps/worker` boots pg-boss consumers:

- `run.execute` — the main handler; concurrency = configurable slots (default 2 per worker; horizontal scale = more worker containers).
- `run.expire-approval` — scheduled when an approval is requested; enforces `timeout`/`onTimeout`.
- `quota.rollup` — periodic aggregation of `token_usage` into project usage summaries.

Graceful shutdown: stop fetching → abort in-flight runs via their `AbortController` → their jobs return failed with `resumable` marker → pg-boss retry (limit 2) picks them up on a healthy worker, where the engine **resumes** rather than restarts.

## Engine Loop (per run)

```
load run + compiled template + model_resolution
provision workspace (git clone if spec'd; else scratch dir)   [skipped on resume if intact]
for each phase:
  if phase.approval and not yet approved:
      create approvals row → emit approval.required → set run waiting_approval
      → COMPLETE the pg-boss job (worker slot freed) → return
  for each step:
    if step already succeeded (resume): skip
    if when:false or requires: unmet on optional resource: mark skipped
    kind system → run platform action
    kind agent  → resolve request (prompt interpolation, priorContext, resources, secrets)
                  → executor.executeStep(req, ctx)
                  → persist every event to run_events (seq++), publish to Redis,
                    update run_steps, record token_usage, feed BudgetMeter
enforce output contract (required artifacts present?) → succeeded | failed
finalize: usage_totals, workspace cleanup, terminal event
```

### Resumability (step-granular)

Steps are the idempotency unit. On retry/resume, the engine loads `run_steps`, **skips succeeded steps**, and re-executes the first non-terminal step:

- A step left `running` by a dead worker is marked `crashed`. A crash is an *interrupted* attempt, not a consumed retry: it adds one extra attempt (so even a no-retry step re-executes rather than being silently skipped), and the crashed attempt's `executor_session_id` is carried onto the recovery attempt so a resume-capable executor resumes that session.
- Otherwise → restart the step as `attempt + 1` (templates must keep steps restart-safe; the workspace checkout is deterministic and `system` actions are idempotent).

Budget correctness on resume: the `BudgetMeter` initializes from **persisted** `token_usage` totals, and usage rows are keyed by `(run_id, step_id, attempt)` — a partially-executed attempt's cost is counted, never double-counted.

### Approvals

Approvals **do not hold a worker slot**. When a checkpoint is hit: `approvals` row created (with the artifact keys to present), run → `waiting_approval`, current pg-boss job completes, expiry job scheduled. `POST /runs/:id/approvals/:approvalId {decision}`:

- `approved` → re-enqueue `run.execute`; engine resumes at the gated phase.
- `rejected` → run → `failed` with `error.code = "approval_rejected"`.
- expiry → per-template `onTimeout` (`cancel | reject | approve`).

Decisions are a compare-and-swap on `status = 'pending'` (`run-lifecycle.decideApproval`), so a user decision and the expiry worker can't overwrite each other. The decision is durable before the resume enqueue; if that enqueue is lost, the reconciliation sweeper re-enqueues any `waiting_approval` run whose approval is already decided, so a run can't be stranded.

### Cancellation

`POST /runs/:id/cancel` sets `runs.cancel_requested = true` and publishes on Redis channel `run:{id}:control`. The worker's control subscriber fires the run's `AbortController`; the executor aborts; the engine records `cancelled`. If no worker holds the run (queued / waiting_approval), the API transitions it directly and cancels the pending job. The DB flag backstops the pubsub message (worker checks it at step boundaries), so a lost message delays cancellation by at most one step.

### Budgets & quota

Two independent layers, both enforced:

- **Run budget** (template `budgets`): `BudgetMeter` accumulates `usage` events against run-level and per-phase `maxCostUsd`; breach → abort signal → `failed` with `budget_exceeded`. `maxDurationMinutes` → composed `AbortSignal.timeout` → `timed_out`.
- **Project quota** (`project_quotas`): checked at submit (reject with quota error) and re-read from the database at every step boundary; if `hard_stop` and exhausted mid-run → abort as `budget_exceeded` with quota provenance. Submit and engine count the **same monthly window**, and the engine's headroom **excludes the run's own spend** (the meter already carries it, so including it would double-count on resume). Re-reading each step lets concurrent runs see each other's spend rather than each measuring only a stale start-of-run snapshot. Soft quotas surface warnings in the UI instead of aborting.

## Live Progress (SSE)

Ordering rule: the engine writes `run_events` **first** — the per-run monotonic `seq` is allocated by the database inside the INSERT (`run-lifecycle.appendRunEvent`), not from an in-memory `max+1` that a concurrent writer could collide with — then publishes the same event to Redis `run:{id}:events`.

`GET /runs/:id/events` (SSE):

1. **subscribe** to the Redis channel first, buffering live events,
2. replay `run_events WHERE run_id = ? AND seq > :lastEventId ORDER BY seq` (from the `Last-Event-ID` header, or 0),
3. flush the buffer, deduplicating by `seq` against the replay,
4. emit each as `id: <seq>\nevent: <type>\ndata: <payload>`.

Subscribing **before** replaying is what makes reconnection gap-free by construction: an event committed and published in the window between replay and subscribe would otherwise be delivered only at the terminal replay. No polling anywhere (a bus-less deployment falls back to periodic DB replay). Redis here is a pure fan-out optimization — if Redis is briefly down, clients reconnect and replay from Postgres.
