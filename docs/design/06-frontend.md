# 06 — Frontend Architecture

> Status: living document · Last updated: 2026-07-17

`apps/web`: Vite + React SPA. Routing: **TanStack Router** (code-first route tree in `src/router.tsx`, type-safe params). Data: **TanStack Query**. UI: **shadcn/ui** on Tailwind v4 (`@tailwindcss/vite` plugin + `@/` path alias; components vendored into `src/components/ui/`, exempted from strict lint via a scoped biome override). Visual identity: indigo/violet primary over cool-tinted neutrals, defined as OKLCH tokens in `src/index.css` (light + dark), plus semantic `status-*` tokens for run/step states. Icons: lucide-react.

## Structure

```
apps/web/src/
├── router.tsx              # code-first route tree; staticData.crumb drives breadcrumbs
├── pages/                  # one component per route
│   ├── Shell.tsx           # auth gate + MeContext + sidebar/topbar chrome
│   ├── ProjectLayout.tsx   # membership guard, persists last-visited project
│   ├── admin/AdminLayout.tsx  # org_admin guard (redirect + toast)
│   └── …Page.tsx           # Dashboard, Catalog, SubmitTask, Tasks, RunDetail, …
├── components/
│   ├── shell/              # AppSidebar, ProjectSwitcher, Topbar, UserMenu, nav model
│   ├── ui/                 # vendored shadcn components
│   └── …                   # PageHeader, EmptyState, ConfirmDialog, skeletons,
│                           #   LocalizedTextFields, RunStatusBadge
├── features/               # me (session), theme, lastProject, useRunEvents (SSE)
└── lib/                    # api client, i18n init, shared API types, format helpers
```

## App shell (GitLab-style)

The chrome is a persistent **left sidebar** + slim **top bar** (`SidebarProvider` → `AppSidebar` + `SidebarInset`):

- **Sidebar** (`components/shell/AppSidebar.tsx`, collapsible to an icon rail; renders as a sheet drawer on mobile): brand mark, then the **project context switcher** (command palette popover: search, archived badges, "New project" dialog), then grouped navigation — *Project* (Dashboard / Catalog / Tasks / Settings, role-gated), *Organization* (Approvals, Admin for org admins). While on org-level pages the project group stays visible, bound to the last-visited project (persisted as `agrippa.lastProject`).
- **Top bar** (`components/shell/Topbar.tsx`): sidebar trigger, **breadcrumbs** derived from route `staticData.crumb` (i18n keys, with `$project` / `$run` resolving to live names), and the **user menu** — avatar dropdown with language (en / zh-CN, persists to localStorage + `PATCH /me`) and theme (light / dark / system via `features/theme.tsx`) plus sign out.
- Mutation feedback is toast-based (sonner `Toaster` mounted in the shell); destructive actions confirm via `ConfirmDialog`.

## The Auto-Generated Task Form (core contract)

`GET /task-types/:id` returns the compiled template `inputs` array — a self-describing schema. A single renderer turns it into a working, localized, validated form:

```
<TaskParamsForm schema={inputs} onSubmit={...} />
```

- Widget mapping: `string`→Input, `text`→Textarea, `number`→NumberInput, `boolean`→Switch, `select`→Select, `repoRef`→picker over the project's repo connections, `docRef`→document picker.
- Labels/help from the schema's `{en, zh-CN}` objects via `pickLocale`.
- A zod validator is derived client-side from the same schema; the API re-validates server-side from the identical compiled schema — the two can't drift.

This is the contract that makes "add a task type without frontend work" true: publishing a new template version with different inputs changes the form with zero SPA changes.

## Live Run Detail

`useRunEvents(runId)` opens the SSE stream (`/runs/:id/events`, browser `EventSource` handles `Last-Event-ID` reconnection) and patches the TanStack Query cache:

- step/phase events → update the run-steps query → **phase/step timeline** re-renders (pending/running/succeeded/failed/skipped badges, per-step duration & cost).
- `message.delta` → append to the streaming output pane for the active step.
- `usage` → live cost/token meter vs. budget.
- `artifact` → artifacts tab (markdown rendered inline; patch viewer with syntax highlighting; download for files).
- `approval.required` → approval banner: presents the `present:` artifacts inline with Approve/Reject + comment.

Terminal states close the stream and invalidate queries once — no polling.

## Screens

1. **Project dashboard** — recent runs (status, cost), usage vs. quota gauge, pending approvals, quick-submit shortcuts.
2. **Scenario catalog** — 3 scenario sections × task-type cards (localized names/descriptions, default Faber avatar).
3. **Task submission** — auto-generated form + budget preview (template `budgets` + current quota headroom) + submit → redirects to run detail.
4. **Run detail** — as above; also params snapshot, pinned template version, model resolution, retry button.
5. **Approvals inbox** — pending approvals across the user's projects; decide inline.
6. **Resource admin** — registries for fabri / skills / MCP servers / models: list, status, versions, create/edit; secrets write-only masked.
7. **Template editor** — CodeMirror YAML editor, `validate` (dry-run compile with inline errors), rendered **form preview** from compiled inputs, version list, publish (with diff vs. previous version from `source_yaml`).
8. **Project settings** — members & roles, resource grants (checkbox matrix per resource type), repos, quota.
9. **Usage & audit** — token/cost charts (per model / task type / member / period), audit log table with filters.

## i18n in the SPA

react-i18next; static import of both locales from `@agrippa/i18n` (two locales — no lazy-loading complexity). Locale switcher in the shell persists to localStorage and `PATCH /me`; switch is instant (no reload). DB-driven strings (scenario/task-type names, template labels) arrive as `{en, zh-CN}` objects and go through the shared `pickLocale` helper. See [07-i18n](07-i18n.md).
