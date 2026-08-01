import { NOTIFIABLE_EVENT_TYPES, type NotifiableEventType, type RunQueue } from "@agrippa/core";
import {
  type Db,
  notificationDeliveries,
  notificationEndpoints,
  runEvents,
  runs,
} from "@agrippa/db";
import { and, eq, inArray, lt, notExists, sql } from "drizzle-orm";

/**
 * Delivery bookkeeping for outbound notifications (docs/design/04).
 *
 * Deliveries derive from run_events: every notifiable transition already
 * writes its event transactionally, so a delivery row per (endpoint, event)
 * — guarded by the partial unique index — is exactly-once by construction.
 * Callers invoke syncRunNotifications post-commit at the trigger sites; the
 * worker's sweeper backstops both missed syncs and stranded pending rows,
 * the same loss-proofing shape as run enqueueing.
 */

type DeliveryValue = typeof notificationDeliveries.$inferInsert;

function matchesFilter(endpointEvents: NotifiableEventType[], eventType: string): boolean {
  return endpointEvents.length === 0 || endpointEvents.includes(eventType as NotifiableEventType);
}

async function insertAndEnqueue(
  db: Db,
  queue: RunQueue | null,
  values: DeliveryValue[],
): Promise<string[]> {
  if (values.length === 0) return [];
  const inserted = await db
    .insert(notificationDeliveries)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: notificationDeliveries.id });
  for (const row of inserted) {
    await queue?.enqueueNotificationDelivery(row.id);
  }
  return inserted.map((r) => r.id);
}

/**
 * Turn this run's notifiable events into delivery rows for every enabled,
 * filter-matching endpoint of its project, and enqueue the new ones.
 * Idempotent: re-running after a partial failure or a re-delivered job
 * creates nothing new. `queue` may be null (API without a queue handle) —
 * rows still land and the worker sweeper enqueues them.
 */
export async function syncRunNotifications(
  db: Db,
  queue: RunQueue | null,
  runId: string,
): Promise<string[]> {
  const [run] = await db
    .select({ projectId: runs.projectId })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  if (!run) return [];

  const endpoints = await db
    .select({
      id: notificationEndpoints.id,
      events: notificationEndpoints.events,
      activatedAt: notificationEndpoints.activatedAt,
    })
    .from(notificationEndpoints)
    .where(
      and(
        eq(notificationEndpoints.projectId, run.projectId),
        eq(notificationEndpoints.enabled, true),
      ),
    );
  if (endpoints.length === 0) return [];

  const events = await db
    .select({ id: runEvents.id, type: runEvents.type, createdAt: runEvents.createdAt })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), inArray(runEvents.type, [...NOTIFIABLE_EVENT_TYPES])));
  if (events.length === 0) return [];

  const values: DeliveryValue[] = [];
  for (const endpoint of endpoints) {
    for (const event of events) {
      // activation watermark: a new or materially changed endpoint never
      // replays events from before it existed in its current form
      if (event.createdAt < endpoint.activatedAt) continue;
      if (!matchesFilter(endpoint.events, event.type)) continue;
      values.push({
        endpointId: endpoint.id,
        projectId: run.projectId,
        runId,
        eventId: event.id,
        eventType: event.type,
      });
    }
  }
  return insertAndEnqueue(db, queue, values);
}

/** Sweep window: events older than this are never backfilled. */
const SWEEP_WINDOW = sql`now() - interval '24 hours'`;
/** A pending row untouched this long is re-enqueued (singleton key dedupes). */
const STALE_PENDING = sql`now() - interval '60 seconds'`;
/** Rows pending past this many attempts are finalized failed by the sweep. */
const MAX_SWEPT_ATTEMPTS = 8;

/**
 * Worker-side backstop, run on the reconciliation interval:
 * (a) recent notifiable events that never got a delivery row (a crash between
 *     commit and sync, or an endpoint whose queue handle was null) are
 *     backfilled and enqueued;
 * (b) stale pending rows are re-enqueued — pg-boss's singleton key drops the
 *     send when a job for that delivery still exists;
 * (c) pending rows past MAX_SWEPT_ATTEMPTS (a worker died between the final
 *     attempt and its bookkeeping) are finalized failed instead of being
 *     re-enqueued forever.
 */
export async function sweepNotificationDeliveries(db: Db, queue: RunQueue): Promise<void> {
  const candidates = await db
    .select({
      eventId: runEvents.id,
      eventType: runEvents.type,
      runId: runEvents.runId,
      projectId: runs.projectId,
      endpointId: notificationEndpoints.id,
      endpointEvents: notificationEndpoints.events,
    })
    .from(runEvents)
    .innerJoin(runs, eq(runEvents.runId, runs.id))
    .innerJoin(
      notificationEndpoints,
      and(
        eq(notificationEndpoints.projectId, runs.projectId),
        eq(notificationEndpoints.enabled, true),
      ),
    )
    .where(
      and(
        inArray(runEvents.type, [...NOTIFIABLE_EVENT_TYPES]),
        sql`${runEvents.createdAt} > ${SWEEP_WINDOW}`,
        // activation watermark (same rule as syncRunNotifications)
        sql`${runEvents.createdAt} >= ${notificationEndpoints.activatedAt}`,
        notExists(
          db
            .select({ one: sql`1` })
            .from(notificationDeliveries)
            .where(
              and(
                eq(notificationDeliveries.endpointId, notificationEndpoints.id),
                eq(notificationDeliveries.eventId, runEvents.id),
              ),
            ),
        ),
      ),
    );

  const values: DeliveryValue[] = candidates
    .filter((c) => matchesFilter(c.endpointEvents, c.eventType))
    .map((c) => ({
      endpointId: c.endpointId,
      projectId: c.projectId,
      runId: c.runId,
      eventId: c.eventId,
      eventType: c.eventType,
    }));
  await insertAndEnqueue(db, queue, values);

  await db
    .update(notificationDeliveries)
    .set({ status: "failed", lastError: "delivery attempts exhausted" })
    .where(
      and(
        eq(notificationDeliveries.status, "pending"),
        sql`${notificationDeliveries.attempts} >= ${MAX_SWEPT_ATTEMPTS}`,
      ),
    );

  const stale = await db
    .select({ id: notificationDeliveries.id })
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.status, "pending"),
        lt(notificationDeliveries.createdAt, STALE_PENDING),
      ),
    );
  for (const row of stale) {
    await queue.enqueueNotificationDelivery(row.id);
  }
}
