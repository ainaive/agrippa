# 05 — API, Auth & RBAC

> Status: living · Last updated: 2026-07-23

Hono server (`apps/api`), REST under `/api/v1`, request/response validation via `@hono/zod-validator` with all schemas imported from `@agrippa/core` (the SPA consumes the same schemas — one source of truth). Auth: **better-auth** with its Drizzle adapter ([ADR-0004](../adr/0004-better-auth.md)), mounted at `/api/auth/*`.

## Authentication

- **M1**: email + password (better-auth), session cookies for the SPA. SSO/OIDC is a later drop-in (better-auth plugin).
- **Invite-only onboarding; self-registration is closed.** `POST /api/auth/sign-up/*` is guarded in `apps/api/src/app.ts` and returns `403 registration_closed` (localized). The only ways a user joins the org:
  - **Bootstrap admin** — `bun --env-file=../../.env.local apps/api/src/cli/bootstrap-admin.ts` reads `AGRIPPA_BOOTSTRAP_EMAIL` / `AGRIPPA_BOOTSTRAP_PASSWORD` and creates the first `org_admin` (idempotent on email). The password is hashed with better-auth's `hashPassword`, so the account signs in via the normal `/api/auth/sign-in/email` flow.
  - **Invitation** — an `org_admin` calls `POST /api/v1/invitations` with an email; the system returns a one-time `?token=…` link (the token is stored **hashed** — sha256 — so a DB leak can't be replayed). The invitee opens `/accept-invite?token=…` (public, no session), sets name + password; `POST /api/auth/accept-invite` validates the token, creates the `users` + `accounts` rows directly (again `hashPassword`), marks the invitation accepted, and writes an audit row (actor = the inviter). No session is issued — the invitee signs in via `/api/auth/sign-in/email`. `GET /api/v1/invitations` lists invitations; `DELETE /api/v1/invitations/:id` revokes a pending one. No email infra exists; the admin shares the link out-of-band. The first-user→org_admin `user.create` hook in `auth.ts` is retained as a safety net but is superseded by `bootstrap-admin`.
- **API keys** for programmatic access (implemented, Track T): `Authorization: Bearer agr_<key>`. Issued and revoked by **project admins** under Settings → API keys (`POST/GET /api/v1/projects/:projectId/api-keys`, `POST …/:id/revoke`); the plaintext is shown exactly once, and only a sha256 hash plus a 12-char lookup prefix is stored (`api_keys.key_hash` / `.prefix`, uniquely indexed). Verification is the daemon-token shape — prefix-indexed lookup, constant-time compare — sharing one implementation via `apps/api/src/lib/bearer-tokens.ts`, which the `agrd_` and invitation tokens also call. Unknown, malformed, revoked, and expired all answer the same `401 api_key_invalid`, so a probe learns nothing from the difference.

  The gate is `requireSession` itself (`apps/api/src/middleware/auth.ts`): it accepts either a better-auth session or an `agr_` bearer, and sets `user` + `principal` either way so no handler branches on how the caller authenticated. A key **acts as its creating user**, which is what keeps project membership the single source of access — revoke someone's membership and their keys stop working with it — but is narrowed in two ways a session is not: `orgRole` is pinned to `org_member` regardless of the owner's real role, and reachable routes are an **explicit allow-list** (`apps/api/src/lib/api-key-routes.ts`) mapping (method, path) → required scope. Anything unlisted answers `403`, so a route added later is unreachable by every key issued before it; administration — registries, template publish, members, quota, settings, notification endpoints, checkpoint decisions, and API-key management itself — is deliberately absent. Scopes are `tasks:write` (submit/retry/cancel), `runs:read` (tasks, runs, steps, checkpoints, comments, artifacts), `resources:read` (scenario catalog).

  Every key is bound to the project it was created in. That binding is enforced inside `assertProjectRole`, which takes the whole `RequestPrincipal` rather than a bare user id — handlers reach projects by several routes (a `:projectId` param, a loaded run, a loaded task) and all of them land there, so the binding cannot be bypassed by forgetting it at a call site. **Audit on use** falls out of the actor generalization: `audit()` names both `actor_user_id` and `actor_api_key_id`, so every mutation records which credential was used without an audit row per read. `last_used_at` advances at most once a minute — it is a liveness signal for the UI, not the audit trail.
- **Daemon runtime tokens** (ADR-0017, implemented): `Authorization: Bearer agrd_<token>` authenticates a remote runtime daemon against `/api/daemon/*` — a separate Hono sub-app with its own env (`runtime` principal, never a session user) mounted outside the v1 session gate, the accept-invite precedent. Tokens are issued from **Admin → Workers** (`POST /api/v1/runtimes`, org_admin; plaintext shown exactly once), stored as sha256 hash + a 12-char display/lookup prefix, verified with a constant-time compare, and revocable (`POST /api/v1/runtimes/:id/revoke` kills the token immediately). Every auth failure is the same `401 daemon_token_invalid`, so probes can't distinguish unknown, malformed, and revoked tokens. Daemon-actor mutations audit with `audit_logs.actor_runtime_id`. `register` reports hostname/version/executor advertisement and returns protocol hints (claim wait, heartbeat, keepalive cadences); `heartbeat` bumps the liveness watermark routing reads and the contact deadline of active dispatches. The dispatch surface: `GET claim?wait=N` long-polls (bounded at 25 s, 1 s tick) and atomically claims the oldest pending dispatch for the runtime (`FOR UPDATE SKIP LOCKED`) — an empty poll still answers 200 because two piggybacks ride every claim response: `abortedDispatchIds`, and `reapableRunIds` — runs pinned to this runtime that have finalized, so the daemon can delete their workspaces. It cannot work that out for itself: affinity gives it a run's workspace for the run's whole life, so the directory accumulates state across steps and reaping a live one is not merely wasteful — the next dispatch re-clones at the pinned base and the run continues silently without earlier steps' work. Only the server knows the run finalized, because the engine runs centrally even when the executor does not. Bounded by a 24-hour window rather than an acknowledgement, since removal is idempotent; the daemon also sweeps directories untouched for 30 days at boot, which collects what the signal missed (a daemon offline when its runs ended, or upgraded from a build that never reaped); `POST dispatches/:id/events` takes sequence-numbered batches (≤100 events / 256 KiB, bounded by Content-Length before parsing), deduplicated on `(dispatch, seq)` so at-least-once delivery cannot double-count usage, with the response carrying the abort flag (an empty batch is the keepalive that bounds abort latency); `POST dispatches/:id/artifacts/:key` streams bytes into the per-dispatch staging area with the sha256 computed server-side at write time (daemon-reported hashes are never trusted; keys are single traversal-proof tokens, and the 25 MiB artifact cap applies); `complete`/`fail` are terminal CAS transitions (the loser of a race gets 409 `dispatch_not_live`). This is the codebase's first bearer auth — Track T's API-key middleware generalizes from it.
- **Inbound webhook triggers** (implemented, Track T): `POST /api/triggers/:token`, a Hono sub-app mounted **outside** the v1 session gate alongside the daemon surface. The `agrt_` token travels in the URL path rather than a header because the senders that matter — CI runners, IM bots, hosted git providers — can all POST to a URL and many cannot set `Authorization`. That makes the URL a capability and only half the authentication: a **signing secret is mandatory** (unlike an outbound endpoint's optional one, where IM bots have their own auth), because an unsigned inbound trigger is an open "spend this project's tokens" endpoint for anyone who ever sees the URL in a proxy log or a CI transcript. Requests carry `x-agrippa-timestamp` and `x-agrippa-signature: v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>">` — deliberately the same convention the platform *sends* on outbound notifications, so there is one dialect in both directions. The signature is computed over the **raw request bytes**, never a re-serialization, and timestamps outside ±5 minutes are refused in both directions so a fast sender clock cannot buy a longer replay window. Unknown token, wrong signature, stale timestamp, and disabled trigger all answer the same `401 trigger_request_invalid`.

  The signature is computed over the **raw bytes**, which are buffered and verified before any decode — decoding first would substitute U+FFFD for invalid UTF-8 and reject a legitimately signed body as if its secret were wrong. The request **records and acknowledges; the worker submits**. A `trigger_deliveries` row is written before the `202`, so a submission that fails later is visible and replayable rather than lost with the sender's connection, and a slow submit can never become a timeout the sender retries into a duplicate run. **Duplicate suppression is conditional on the sender.** The dedupe key is a partial unique index on `(endpoint, external_id)` — the inbound mirror of the outbound `(endpoint, event)` — and `external_id` comes from an *optional* `x-agrippa-delivery-id` header. A sender that supplies a stable one gets **at-most-once run per id** — the index collapses its duplicate *requests* onto the first delivery, and `runs.origin_key` makes a pg-boss redelivery of that delivery idempotent — but not exactly-once, because the liveness half is missing: a delivery whose attempts are exhausted ends `failed` and produces no run at all. A sender that supplies nothing has nothing to deduplicate against, so any retry it makes for any reason inserts a second delivery and produces a second run. The header is taken as the sender wrote it or not at all: **blank is absent** (a present-but-empty header would otherwise be stored as `''`, which the partial index happily matches, collapsing every such request onto one delivery forever), and an id past `TRIGGER_DELIVERY_ID_MAX_LENGTH` is a **400** rather than a truncation — silently shortening an idempotency key turns two distinct events into a duplicate, and dropping one behind a `200 accepted` is the failure the header exists to prevent. What the platform guarantees unconditionally is narrower: it acknowledges before submitting, so a slow submit cannot itself become the timeout that provokes such a retry. Integrations that care should send the header. `fireTrigger` refuses a delivery that already succeeded, so at-least-once job delivery and an operator hitting replay both converge on one run. Authority is re-checked per firing by the same `checkWorkAuthority` schedules use, and the payload is stored for inspection but **never interpolated into a prompt**: a valid signature proves who sent the bytes, not that the bytes are safe.

- **Locale middleware** resolves the request locale (`?lang=` → user profile → `Accept-Language` → `en`) and localizes error `message`; the machine-readable `code` is stable regardless of locale.

## RBAC

Two layers, deliberately simple:

| Layer | Roles | Governs |
|---|---|---|
| Org | `org_admin`, `org_member` | Resource layer writes (registries, template publish), org settings, user management |
| Project | `admin`, `member`, `viewer` | Everything project-scoped |

Project-role capabilities: **viewer** = read everything in the project (including run comments and the timeline); **member** = viewer + submit tasks (with agent-slot overrides), cancel own runs, respond to checkpoints (approve/reject, request changes — offered only on loop checkpoints, elsewhere the API answers `request_changes_unsupported` — answer questions, decide review findings), post run comments; **admin** = member + manage members, resource grants, quota, repos, provider credentials, project settings.

Enforcement: a single middleware `requireRole(scope, minRole)` — scope is `org` or a project id resolved from the route; it reads `project_members` (or `users.org_role`) and rejects with `403 {code: "forbidden"}`. Every mutating handler writes an `audit_logs` row (actor, action, resource, payload diff, IP) via a shared audit helper — auditing is not optional per-route.

## Error Shape

```json
{ "code": "quota_exceeded", "message": "本月项目配额已用尽", "details": {...} }
```

Stable `code` slugs (localizable message via i18next backend instance). Validation errors: `code: "validation_failed"` with zod issue paths in `details`.

## Endpoints

### Me & auth
```
POST/GET /api/auth/*                      # better-auth (sign-in, sign-out, session)
POST     /api/auth/sign-up/*              # 403 registration_closed — self-registration is disabled
GET/POST /api/auth/accept-invite          # public invite-accept flow (no session; token-gated)
POST     /api/v1/invitations              # org_admin: create invite → { inviteUrl, token }
GET      /api/v1/invitations              # org_admin: list invites
DELETE   /api/v1/invitations/:id         # org_admin: revoke a pending invite
GET   /me                                 # profile + org role + project memberships
PATCH /me                                 # name, locale
```

### Projects
```
POST   /projects                          GET /projects
GET    /projects/:id                      PATCH /projects/:id      DELETE /projects/:id (archive)
POST   /projects/:id/members              GET /projects/:id/members
PATCH  /projects/:id/members/:userId      DELETE /projects/:id/members/:userId
POST   /projects/:id/repos                GET /projects/:id/repos  DELETE .../repos/:repoId
                                          # provider: github | gitlab | gitcode | generic-git (pr.open needs the first three)
GET    /projects/:id/providers            POST /projects/:id/providers            # provider credentials (ADR-0013)
PATCH  /projects/:id/providers/:provider  DELETE /projects/:id/providers/:provider
   # key is write-only (encrypted into secrets, kind provider_api_key); reads expose hasCredential only.
   # viewer reads the list; admin writes. PATCH rotates the key in place and/or sets baseUrl (null clears
   # back to the catalog default); setting a NEW baseUrl requires re-entering apiKey in the same request —
   # endpoint and key travel together, so an existing write-only key can never be redirected (ADR-0013 am. 2).
   # DELETE removes row + secret in one tx. Duplicate provider → 409 provider_exists; bad endpoint → 400 base_url_invalid.
   # POST also grants that provider's active built-in models (autoGrantedModels in the response) — convention
   # over configuration: a credential is what makes a provider's models usable, so the two are coupled.
   # POST/PATCH validate the provider is an active provider_catalog entry (400 provider_not_in_catalog) and
   # the baseUrl host against that entry's host allowlist.
GET    /provider-catalog              POST /provider-catalog                # org_admin-managed provider catalog
PATCH  /provider-catalog/:providerId  DELETE /provider-catalog/:providerId
   # the resolvable provider set (label, per-wire-protocol default endpoints, auth policy, host pins).
   # builtins (anthropic/openai/dashscope) are seeded org_id NULL and immutable/non-deletable; customs are
   # org-scoped. Resolution derives claude (anthropic) / codex (openai) candidates by protocol from this
   # catalog, so a custom Anthropic-compatible provider is resolvable by the claude executor.
GET    /projects/:id/grants               PUT /projects/:id/grants # bulk enable/disable resources
   # a NEW project is auto-granted every active built-in resource (models/skills/fabri) inside its create
   # transaction, so it never starts in a zero-grants state; a seed backfill brings existing projects to parity.
GET    /projects/:id/task-types/:taskTypeId/preflight   # viewer-readable submit-readiness check (P1-4)
   # runs the same resolution + skill/MCP/repo grant logic submit uses, but reports each dimension as a
   # structured check instead of failing fast; returns {ready, checks[]} with a settings fixPath per failing
   # item so the submit summary can deep-link to the right tab. 409 if the template has no published version.
GET    /projects/:id/quota                PUT /projects/:id/quota
GET    /projects/:id/usage   # current-month totals + byModel + byTaskType + byDay (same window as the quota gate)
GET    /projects/:id/notifications/endpoints              POST /projects/:id/notifications/endpoints
PATCH  /projects/:id/notifications/endpoints/:endpointId  DELETE .../endpoints/:endpointId
POST   /projects/:id/notifications/endpoints/:endpointId/test   # 202 {deliveryId} — queues a test send
GET    /projects/:id/notifications/deliveries?limit=&status=    # delivery log w/ endpoint + run context
POST   /projects/:id/notifications/deliveries/:deliveryId/retry # CAS failed→pending (else 409 not_retryable)
   # ALL admin-only, reads included: IM bot webhook URLs are capability URLs, so responses carry a masked
   # url + hasSecret only. The signing secret is write-only (secrets kind webhook_secret); required for
   # kind generic, optional for feishu/dingtalk. Changing the URL of a SIGNED endpoint requires re-entering
   # the secret (the provider-credential rule; enforced in the route since unsigned endpoints are exempt).
   # PATCH resets the activation watermark (activated_at) on re-enable and on url/events changes AND
   # fails the endpoint's still-pending deliveries in the same transaction, so a changed endpoint never
   # replays historical events (a worker-side guard catches rows in flight past that transaction).
   # Bad URL → 400 webhook_url_invalid (per-kind host pins: open.feishu.cn / oapi.dingtalk.com; query
   # allowed — DingTalk carries access_token there). DELETE removes endpoint + secret in one tx; deliveries
   # cascade. Audit actions: project.webhook.add|update|remove|test|retry.
```

### Catalog
```
GET /scenarios                            # localized, enabled only
GET /scenarios/:slug/task-types
GET /task-types/:id                       # includes compiled input schema → form generation
```

### Execution
```
POST /projects/:id/tasks                  # {taskTypeId, title, params, agents?} → 202 {taskId, runId}
GET  /projects/:id/tasks?status=&taskType=
GET  /tasks/:id                           POST /tasks/:id/retry     # → new run (re-resolved vs current config, ADR-0014)
GET  /runs/:id                            # embeds a viewer-scoped template plan (phases/loops/checkpoints/limits/modelRoles —
                                          # no prompts), per-slot agent metadata, and all checkpoint rows with decider names
GET  /runs/:id/steps                      # each row carries iteration + usage {tokens}
GET  /runs/:id/events                     # SSE; Last-Event-ID replay (see 04)
POST /runs/:id/cancel
GET  /checkpoints/pending                 # cross-project "waiting on you" inbox (kind, iteration, payload snapshot)
GET  /runs/:id/checkpoints                # all checkpoint rows for the run
POST /runs/:id/checkpoints/:checkpointId/respond   # kind-discriminated: approval {decision, comment} |
                                                   # input {answers} | review-gate {outcome, selectedFindingIds}
GET  /runs/:id/comments                   POST /runs/:id/comments   # {body} → also a comment.added run event
POST /runs/:id/followup                   # {message} → 202 {runId, number, coalesced} — steer a FINISHED run
                                          # (ADR-0018): new run, same workspace + session, config copied verbatim
GET  /runs/:id/artifacts                  GET /artifacts/:id/download
```

Submission authorizes the resources a task references before persisting: a `repoRef` param must name a repo connection **owned by the project** (else `400 {code: "repo_not_in_project"}`), the run's authorized skills/MCP are pinned into a resource manifest (see [04](04-execution-runtime.md) and [ADR-0009](../adr/0009-security-correctness-deep-modules.md)), and every agent slot resolves to a concrete faber + executor (`resolveAgentBindings`: overrides on overridable slots only — `400 slot_not_overridable`/`slot_unknown`/`executor_unknown`/`faber_unknown`, capability checks against the executor catalog — `400 executor_capability`, provider-filtered per-slot model resolution — `400 model_unresolvable`).

**Follow-up steering** (`POST /runs/:id/followup`) continues a finished run rather than resubmitting it. Gated like any new work — project accepts work, quota headroom, member role — plus two of its own: the run must be terminal (`409 run_active`; steering a live run is a different feature with a different failure model) and its workspace must not already be collectable (`409 workspace_expired`, so an expired workspace answers as a 409 rather than as a charged run that fails `workspace_lost` on a worker). The message lands on the run's thread first, so it is visible whatever the queue does; then, if an unstarted follow-up already exists for that workspace, it **absorbs** the message (`coalesced: true`) via a CAS on `started_at IS NULL` — the run row is the burst buffer, because the API runs multiple replicas and an in-process debounce would coalesce per replica. A message arriving after the follow-up starts becomes the next follow-up rather than joining it. The enqueue is delayed by `AGRIPPA_FOLLOWUP_COALESCE_SECONDS` (default 15) and, like every post-commit send here, not awaited. Not on the API-key allow-list: steering is a human affordance, and the allow-list denies by default.

Checkpoint responses validate against the pending row's kind (`409 checkpoint_kind_mismatch`) and its snapshot (unknown/missing answers or finding ids → `400 validation_failed`); `request_changes` outside a loop → `409 request_changes_unsupported`. Decisions are a compare-and-swap on the pending status: a response that lost the race returns `409 {code: "already_decided"}`. The decision, its `checkpoint.decided` event, and the audit row commit in one transaction; comments likewise commit with their `comment.added` event so the SSE timeline and the thread can never disagree.

### Resource layer (org_admin writes; members read)
```
CRUD /fabri
CRUD /skills                              POST /skills/:id/versions
CRUD /mcp-servers                         # secrets accepted write-only, returned masked
CRUD /models
CRUD /templates                           POST /templates/:id/versions            # save draft
POST /templates/:id/versions/:v/publish   POST /templates/validate                # dry-run compile
POST /templates/:id/versions/:v/deprecate # published & non-latest only (409 version_is_latest)
```

### Governance
```
GET  /audit-logs?projectId=&action=&limit=   # rows include joined actorEmail/actorName
GET|POST /:projectId/api-keys             # project-scoped; secret shown once at creation
POST /:projectId/api-keys/:id/revoke      # revoked, never deleted — the audit trail keeps the row
```

Conventions: cursor pagination (`?cursor=&limit=`), `202` for async acceptance (task submission), idempotent retries via client-supplied `Idempotency-Key` on task submission (stored briefly to dedupe double-clicks).

## Module Layout

`apps/api/src/routes/` — one file per resource. `apps/api/src/middleware/` — `auth.ts`, `rbac.ts`, `locale.ts`, `audit.ts`, `error.ts` (maps thrown domain errors → error shape). The API **never imports executors** — it enqueues jobs and reads state; execution belongs to the worker.
