# ADR-0007: SSE with Event Replay over WebSocket for Live Run Progress

- Status: accepted · Date: 2026-07-17

## Context

The run-detail screen streams step events, message deltas, and usage in real time. Traffic is strictly server→client (client actions — cancel, approve — are plain REST). Clients disconnect (laptop lids, proxies) and must not miss events.

## Decision

Server-Sent Events. Each event carries `id: <seq>` (the per-run monotonic sequence from append-only `run_events`); on connect the server replays rows `> Last-Event-ID` from Postgres, then bridges the live Redis subscription, deduplicating by `seq`.

## Alternatives considered

- **WebSocket**: bidirectional capability we don't need, plus hand-rolled reconnection and replay — the browser's `EventSource` gives both for free with SSE.
- **Polling**: simplest, but message deltas make it either laggy or chatty, and we'd still need the event log.

## Consequences

- Gap-free reconnection by construction; Redis is a latency optimization, not a correctness dependency (Redis down ⇒ clients reconnect and replay from Postgres).
- Reverse proxies must disable buffering on the events route (documented in the deployment guide).
- If a genuinely interactive channel emerges later (e.g. mid-run permission dialogs answered in real time), WebSocket can be added for that surface without disturbing this one; `permission.request` events in M1 are surfaced via the approvals mechanism instead.
