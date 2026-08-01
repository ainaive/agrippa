# 04 — Execution Runtime

> Status: living · Last updated: 2026-07-23

How a submitted task becomes a finished run: queueing, the run state machine, resumability, approvals, cancellation, usage limits, and live progress. Queue: **pg-boss** ([ADR-0003](../adr/0003-pg-boss-over-bullmq.md)); live progress: **SSE** ([ADR-0007](../adr/0007-sse-over-websocket.md)).

## Submission (transactional)

`POST /projects/:id/tasks` validates params against the compiled template inputs, verifies each `repoRef` points at a repo connection **owned by the project**, checks resource grants and quota headroom, then in **one Postgres transaction**:

1. insert `tasks` row,
2. insert `runs` row (`status = queued`, pinned `template_version_id`, `params_snapshot`, frozen slot-keyed `model_resolution`, frozen `agent_bindings` (slot → faber + executor, from template defaults + submit-time overrides — see [ADR-0010](../adr/0010-agrippa-v2-slots-checkpoints-loops.md)), a pinned `resource_manifest` of the skills/MCP the run is authorized to use).

Model resolution (`resolveAgentBindings` → `resolveSlotModels`, ADR-0013) is per slot and **role-scoped**: each slot resolves only the roles its steps (and their subagents) reference. Provider-constrained slots resolve **single-provider** — a step's base URL is process-wide and its subagents share the query, so a mixed slot could not execute. Candidate providers come from the executor's catalog entry; those whose catalog auth policy is `project` without a `provider_credentials` row are excluded (if that is the only blocker the submit fails with `provider_credential_required`), and the winner ranks by: has a project credential, lowest total selection rank over the slot's roles, provider id. The `"*"` provider set (fake/demo, custom executors) keeps the legacy mixed most-preferred-per-tier resolution with no credential gating. Note the asymmetry: the `auth` policy governs only whether submission **requires** a credential — a stored credential for an env-policy provider (`anthropic`/`openai`) is still fully live: it wins the resolution ranking, satisfies the keyless-worker preflight, and overrides worker-env auth at every step.

After the transaction commits, the handler enqueues the pg-boss job `run.execute({runId})`. The `resource_manifest` is the authorization boundary: required grants are enforced at submit and optional resources are included **only when granted**, so the worker resolves skills/MCP strictly from the manifest and never re-reads the mutable global registry — an ungranted optional resource is simply unavailable (see [ADR-0009](../adr/0009-security-correctness-deep-modules.md)). Project provider credentials are the same shape of boundary for model auth: the engine asks the worker's materializer for the project's credential per provider fresh at each step (decrypted in the worker, registered with the redactor before use) and attaches it to the request. Absence falls back to worker-env auth only where that fallback is legitimate — on a real (cataloged) executor a missing credential fails the step with `provider_credential_required` whenever the provider's auth policy is `project` **or** this worker advertises no env auth for it; demo and uncataloged executors are never gated (ADR-0013 amendments 2 §4 and 4 §2).

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
- `approval.expire` — scheduled when an approval is requested; enforces `timeout`/`onTimeout`, and appends a `checkpoint.expired` run event so the timeline (and notifications) show the expiry.
- `notification.deliver` — one job per `notification_deliveries` row; retries with backoff (limit 5), the consumer flips the row to `failed` only at exhaustion.

(There is no `quota.rollup` job — project usage is computed on read from `token_usage`.)

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
                    update run_steps, record token_usage, feed UsageMeter
