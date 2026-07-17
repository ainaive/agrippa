# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately via
[GitHub Security Advisories](https://github.com/ainaive/agrippa/security/advisories/new)
— do not open a public issue. You should receive an acknowledgement within a
few days; please allow time for a fix before public disclosure.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x (M1) | ✅ |

## Security posture (M1)

What the platform does today:

- **Secrets at rest**: user-registered credentials (git tokens, MCP auth) are encrypted with AES-256-GCM under `AGRIPPA_SECRET_KEY` and are **write-only** through the API — responses expose only `hasAuth`/`hasCredential` booleans. Provider keys (`ANTHROPIC_API_KEY`) live only in process env, never in the database.
- **Authorization**: two-layer RBAC — org roles gate the resource layer, project roles (admin ⊃ member ⊃ viewer) gate everything project-scoped; org admins get **no** implicit project access. Every mutation writes an audit row (actor, action, resource, payload, IP).
- **Execution hygiene**: git credentials are injected only into the clone URL and scrubbed from the remote before any agent code runs; run workspaces are per-run throwaway directories; the Claude executor's tool policy denies file writes outside the run workspace; MCP secrets resolve lazily at spawn.
- **Quota/budget containment**: template budgets and hard-stop project quotas bound runaway spend at submit time, at every step boundary, and mid-step via usage events.

Known limitations — **assume a trusted single organization** (per `docs/design/03-executor-abstraction.md`):

- Agent steps execute inside the shared worker container with directory-scoped (not kernel-enforced) isolation; per-run container/micro-VM sandboxing is planned for M2. Do not run templates over hostile/untrusted repositories or inputs.
- No outbound-network (egress) control on agent Bash yet.
- Losing `AGRIPPA_SECRET_KEY` permanently orphans all stored credentials — back it up; rotating it requires re-entering secrets.
