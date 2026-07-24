# 04 — Execution Runtime

> Status: living · Last updated: 2026-07-23

How a submitted task becomes a finished run: queueing, the run state machine, resumability, approvals, cancellation, budgets, and live progress. Queue: **pg-boss** ([ADR-0003](../adr/0003-pg-boss-over-bullmq.md)); live progress: **SSE** ([ADR-0007](../adr/0007-sse-over-websocket.md)).

## Submission (transactional)

`POST /projects/:id/tasks` validates params against the compiled template inputs, verifies each `repoRef` points at a repo connection **owned by the project**, checks resource grants and quota headroom, then in **one Postgres transaction**:

1. insert `tasks` row,
2. insert `runs` row (`status = queued`, pinned `template_version_id`, `params_snapshot`, frozen slot-keyed `model_resolution`, frozen `agent_bindings` (slot → faber + executor, from template defaults + submit-time overrides — see [ADR-0010](../adr/0010-agrippa-v2-slots-checkpoints-loops.md)), a pinned `resource_manifest` of the skills/MCP the run is authorized to use, computed `budget`).

Model resolution (`resolveAgentBindings` → `resolveSlotModels`, ADR-0013) is per slot and **role-scoped**: each slot resolves only the roles its steps (and their subagents) reference. Provider-constrained slots resolve **single-provider** — a step's base URL is process-wide and its subagents share the query, so a mixed slot could not execute. Candidate providers come from the executor's catalog entry; those whose catalog auth policy is `project` without a `provider_credentials` row are excluded (if that is the only blocker the submit fails with `provider_credential_required`), and the winner ranks by: has a project credential, lowest total input cost over the slot's roles, provider id. The `"*"` provider set (fake/demo, custom executors) keeps the legacy mixed cheapest-per-tier resolution with no credential gating.

After the transaction commits, the handler enqueues the pg-boss job `run.execute({runId})`. The `resource_manifest` is the authorization boundary: required grants are enforced at submit and optional resources are included **only when granted**, so the worker resolves skills/MCP strictly from the manifest and never re-reads the mutable global registry — an ungranted optional resource is simply unavailable (see [ADR-0009](../adr/0009-security-correctness-deep-modules.md)). Project provider credentials are the same shape of boundary for model auth: the engine asks the worker's materializer for the project's credential per provider fresh at each step (decrypted in the worker, registered with the redactor before use) and attaches it to the request; absence falls back to worker-env auth.

The enqueue is a post-commit send, so a narrow dual-write window exists (a crash between commit and send would leave a `queued` run with no job). It is mitigated, not eliminated: the worker's reconciliation sweeper re-enqueues `queued` runs older than 30 s. pg-boss stores jobs in Postgres, so once the send lands the job is durable — the primary reason for pg-boss over a Redis-backed queue.

The same sweepers double as the recovery path for **heterogeneous fleets**: a worker that picks up a run bound to an executor it didn't register — or one it registered but cannot authenticate for the run's providers (a keyless worker, no matching project credential; executors advertise `envAuthProviders`, ADR-0013 amendment 2) — declines the job before any status transition (appending a `run.deferred` event) and lets the sweeps re-enqueue it until a capable worker claims it. This pre-claim probe checks only that the project has a credential row with a referenced secret, and it applies only in the pre-claim states the worker can re-enqueue (`queued`/`waiting_approval`) — a crash-recovered `running` run proceeds and, if its auth is truly unusable, fails actionably per-step with `provider_credential_required` (ADR-0013 amendment 4). DNS validation and decryption happen after claim during per-step materialization, so deterministic endpoint errors become `base_url_invalid` while resolver/infrastructure blips follow the normal pg-boss retry path. See [03-executor-abstraction](03-executor-abstraction.md) for the heterogeneous-fleet mechanism and its limits.

## Run State Machine

