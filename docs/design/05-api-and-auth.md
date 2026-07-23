# 05 — API, Auth & RBAC

> Status: living · Last updated: 2026-07-23

Hono server (`apps/api`), REST under `/api/v1`, request/response validation via `@hono/zod-validator` with all schemas imported from `@agrippa/core` (the SPA consumes the same schemas — one source of truth). Auth: **better-auth** with its Drizzle adapter ([ADR-0004](../adr/0004-better-auth.md)), mounted at `/api/auth/*`.

## Authentication

- **M1**: email + password (better-auth), session cookies for the SPA. SSO/OIDC is a later drop-in (better-auth plugin).
- **Invite-only onboarding; self-registration is closed.** `POST /api/auth/sign-up/*` is guarded in `apps/api/src/app.ts` and returns `403 registration_closed` (localized). The only ways a user joins the org:
  - **Bootstrap admin** — `bun --env-file=../../.env.local apps/api/src/cli/bootstrap-admin.ts` reads `AGRIPPA_BOOTSTRAP_EMAIL` / `AGRIPPA_BOOTSTRAP_PASSWORD` and creates the first `org_admin` (idempotent on email). The password is hashed with better-auth's `hashPassword`, so the account signs in via the normal `/api/auth/sign-in/email` flow.
  - **Invitation** — an `org_admin` calls `POST /api/v1/invitations` with an email; the system returns a one-time `?token=…` link (the token is stored **hashed** — sha256 — so a DB leak can't be replayed). The invitee opens `/accept-invite?token=…` (public, no session), sets name + password; `POST /api/auth/accept-invite` validates the token, creates the `users` + `accounts` rows directly (again `hashPassword`), marks the invitation accepted, and writes an audit row (actor = the inviter). No session is issued — the invitee signs in via `/api/auth/sign-in/email`. `GET /api/v1/invitations` lists invitations; `DELETE /api/v1/invitations/:id` revokes a pending one. No email infra exists; the admin shares the link out-of-band. The first-user→org_admin `user.create` hook in `auth.ts` is retained as a safety net but is superseded by `bootstrap-admin`.
- **API keys** for programmatic access: `Authorization: Bearer agr_<key>`. Keys are hashed at rest (`api_keys.key_hash`), carry explicit `scopes` (e.g. `tasks:write`, `runs:read`, `resources:read`) and an optional project binding. Key middleware resolves them to a principal equivalent to a user context with restricted scopes.
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
GET    /projects/:id/providers            POST /projects/:id/providers            # provider credentials (ADR-0013)
PATCH  /projects/:id/providers/:provider  DELETE /projects/:id/providers/:provider
   # key is write-only (encrypted into secrets, kind provider_api_key); reads expose hasCredential only.
   # viewer reads the list; admin writes. PATCH rotates the key in place and/or sets baseUrl (null clears
   # back to the catalog default); DELETE removes row + secret in one tx. Duplicate provider → 409 provider_exists.
GET    /projects/:id/grants               PUT /projects/:id/grants # bulk enable/disable resources
GET    /projects/:id/quota                PUT /projects/:id/quota
GET    /projects/:id/usage   # current-month totals + byModel + byTaskType + byDay (same window as the quota gate)
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
GET  /tasks/:id                           POST /tasks/:id/retry     # → new run (bindings copied)
GET  /runs/:id                            # embeds a viewer-scoped template plan (phases/loops/checkpoints/budgets/modelRoles —
                                          # no prompts), per-slot agent metadata, and all checkpoint rows with decider names
GET  /runs/:id/steps                      # each row carries iteration + usage {costUsd, tokens}
GET  /runs/:id/events                     # SSE; Last-Event-ID replay (see 04)
POST /runs/:id/cancel
GET  /checkpoints/pending                 # cross-project "waiting on you" inbox (kind, iteration, payload snapshot)
GET  /runs/:id/checkpoints                # all checkpoint rows for the run
POST /runs/:id/checkpoints/:checkpointId/respond   # kind-discriminated: approval {decision, comment} |
                                                   # input {answers} | review-gate {outcome, selectedFindingIds}
GET  /runs/:id/comments                   POST /runs/:id/comments   # {body} → also a comment.added run event
GET  /runs/:id/artifacts                  GET /artifacts/:id/download
```

Submission authorizes the resources a task references before persisting: a `repoRef` param must name a repo connection **owned by the project** (else `400 {code: "repo_not_in_project"}`), the run's authorized skills/MCP are pinned into a resource manifest (see [04](04-execution-runtime.md) and [ADR-0009](../adr/0009-security-correctness-deep-modules.md)), and every agent slot resolves to a concrete faber + executor (`resolveAgentBindings`: overrides on overridable slots only — `400 slot_not_overridable`/`slot_unknown`/`executor_unknown`/`faber_unknown`, capability checks against the executor catalog — `400 executor_capability`, provider-filtered per-slot model resolution — `400 model_unresolvable`).

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
CRUD /api-keys                            # secret shown once at creation
```

Conventions: cursor pagination (`?cursor=&limit=`), `202` for async acceptance (task submission), idempotent retries via client-supplied `Idempotency-Key` on task submission (stored briefly to dedupe double-clicks).

## Module Layout

`apps/api/src/routes/` — one file per resource. `apps/api/src/middleware/` — `auth.ts`, `rbac.ts`, `locale.ts`, `audit.ts`, `error.ts` (maps thrown domain errors → error shape). The API **never imports executors** — it enqueues jobs and reads state; execution belongs to the worker.
