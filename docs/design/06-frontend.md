# 06 — Frontend Architecture

> Status: draft for review · Last updated: 2026-07-17

`apps/web`: Vite + React SPA. Routing: **TanStack Router** (file-based, type-safe params/search). Data: **TanStack Query**. UI: **shadcn/ui** on Tailwind v4 (officially supported on plain Vite: `@tailwindcss/vite` plugin + `@/` path alias; components vendored into `src/components/ui/`). Forms: **react-hook-form** + zod resolvers, schemas from `@agrippa/core`.

## Structure

```
apps/web/src/
├── routes/                 # TanStack Router file-based routes
│   ├── __root.tsx          # shell: nav, project switcher, locale switcher, approvals badge
│   ├── index.tsx           # → redirect to last project dashboard
│   ├── projects.$projectId/
│   │   ├── index.tsx       # project dashboard
│   │   ├── catalog.tsx     # scenario catalog
│   │   ├── tasks.new.tsx   # submission form (?taskType=)
│   │   ├── tasks.index.tsx # task list
│   │   ├── runs.$runId.tsx # run detail (live)
│   │   └── settings.*.tsx  # members / grants / repos / quota
│   ├── approvals.tsx       # cross-project approvals inbox
│   ├── admin/              # resource layer (org_admin)
│   │   ├── fabri.tsx  skills.tsx  mcp-servers.tsx  models.tsx
│   │   └── templates.$templateId.tsx   # template editor
│   └── usage.tsx           # org/project usage & audit
├── features/               # per-domain components + hooks (projects/, runs/, resources/, ...)
├── components/ui/          # vendored shadcn components
└── lib/                    # api client, i18n init, query client, SSE hook
```

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
