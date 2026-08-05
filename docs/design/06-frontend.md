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

- **Sidebar** (`components/shell/AppSidebar.tsx`, collapsible to an icon rail; renders as a sheet drawer on mobile): brand mark, then the **project context switcher** (command palette popover: search, archived badges, "New project" dialog), then grouped navigation — *Project* (Dashboard / Catalog / Tasks / Settings, role-gated), *Organization* (Approvals — the nav name kept for the generalized "waiting on you" checkpoint inbox — and Admin for org admins). While on org-level pages the project group stays visible, bound to the last-visited project (persisted as `agrippa.lastProject`). Collapse state persists via the `sidebar_state` cookie, which the SPA reads back into `SidebarProvider`'s `defaultOpen` (`lib/sidebar-state.ts` — upstream shadcn reads it server-side). Responsive visibility deliberately uses `max-*:hidden` variants instead of the canonical `hidden md:*` pattern: browser extensions that inject a global unlayered `.hidden` rule out-cascade every `@layer`ed Tailwind utility and would otherwise blank the desktop sidebar entirely.
- **Top bar** (`components/shell/Topbar.tsx`): sidebar trigger, **breadcrumbs** derived from route `staticData.crumb` (i18n keys, with `$project` / `$run` resolving to live names), and the **user menu** — avatar dropdown with language (en / zh-CN, persists to localStorage + `PATCH /me`) and theme (light / dark / system via `features/theme.tsx`) plus sign out.
- Mutation feedback is toast-based (sonner `Toaster` mounted in the shell); destructive actions confirm via `ConfirmDialog`.
- A router `onResolved` subscription clears a stale Radix body lock (`pointer-events: none` left behind when a navigation unmounts a modal layer mid-exit-animation) — guarded by `lib/body-lock.ts`: every body-locking vendored primitive (dialog, alert-dialog, sheet, dropdown-menu, select) marks its portal content with `data-locks-body`, and the lock is cleared only when no such element remains mounted. **Any new modal primitive must set `data-locks-body` on its content** — a role allowlist was tried twice and each missed role (menu, then listbox) reopened a click-through hole.

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

`GET /runs/:id` embeds a **viewer-scoped projection of the pinned template plan** (`template: { slug, version, phases[{id, name, stepIds, approval}], limits, modelRoles }` — structure and i18n names only, never step instructions or prompts), and `GET /runs/:id/steps` aggregates per-step token consumption from `token_usage` into each row's `usage`. On top of that, `useRunEvents(runId)` opens the SSE stream (`/runs/:id/events`, browser `EventSource` handles `Last-Event-ID` reconnection) and invalidates the run queries (debounced) as events arrive; the run also polls at 3–5 s while non-terminal as a fallback.

The page (`pages/RunDetailPage.tsx` composing `features/runs/*`):

- **RunTimeline** (`features/runs/RunTimeline.tsx`, the default tab) — the run's conversational spine, derived entirely from the replayed SSE stream (no extra transport): phase headers with loop-round chips ("Review & fix · Round 2/3"), streaming **agent turns** tagged with the slot's faber avatar and executor label (collapsing to a preview once done), tool-call strips, inline interaction cards, teammate **comments** interleaved by event order, system chips (workspace ready, branch created/pushed, auto-passed gates, loop exhaustion), and a **PR card** with the branch and an open button at the end. A comment composer is pinned under the timeline for members; comments arrive back through `comment.added` events, so every watcher sees them live.
- **CheckpointPanel** (`features/runs/CheckpointPanel.tsx`, rendered inline in the timeline while pending, and in the inbox) — kind-specific bodies: *approval* = present-artifact previews + comment + Approve / Request changes (loop checkpoints only, comment required) / Reject; *input* = **QuestionsForm** rendered from the agent's question snapshot (text/select/boolean widgets, one-click "use recommendation" per question, "accept all recommendations"); *review-gate* = **FindingsTable** with severity badges and file:line references, where checked findings go to the fix round and unchecked ones are explicitly accepted — the confirm dialog lists exactly what is being waived. Decided checkpoints render as summary chips with outcome, decider name, and time.
- **PhaseTimeline** (left rail) — steps grouped under the template's phases, loop phases repeated per round with round chips; each step with status icon, duration, token count, attempt count, and its agent-slot chip; planned checkpoints show their decision state.
- **UsageLimitsCard** — tokens vs. `maxTokens` and elapsed vs. `maxDurationMinutes` as progress meters (danger tint past 90%), plus per-phase caps.
- **RunMetaCard** — pinned `slug@vN`, executor, and the frozen model resolution (flat or slot-keyed: slot · role → provider model + tier). The page header additionally shows per-slot agent chips (faber avatar + name + executor label) and the platform work branch.
- **Activity tab** (`features/runs/RunActivityFeed.tsx`) — the raw event feed kept for debugging: tool calls (error-tinted), subagent spawns, workspace checkout, step transitions, checkpoint requests.
- **Artifact previews** (`components/artifacts/ArtifactPreview.tsx`) — markdown rendered inline (react-markdown + GFM, styled by the `.markdown-body` component layer), patches colorized by the hand-rolled `PatchView`, JSON pretty-printed, links clickable; anything over 256 KB (or of kind `file`) is download-only.
- **Follow-up steering** (ADR-0018) — on a finished run whose workspace is still held (`workspaceExpiresAt` in the future), the timeline's composer grows a second destination: **Continue** posts the same text to `/runs/:id/followup` instead of `/comments`, and the reader is taken to the run that will do the work (the same run, when the message was coalesced into one already queued). The text lands on the thread either way — the endpoint writes the comment itself — so the visible difference is only whether the agent is asked to act on it. A follow-up's header carries a "continues #N" chip back to its parent, resolved server-side so the page needs no second request. Cross-run timeline stitching is deliberately not attempted.
- Cancel while running; retry once terminal (members only) — a confirm dialog states that the new run re-executes from checkout under current project configuration and re-asks earlier checkpoints (ADR-0014); submit-shaped rejections (grants, credentials, quota) surface as a toast.

