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
           name, key_hash, prefix unique,                     -- 'agr_' + short prefix; the indexed lookup that precedes
                                                               -- the constant-time hash compare (shared with agrd_/agrt_)
           scopes jsonb,                                      -- ["tasks:write","runs:read",...]
           created_by fk users, expires_at, revoked_at, last_used_at)

invitations (id pk, org_id fk, email,                         -- invite-only onboarding
           token_hash unique,                                -- sha256 of one-time token; plaintext never stored
           role text not null default 'org_member',           -- only org_member is granted via invite
           created_by fk users, expires_at,                   -- default +7d
           accepted_at null, accepted_user_id fk users null)  -- null = pending
           -- self-registration is closed (05); this is the only path a new member joins

secrets   (id pk, org_id fk, kind text,                       -- 'mcp_auth' | 'git_credential' | 'provider_api_key' | 'webhook_secret' | ...
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

repo_connections (id pk, project_id fk, provider text,        -- 'github' | 'gitlab' | 'gitcode' | 'generic-git'
           url, default_branch, credential_secret_ref fk secrets null, status)

provider_credentials (id pk, project_id fk, provider text,    -- PROVIDER_CATALOG id, e.g. 'dashscope'
           base_url null,                                     -- overrides the catalog's default endpoints
           secret_ref fk secrets not null,                    -- the API key, write-only via the API
           unique (project_id, provider))
           -- present → overrides worker-env auth for this provider (ADR-0013)

project_resource_grants (id pk, project_id fk,
           resource_type text check in ('skill','mcp_server','model','template','faber'),
           resource_id uuid,
           config_override jsonb null,                        -- e.g. MCP env overrides
           granted_by fk, created_at,
           unique (project_id, resource_type, resource_id))

project_quotas (id pk, project_id fk unique,
           period text not null default 'monthly',
           token_limit bigint null,
           hard_stop boolean not null default true,
           current_period_start date)

notification_endpoints (id pk, project_id fk cascade,
           kind text,                                          -- 'generic' | 'feishu' | 'dingtalk' (TS-only enum)
           name, url,                                          -- url is a capability URL for IM bots: admin-only reads, masked in responses
           secret_ref fk secrets null,                         -- signing secret; required for 'generic' (API-enforced)
           events jsonb default '[]',                          -- NotifiableEventType[]; empty = all
           locale text default 'zh-CN',                        -- the channel's rendering locale (design/07)
           enabled bool,
           activated_at tstz default now(),                    -- watermark: no event older than this is delivered;
                                                               -- PATCH resets it on re-enable and url/events changes
           created_by fk, created_at)

notification_deliveries (id pk, endpoint_id fk cascade, project_id fk cascade,
           run_id fk null, event_id fk run_events null,        -- both null only for test sends
           event_type text, status check in ('pending','succeeded','failed'),
           attempts int, payload jsonb,                        -- redacted rendered snapshot
           last_attempt_at, response_status, response_snippet, last_error, created_at,
           unique (endpoint_id, event_id) where event_id is not null)  -- delivery bookkeeping is idempotent

task_schedules (id pk, org_id fk, project_id fk cascade, task_type_id fk,
           name, params jsonb, agent_overrides jsonb,          -- exactly what a manual submission would carry
           cron text, timezone text default 'UTC',             -- 5-field cron; pg-boss owns the calendar and its DST edges
           concurrency_policy check in ('skip','queue','replace'),  -- what a firing does when the previous run is unfinished
           enabled bool, disabled_reason text,                 -- set by the platform for conditions that never self-heal
           last_error text, last_error_at tstz,                -- fixable failures: the schedule stays on and retries
           last_fired_at tstz, last_run_id fk runs null,       -- the concurrency check reads last_run_id
           created_by fk NOT NULL, created_at, updated_at)     -- authority anchor: re-checked at every firing, never frozen

trigger_endpoints (id pk, org_id fk, project_id fk cascade, task_type_id fk,
           name, params jsonb, agent_overrides jsonb,
           token_hash text, token_prefix text unique,          -- token travels in the URL path; prefix is the indexed lookup
           secret_ref fk secrets NOT NULL,                     -- required, unlike outbound: an unsigned inbound URL is an open
                                                               -- 'spend this project's tokens' endpoint for whoever sees it
           timezone text default 'UTC',                        -- resolves the same fire-time date tokens schedules use
           enabled bool, disabled_reason text,
           last_fired_at tstz, created_by fk NOT NULL, created_at, updated_at)

trigger_deliveries (id pk, endpoint_id fk cascade, project_id fk cascade,
           external_id text null,                              -- sender-supplied id; the idempotency key when offered
           status check in ('pending','succeeded','failed'), attempts int,
           payload jsonb,                                      -- the received body, stored for inspection, never interpolated
           task_id fk null, run_id fk null,                    -- set once the worker submits
           last_error text, last_attempt_at, created_at,
           unique (endpoint_id, external_id) where external_id is not null)  -- a sender's retry cannot become a second run
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
           rank integer not null default 100, status)
