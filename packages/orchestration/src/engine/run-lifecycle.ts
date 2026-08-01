import { type CheckpointStoredResponse, canTransitionRun, type RunStatus } from "@agrippa/core";
import { checkpoints, type Db, type DbOrTx, runEvents, runs } from "@agrippa/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

/**
 * Run-lifecycle module (docs/design/04, ADR-0007): the one place that mutates
 * run status and appends events, always atomically.
 *
 * Every status change is a compare-and-swap on the expected `from` status, so a
 * late worker completion can never overwrite a concurrent cancellation, and two
 * resumed jobs for the same run cannot both "win". Every event seq is allocated
 * by the database inside the INSERT, so the per-run monotonic seq can't be
 * seeded stale in memory and lost to a concurrent writer.
 */

export type RunEventInput = {
  runId: string;
  stepId?: string | null;
  type: string;
  payload?: Record<string, unknown>;
};

export type AppendedRunEvent = { seq: number; createdAt: Date };

/**
 * Move a run from `from` to `to` iff it is still in `from` (compare-and-swap).
 * Returns true when this caller made the change, false when the row had already
 * moved on (e.g. a cancel landed first). Rejects illegal transitions up front.
 */
export async function transitionRun(
  db: DbOrTx,
  runId: string,
  from: RunStatus,
  to: RunStatus,
): Promise<boolean> {
  if (from === to) {
    // a self-transition is an assertion "the run is still in `from`" — verify
    // against the database rather than trusting a possibly-stale caller value
    const [row] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
    return row?.status === to;
  }
  if (!canTransitionRun(from, to)) {
    throw new Error(`illegal run transition ${from} → ${to}`);
  }
  const updated = await db
    .update(runs)
    .set({ status: to })
    .where(and(eq(runs.id, runId), eq(runs.status, from)))
    .returning({ id: runs.id });
  return updated.length > 0;
}

/**
 * Append a run event with a database-allocated per-run seq. The seq comes from an
 * atomic `UPDATE runs SET next_event_seq = next_event_seq + 1 … RETURNING`: the
 * row lock serializes concurrent allocations, so this is collision-free and — key
 * for the approval flow — works inside a caller's transaction (the old
 * max(seq)+1-with-retry aborted on the first unique violation inside a tx).
 */
export async function appendRunEvent(db: DbOrTx, event: RunEventInput): Promise<AppendedRunEvent> {
  const [seqRow] = await db
    .update(runs)
    .set({ nextEventSeq: sql`${runs.nextEventSeq} + 1` })
    .where(eq(runs.id, event.runId))
    .returning({ seq: runs.nextEventSeq });
  if (!seqRow) throw new Error(`appendRunEvent: run ${event.runId} not found`);
  const [row] = await db
    .insert(runEvents)
    .values({
      runId: event.runId,
      stepId: event.stepId ?? null,
      seq: seqRow.seq,
      type: event.type,
      payload: event.payload ?? {},
    })
    .returning({ seq: runEvents.seq, createdAt: runEvents.createdAt });
  if (!row) throw new Error("run_events insert returned no row");
  return row;
}

/**
 * Runs paused in `waiting_approval` whose checkpoints are **all** decided — i.e. a
 * decision landed but its resume enqueue was lost. The sweeper re-enqueues these.
 * The `not exists (… pending)` guard is essential: a multi-checkpoint run with an
 * earlier decided checkpoint and a current pending one must NOT be selected, or the
 * sweeper would re-enqueue it every tick while it legitimately waits.
 */
export async function findStrandedCheckpointRuns(db: DbOrTx): Promise<string[]> {
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.status, "waiting_approval"),
        sql`not exists (select 1 from ${checkpoints} where ${checkpoints.runId} = ${runs.id} and ${checkpoints.status} = 'pending')`,
      ),
    );
  return rows.map((r) => r.id);
}

/** Default execution-lease TTL: survives two missed 30s renewals. */
export const RUN_LEASE_TTL_MS = 90_000;