`useRunEvents` keeps one `EventSource` per run for the run's whole lifetime: the run status is read through a ref, not the effect deps, so status transitions don't tear down the stream (recreating it wiped accumulated activity mid-run); terminal `run.*` events still close it.

## Screens

1. **Project dashboard** — stat tiles (active runs, pending checkpoints with a link to the Approvals inbox, tokens used with a quota progress meter, totals), recent-tasks card, tokens-by-model panel.
2. **Scenario catalog** — scenario sections × task-type cards (localized names/descriptions, Faber avatar chips), searchable across both locales' text.
3. **Task submission** — auto-generated form (+ agent-slot pickers for v2 templates) beside a sticky summary card (Faber, pinned template version, usage limits) with the submit action; errors toast. Project admins get two more actions on the same filled-in form: **Run on a schedule** and **Trigger by webhook**, each opening a dialog that turns exactly these parameters into a standing order. Both live here rather than in settings precisely because a schedule or trigger has to carry the parameters a real submission would — and the trigger dialog is the only place its URL is ever displayed, so it stays open on success instead of navigating away.
4. **Run detail** — see "Live Run Detail" above.
5. **"Waiting on you" inbox** — `GET /checkpoints/pending`, grouped by project; rows carry a kind icon and label (Confirm / Answer questions / Review findings) plus the loop round, and expand into the shared CheckpointPanel for inline response (viewers get read-only rows); sidebar badge carries the live count.
6. **Resource admin** — per-resource pages (`pages/admin/`) with a shared dialog-form pattern: fabri / models / skills+versions / MCP servers, full create/edit, disable-without-delete, write-only masked secrets with an explicit clear affordance.
7. **Template editor** — monospace YAML textarea (CodeMirror deliberately out of scope for now), `validate` (dry-run compile with inline errors), rendered **form preview** from compiled inputs, version browser (open any version; edits fork into the next draft), client-side diff between any two versions (`diff` + the shared PatchView), publish and deprecate with confirmation.
8. **Project settings** — vertical section nav: General (rename/description + archive danger zone), members & roles, resource grants (the toggle matrix per resource type, with per-project model-provider credentials nested inside it rather than as a peer section), repos, notifications (outbound endpoints + the delivery log with retry), schedules (list/pause/delete cron schedules and see why one stopped — creation happens on the submit page), webhook triggers (the same, plus the received-payload inspector and failed-delivery replay), API keys (issue with scopes, revoke; the plaintext is shown once), quota; destructive actions confirm.
9. **Usage** — per-project page: total tokens vs. quota, remaining headroom, daily-token SVG bars, byModel/byTaskType proportion bars (all from `GET /projects/:id/usage`).
10. **Audit log** — org-admin page over `GET /audit-logs`: actor/action/resource rows with project + action filters and expandable payloads.
11. **Worker fleet** — org-admin page over `GET /fleet/workers` (ADR-0017): live/stale per container against the database clock, each with its executor advertisement, env-auth providers, readiness and build version; below it the remote runtime daemons — issue a token (plaintext shown once), see last-seen, revoke.

## i18n in the SPA

react-i18next; static import of both locales from `@agrippa/i18n` (two locales — no lazy-loading complexity). Locale switcher in the shell persists to localStorage and `PATCH /me`; switch is instant (no reload). DB-driven strings (scenario/task-type names, template labels) arrive as `{en, zh-CN}` objects and go through the shared `pickLocale` helper. See [07-i18n](07-i18n.md).
