# ADR-0004: better-auth for Authentication

- Status: accepted · Date: 2026-07-17

## Context

Self-hosted deployment needs credential auth out of the box (no mandatory external IdP), session management for the SPA, API keys for programmatic access, and a path to SSO later. It must run on Bun + Hono + Drizzle.

## Decision

better-auth with its Drizzle adapter, mounted at `/api/auth/*`. Email + password in M1; API keys via its plugin model; org/project RBAC implemented in our own middleware on top (better-auth authenticates; Agrippa authorizes).

## Alternatives considered

- **Lucia**: influential but its maintainers deprecated the library form in favor of "write it yourself" guidance — wrong direction for us.
- **Auth.js**: OAuth-first design; credentials support is a second-class citizen, and self-hosters shouldn't need an external IdP to log in.
- **Hand-rolled sessions**: entirely feasible but password hashing, session rotation, and eventual SSO are undifferentiated risk we don't need to own.

## Consequences

- Auth tables live in our Postgres via the same Drizzle schema/migrations as everything else.
- RBAC stays ours: `requireRole(scope, minRole)` reads `project_members`/`users.org_role` — better-auth never encodes project semantics.
- SSO/OIDC later is a plugin addition, not a migration.
