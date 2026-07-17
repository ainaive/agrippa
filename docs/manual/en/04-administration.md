# Administration

Two admin surfaces exist: **org administration** (the sidebar's *Admin* section, visible only to the org admin role) governs the shared registries; **project administration** (each project's *Settings* page, visible to project admins) governs one project.

## Org roles

The first account ever created is the **org admin**; everyone else signs up as **org member**. Org admins manage the registries below and can read the audit log; they get *no* implicit access inside projects — project membership is always explicit.

## Registries (Admin section)

Each registry has its own page in the Admin sidebar section, with create and edit dialogs — resources are managed entirely from the UI.

**Models** — registrations of provider models: display name, provider model id, a **tier** (`strong` / `balanced` / `fast`), context window, and per-MTok pricing (used for cost accounting and budget enforcement). Templates request tiers, never concrete models, so upgrading the fleet is a registry edit plus project grants — no template changes. Models can be disabled without deleting them.

**Fabri** — the preset agents (persona + system prompt + avatar), editable in place. You can add your own alongside the three builtins. Names and personas require both English and Chinese.

**Skills** — packaged instruction sets agents load (Claude Code skill format). Builtin skills ship with the platform (`git-workflow`, `test-runner`); each skill has immutable semver versions (added via *New version*) and templates reference them as `slug@range` (e.g. `builtin/git-workflow@^1`).

**MCP servers** — Model Context Protocol integrations (e.g. GitHub). Register the transport (`stdio`/`http`/`sse`) and JSON config; the optional **auth token is write-only** — it's encrypted immediately and the UI only ever shows "auth configured". Leave the token field empty when editing to keep the stored token, or use the explicit remove switch to clear it. Config edits bump a revision number recorded by runs for auditability.

**Templates** — every orchestration template with its version history. Clicking one opens the **editor**: edit the YAML source, **Validate** (a dry-run compile listing every issue at once, plus a live preview of the submission form the inputs will generate), **Save draft**, then **Publish**. Published versions are immutable — the publish button moves the "latest" pointer that new submissions use, while running and historical runs keep their pinned versions. Builtin templates re-publish automatically when the platform ships changed sources.

## Project settings (Settings tab, project admins)

- **Members** — add by email (the person must have an account), change roles, remove. A project always keeps at least one admin; the platform blocks demoting or removing the last one.
- **Resources** — the grant toggles per registry type. This is the gate: a template requirement that isn't granted here makes submission fail fast with a named error. **Optional** resources are also gated — an optional skill or MCP server (for example the GitHub server behind an "open a PR" step) is withheld from the run unless it's granted, never resolved with a shared credential. A step that explicitly requires that resource is then skipped; a step that merely could use it runs without it.
- **Repositories** — git remotes the project's runs may check out: URL, default branch, optional access token (write-only, encrypted; injected only during clone and scrubbed before agent code runs).
- **Quota** — monthly cost (USD) and/or token ceilings with a **hard stop** switch. Hard-stop quotas reject new submissions once exhausted and abort in-flight runs at the next step boundary; soft quotas are informational.

## Usage & audit

Each project's dashboard shows current-month spend (with a per-model breakdown) against the quota; the same data is available at `GET /api/v1/projects/:id/usage`.

Every mutation in the system — member changes, grants, template publishes, submissions, approvals, cancellations — writes an audit entry (actor, action, resource, payload, IP). Org admins browse them on the **Audit log** page in the Admin section: filter by project or action, and expand any row to see its payload. The same data is available at `GET /api/v1/audit-logs?projectId=&action=&limit=`.
