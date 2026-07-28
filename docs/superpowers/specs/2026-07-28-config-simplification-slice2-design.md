# Config Simplification — Slice 2: Data-Driven Provider Catalog & Merged Models/Providers UI

Date: 2026-07-28
Status: Approved (scope + key decisions confirmed)
Branch: `feat/config-simplification` (continues from slice 1)

## Problem

Slice 1 (default grants + provider auto-grant + preflight) eased onboarding but
left a deeper gap: a member wanting a **custom** model provider (e.g. DeepSeek,
a self-hosted gateway, any Anthropic/OpenAI-compatible endpoint) cannot use it
end-to-end. Three layers block it:

1. **Resolution gate.** `EXECUTOR_CATALOG["claude-agent-sdk"].providers = ["anthropic","dashscope"]` is a hardcoded list (`executors.ts:28`). `resolveSlotModels` only iterates that list, so a model registered under `deepseek` is never a candidate → submit fails `model_unresolvable` before runtime. **This is the real blocker.**
2. **Auth policy.** `providerAuthPolicy(unknown) = "env"` — resolution does not require a credential for an unknown provider, yet an unknown provider has no default endpoint, so a keyless resolution would misfire at runtime.
3. **Frontend.** The Providers dropdown is hardcoded to the 3 catalog providers (`SettingsPage.tsx:461`); the Grants (model toggles) and Providers (keys) tabs are separate, so there's no single place to add a custom provider's models + key.

The runtime (`effectiveBaseUrl`, `isolation.ts:271`) actually works for an
unknown provider that has a credential with a `baseUrl` — so the fix is to
remove the pre-runtime gates and let the data flow through.

## Scope (this slice)

- **Data-driven provider catalog.** Move the resolvable provider catalog from a code constant to a DB table; builtins seeded, customs org_admin-created.
- **Protocol-driven resolution.** Replace hardcoded executor `providers` lists with "providers that serve this executor's wire protocol" (derived from the catalog), so a custom Anthropic-compatible provider is resolvable by the claude executor.
- **Merged UI.** At the org level, register providers + models in one admin page. At the project level, grant models + configure provider credentials in one "Resources" tab, grouped by provider.

## Key decisions (confirmed)

- "Merge" = unify provider config + model config in one place at each layer — **not** delete provider config.
- Both layers merged (org-level Admin + project-level Settings).
- Only `org_admin` can create a custom provider catalog entry (id + default endpoint + host allowlist + auth policy).
- Host allowlist retained: a custom provider's `base_url_hosts` are pinned by org_admin; project-level `baseUrl` overrides stay within the pinned family. `validateProviderBaseUrl` (https, public DNS, no embedded creds, host pin) unchanged.

## Design

### Data model

New `provider_catalog` table:

```
id uuid PK
org_id uuid NULL        -- NULL = builtin/deployment-level
provider_id text        -- "anthropic" | "dashscope" | "deepseek" …  (globally unique)
label text
base_urls jsonb         -- { anthropic?: string, openai?: string }
auth text               -- "project" | "env"
base_url_hosts jsonb NULL  -- string[] | null (host allowlist pins)
status text             -- "active" | "disabled"
created_at timestamptz default now()
UNIQUE(provider_id)      -- global; builtins (org_id NULL) + customs
```

`models.provider` and `provider_credentials.provider` stay free text (they
already match `provider_id`). The seed writes the 3 builtins as `org_id=NULL`
rows; customs are org-scoped (default org for now).

### Core (`@agrippa/core`)

- Keep `PROVIDER_CATALOG` (code) as the **builtin baseline + the validation host logic**; it seeds the DB and is the fallback when the DB catalog isn't loaded (e.g. unit tests).
- Add a `ProviderCatalog = Record<string, ProviderCatalogEntry>` type + `buildProviderCatalog(builtin, dbRows)` that merges builtin + org rows (org rows win on id collision? — no: builtins are non-deletable; customs use distinct ids).
- Refactor `providerAuthPolicy`, `providerDefaultBaseUrl`, `providerServesProtocol` to accept a catalog param (pure, no DB) — keep no-arg builtin overloads for tests/back-compat where convenient, but resolution passes the merged catalog.
- `EXECUTOR_CATALOG` gains `protocol: WireProtocol` per executor (claude→`anthropic`, codex→`openai`, fake keeps `providers:"*"`). The executor's resolvable provider set is derived: `providers = "*" ` stays for fake/uncataloged; for cataloged executors it becomes "all catalog entries that serve this executor's protocol" — computed at resolution time from the merged catalog, not a static list.

