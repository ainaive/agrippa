# ADR-0001: Bun Workspaces Monorepo with Hono + Vite React

- Status: accepted · Date: 2026-07-17

## Context

Agrippa spans a SPA, an API server, a background worker, and several shared libraries (domain types, DB schema, orchestration engine, executors, i18n). They must share TypeScript types without publish overhead, and the runtime choice (Bun) was a product-level input.

## Decision

A single Bun workspaces monorepo: `apps/web` (Vite + React), `apps/api` (Hono), `apps/worker` (pg-boss consumers), and `packages/*` for shared code. Hono over Next.js and Elysia; Vite SPA over a meta-framework.

## Alternatives considered

- **Next.js full-stack**: richest ecosystem, but long-running background agent execution still requires a separate worker process, and Bun support remains partial — we'd carry two runtimes for little gain since the UI is an authenticated app (no SEO/SSR need).
- **Elysia**: most Bun-idiomatic with Eden type safety, but a smaller ecosystem and community than Hono; Hono is runtime-portable (a hedge if Bun ever becomes a constraint).
- **Polyrepo**: type sharing across repo boundaries would need package publishing from day one — pure overhead at this stage.

## Consequences

- One `bun install`, one CI pipeline, atomic cross-cutting changes.
- Dependency direction between packages must be enforced by a CI check (nothing stops an accidental `web → db` import otherwise).
- SSE from Hono and static SPA serving from the api container keep production to two app images and avoid CORS entirely.
