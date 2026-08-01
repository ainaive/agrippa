# ADR-0017: Remote Runtime Daemons — the Execution-Surface Split

- Status: proposed · Date: 2026-08-01
- Builds on ADR-0005 (the step seam is the split point); resolves the execution lease left as future work by ADR-0009; preserves ADR-0011/0012 across the new boundary (0012 gains an amendment at implementation time); extends ADR-0013 with daemon-local auth. Charted as Phase B of [docs/plan/m2-plan.md](../plan/m2-plan.md); motivation in [docs/plan/multica-analysis.md](../plan/multica-analysis.md).

## Context

Today one worker process does everything: it claims the `run.execute` job, runs the orchestration engine, invokes executors in-process, and owns the workspace, artifact store, and SCM write-path on its own filesystem. That topology has two structural costs. Sandboxing: an agent subprocess shares a container with the worker's credentials, which is why the deployment docs scope the Compose posture to trusted orgs. Credentials: every provider key a run needs must be provisioned centrally, even when the person who submitted the task already has a Claude Code or Codex login on their own machine.

M2's headline direction is to let teams bring their own compute: a daemon on a user's machine registers with the platform, reports which agent CLIs it can run, and executes agent work locally — while quotas, checkpoints, audit, and git publication stay on the platform. This ADR fixes where the cut goes and what crosses it.

Two facts about the current code decide most of the design. First, the dependency rule (`scripts/check-deps.ts`) already forbids executor packages from importing `@agrippa/db` — executors receive everything in `StepExecutionRequest` and answer only in events, so they are daemon-portable by construction. Second, the engine is the opposite: `EngineDeps.db` is a raw Drizzle handle and the engine issues dozens of direct queries for status CAS, events, checkpoints, usage, and quota. The engine cannot leave the platform without mirroring the whole database write surface over HTTP — and whoever hosts that surface's client controls governance.

## Decision

1. **The engine stays central; the daemon hosts the executor and the workspace.** The split lands exactly on the ADR-0005 seam: one step = one executor invocation = one remote dispatch. A daemon never sees the template, the expression language, checkpoint logic, quotas, or the database. A central worker still claims `run.execute` and runs the engine; only the agent step's execution — and the workspace it acts on — moves to the daemon.