/**
 * Claim a run for execution: one CAS that both moves it to `running` and takes
 * the execution lease (ADR-0017 Decision 4). Claimable states:
 *
 * - `queued` / `waiting_approval` — the normal pickups; any prior lease residue
 *   is irrelevant (the previous owner released or finalized).
 * - `running` with a NULL or expired lease — crash/drain recovery. A live
 *   lease blocks the claim even for the same owner: two deliveries on one
 *   worker (legacy-queue skew) must not both enter the run, and a same-
 *   container crash recovers via the sweeper after expiry instead.
 *
 * This deliberately does not trust the caller's stale status read — the
 * predicate re-checks everything in the UPDATE, replacing the old
 * `transitionRun(status → "running")` claim whose self-transition tolerance
 * let a second at-least-once delivery re-enter a running run.
 */
export async function claimRunLease(
  db: DbOrTx,
  runId: string,
  owner: string,
  ttlMs: number = RUN_LEASE_TTL_MS,
): Promise<boolean> {
  const ttl = sql`${Math.round(ttlMs / 1000)} * interval '1 second'`;
  const updated = await db
    .update(runs)
    .set({
      status: "running",
      leaseOwner: owner,
      leaseExpiresAt: sql`now() + ${ttl}`,
    })
    .where(
      and(
        eq(runs.id, runId),
        sql`(${runs.status} in ('queued', 'waiting_approval')
             or (${runs.status} = 'running'
                 and (${runs.leaseOwner} is null or ${runs.leaseExpiresAt} < now())))`,
      ),
    )
    .returning({ id: runs.id });
  return updated.length > 0;
}

/** Release the lease iff this owner still holds it (pause, drain, terminal). */
export async function releaseRunLease(db: DbOrTx, runId: string, owner: string): Promise<void> {
  await db
    .update(runs)
    .set({ leaseOwner: null, leaseExpiresAt: null })
    .where(and(eq(runs.id, runId), eq(runs.leaseOwner, owner)));
}

/**
 * Renew this owner's leases on the given runs; returns the ids actually
 * renewed. A missing id means the lease was lost (expired and swept, or the
 * run left `running`) — the caller must stop executing that run.
 */
export async function renewRunLeases(
  db: DbOrTx,
  owner: string,
  runIds: readonly string[],
  ttlMs: number = RUN_LEASE_TTL_MS,
): Promise<string[]> {
  if (runIds.length === 0) return [];
  const ttl = sql`${Math.round(ttlMs / 1000)} * interval '1 second'`;
  const rows = await db
    .update(runs)
    .set({ leaseExpiresAt: sql`now() + ${ttl}` })
    .where(
      and(inArray(runs.id, [...runIds]), eq(runs.leaseOwner, owner), eq(runs.status, "running")),
    )
    .returning({ id: runs.id });
  return rows.map((r) => r.id);
}

/**
 * Expire dead leases and surface recoverable runs. Runs on every replica's
 * sweeper concurrently: the SELECT takes row locks with SKIP LOCKED and the
 * clear-then-event pair commits atomically, so each expiry is observed (and
 * its timeline event written) exactly once. Returns:
 *
 * - `expired` — leases cleared just now (a `run.lease_expired` event each);
 * - `orphaned` — every `running` run with no lease, INCLUDING the just-expired
 *   ones: the caller re-enqueues these (singleton keys dedupe), which is what
 *   finally gives crashed `running` runs a recovery path.
 */
