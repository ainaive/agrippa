# 01 — Domain Model & Data Model

> Status: draft for review · Last updated: 2026-07-17

Postgres via **Drizzle ORM** ([ADR-0002](../adr/0002-drizzle-over-prisma.md)). All primary keys are **UUIDv7** (time-ordered, index-friendly, safe to expose). All timestamps are `timestamptz`. Localized display fields use `jsonb` of shape `{"en": "...", "zh-CN": "..."}` ([ADR-0008](../adr/0008-i18n-jsonb-columns.md)).

## Entity Relationship Overview

```
Org 1─* User
Org 1─* Project ─┬─* ProjectMember (User × role)
                 ├─* RepoConnection
                 ├─* ProjectResourceGrant
                 ├─1 ProjectQuota
                 └─* Task 1─* Run
Scenario 1─* TaskType ──1 OrchestrationTemplate 1─* TemplateVersion (immutable)
TaskType ──1 Faber (default)
Run ──1 TemplateVersion (pinned at submit)
Run 1─* RunStep 1─* RunEvent (append-only)
Run 1─* Approval, Artifact, TokenUsage
Everything mutating ─* AuditLog
```

Invariants:

- Every top-level table carries `org_id` even though M1 seeds exactly one org — SaaS later means adding row-level scoping, not schema rewrites.
- A run **pins** `template_version_id` at submit. Publishing a new template version never affects in-flight or historical runs.
- `run_events` is **append-only** and the source of truth for the execution timeline; `run_steps` is a queryable projection updated by the engine.
- Published `template_versions` / `skill_versions` rows are immutable; changes require a new version.
- Secrets never live in plain `jsonb` — only `*_secret_ref` references into the encrypted `secrets` table.

## Schema

### Identity & tenancy

better-auth owns `users` / `sessions` / `accounts` base columns (via its Drizzle adapter); we extend `users`.

```sql
orgs      (id pk, slug unique, name, created_at)

users     (id pk, org_id fk, email unique, name,
           locale text not null default 'en',                 -- 'en' | 'zh-CN'
           org_role text not null check in ('org_admin','org_member'),
           ... better-auth columns)

api_keys  (id pk, org_id fk, project_id fk null,              -- null = org-wide key
           name, key_hash, prefix,                            -- 'agr_' + short prefix shown in UI
           scopes jsonb,                                      -- ["tasks:write","runs:read",...]
           created_by fk users, expires_at, revoked_at, last_used_at)

invitations (id pk, org_id fk, email,                         -- invite-only onboarding
           token_hash unique,                                -- sha256 of one-time token; plaintext never stored
           role text not null default 'org_member',           -- only org_member is granted via invite
           created_by fk users, expires_at,                   -- default +7d
           accepted_at null, accepted_user_id fk users null)  -- null = pending
           -- self-registration is closed (05); this is the only path a new member joins

secrets   (id pk, org_id fk, kind text,                       -- 'mcp_auth' | 'git_credential' | ...
           ciphertext bytea, created_by fk, created_at, rotated_at)
           -- AES-256-GCM via node:crypto; key from AGRIPPA_SECRET_KEY env
```

### Projects

```sql
projects  (id pk, org_id fk, slug, name, description, status,
           settings jsonb, created_by fk, created_at, archived_at,
           unique (org_id, slug))

project_members (id pk, project_id fk, user_id fk,
           role text not null check in ('admin','member','viewer'),
           unique (project_id, user_id))

repo_connections (id pk, project_id fk, provider text,        -- 'github' | 'gitlab' | 'generic-git'
           url, default_branch, credential_secret_ref fk secrets null, status)

project_resource_grants (id pk, project_id fk,
           resource_type text check in ('skill','mcp_server','model','template','faber'),
           resource_id uuid,
           config_override jsonb null,                        -- e.g. MCP env overrides
           granted_by fk, created_at,
           unique (project_id, resource_type, resource_id))

project_quotas (id pk, project_id fk unique,
           period text not null default 'monthly',
           token_limit bigint null, cost_limit_usd numeric null,
           hard_stop boolean not null default true,
           current_period_start date)
```

### Scenario layer

```sql
scenarios (id pk, org_id fk null,                             -- null = builtin
           slug unique, name_i18n jsonb, description_i18n jsonb,
           icon, sort_order, enabled boolean)

task_types (id pk, scenario_id fk, slug,
           name_i18n jsonb, description_i18n jsonb,
           template_id fk orchestration_templates,
           default_faber_id fk fabri,
           enabled boolean, sort_order,
           unique (scenario_id, slug))
```

### Resource layer

All versioned resources follow one pattern: a **head** row (identity, latest pointers) + **immutable version** rows.

```sql
fabri     (id pk, org_id fk, slug unique,
           name_i18n jsonb, persona_i18n jsonb,               -- user-facing persona description
           system_prompt text,                                -- injected as executor systemPrompt
           avatar, default_model_role_policy jsonb, status)

orchestration_templates (id pk, org_id fk, slug unique, scenario_id fk,
           name_i18n jsonb, latest_published_version_id fk null, created_by fk)

template_versions (id pk, template_id fk, version int,
           status text check in ('draft','published','deprecated'),
           source_yaml text,                                  -- what humans author/review
           compiled jsonb,                                    -- what the engine executes
           checksum text,                                     -- guards builtin re-seeding
           created_by fk, published_at,
           unique (template_id, version))

skills    (id pk, org_id fk, slug unique, name_i18n jsonb, description_i18n jsonb,
           source text check in ('builtin','git','upload'), latest_version_id fk null)

skill_versions (id pk, skill_id fk, version text,             -- semver string
           content_ref text,                                  -- storage path to skill bundle
           manifest jsonb, status, unique (skill_id, version))

mcp_servers (id pk, org_id fk, slug unique, name_i18n jsonb,
           transport text check in ('stdio','http','sse'),
           config jsonb,                                      -- {command,args,env} or {url,headers}
           auth_secret_ref fk secrets null,
           config_revision int not null default 1,            -- bumped on config change; runs record it
           status)

models    (id pk, org_id fk, provider text,                   -- 'anthropic' | ...
           provider_model_id text,                            -- e.g. 'claude-sonnet-5'
           display_name,
           tier text check in ('strong','balanced','fast'),
           capabilities jsonb, context_window int,
           input_cost_per_mtok numeric, output_cost_per_mtok numeric, status)
```

