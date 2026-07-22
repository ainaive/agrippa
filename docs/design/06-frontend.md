# 06 — Frontend Architecture

> Status: living document · Last updated: 2026-07-23

`apps/web`: Vite + React SPA. Routing: **TanStack Router** (code-first route tree in `src/router.tsx`, type-safe params). Data: **TanStack Query**. UI: **shadcn/ui** on Tailwind v4 (`@tailwindcss/vite` plugin + `@/` path alias; components vendored into `src/components/ui/`, exempted from strict lint via a scoped biome override and carrying a few deliberate theme divergences: quiet muted table headers with `tabular-nums` cells, eased sidebar/input transitions, `shadow-2xs` on cards and `shadow-lg` on dialogs). Visual identity: indigo/violet primary over cool-tinted neutrals, defined as OKLCH tokens in `src/index.css` (light + dark) — light mode uses the gray-canvas/white-card surface model (canvas 0.975, sidebar 0.962, cards white) for three-level depth — plus semantic `status-*` tokens for run/step states. **Chrome is neutral**: hover/selected/active surfaces are quiet grays; brand indigo appears only on the primary CTA, focus rings, links, progress, and the logo tile. Typography: Geist Variable + Geist Mono Variable on a **custom type ramp** (`--text-*` in `@theme`: xs 11px, sm 13px body, base 15px card/dialog titles, xl 18px page titles, 2xl 22px stat values; mobile inputs hard-code 16px for the iOS no-zoom rule), globally antialiased, primary-tinted selection, thin scrollbars. Shape: `--radius: 0.5rem` (8px controls, ~11px cards), rounded-rect badges. Icons: lucide-react.

Visual verification is not left to code review: `scripts/screenshot.ts` (dev tool, Playwright) boots the stack on a throwaway database with the fake executor, seeds fixture runs, and captures every page in light and dark, failing on any browser console error.

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

For agrippa/v2 templates the submit page adds an **AgentSlotPicker** (`components/submit/AgentSlotPicker.tsx`) below the form: one row per slot (Implementer / Reviewer …) with a faber picker (active fabri from the task-type detail) and an executor picker (the static `EXECUTOR_CATALOG` from `@agrippa/core` — the SPA imports it directly, no endpoint needed), prefilled with the template defaults. Only overridable slots are editable, and only values that differ from the default are sent (`agents` on the submit body). The card is hidden entirely when nothing is overridable (all v1 templates).

## Live Run Detail

`GET /runs/:id` embeds a **viewer-scoped projection of the pinned template plan** (`template: { slug, version, phases[{id, name, stepIds, approval}], budgets, modelRoles }` — structure and i18n names only, never step instructions or prompts), and `GET /runs/:id/steps` aggregates per-step spend from `token_usage` into each row's `usage`. On top of that, `useRunEvents(runId)` opens the SSE stream (`/runs/:id/events`, browser `EventSource` handles `Last-Event-ID` reconnection) and invalidates the run queries (debounced) as events arrive; the run also polls at 3–5 s while non-terminal as a fallback.

The page (`pages/RunDetailPage.tsx` composing `features/runs/*`):