Pure function in `@agrippa/core` (`transition(state, event) → state | error`); every transition is persisted and audited. The persist step is a **compare-and-swap** on the expected `from` status (`run-lifecycle.transitionRun`), so a late worker finalize can't overwrite a status another path (e.g. a concurrent cancel) already moved on from — the loser of the race simply doesn't write. Finalization commits the status change, `finishedAt`/`usageTotals`, and the terminal event in **one transaction** (publishing to the bus only after commit), so a crash can't leave a terminal run missing its totals or event; the retry-exhaustion path also goes through the CAS.

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
load run + compiled template (v1 rows upgraded to the v2 IR) + agent bindings
provision workspace (git clone if spec'd; else scratch dir)   [skipped on resume if intact]
for each flow node (phase | loop):
  loop → derive start iteration from persisted rows, run inner phases per
         iteration, evaluate `until` after each; exhaustion → fail | continue
  for each step of the phase (rows keyed (stepId, iteration)):
    if step already succeeded/skipped (resume): skip
    if when:false or requires: unmet on optional resource: mark skipped
    kind checkpoint → no row: auto-pass (input: absent/empty; review-gate:
                      valid empty findings only) or insert pending row +
                      waiting_approval step row → emit checkpoint.required →
                      set run waiting_approval → COMPLETE the job → return
                      decided: fold response into the expression context
                      (checkpoints.<id>), settle the step row, continue
    kind system → platform action (workspace.checkout | git.branch | git.push |
                  pr.open via EngineDeps.scm; pr.open appends the waiver section;
                  git.push rebuilds a platform-owned snapshot and FAILS before
                  push on Git error, empty output, or any evidence mismatch)
    kind agent  → resolve the slot binding (executor + faber prompt) + request
                  → replace .claude/.mcp.json; materialize authorized resources
                  → executor.executeStep(req, ctx)
                  → persist every event to run_events (seq++), publish to Redis,
                    update run_steps, record token_usage, feed BudgetMeter
enforce output contract (required artifacts present? latest iteration wins)
finalize: usage_totals, workspace cleanup, terminal event
```

### Resumability (step-granular)

Steps are the idempotency unit. On retry/resume, the engine loads `run_steps`, **skips succeeded steps**, and re-executes the first non-terminal step:

- A step left `running` by a dead worker is marked `crashed`. A crash is an *interrupted* attempt, not a consumed retry: it adds one extra attempt (so even a no-retry step re-executes rather than being silently skipped), and the crashed attempt's `executor_session_id` is carried onto the recovery attempt so a resume-capable executor resumes that session.
- Otherwise → restart the step as `attempt + 1` (templates must keep steps restart-safe; the workspace checkout is deterministic and `system` actions are idempotent).
- Workspaces are **host-local**: when a succeeded checkout has no repository behind it on this host (the resume landed elsewhere, or the files were removed), the engine's `isIntact()` probe fails the run with `workspace_lost` up front instead of letting every subsequent step run against an empty directory — see [03-executor-abstraction](03-executor-abstraction.md) on the host-affinity boundary.
- Repository workspaces also require the trusted platform gitdir created at checkout. Legacy workspaces without it fail `workspace_lost`; they are never reconstructed from agent-writable metadata.

Budget correctness on resume: the `BudgetMeter` initializes from **persisted** `token_usage` totals, and usage rows are keyed by `(run_id, step_id, attempt)` — a partially-executed attempt's cost is counted, never double-counted.

### Patch evidence and snapshot publication

Patch artifacts are generated from a platform-owned Git index, not the agent's `.git`. Each read resets that index to the trusted clone base, stages the current worktree with runtime paths excluded, and emits a binary cached diff. A Git failure is a retryable `tool_error`; an empty required patch fails its producing step.

At `git.push`, the engine first compares the stored patch byte-for-byte with a fresh snapshot, including empty values. The SCM adapter stages again while holding its own operation boundary and returns a typed mismatch if the workspace changed between those checks. Only an exact, nonempty match becomes a single Agrippa-authored `commit-tree` child of the clone base. Its sidecar ref makes retries idempotent: a matching tree/parent reuses the commit; any other ref state fails. The pushed PR therefore represents the approved tree, while any local agent commit graph stays only in the disposable workspace (ADR-0012).

### Checkpoints (approvals, questions, review gates)

Checkpoints **do not hold a worker slot**. When a checkpoint step pauses: a `checkpoints` row is created (kind, iteration, and a payload snapshot — the questions or findings the responder will see), run → `waiting_approval`, current pg-boss job completes, expiry job scheduled. Auto-pass is deliberately asymmetric: an `input` checkpoint auto-passes when its questions artifact is **absent or contains a valid empty list** ("nothing to ask" is the designed signal), while a `review-gate` auto-passes **only** on a present, schema-valid report with zero findings — an absent report fails the run (see the gate-without-evidence rule below). A present-but-malformed artifact of either kind (including `{}` or a typo'd key — the schemas are strict with required arrays) is a contract violation, caught when the producing step stores it. `POST /runs/:id/checkpoints/:checkpointId/respond` (kind-discriminated payload):

- approval `approved` / input answers / review-gate decision → the structured `response` is stored on the row (full finding objects for fix/accept splits), a `checkpoint.decided` event and audit row commit in the same transaction, and the run re-enqueues; the engine folds the response into the `checkpoints.<id>` expression root on resume.
- approval `request_changes` (loop checkpoints only) → stored as an approved row whose outcome keeps the loop going; the comment re-enters the run for the revision step.
- approval `rejected` → run → `failed` with `error.code = "approval_rejected"`.
- expiry → per-template `onTimeout` (`cancel | reject | approve` for approvals; `cancel` otherwise).

**Gate-without-evidence rule.** Artifacts that drive an input/review-gate checkpoint are validated against the shared interaction schemas **at store time** — a malformed questions/review-report artifact fails the *producing step* with `contract_violation` while its attempt is still open, so template `retry`/`onFailure` apply. The checkpoint-time read is a strict backstop (it protects resumed runs whose artifact rows predate the validation): an **absent** review report fails the run — a gate must never pass on missing evidence — while an absent/empty questions list is the designed "nothing to ask" auto-pass; an artifact too large to inline gets a distinct error rather than being read as empty.

**Work branch naming.** `git.branch` defaults to `agrippa/run-${run.number}-${run.shortId}`: run numbers are unique per *task*, so the run id's random tail (`run.shortId`, the last 12 hex chars of the UUIDv7 — 48 random bits — the head is timestamp bits) disambiguates across tasks. Unique branches are also what makes `pr.open`'s duplicate-recovery safe: a provider 422/409 on retry looks up the existing open PR by head/base and returns its URL.

Decisions are a compare-and-swap on `status = 'pending'` (`run-lifecycle.decideCheckpoint`), so a user decision and the expiry worker can't overwrite each other. The decision is durable before the resume enqueue; if that enqueue is lost, the reconciliation sweeper re-enqueues any `waiting_approval` run whose checkpoints are all decided, so a run can't be stranded.

### Loops

`kind: loop` nodes repeat their phases up to a static `maxIterations`, evaluating `until` after each iteration. All step/checkpoint/artifact rows carry an `iteration`; the resume iteration is **derived** from those rows (no extra state table), so crash recovery inside a loop reuses the ordinary skip-succeeded logic. Expression reads resolve to the latest iteration; loop lifecycle events (`loop.iteration.started`, `loop.completed`, `loop.exhausted`) consult the event log so resumes never re-emit them. `budgets.perPhase` caps a phase's **cumulative** spend across iterations; the run budget plus the static bound cap the loop as a whole.

### Cancellation

`POST /runs/:id/cancel` sets `runs.cancel_requested = true` and publishes on Redis channel `run:{id}:control`. The worker's control subscriber fires the run's `AbortController`; the executor aborts; the engine records `cancelled`. If no worker holds the run (queued / waiting_approval), the API transitions it directly and cancels the pending job. The DB flag backstops the pubsub message (worker checks it at step boundaries), so a lost message delays cancellation by at most one step.

### Budgets & quota

Two independent layers, both enforced:

- **Run budget** (template `budgets`): `BudgetMeter` accumulates `usage` events against run-level and per-phase `maxCostUsd`; breach → abort signal → `failed` with `budget_exceeded`. `maxDurationMinutes` → composed `AbortSignal.timeout` → `timed_out`.
- **Project quota** (`project_quotas`): checked at submit (reject with quota error) and re-read from the database at every step boundary; if `hard_stop` and exhausted mid-run → abort as `budget_exceeded` with quota provenance. Submit and engine count the **same monthly window**, and the engine's headroom **excludes the run's own spend** (the meter already carries it, so including it would double-count on resume). Re-reading each step lets concurrent runs see each other's spend rather than each measuring only a stale start-of-run snapshot. Soft quotas surface warnings in the UI instead of aborting.

## Live Progress (SSE)

Ordering rule: the engine writes `run_events` **first** — the per-run monotonic `seq` comes from an atomic counter (`runs.next_event_seq`, allocated by `UPDATE … RETURNING` in `run-lifecycle.appendRunEvent`), so it is collision-free and works inside a caller's transaction (the approval decision, which appends its event in the same tx as the decision) — then publishes the same event to Redis `run:{id}:events`.

`GET /runs/:id/events` (SSE):

1. **subscribe** to the Redis channel first, buffering live events,
2. replay `run_events WHERE run_id = ? AND seq > :lastEventId ORDER BY seq` (from the `Last-Event-ID` header, or 0),
3. flush the buffer, deduplicating by `seq` against the replay,
4. emit each as `id: <seq>\nevent: <type>\ndata: <payload>`.

The bus is only a **wake-up**: every event is delivered by an ordered `replay()` from Postgres (`seq > cursor ORDER BY seq`), so the cursor advances contiguously and can never jump past a gap. Sending bus events directly would advance a high-water cursor past a dropped seq, and that gap would then be skipped forever — even on a `Last-Event-ID` reconnect. The handler subscribes (and **awaits** the subscription being live — for Redis, the SUBSCRIBE ack) **before** the first replay, so nothing published in the subscribe/replay window is lost. Redis is optional: with a bus a wake-up makes delivery near-instant; without one the stream ticks the same replay on a timer. Either way a dropped pub/sub message (or a brief Redis outage) is recovered by the next replay, since Postgres is the source of truth.
