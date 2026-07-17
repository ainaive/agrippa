# ADR-0003: pg-boss over BullMQ for Background Jobs

- Status: accepted · Date: 2026-07-17

## Context

Task submission must atomically create the task, the run, and the job that executes it. Runs are long (minutes to an hour), low-frequency, and must survive worker crashes with resumable state. We already run Postgres; Redis is in the stack for pubsub.

## Decision

pg-boss (Postgres-backed queue). Redis remains for pubsub (live events fan-out, cancellation control channel) only.

## Alternatives considered

- **BullMQ (Redis)**: higher raw throughput and richer job orchestration, but enqueueing in a Postgres transaction is impossible — a crash between the DB commit and the Redis enqueue strands a `queued` run with no job (or vice versa). Outbox patterns fix this at the cost of the very complexity we're avoiding. Our job volume (agent runs, not events) never approaches Redis-queue territory.
- **No queue, LISTEN/NOTIFY + polling**: workable but re-implements retry/backoff/expiry that pg-boss already provides on the same database.

## Consequences

- `INSERT task + INSERT run + enqueue job` commit or roll back together — the dual-write failure mode is structurally gone.
- Retry (limit 2) with resume-aware handlers gives crash recovery; approval waits complete the job instead of holding workers.
- Redis becomes disposable infrastructure: if it's down, live streams degrade to reconnect-and-replay from Postgres; execution correctness is unaffected.