- **RunTimeline** (`features/runs/RunTimeline.tsx`, the default tab) — the run's conversational spine, derived entirely from the replayed SSE stream (no extra transport): phase headers with loop-round chips ("Review & fix · Round 2/3"), streaming **agent turns** tagged with the slot's faber avatar and executor label (collapsing to a preview once done), tool-call strips, inline interaction cards, teammate **comments** interleaved by event order, system chips (workspace ready, branch created/pushed, auto-passed gates, loop exhaustion), and a **PR card** with the branch and an open button at the end. A comment composer is pinned under the timeline for members; comments arrive back through `comment.added` events, so every watcher sees them live.
- **CheckpointPanel** (`features/runs/CheckpointPanel.tsx`, rendered inline in the timeline while pending, and in the inbox) — kind-specific bodies: *approval* = present-artifact previews + comment + Approve / Request changes (loop checkpoints only, comment required) / Reject; *input* = **QuestionsForm** rendered from the agent's question snapshot (text/select/boolean widgets, one-click "use recommendation" per question, "accept all recommendations"); *review-gate* = **FindingsTable** with severity badges and file:line references, where checked findings go to the fix round and unchecked ones are explicitly accepted — the confirm dialog lists exactly what is being waived. Decided checkpoints render as summary chips with outcome, decider name, and time.
- **PhaseTimeline** (left rail) — steps grouped under the template's phases, loop phases repeated per round with round chips; each step with status icon, duration, cost, attempt count, and its agent-slot chip; planned checkpoints show their decision state.
- **BudgetMeter** — cost vs. `maxCostUsd` and elapsed vs. `maxDurationMinutes` as progress meters (danger tint past 90%), plus per-phase caps.
- **RunMetaCard** — pinned `slug@vN`, executor, and the frozen model resolution (flat or slot-keyed: slot · role → provider model + tier). The page header additionally shows per-slot agent chips (faber avatar + name + executor label) and the platform work branch.
- **Activity tab** (`features/runs/RunActivityFeed.tsx`) — the raw event feed kept for debugging: tool calls (error-tinted), subagent spawns, workspace checkout, step transitions, checkpoint requests.
- **Artifact previews** (`components/artifacts/ArtifactPreview.tsx`) — markdown rendered inline (react-markdown + GFM, styled by the `.markdown-body` component layer), patches colorized by the hand-rolled `PatchView`, JSON pretty-printed, links clickable; anything over 256 KB (or of kind `file`) is download-only.
- Cancel while running; retry (navigates to the new pinned run) once terminal.

`useRunEvents` keeps one `EventSource` per run for the run's whole lifetime: the run status is read through a ref, not the effect deps, so status transitions don't tear down the stream (recreating it wiped accumulated activity mid-run); terminal `run.*` events still close it.

## Screens

1. **Project dashboard** — stat tiles (active runs, pending approvals with an inbox link, spend with a quota progress meter, totals), recent-tasks card, spend-by-model panel.
2. **Scenario catalog** — scenario sections × task-type cards (localized names/descriptions, Faber avatar chips), searchable across both locales' text.
3. **Task submission** — auto-generated form (+ agent-slot pickers for v2 templates) beside a sticky summary card (Faber, pinned template version, budgets) with the submit action; errors toast.
4. **Run detail** — see "Live Run Detail" above.
5. **"Waiting on you" inbox** — `GET /checkpoints/pending`, grouped by project; rows carry a kind icon and label (Confirm / Answer questions / Review findings) plus the loop round, and expand into the shared CheckpointPanel for inline response (viewers get read-only rows); sidebar badge carries the live count.
6. **Resource admin** — per-resource pages (`pages/admin/`) with a shared dialog-form pattern: fabri / models / skills+versions / MCP servers, full create/edit, disable-without-delete, write-only masked secrets with an explicit clear affordance.
7. **Template editor** — monospace YAML textarea (CodeMirror deliberately out of scope for now), `validate` (dry-run compile with inline errors), rendered **form preview** from compiled inputs, version browser (open any version; edits fork into the next draft), client-side diff between any two versions (`diff` + the shared PatchView), publish and deprecate with confirmation.
8. **Project settings** — vertical section nav: General (rename/description + archive danger zone), members & roles, resource grants (toggle matrix per resource type), repos, quota; destructive actions confirm.
9. **Usage** — per-project page: spend vs. quota, total tokens, daily-spend SVG bars, byModel/byTaskType proportion bars (all from `GET /projects/:id/usage`).
10. **Audit log** — org-admin page over `GET /audit-logs`: actor/action/resource rows with project + action filters and expandable payloads.

## i18n in the SPA

react-i18next; static import of both locales from `@agrippa/i18n` (two locales — no lazy-loading complexity). Locale switcher in the shell persists to localStorage and `PATCH /me`; switch is instant (no reload). DB-driven strings (scenario/task-type names, template labels) arrive as `{en, zh-CN}` objects and go through the shared `pickLocale` helper. See [07-i18n](07-i18n.md).