2. **The remote transport is an `Executor` implementation.** `EngineDeps.executors[id]` binds each slot either to an in-process executor (today's central path, unchanged) or to a `RemoteExecutor` proxy that serializes the `StepExecutionRequest`, dispatches it to the owning runtime, and yields the daemon's reported events as `AsyncIterable<ExecutorEvent>` — every event variant is already JSON-serializable. `ExecutionContext` shrinks to `{ signal, logger }` before it crosses a wire: `usage.record` is a no-op and `secrets` unconditionally throws today; both are removed rather than transported. **Acceptance gate: the FakeExecutor compliance suite passes unmodified with the fake executor wrapped in the remote transport.** The suite is the executor contract (ADR-0005); if the transport cannot satisfy it, the transport is wrong.

3. **Dispatch protocol.** Daemons speak HTTP to `/api/daemon/*` (the api stays free of executor imports — it brokers dispatch rows, it executes nothing):
   - `register` — authenticate with a daemon token; report hostname, detected executors with capabilities and `envAuthProviders`, and versions. Upserts the runtime record.
   - `heartbeat` — liveness plus lease renewal (below).
   - `claim` — long-poll for dispatches addressed to this runtime.
   - `dispatches/:id/events` — sequence-numbered event batches; the server deduplicates on `(dispatch, seq)`, so delivery is at-least-once safe.
   - `dispatches/:id/artifacts/:key` — artifact byte upload. The server-side artifact store computes the sha256 at store time; daemon-reported hashes are never trusted.
   - `dispatches/:id/complete` / `fail` — terminal for the dispatch.
   - Cancellation and abort (the serialized form of `ctx.signal`) ride the responses of `claim` and `events` — no server-initiated connection to the daemon exists.
   The engine's `RemoteExecutor` writes a dispatch row and awaits its event stream; the first workspace-bearing step of a run routes by capability and auth scoring; every subsequent step pins to the runtime that owns the workspace (affinity).

4. **Execution lease (resolves ADR-0009).** `runs` gains `lease_owner` / `lease_expires_at`. Claiming a run takes the lease by compare-and-swap; heartbeats renew it; a sweeper expires dead leases and re-enqueues the run. This replaces the current one-shot claim — `transitionRun(status → "running")` — whose self-transition tolerance lets a second at-least-once delivery re-enter a `running` run. The lease is not daemon-specific: central workers adopt it in the same change, closing the double-delivery gap everywhere and giving crashed `running` runs a recovery path for the first time.

5. **Verification and publication stay central.** The daemon runs the workspace manager locally — clone, sanitization, the platform sidecar — and computes the evidence diff on its own filesystem, uploading the patch like any artifact. The server verifies evidence exactly as today: store-time sha256 against the approved artifact. Publication inverts the trust: `git.push` applies the **approved patch** to a pristine server-side clone of the pinned base ref, produces the deterministic snapshot commit, and pushes. Git credentials never reach the daemon, and the published tree derives from approved evidence rather than from any daemon-reported state. This strengthens ADR-0012 — the sidecar gitdir stops being a trust anchor at all — and requires an amendment to it when implemented. `pr.open` is unchanged (already server-side against the provider API).

6. **Trust model: daemons report, the server enforces.** Usage events are daemon-reported — the same trust level as executor-reported today, since the executor process already runs adjacent to agent code. Limits and quotas are enforced centrally at step boundaries by unchanged code. A lying daemon can waste its own compute and fabricate its own transcript; it cannot mint pushes, evidence digests, checkpoint outcomes, or audit rows. The blast radius of a compromised daemon is its own workspace and whatever auth its machine holds — which is precisely the boundary its owner already lives inside.

7. **Provider auth is daemon-local by default.** A daemon advertises `envAuthProviders` — the CLI logins its machine has. Routing matches a run's resolved providers against runtime auth the same way the keyless-worker decline path does today, generalized from "defer" to "score at dispatch". Decrypted project provider credentials (ADR-0013) are **not** shipped to remote daemons; central workers keep the existing credential path. A per-org policy to opt into credential shipping may come later; it is deliberately not part of this decision.

8. **Rollout is additive.** The in-process worker path remains fully supported; Phase A's capability-based claim filtering is the shared prerequisite; central workers may eventually become the first daemon-protocol clients, but Phase B does not require or schedule that convergence.

## Alternatives considered

- **Engine on the daemon** (the Multica shape — their daemon owns the whole task loop). Rejected: Agrippa has an engine and Multica does not. Re-homing it means exposing `finalizeRun`, `appendRunEvent`, checkpoint CAS, and quota reads as an HTTP surface whose honest use depends on the untrusted side, and it breaks the serialization assumption ADR-0012's push idempotency leans on. The entire governance thesis lives in the engine; it stays home.
- **WebSocket transport.** Rejected for now: claim long-poll plus batched event POSTs needs no full-duplex channel, matches ADR-0007's SSE-over-WebSocket precedent, and keeps the daemon usable behind restrictive egress. Revisit on latency evidence.
- **Shipping project credentials to daemons.** Default-off (Decision 7). The BYO value proposition is that the daemon uses its own logins; wiring central secrets onto user machines reverses the blast-radius win that motivates the whole feature.
- **Trusting daemon-computed digests or trees for publication.** Rejected: server-side patch-apply costs one clone per publish and removes the daemon from the publication trust chain entirely.

## Consequences

- New surface: `/api/daemon/*` routes, a `runtimes` registry (subsuming today's deployment-wide `executor_registrations` with per-runtime rows), dispatch rows, and the run lease. The lease work also closes a latent central-worker correctness gap and should land first.
- New artifact: a daemon binary (Bun `--compile`) embedding the executor packages plus daemon-side workspace management, resource materialization, and artifact upload. The materializer's outputs (`skills[].localPath`, `workspaceDir`, `toolPolicy.writeRoot`) become daemon-local paths produced daemon-side.
- The compliance suite gains a transport dimension: the same suite through `RemoteExecutor`, plus lease-specific tests (expiry, renewal, double-claim).
- Graceful drain must actually abort: design/04 describes SIGTERM aborting in-flight work, but the worker only stops the queue today. The lease makes this visible (a drained-but-running step holds a lease), so the abort fix travels with the lease work.
- Phase C (workspace affinity as a user-visible guarantee, follow-up steering runs) builds directly on the lease + affinity primitives this ADR introduces.
- Open questions deferred to implementation: event-batch sizing and backpressure; artifact upload limits versus the existing 25 MiB cap; daemon-token rotation; how long `claim` long-polls before cycling.
