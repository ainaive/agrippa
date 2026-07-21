# Administration

Two admin surfaces exist: **org administration** (the sidebar's *Admin* section, visible only to the org admin role) governs the shared registries; **project administration** (each project's *Settings* page, visible to project admins) governs one project.

## Org roles

Two org roles exist: **org admin** and **org member**. Org admins manage the registries below, invite new members, and can read the audit log; they get *no* implicit access inside projects — project membership is always explicit.

## Accounts & onboarding

Self-registration is **closed** — onboarding is invite-only, so the instance isn't open to arbitrary sign-ups.

- **First admin** — created out-of-band via the bootstrap script, not through the UI:
  ```sh
  AGRIPPA_BOOTSTRAP_EMAIL=you@example.com \
  AGRIPPA_BOOTSTRAP_PASSWORD='choose-a-strong-password' \
  bun --env-file=../../.env.local apps/api/src/cli/bootstrap-admin.ts
  ```
  It's idempotent on email, so re-running with the same address is a no-op. The password is hashed with the same routine the login flow uses, so the account signs in at the login page immediately.
- **Inviting members** — org admins open **Admin → Members**, enter an invitee's email, and generate a one-time invite link (valid 7 days). Share the link out-of-band (Agrippa has no email sender). The invitee opens it, sets their name and password, and is created as an **org member** — then signs in normally. Pending invitations show in the list and can be revoked before they're used. Each token is stored hashed, so a database leak alone can't redeem an invite.

## Registries (Admin section)

Each registry has its own page in the Admin sidebar section, with create and edit dialogs — resources are managed entirely from the UI.

**Models** — registrations of provider models: display name, provider model id, a **tier** (`strong` / `balanced` / `fast`), context window, and per-MTok pricing (used for cost accounting and budget enforcement). Templates request tiers, never concrete models, so upgrading the fleet is a registry edit plus project grants — no template changes. Models can be disabled without deleting them.

**Fabri** — the preset agents (persona + system prompt + avatar), editable in place. You can add your own alongside the three builtins. Names and personas require both English and Chinese.

**Skills** — packaged instruction sets agents load (Claude Code skill format). Builtin skills ship with the platform (`git-workflow`, `test-runner`); each skill has immutable semver versions (added via *New version*) and templates reference them as `slug@range` (e.g. `builtin/git-workflow@^1`).

**MCP servers** — Model Context Protocol integrations (e.g. GitHub). Register the transport (`stdio`/`http`/`sse`) and JSON config; the optional **auth token is write-only** — it's encrypted immediately and the UI only ever shows "auth configured". Leave the token field empty when editing to keep the stored token, or use the explicit remove switch to clear it. Config edits bump a revision number recorded by runs for auditability.

**Templates** — every orchestration template with its version history. Clicking one opens the **editor**: edit the YAML source, **Validate** (a dry-run compile listing every issue at once, plus a live preview of the submission form the inputs will generate), **Save draft**, then **Publish**. Published versions are immutable — the publish button moves the "latest" pointer that new submissions use, while running and historical runs keep their pinned versions. Builtin templates re-publish automatically when the platform ships changed sources.

## Project settings (Settings page, project admins)

- **General** — rename the project, edit its description, and (in the danger zone, behind a confirmation) **archive** it: the project disappears from switchers and stops accepting submissions, while historical runs and data are preserved.
- **Members** — add by email (the person must have an account), change roles, remove (with confirmation). A project always keeps at least one admin; the platform blocks demoting or removing the last one.
- **Resources** — the grant toggles per registry type. This is the gate: a template requirement that isn't granted here makes submission fail fast with a named error. **Optional** resources are also gated — an optional skill or MCP server (for example the GitHub server behind an "open a PR" step) is withheld from the run unless it's granted, never resolved with a shared credential. A step that explicitly requires that resource is then skipped; a step that merely could use it runs without it.
- **Repositories** — git remotes the project's runs may check out: URL, default branch, optional access token (write-only, encrypted; injected only during clone and scrubbed before agent code runs).
- **Quota** — monthly cost (USD) and/or token ceilings with a **hard stop** switch. Hard-stop quotas reject new submissions once exhausted and abort in-flight runs at the next step boundary; soft quotas are informational.

## Usage & audit

Each project's **Usage** page (sidebar) shows current-month spend against the quota, total tokens, a daily-spend chart, and breakdowns by model and by task type; the dashboard carries the headline numbers. The same data is available at `GET /api/v1/projects/:id/usage`.

Every mutation in the system — member changes, grants, template publishes, submissions, approvals, cancellations — writes an audit entry (actor, action, resource, payload, IP). Org admins browse them on the **Audit log** page in the Admin section: filter by project or action, and expand any row to see its payload. The same data is available at `GET /api/v1/audit-logs?projectId=&action=&limit=`.
