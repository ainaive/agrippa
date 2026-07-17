# ADR-0002: Drizzle ORM over Prisma

- Status: accepted · Date: 2026-07-17

## Context

We need a TypeScript ORM on Bun + Postgres, with committed SQL migrations (self-hosted operators must be able to read what an upgrade does to their database) and support for jsonb-heavy tables.

## Decision

Drizzle ORM with drizzle-kit generated SQL migrations, committed to the repo.

## Alternatives considered

- **Prisma**: excellent DX, but its query-engine/codegen path on Bun has historically been the flakier combination, and its migration DSL is a layer removed from the SQL operators will actually run.
- **Raw SQL / kysely**: maximal control, but we'd hand-write the type layer that Drizzle derives from schema definitions.

## Consequences

- Schema is TypeScript-first (`packages/db/src/schema/`), one file per aggregate; types flow into `@agrippa/core` consumers naturally.
- Migrations are plain `.sql` files — reviewable in PRs, runnable by entrypoint with an advisory lock.
- We accept Drizzle's thinner relational-query sugar; complex reads (usage rollups) drop to its SQL builder deliberately.
