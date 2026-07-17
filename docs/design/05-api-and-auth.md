# 05 — API, Auth & RBAC

> Status: draft for review · Last updated: 2026-07-17

Hono server (`apps/api`), REST under `/api/v1`, request/response validation via `@hono/zod-validator` with all schemas imported from `@agrippa/core` (the SPA consumes the same schemas — one source of truth). Auth: **better-auth** with its Drizzle adapter ([ADR-0004](../adr/0004-better-auth.md)), mounted at `/api/auth/*`.

## Authentication

- **M1**: email + password (better-auth), session cookies for the SPA. SSO/OIDC is a later drop-in (better-auth plugin).
- **API keys** for programmatic access: `Authorization: Bearer agr_<key>`. Keys are hashed at rest (`api_keys.key_hash`), carry explicit `scopes` (e.g. `tasks:write`, `runs:read`, `resources:read`) and an optional project binding. Key middleware resolves them to a principal equivalent to a user context with restricted scopes.
- **Locale middleware** resolves the request locale (`?lang=` → user profile → `Accept-Language` → `en`) and localizes error `message`; the machine-readable `code` is stable regardless of locale.

## RBAC

Two layers, deliberately simple:

| Layer | Roles | Governs |
|---|---|---|
| Org | `org_admin`, `org_member` | Resource layer writes (registries, template publish), org settings, user management |
| Project | `admin`, `member`, `viewer` | Everything project-scoped |

Project-role capabilities: **viewer** = read everything in the project; **member** = viewer + submit tasks, cancel own runs, decide approvals; **admin** = member + manage members, resource grants, quota, repos, project settings.

Enforcement: a single middleware `requireRole(scope, minRole)` — scope is `org` or a project id resolved from the route; it reads `project_members` (or `users.org_role`) and rejects with `403 {code: "forbidden"}`. Every mutating handler writes an `audit_logs` row (actor, action, resource, payload diff, IP) via a shared audit helper — auditing is not optional per-route.

## Error Shape

```json
{ "code": "quota_exceeded", "message": "本月项目配额已用尽", "details": {...} }
```

Stable `code` slugs (localizable message via i18next backend instance). Validation errors: `code: "validation_failed"` with zod issue paths in `details`.

## Endpoints

### Me & auth
```
POST/GET /api/auth/*                      # better-auth (sign-up, sign-in, session)
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
GET    /projects/:id/grants               PUT /projects/:id/grants # bulk enable/disable resources
GET    /projects/:id/quota                PUT /projects/:id/quota
GET    /projects/:id/usage?period=&groupBy=model|task_type|member
```

### Catalog
```
GET /scenarios                            # localized, enabled only
GET /scenarios/:slug/task-types
GET /task-types/:id                       # includes compiled input schema → form generation
```

### Execution
```
POST /projects/:id/tasks                  # {taskTypeId, title, params} → 202 {taskId, runId}
GET  /projects/:id/tasks?status=&taskType=
GET  /tasks/:id                           POST /tasks/:id/retry     # → new run
GET  /runs/:id                            # embeds a viewer-scoped template plan (phases/budgets/modelRoles — no prompts)
GET  /runs/:id/steps                      # each row carries usage {costUsd, tokens} aggregated from token_usage
GET  /runs/:id/events                     # SSE; Last-Event-ID replay (see 04)
POST /runs/:id/cancel
GET  /approvals/pending                   # cross-project inbox: pending checkpoints in the caller's projects
GET  /runs/:id/approvals                  POST /runs/:id/approvals/:approvalId  # {decision, comment}
GET  /runs/:id/artifacts                  GET /artifacts/:id/download
```

Submission authorizes the resources a task references before persisting: a `repoRef` param must name a repo connection **owned by the project** (else `400 {code: "repo_not_in_project"}`), and the run's authorized skills/MCP are pinned into a resource manifest (see [04](04-execution-runtime.md) and [ADR-0009](../adr/0009-security-correctness-deep-modules.md)). Approval decisions are a compare-and-swap on the pending status: a decision that lost the race (already decided, or expired) returns `409 {code: "already_decided"}`.

### Resource layer (org_admin writes; members read)
```
CRUD /fabri
CRUD /skills                              POST /skills/:id/versions
CRUD /mcp-servers                         # secrets accepted write-only, returned masked
CRUD /models
CRUD /templates                           POST /templates/:id/versions            # save draft
POST /templates/:id/versions/:v/publish   POST /templates/validate                # dry-run compile
```

### Governance
```
GET  /audit-logs?projectId=&action=&limit=   # rows include joined actorEmail/actorName
CRUD /api-keys                            # secret shown once at creation
```

Conventions: cursor pagination (`?cursor=&limit=`), `202` for async acceptance (task submission), idempotent retries via client-supplied `Idempotency-Key` on task submission (stored briefly to dedupe double-clicks).

## Module Layout

`apps/api/src/routes/` — one file per resource. `apps/api/src/middleware/` — `auth.ts`, `rbac.ts`, `locale.ts`, `audit.ts`, `error.ts` (maps thrown domain errors → error shape). The API **never imports executors** — it enqueues jobs and reads state; execution belongs to the worker.