```

### Execution

```sql
tasks     (id pk, org_id fk, project_id fk, task_type_id fk,
           title, params jsonb,                               -- validated against template inputs
           agent_overrides jsonb,                             -- raw submit-time slot overrides (ADR-0014)
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
           usage_totals jsonb,
           workspace_ref text, error jsonb,
           cancel_requested boolean not null default false,
           origin_key text null, unique (origin_key) where not null,
                                                              -- one unattended FIRING: 'schedule:<job id>'
                                                              -- or 'trigger:<delivery id>'; NULL when a
                                                              -- human submitted (see docs/design/04)
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
           occurred_at,
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
- **Why `model_resolution` frozen at run start**: role→tier→model resolution depends on project grants, which can change mid-run; freezing makes runs reproducible and usage attribution unambiguous. The freeze is per **run**, never per task — a retry re-resolves against current configuration and freezes its own resolution (ADR-0014).
- **Why `token_usage.attempt`**: a retried step consumes tokens again; rows keyed by `(run_id, step_id, attempt)` let the usage meter sum persisted totals on resume without double-counting a partially-executed attempt (the attempt's rows are written incrementally and summed as-is — the tokens were really spent even when the attempt failed).
- **Why `mcp_servers.config_revision`**: MCP config is mutable head state (no full versioning in M1 — configs are small and secrets rotate); runs record the revision they resolved so audits can detect drift.
- **Storage**: text/JSON artifacts ≤ 64 KiB are stored `inline` (jsonb/text); larger ones — and `file`-kind (possibly binary) artifacts of **any** size — go to a disk-backed store at `storage_ref` (a Docker volume path in M1; the indirection allows S3 later). Either way a single artifact is capped at `AGRIPPA_MAX_ARTIFACT_BYTES` (25 MB default). Checkpoint-driving (interaction) artifacts get a raised inline allowance — `INTERACTION_ARTIFACT_MAX_BYTES`, 2 MiB, sized to dominate any schema-valid payload — because resume re-reads them from the row; an artifact that only exists on disk cannot drive its checkpoint. Patch artifacts have no such allowance: every row carries a store-time `sha256`, and at `git.push` a larger-than-inline patch is verified against that digest — never against the disk bytes, which live on an agent-writable volume (the digest is tamper-resistance within the deployment posture, not a boundary — see the sandboxing residual in [08](08-deployment.md)).

## Drizzle Package Layout

`packages/db/src/schema/` — one file per aggregate: `orgs.ts`, `auth.ts` (users/sessions/accounts + better-auth extensions), `invitations.ts`, `projects.ts`, `registry.ts` (scenarios/task_types/fabri/skills/mcp/models/templates), `runs.ts` (tasks/runs/steps/events/checkpoints/artifacts), `usage.ts`, `audit.ts`, `secrets.ts`, `api-keys.ts`, `notifications.ts` (endpoints + deliveries), `schedules.ts` (task_schedules), `triggers.ts` (endpoints + deliveries), `runtimes.ts`, `dispatches.ts`. Generated SQL migrations are committed under `packages/db/drizzle/`. Seed data (`packages/db/src/seed/`) upserts the builtin org, scenarios, task types, fabri, models, and compiles+publishes builtin templates from `templates/` (checksum-guarded so re-seeding is idempotent).