### Resolution (`@agrippa/orchestration/src/resolve.ts`)

`resolveAgentBindings`:
- Load the merged provider catalog once (builtins ∪ DB org rows).
- For each slot, instead of `entry?.providers ?? "*"`, derive candidate providers = catalog entries that serve the slot executor's `protocol` (and are active). For `fake`/uncataloged executors, keep `"*"`.
- A custom provider's auth policy comes from its catalog entry (`project` for customs without an env fallback → credential required). Single-provider resolution + credential gating logic unchanged.
- `providerAuthPolicy`/`providerServesProtocol`/`providerDefaultBaseUrl` called with the merged catalog.

`assertResolutionCredentialed` (retry gate) and the preflight (slice 1) inherit
the new behavior automatically (they call the same functions).

### Runtime (`@agrippa/executor-core/src/isolation.ts`)

`effectiveBaseUrl` and friends load the merged catalog (builtins ∪ DB) so a
custom provider's declared `base_urls` + `base_url_hosts` apply at runtime.
`validateProviderBaseUrl` consults the catalog entry's `base_url_hosts`.

### API

- New org_admin CRUD: `GET/POST/PATCH/DELETE /provider-catalog` (org_admin). POST validates `provider_id` (lowercase-hyphen regex, unique), `base_urls` URLs (host-pinned via the catalog's own `base_url_hosts`), `auth` enum. Builtins (org_id NULL) are non-deletable (4040/409).
- `POST /projects/:id/providers` validates the `provider` exists in the org's active catalog (builtin or custom) — closes the free-text gap so a key can't be set for a typo'd provider.
- Model registration (`POST /models`) validates `provider` is an active catalog entry too.
- Audit every mutation.

### Frontend

**Org level (Admin → "Models & Providers")**: merge `ModelsPage` with a new
provider-catalog section. org_admin creates a custom provider (id, label,
per-protocol base URLs, host allowlist, auth policy) and registers models;
the list groups models under their provider, showing each provider's
endpoint/auth + a "register model" affordance.

**Project level (Settings → "Resources", replacing Grants + Providers tabs)**:
grouped by provider. Each provider group shows:
- the credential state (key set / env-auth / missing) + an inline key input & rotate;
- that provider's model grant toggles.
"+ Add provider" picks from the org's active catalog; a provider needing a key
shows the key input inline. The `?tab=` deep-link from the preflight (slice 1)
points at `resources` instead of `grants`/`providers`.

### Security invariants preserved

- Worker sends the decrypted key only to host-pinned https endpoints (`validateProviderBaseUrl` unchanged; custom hosts pinned at the catalog level by org_admin).
- Project boundary, submit-time manifest pinning, credential encryption — untouched.
- `resolveSlotModels` single-provider + credential-gating rules unchanged; only the candidate set widens (protocol-derived).

## Testing

- DB: migration applies; seed writes 3 builtins.
- Core: `buildProviderCatalog` merges; `providerServesProtocol` over the merged catalog (custom anthropic-compatible → claude serves it; openai-only custom → claude does not).
- Resolution: a project with a custom provider catalog entry + a model registered under it + a credential with a baseUrl resolves and submits (202); without the credential → `provider_credential_required`; model under an openai-only custom provider + claude executor → `model_unresolvable`.
- API: org_admin CRUD; member forbidden; builtin non-deletable; provider_id regex + unique; `POST /projects/:id/providers` + `POST /models` reject unknown providers.
- Engine compliance suite (`engine.integration.test.ts`): update hardcoded provider lists to the protocol-derived model; semantics preserved.
- Preflight (slice 1): a custom-provider project reports `provider_credential` fail without a key, ready with one.

## Files touched (planned)

- `packages/db/src/schema/registry.ts` (or a new `provider-catalog.ts`) — new table
- `packages/db/drizzle/0008_provider_catalog.sql` — generated migration
- `packages/db/src/seed/index.ts` — seed builtins
- `packages/core/src/providers.ts`, `executors.ts` — catalog merge, executor `protocol`
- `packages/orchestration/src/resolve.ts` — protocol-driven candidates
- `packages/executor-core/src/isolation.ts` — merged catalog at runtime
- `apps/api/src/routes/` — provider-catalog CRUD; validate provider refs
- `apps/web/src/pages/admin/ModelsPage.tsx` — merged org page
- `apps/web/src/pages/SettingsPage.tsx` — merged project Resources tab
- `packages/i18n/locales/{en,zh-CN}` — new copy
- docs + CHANGELOG
