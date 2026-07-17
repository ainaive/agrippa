# ADR-0009: Deep Modules for Execution Isolation, Authorized Resources, and the Run Lifecycle

- Status: accepted · Date: 2026-07-17

## Context

An M1 code review found that several documented invariants were declared but not enforced, and that the enforcement logic that did exist was scattered across the API, engine, worker, and SDK adapter — so it was easy for one caller to skip a check. The critical cases:

- **Execution isolation** leaked into the SDK adapter: only three write tools were path-checked (Bash and everything else bypassed containment), the check used a prefix test that admitted sibling paths, `workspace.access: readOnly` was inert, the checked-out repository's `.claude` settings/hooks were honored, and the agent subprocess inherited the worker's full environment including the master secret key.
- **Resource authorization** was split: submission validated required grants, but the worker independently re-resolved skills/MCP from the mutable global registry — and optional resources skipped the grant check entirely, so an ungranted project could still be handed the platform's global credential. `repoRef` was only shape-validated and the worker loaded the connection by raw id, a cross-tenant IDOR.
- **Run lifecycle** mutations (status transitions, event-seq allocation, approval decisions, queue handoff) were non-atomic and duplicated between the API, engine, and worker, so concurrent writers could clobber each other or strand a run.

## Decision

Concentrate each concern behind one deep module whose interface is the test surface, rather than re-litigating the accepted ADRs (Bun, Drizzle, pg-boss, SSE):

1. **Execution-isolation seam** (`packages/executor-core/isolation.ts`) — `evaluateToolCall`, `isWithin`, and `buildScrubbedEnv` are pure and back both the SDK adapter and its tests. The adapter must route every tool decision and the subprocess environment through it, and layers OS-level controls on top (the SDK `sandbox`, a non-root worker, repo-config stripping at checkout).
2. **Authorized run-manifest** — `resolve.authorizeResources` pins the exact skills/MCP a run may use (required grants enforced, optional included only when granted) into `runs.resource_manifest` at submit; `verifyRepoRefs` enforces repo-connection ownership. The engine resolves resources only from the manifest, never the global registry, and the worker loads repo connections scoped to the run's project.
3. **Run-lifecycle module** (`packages/orchestration/src/engine/run-lifecycle.ts`) — `transitionRun` (compare-and-swap on the expected status), `appendRunEvent` (database-allocated per-run seq), and `decideApproval` (CAS on `pending`) own every lifecycle mutation for both the API and the worker.

## Alternatives considered

- **Minimal in-place patches** (add a WHERE clause here, an `if` there): faster, but leaves the cross-cutting sprawl the review flagged, so the next caller can skip the check again. Rejected in favor of one enforceable seam per concern.
- **Grant-aware resolution at the worker instead of a pinned manifest**: closes the token leak but still trusts the mutable global registry mid-run; the manifest pins the decision at submit, which is both safer and a smaller worker interface.

## Consequences

- The static isolation layer contains file writes and refuses shell in read-only workspaces, but it cannot bound arbitrary writes a shell command makes in a read-write workspace — that remains the OS sandbox / non-root worker / container's job, and full container-level isolation is still future work.
- Adds a `runs.resource_manifest` column (migration 0002); retries and resumes carry the pinned manifest, so authorization can't drift after submit.
- Grants now genuinely gate optional resources: an optional skill/MCP with no project grant is treated as unavailable, so its dependent step is skipped rather than silently privileged.