enforce output contract (required artifacts present? latest iteration wins)
finalize: usage_totals, workspace cleanup, terminal event
```

### Run-level retry (re-submission)

Task retry (`POST /tasks/:id/retry`) creates run #N+1 as a **re-submission of the pinned task** (ADR-0014): the template version and params snapshot are copied, while everything derived from project configuration — agent bindings, per-slot model resolution, the resource manifest, quota headroom, repo-ref ownership — re-resolves through the same helper submit uses, applying the task's persisted submit-time agent overrides. Unchanged configuration reproduces the previous bindings deterministically; changed configuration is picked up, so a config fix heals a failed task instead of burning another run's worth of tokens on a doomed one. Configuration that still cannot satisfy a slot fails at the endpoint with submit's error codes, never mid-run. This is distinct from the *step-level* retry below, which resumes inside one run.

### Resumability (step-granular)

Steps are the idempotency unit. On retry/resume, the engine loads `run_steps`, **skips succeeded steps**, and re-executes the first non-terminal step:

- A step left `running` by a dead worker is marked `crashed`. A crash is an *interrupted* attempt, not a consumed retry: it adds one extra attempt (so even a no-retry step re-executes rather than being silently skipped), and the crashed attempt's `executor_session_id` is carried onto the recovery attempt so a resume-capable executor resumes that session.
- Otherwise → restart the step as `attempt + 1` (templates must keep steps restart-safe; the workspace checkout is deterministic and `system` actions are idempotent).
- Workspaces are **host-local**: when a succeeded checkout has no repository behind it on this host (the resume landed elsewhere, or the files were removed), the engine's `isIntact()` probe fails the run with `workspace_lost` up front instead of letting every subsequent step run against an empty directory — see [03-executor-abstraction](03-executor-abstraction.md) on the host-affinity boundary.
- Repository workspaces also require the trusted platform gitdir created at checkout. Legacy workspaces without it fail `workspace_lost`; they are never reconstructed from agent-writable metadata.

Usage-accounting correctness on resume: the `UsageMeter` initializes from **persisted** `token_usage` totals, and usage rows are keyed by `(run_id, step_id, attempt)` — a partially-executed attempt's tokens are counted, never double-counted.

### Patch evidence and snapshot publication

Patch artifacts are generated from a platform-owned Git index, not the agent's `.git`. Each read resets that index to the trusted clone base, stages the current worktree with runtime paths excluded, and emits a binary cached diff. A Git failure is a retryable `tool_error`; an empty required patch fails its producing step.

At `git.push`, the engine first compares the stored patch byte-for-byte with a fresh snapshot, including empty values. A patch over the store's 64 KB inline threshold compares against its store-time sha256 (persisted on the artifact row) instead: the digest lives in Postgres, which agent subprocesses hold no credentials for, while the spilled file shares an agent-writable volume — bytes read back from disk could be rewritten after review, so they are never trusted as evidence. (This is tamper-resistance within the deployment posture, not a boundary: an agent that recovers worker credentials — possible under compose, see the sandboxing residual in [08](08-deployment.md) — can forge database state wholesale.) A spilled patch without a digest fails with a distinct `contract_violation` rather than publishing unverified. The SCM adapter stages again while holding its own operation boundary and returns a typed mismatch if the workspace changed between those checks. Only an exact, nonempty match becomes a single Agrippa-authored `commit-tree` child of the clone base. Its sidecar ref makes retries idempotent: a matching tree/parent reuses the commit; any other ref state fails. The pushed PR therefore represents the approved tree, while any local agent commit graph stays only in the disposable workspace (ADR-0012).

### Checkpoints (approvals, questions, review gates)

Checkpoints **do not hold a worker slot**. When a checkpoint step pauses: a `checkpoints` row is created (kind, iteration, and a payload snapshot — the questions or findings the responder will see), run → `waiting_approval`, current pg-boss job completes, expiry job scheduled. Auto-pass is deliberately asymmetric: an `input` checkpoint auto-passes when its questions artifact is **absent or contains a valid empty list** ("nothing to ask" is the designed signal), while a `review-gate` auto-passes **only** on a present, schema-valid report with zero findings — an absent report fails the run (see the gate-without-evidence rule below). A present-but-malformed artifact of either kind (including `{}` or a typo'd key — the schemas are strict with required arrays) is a contract violation, caught when the producing step stores it. `POST /runs/:id/checkpoints/:checkpointId/respond` (kind-discriminated payload):

- approval `approved` / input answers / review-gate decision → the structured `response` is stored on the row (full finding objects for fix/accept splits), a `checkpoint.decided` event and audit row commit in the same transaction, and the run re-enqueues; the engine folds the response into the `checkpoints.<id>` expression root on resume.
- approval `request_changes` (loop checkpoints only) → stored as an approved row whose outcome keeps the loop going; the comment re-enters the run for the revision step.
- approval `rejected` → run → `failed` with `error.code = "approval_rejected"`.
- expiry → per-template `onTimeout` (`cancel | reject | approve` for approvals; `cancel` otherwise).

**Gate-without-evidence rule.** Artifacts that drive an input/review-gate checkpoint are validated against the shared interaction schemas **at store time** — a malformed questions/review-report artifact fails the *producing step* with `contract_violation` while its attempt is still open, so template `retry`/`onFailure` apply. The checkpoint-time read is a strict backstop (it protects resumed runs whose artifact rows predate the validation): an **absent** review report fails the run — a gate must never pass on missing evidence — while an absent/empty questions list is the designed "nothing to ask" auto-pass. Interaction artifacts get a raised inline allowance (`INTERACTION_ARTIFACT_MAX_BYTES`, 2 MiB — sized so every schema-valid report/questions payload inlines whole), so only schema-invalid or padded content can be too large to inline — and that gets a distinct too-large error rather than being read as empty.

**Work branch naming.** `git.branch` defaults to `agrippa/run-${run.number}-${run.shortId}`: run numbers are unique per *task*, so the run id's random tail (`run.shortId`, the last 12 hex chars of the UUIDv7 — 48 random bits — the head is timestamp bits) disambiguates across tasks. Unique branches are also what makes `pr.open`'s duplicate-recovery safe: a provider duplicate status on retry (GitHub 422, GitLab 409, GitCode any 4xx — its status is undocumented) looks up the existing open PR by head/base and returns its URL.

Decisions are a compare-and-swap on `status = 'pending'` (`run-lifecycle.decideCheckpoint`), so a user decision and the expiry worker can't overwrite each other. The decision is durable before the resume enqueue; if that enqueue is lost, the reconciliation sweeper re-enqueues any `waiting_approval` run whose checkpoints are all decided, so a run can't be stranded.

### Loops

`kind: loop` nodes repeat their phases up to a static `maxIterations`, evaluating `until` after each iteration. All step/checkpoint/artifact rows carry an `iteration`; the resume iteration is **derived** from those rows (no extra state table), so crash recovery inside a loop reuses the ordinary skip-succeeded logic. Expression reads resolve to the latest iteration; loop lifecycle events (`loop.iteration.started`, `loop.completed`, `loop.exhausted`) consult the event log so resumes never re-emit them. `limits.perPhase` caps a phase's **cumulative** token consumption across iterations; the run token limit plus the static bound cap the loop as a whole.

### Cancellation

`POST /runs/:id/cancel` sets `runs.cancel_requested = true` and publishes on Redis channel `run:{id}:control`. The worker's control subscriber fires the run's `AbortController`; the executor aborts; the engine records `cancelled`. If no worker holds the run (queued / waiting_approval), the API finalizes it to `cancelled` directly via the same CAS `finalizeRun` path and publishes the terminal event — the pending singleton job, when the worker eventually picks it up, is a no-op (`executeRun` returns `already_terminal`). The DB flag backstops the pubsub message (worker checks it at step boundaries), so a lost message delays cancellation by at most one step.

### Usage limits & quota

Two independent layers, both enforced, both denominated in **tokens** — the platform has no notion of money ([ADR-0015](../adr/0015-tokens-as-the-unit-of-account.md)):

- **Run limits** (template `limits`): `UsageMeter` accumulates `usage` events against run-level and per-phase `maxTokens`; breach → abort signal → `failed` with `usage_limit_exceeded`. `maxDurationMinutes` → composed `AbortSignal.timeout` → `timed_out`.
- **Project quota** (`project_quotas.token_limit`): checked at submit (reject with quota error) and re-read from the database at every step boundary; if `hard_stop` and exhausted mid-run → abort as `usage_limit_exceeded` with quota provenance. Submit and engine count the **same monthly window** and the **same measure** (input + output tokens, cache excluded), and the engine's headroom **excludes the run's own consumption** (the meter already carries it, so including it would double-count on resume). Re-reading each step lets concurrent runs see each other's consumption rather than each measuring only a stale start-of-run snapshot. Soft quotas surface warnings in the UI instead of aborting.

### Notifications (outbound)

Deliveries **derive from `run_events`** — the engine is untouched. `syncRunNotifications` turns a run's notifiable events (`checkpoint.required`, `checkpoint.expired`, `run.succeeded|failed|cancelled|timed_out`) into `notification_deliveries` rows, one per enabled filter-matching `notification_endpoints` row of the project, deduplicated by a partial unique index on `(endpoint_id, event_id)` — exactly-once by construction because every notifiable transition writes its event transactionally. It runs post-commit at the three trigger sites (worker after `executeRun`, worker retry-exhaustion, the API's direct cancel finalize) and enqueues a `notification.deliver` job per new row; the worker's reconciliation sweeper backstops it (`sweepNotificationDeliveries`: 24 h event backfill, stale-pending re-enqueue via the singleton key, and finalization of rows whose attempts were exhausted without bookkeeping).

The delivery executor (`apps/worker/src/deps/notify.ts`) sends one attempt per invocation: it re-resolves the webhook host at send time through the same global-unicast guard as provider endpoints, decrypts the write-only signing secret, renders the card copy from the `notifications` i18n namespace in the **endpoint's configured locale** (a channel has no single recipient, so the channel carries its own locale), and posts with a 10 s bound. Formatters are pluggable per endpoint kind — `generic` (JSON payload, `X-Agrippa-Signature: v1=hex(HMAC-SHA256(secret, "<ts>.<body>"))`), `feishu` (interactive card, the platform's timestamp-newline-secret signing), `dingtalk` (action card, sign in query params) — and success is formatter-defined because the IM platforms answer HTTP 200 with an error code in the body. Delivery records keep a redacted payload snapshot, response status/snippet, and attempts; a failed delivery is retryable from Project Settings (CAS `failed → pending` with the attempt budget reset).

## Live Progress (SSE)

Ordering rule: the engine writes `run_events` **first** — the per-run monotonic `seq` comes from an atomic counter (`runs.next_event_seq`, allocated by `UPDATE … RETURNING` in `run-lifecycle.appendRunEvent`), so it is collision-free and works inside a caller's transaction (the approval decision, which appends its event in the same tx as the decision) — then publishes the same event to Redis `run:{id}:events`.

`GET /runs/:id/events` (SSE):

1. **subscribe** to the Redis channel first, buffering live events,
2. replay `run_events WHERE run_id = ? AND seq > :lastEventId ORDER BY seq` (from the `Last-Event-ID` header, or 0),
3. flush the buffer, deduplicating by `seq` against the replay,
4. emit each as `id: <seq>\nevent: <type>\ndata: <payload>`.

The bus is only a **wake-up**: every event is delivered by an ordered `replay()` from Postgres (`seq > cursor ORDER BY seq`), so the cursor advances contiguously and can never jump past a gap. Sending bus events directly would advance a high-water cursor past a dropped seq, and that gap would then be skipped forever — even on a `Last-Event-ID` reconnect. The handler subscribes (and **awaits** the subscription being live — for Redis, the SUBSCRIBE ack) **before** the first replay, so nothing published in the subscribe/replay window is lost. Redis is optional: with a bus a wake-up makes delivery near-instant; without one the stream ticks the same replay on a timer. Either way a dropped pub/sub message (or a brief Redis outage) is recovered by the next replay, since Postgres is the source of truth.
