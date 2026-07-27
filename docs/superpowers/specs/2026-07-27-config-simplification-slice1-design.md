# Config Simplification — Slice 1: Default Grants, Provider Auto-Grant, Preflight

Date: 2026-07-27
Status: Approved (scope + key decisions confirmed)
Branch: `feat/config-simplification`

## Problem

Agrippa's configuration is "precise-control" oriented: every resource must be
explicitly registered, explicitly granted, and explicitly coupled. Concretely:

1. New projects get **zero** `project_resource_grants` — an admin must hand-toggle
   every model, skill, and faber before any task runs.
2. Provider credentials (`provider_credentials`) and model grants
   (`project_resource_grants`) are fully decoupled — you can grant a dashscope
   model with no credential, or hold a credential without granting its models.
3. Config problems (wrong tier, missing credential, missing grant) surface only
   as **post-submit run failures**. The SubmitTaskPage summary shows budget and
   duration but no readiness state.

This slice makes the platform follow "Convention over Configuration" for
onboarding while preserving every security invariant (project boundary,
resource manifest pinning at submit, credential encryption).

## Scope (this slice)

- **P0-3** — Built-in resources auto-granted at project creation.
- **P0-2** — Provider credential auto-grants that provider's active models.
- **P1-4** — Preflight check (project-scoped endpoint + SubmitTaskPage summary).

Deferred: setup wizard (P0-1 — largely redundant once the above exist), grants/
providers UI merge & regroup-by-provider (P1-5/P1-6 — slice 2), model auto-
discovery / template presets / org-level defaults (P2).

## Design

### P0-3: Default grants on project creation

When `POST /projects` creates a project, the same transaction inserts
`project_resource_grants` rows for every **active built-in** resource — i.e.
registry rows whose `orgId IS NULL` (the seeded built-ins: 8 models, 2 skills,
4 fabri). `mcp_servers` are org-scoped seeded; none are built-in, so none are
auto-granted here (an MCP server always carries org-scoped config + optional
secret, so default-granting it would be surprising).

**Selection** (all within the create transaction):
```ts
SELECT id FROM models    WHERE org_id IS NULL AND status = 'active'
UNION skills             WHERE org_id IS NULL AND latest_version_id IS NOT NULL
UNION fabri              WHERE org_id IS NULL AND status = 'active'
```
Skills require a published version to be grantable, so the join guards on
`latest_version_id IS NOT NULL`.

`grantedBy` = the creating user. One audit row covers the bulk insert
(`action: project.grants.default`, payload `{ count, sources: {models,skills,fabri} }`).

**Backfill for existing projects**: the seed step runs an idempotent
`seedDefaultGrants(db)` that, for the default org's projects, inserts any
missing built-in grants (the unique index `project_grants_uq` makes the insert
conflict-safe via `onConflictDoNothing`). This brings pre-existing dev
projects to parity with new ones on next boot/seed.

**Why not an org-level defaults table**: that's P2-9 and a bigger surface
(new table, admin UI, override semantics). Auto-grant at creation captures 90%
of the value now and stays a one-function change to refactor later.

**Security note**: grants say "this project *may* use this resource." Granting
a dashscope model is harmless without a credential — resolution still requires
one. The project boundary (grants ∩ registry) and submit-time manifest pinning
are untouched.

### P0-2: Provider credential auto-grants its models

`POST /projects/:id/providers`, on success, inserts grants for every **active**
`models` row whose `provider` matches and `org_id IS NULL` (built-in models of
that provider). `onConflictDoNothing` keeps it idempotent (re-adding a deleted
credential, or rotating, won't duplicate). A *non*-built-in (org-scoped) model
of that provider is **not** auto-granted — the admin registered it explicitly,
so explicit grant stays appropriate.

The response gains `autoGrantedModels: number` (count of newly-inserted grant
rows; 0 if all already existed). The frontend surfaces a toast:
`"Granted N models from <provider> — adjust in Resources"`.

**Credential removal does NOT revoke grants** — grants are independent of
credentials by design, and auto-revoking would be surprising data loss. The
preflight (below) tells the user a credential is missing; they act on it
deliberately.

### P1-4: Preflight check

New endpoint: `GET /projects/:projectId/task-types/:taskTypeId/preflight`
(`viewer` role — read-only readiness info, same visibility as grants/repos).

Returns:
```json
{
  "ready": false,
  "checks": [
    { "key": "models", "ok": true,  "detail": "qwen3.7-plus · qwen3.6-flash", "fixPath": null },
    { "key": "provider_credential", "ok": false,
      "detail": "dashscope needs a project key", "fixPath": "providers" },
    { "key": "skills", "ok": true,  "detail": "git-workflow", "fixPath": null },
    { "key": "repo", "ok": true, "detail": "1 connection", "fixPath": null }
  ]
}
```

- `fixPath` is a settings tab key (`providers` / `grants` / `repos`) when the
  check fails, so the UI can deep-link; `null` when ok.
- `ready` is the AND of all `checks[].ok`.

**Reuse**: the model-resolution check calls `resolveRolesFrom` (already
non-throwing — returns `{missingRole,tiers} | {resolution}`) over
`fetchGrantedModels` + `slotRoleSets`, per slot, applying the same
single-provider + credential-gating rules as `resolveSlotModels` but
**reporting** the reason instead of throwing. This is a new
`preflightResolution` helper in `resolve.ts` that mirrors
`resolveAgentBindings`'s slot loop but returns a structured result. The skill/
MCP check reuses `authorizeResources`'s grant-set logic in a dry-run form
(non-throwing). The repo check verifies the project has ≥1 active repo
connection when the template declares a `repoRef` input.

**Frontend**: SubmitTaskPage fetches preflight alongside the task-type detail
and renders a compact checklist above the Submit button in the summary card.
Each failing row links to `settings#<fixPath>`. The Submit button stays enabled
(members may still attempt submit), but failing checks make the likely failure
visible *before* the round-trip.

## Testing

- P0-3: integration test — create project → assert built-in grants present;
  assert no grants for org-scoped resources.
- P0-2: integration test — add dashscope credential → assert dashscope model
  grants inserted; re-add (delete+add) → idempotent; response count correct.
- P1-4: integration test — preflight `ready:true` for a fully-configured
  project; `ready:false` (missing credential / missing model tier / missing
  skill) with the right `fixPath` per case.
- Engine compliance suite (`engine.integration.test.ts`) stays green — no
  resolution semantics change, only a new read-only caller.

## Files touched (planned)

- `apps/api/src/routes/projects.ts` — P0-3 (create), P0-2 (provider POST)
- `packages/db/src/seed/index.ts` — `seedDefaultGrants` backfill
- `packages/orchestration/src/resolve.ts` — `preflightResolution` helper
- `apps/api/src/routes/catalog.ts` — preflight endpoint (or a new route module)
- `apps/web/src/pages/SubmitTaskPage.tsx` — preflight checklist in summary
- `packages/api-client` + `apps/web/src/lib/types.ts` — preflight types
- `packages/i18n/locales/{en,zh-CN}` — toast + checklist copy
- docs + CHANGELOG
