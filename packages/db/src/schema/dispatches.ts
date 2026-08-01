import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAtCol, idCol, tstz } from "./_helpers";
import { runSteps, runs } from "./runs";
import { runtimes } from "./runtimes";

/**
 * One remote step execution (ADR-0017): the engine's RemoteExecutor inserts a
 * dispatch addressed to the run's pinned runtime; the daemon long-polls
 * `claim`, streams event batches, uploads artifacts, and terminates it with
 * complete/fail. `abort_requested` is the serialized form of ctx.signal —
 * the daemon reads it off claim/events responses.
 */
export const dispatches = pgTable(
  "dispatches",
  {
    id: idCol(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** The attempt row this dispatch executes — one live dispatch per attempt. */
    stepRowId: uuid("step_row_id")
      .notNull()
      .references(() => runSteps.id, { onDelete: "cascade" }),
    runtimeId: uuid("runtime_id")
      .notNull()
      .references(() => runtimes.id),
    status: text("status", { enum: ["pending", "claimed", "completed", "failed"] })
      .notNull()
      .default("pending"),
    abortRequested: boolean("abort_requested").notNull().default(false),
    /** DispatchPayload (daemon-protocol): serialized request + workspace spec + skills. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** Terminal report: { baseSha?, treeSha? } on complete, { code, message } on fail. */
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: createdAtCol(),
    claimedAt: tstz("claimed_at"),
    /** Bumped by every daemon contact (claim, events, heartbeat) — the deadman watermark. */
    lastContactAt: tstz("last_contact_at"),
    finishedAt: tstz("finished_at"),
  },
  (t) => [
    // the claim long-poll scans one runtime's pending work, oldest first
    index("dispatches_claim_idx").on(t.runtimeId, t.createdAt).where(sql`${t.status} = 'pending'`),
    // one live dispatch per step attempt — a redispatch must terminate its predecessor
    uniqueIndex("dispatches_step_live_uq")
      .on(t.stepRowId)
      .where(sql`${t.status} in ('pending', 'claimed')`),
  ],
);

/**
 * Sequence-numbered event batches, deduplicated on (dispatch, seq) — delivery
 * is at-least-once, and this dedup also protects token_usage attribution from
 * double counting (usage events replayed in a re-POSTed batch insert nothing).
 */
export const dispatchEvents = pgTable(
  "dispatch_events",
  {
    id: idCol(),
    dispatchId: uuid("dispatch_id")
      .notNull()
      .references(() => dispatches.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    event: jsonb("event").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAtCol(),
  },
  (t) => [uniqueIndex("dispatch_events_seq_uq").on(t.dispatchId, t.seq)],
);