### Execution

```sql
tasks     (id pk, org_id fk, project_id fk, task_type_id fk,
           title, params jsonb,                               -- validated against template inputs
           latest_run_id fk null, created_by fk, created_at)

runs      (id pk, task_id fk,
           project_id fk,                                     -- denormalized for quota/usage queries
           number int, unique (task_id, number),              -- run #1, #2 (retries)
           status text check in ('queued','running','waiting_approval',
                                 'succeeded','failed','cancelled','timed_out'),
           template_version_id fk,                            -- pinned
           faber_id fk, executor_id text,                     -- 'claude-agent-sdk'
           params_snapshot jsonb,                             -- immutable copy at submit
           model_resolution jsonb,                            -- role → concrete model, frozen at start
           budget jsonb, usage_totals jsonb,
           workspace_ref text, error jsonb,
           cancel_requested boolean not null default false,
           queued_at, started_at, finished_at, created_by fk)

run_steps (id pk, run_id fk, phase_id text, step_id text,
           attempt int not null default 1, seq int,
           status text check in ('pending','running','waiting_approval',
                                 'succeeded','failed','skipped','cancelled'),
           agent_ref text, model_id fk null,
           executor_session_id text null,                     -- engine resume handle
           usage jsonb, error jsonb, started_at, finished_at,
           unique (run_id, phase_id, step_id, attempt))

run_events (id bigserial pk, run_id fk, step_id fk null,
           seq int not null,                                  -- per-run monotonic; SSE Last-Event-ID
           type text, payload jsonb, created_at,
           index (run_id, seq))

approvals (id pk, run_id fk, step_id fk null, checkpoint_id text,
           status text check in ('pending','approved','rejected','expired'),
           payload jsonb,                                     -- artifact keys presented to approver
           requested_at, decided_by fk null, decided_at, comment)

artifacts (id pk, run_id fk, step_id fk null,
           artifact_key text,                                 -- from template output contract
           kind text check in ('file','patch','markdown','json','link'),
           name, mime, size,
           storage_ref text null, inline jsonb null,          -- small artifacts inline, big → storage
           created_at)

token_usage (id pk, org_id fk, project_id fk, run_id fk, step_id fk null,
           attempt int not null default 1,                    -- keyed per attempt: no double-count on retry
           model_id fk,
           input_tokens bigint, output_tokens bigint,
           cache_read_tokens bigint, cache_write_tokens bigint,
           cost_usd numeric, occurred_at,
           index (project_id, occurred_at))

audit_logs (id pk, org_id fk, project_id fk null,
           actor_user_id fk null, actor_api_key_id fk null,
           action text,                                       -- 'project.member.add', 'template.publish', ...
           resource_type text, resource_id uuid,
           payload jsonb, ip inet, created_at)
```

## Design Notes

- **Why `run_events` + `run_steps` both**: events give a replayable, gap-free timeline (SSE resume via `Last-Event-ID` = per-run `seq`); steps give cheap queryability (current status, per-step usage) without scanning events. The engine writes the event first, then updates the projection.
- **Why `params_snapshot` on runs** when `tasks.params` exists: a retry may happen after the task type's template was republished with different inputs; the run must be self-contained and auditable.
- **Why `model_resolution` frozen at run start**: role→tier→model resolution depends on project grants, which can change mid-run; freezing makes runs reproducible and usage attribution unambiguous.
- **Why `token_usage.attempt`**: a retried step re-incurs cost; rows keyed by `(run_id, step_id, attempt)` let the budget meter sum persisted totals on resume without double-counting a partially-executed attempt (the attempt's rows are written incrementally and summed as-is — cost is real even when the attempt failed).
- **Why `mcp_servers.config_revision`**: MCP config is mutable head state (no full versioning in M1 — configs are small and secrets rotate); runs record the revision they resolved so audits can detect drift.
- **Storage**: artifacts ≤ 64 KB are stored `inline` (jsonb/text); larger ones go to a disk-backed store at `storage_ref` (a Docker volume path in M1; the indirection allows S3 later).

## Drizzle Package Layout

`packages/db/src/schema/` — one file per aggregate: `orgs.ts`, `auth.ts` (users/sessions/accounts + better-auth extensions), `invitations.ts`, `projects.ts`, `catalog.ts` (scenarios/task_types), `resources.ts` (fabri/skills/mcp/models), `templates.ts`, `runs.ts` (tasks/runs/steps/events/approvals/artifacts), `usage.ts`, `audit.ts`, `secrets.ts`. Generated SQL migrations are committed under `packages/db/drizzle/`. Seed data (`packages/db/src/seed/`) upserts the builtin org, scenarios, task types, fabri, models, and compiles+publishes builtin templates from `templates/` (checksum-guarded so re-seeding is idempotent).