export async function sweepRunLeases(
  db: Db,
): Promise<{ expired: Array<{ id: string; previousOwner: string | null }>; orphaned: string[] }> {
  const expired = await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      select id, lease_owner from runs
      where status = 'running' and lease_expires_at is not null and lease_expires_at < now()
      for update skip locked
    `)) as unknown as Array<{ id: string; lease_owner: string | null }>;
    const cleared: Array<{ id: string; previousOwner: string | null }> = [];
    for (const row of rows) {
      await tx
        .update(runs)
        .set({ leaseOwner: null, leaseExpiresAt: null })
        .where(eq(runs.id, row.id));
      await appendRunEvent(tx, {
        runId: row.id,
        type: "run.lease_expired",
        payload: { previousOwner: row.lease_owner },
      });
      cleared.push({ id: row.id, previousOwner: row.lease_owner });
    }
    return cleared;
  });
  const orphanedRows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.status, "running"), isNull(runs.leaseOwner)));
  return { expired, orphaned: orphanedRows.map((r) => r.id) };
}

export type FinalizeRunInput = {
  runId: string;
  from: RunStatus;
  to: RunStatus;
  /** For a success: the CAS also requires cancel_requested=false, so a cancel that
   *  landed after the last interrupt check wins atomically instead of racing. */
  requireNotCancelled?: boolean;
  error: { code: string; message: string } | null;
  usageTotals: Record<string, unknown>;
  /** Terminal-event payload (caller redacts). */
  eventPayload: Record<string, unknown>;
};

export type FinalizeResult =
  | { outcome: "finalized"; seq: number; createdAt: Date }
  | { outcome: "cancelled_instead" } // requireNotCancelled lost to a pending cancel
  | { outcome: "lost" }; // another path already finalized the run

/**
 * The single terminal-transition implementation used by both the engine and the
 * worker's retry-exhaustion path. In one transaction it CAS-updates the status
 * (optionally requiring no pending cancel), writes finishedAt/error/usageTotals,
 * and appends the terminal event — so a run can never be left half-finalized and
 * both callers always emit the terminal event.
 */
export async function finalizeRun(db: Db, input: FinalizeRunInput): Promise<FinalizeResult> {
  const { runId, from, to, requireNotCancelled = false, error, usageTotals, eventPayload } = input;
  if (!canTransitionRun(from, to)) throw new Error(`illegal run transition ${from} → ${to}`);
  return db.transaction(async (tx): Promise<FinalizeResult> => {
    const conds = [eq(runs.id, runId), eq(runs.status, from)];
    if (requireNotCancelled) conds.push(eq(runs.cancelRequested, false));
    const updated = await tx
      .update(runs)
      .set({
        status: to,
        finishedAt: new Date(),
        error: error ?? null,
        usageTotals,
        // a terminal run holds no lease — releasing here covers every
        // finalization path (engine, worker retry-exhaustion, API cancel)
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(and(...conds))
      .returning({ id: runs.id });
    if (updated.length === 0) {
      const [row] = await tx
        .select({ status: runs.status, cancelRequested: runs.cancelRequested })
        .from(runs)
        .where(eq(runs.id, runId));
      if (requireNotCancelled && row?.status === from && row.cancelRequested) {
        return { outcome: "cancelled_instead" };
      }
      return { outcome: "lost" };
    }
    const evt = await appendRunEvent(tx, { runId, type: `run.${to}`, payload: eventPayload });
    return { outcome: "finalized", seq: evt.seq, createdAt: evt.createdAt };
  });
}

/**
 * Decide a pending checkpoint atomically. The `status = 'pending'` predicate makes
 * this a compare-and-swap: a user decision and the expiry worker can't overwrite
 * each other. Returns the updated row, or null if it was no longer pending.
 */
export async function decideCheckpoint(
  db: DbOrTx,
  checkpointRowId: string,
  patch: {
    status: "approved" | "rejected" | "expired";
    decidedBy?: string;
    comment?: string;
    response?: CheckpointStoredResponse;
  },
): Promise<typeof checkpoints.$inferSelect | null> {
  const [updated] = await db
    .update(checkpoints)
    .set({ ...patch, decidedAt: new Date() })
    .where(and(eq(checkpoints.id, checkpointRowId), eq(checkpoints.status, "pending")))
    .returning();
  return updated ?? null;
}
