# 04 — Execution Runtime

> Status: draft for review · Last updated: 2026-07-17

How a submitted task becomes a finished run: queueing, the run state machine, resumability, approvals, cancellation, budgets, and live progress. Queue: **pg-boss** ([ADR-0003](../adr/0003-pg-boss-over-bullmq.md)); live progress: **SSE** ([ADR-0007](../adr/0007-sse-over-websocket.md)).

## Submission (transactional)

`POST /projects/:id/tasks` validates params against the compiled template inputs, checks resource grants and quota headroom, then in **one Postgres transaction**:

1. insert `tasks` row,
2. insert `runs` row (`status = queued`, pinned `template_version_id`, `params_snapshot`, frozen `model_resolution`, computed `budget`),
3. enqueue pg-boss job `run.execute({runId})`.

Because pg-boss stores jobs in Postgres, there is no dual-write window: either the run and its job both exist, or neither does. This is the primary reason for pg-boss over a Redis-backed queue.

## Run State Machine

Pure function in `@agrippa/core` (`transition(state, event) → state | error`); every transition is persisted and audited.

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

- If the executor supports resume and `executor_session_id` exists → resume that session.
- Otherwise → restart the step as `attempt + 1` (templates must keep steps restart-safe; the workspace checkout is deterministic and `system` actions are idempotent).

Budget correctness on resume: the `BudgetMeter` initializes from **persisted** `token_usage` totals, and usage rows are keyed by `(run_id, step_id, attempt)` — a partially-executed attempt's cost is counted, never double-counted.

### Approvals

Approvals **do not hold a worker slot**. When a checkpoint is hit: `approvals` row created (with the artifact keys to present), run → `waiting_approval`, current pg-boss job completes, expiry job scheduled. `POST /runs/:id/approvals/:approvalId {decision}`:

- `approved` → re-enqueue `run.execute`; engine resumes at the gated phase.
- `rejected` → run → `failed` with `error.code = "approval_rejected"`.
- expiry → per-template `onTimeout` (`cancel | reject | approve`).

### Cancellation

`POST /runs/:id/cancel` sets `runs.cancel_requested = true` and publishes on Redis channel `run:{id}:control`. The worker's control subscriber fires the run's `AbortController`; the executor aborts; the engine records `cancelled`. If no worker holds the run (queued / waiting_approval), the API transitions it directly and cancels the pending job. The DB flag backstops the pubsub message (worker checks it at step boundaries), so a lost message delays cancellation by at most one step.

### Budgets & quota

Two independent layers, both enforced:

- **Run budget** (template `budgets`): `BudgetMeter` accumulates `usage` events against run-level and per-phase `maxCostUsd`; breach → abort signal → `failed` with `budget_exceeded`. `maxDurationMinutes` → composed `AbortSignal.timeout` → `timed_out`.
- **Project quota** (`project_quotas`): checked at submit (reject with quota error) and re-checked at every step boundary; if `hard_stop` and exhausted mid-run → abort as `budget_exceeded` with quota provenance. Soft quotas surface warnings in the UI instead of aborting.

## Live Progress (SSE)

Ordering rule: the engine writes `run_events` **first** (assigning per-run monotonic `seq`), then publishes the same event to Redis `run:{id}:events`.

`GET /runs/:id/events` (SSE):

1. replay `run_events WHERE run_id = ? AND seq > :lastEventId ORDER BY seq` (from the `Last-Event-ID` header, or 0),
2. subscribe to the Redis channel, bridging live events (deduplicating by `seq` across the replay boundary),
3. emit each as `id: <seq>\nevent: <type>\ndata: <payload>`.

Client reconnects are therefore gap-free by construction; no polling anywhere. Redis here is a pure fan-out optimization — if Redis is briefly down, clients reconnect and replay from Postgres.
