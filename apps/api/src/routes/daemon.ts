import {
  AppError,
  DAEMON_PROTOCOL_HINTS,
  type DaemonClaimResponse,
  DISPATCH_EVENT_BATCH_MAX_BYTES,
  type DispatchPayload,
  daemonHeartbeatSchema,
  daemonRegisterSchema,
  dispatchCompleteSchema,
  dispatchEventBatchSchema,
  dispatchFailSchema,
} from "@agrippa/core";
import { auditLogs, type Db, dispatchEvents, dispatches, runtimes } from "@agrippa/db";
import {
  ArtifactTooLargeError,
  DiskArtifactStore,
  isSafeArtifactKey,
  type RunEventBus,
} from "@agrippa/orchestration";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  RUNTIME_TOKEN_PREFIX,
  runtimeTokenMatches,
  runtimeTokenPrefix,
} from "../lib/runtime-tokens";
import { validate } from "../lib/validate";

type RuntimeRow = typeof runtimes.$inferSelect;

/**
 * The daemon-facing surface is its own Hono environment: requests carry a
 * runtime principal, never a session user, and the router mounts OUTSIDE the
 * v1 session gate (the accept-invite precedent in app.ts). The upstream
 * global middleware still provides db/bus/locale.
 */
export type DaemonEnv = {
  Variables: {
    db: Db;
    bus: RunEventBus | null;
    locale: string;
    runtime: RuntimeRow;
  };
};

/**
 * Bearer auth with the runtime token: prefix-indexed lookup, constant-time
 * hash compare, active-status check. Every failure is the same 401 code so
 * a probe can't distinguish unknown, revoked, and malformed tokens.
 */
const daemonAuth: MiddlewareHandler<DaemonEnv> = async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token.startsWith(RUNTIME_TOKEN_PREFIX)) {
    throw new AppError("daemon_token_invalid", 401, "Invalid daemon token");
  }
  const [row] = await c.var.db
    .select()
    .from(runtimes)
    .where(eq(runtimes.tokenPrefix, runtimeTokenPrefix(token)));
  if (row?.status !== "active" || !runtimeTokenMatches(token, row.tokenHash)) {
    throw new AppError("daemon_token_invalid", 401, "Invalid daemon token");
  }
  c.set("runtime", row);
  await next();
};

/** Audit rows for daemon-authenticated requests carry the runtime actor. */
async function daemonAudit(
  c: { var: DaemonEnv["Variables"]; req: { header(name: string): string | undefined } },
  entry: { action: string; payload?: Record<string, unknown> },
): Promise<void> {
  await c.var.db.insert(auditLogs).values({
    orgId: c.var.runtime.orgId,
    actorRuntimeId: c.var.runtime.id,
    action: entry.action,
    resourceType: "runtime",
    resourceId: c.var.runtime.id,
    payload: entry.payload ?? {},
    ip: c.req.header("x-forwarded-for") ?? null,
  });
}

export const daemonRoutes = new Hono<DaemonEnv>()
  .use("*", daemonAuth)
  .post("/register", validate("json", daemonRegisterSchema), async (c) => {
    const body = c.req.valid("json");
    await c.var.db
      .update(runtimes)
      .set({
        hostname: body.hostname,
        version: body.version ?? null,
        executors: body.executors,
        lastSeenAt: sql`now()`,
        registeredAt: sql`coalesce(${runtimes.registeredAt}, now())`,
      })
      .where(eq(runtimes.id, c.var.runtime.id));
    // once per daemon boot — heartbeats are deliberately not audited
    await daemonAudit(c, {
      action: "runtime.register",
      payload: { hostname: body.hostname, executors: body.executors.map((e) => e.id) },
    });
    return c.json({ runtimeId: c.var.runtime.id, hints: DAEMON_PROTOCOL_HINTS });
  })
  .post("/heartbeat", validate("json", daemonHeartbeatSchema), async (c) => {
    const body = c.req.valid("json");
    await c.var.db
      .update(runtimes)
      .set({ lastSeenAt: sql`now()` })
      .where(eq(runtimes.id, c.var.runtime.id));
    if (body.activeDispatchIds.length > 0) {
      await c.var.db
        .update(dispatches)
        .set({ lastContactAt: sql`now()` })
        .where(
          and(
            inArray(dispatches.id, body.activeDispatchIds),
            eq(dispatches.runtimeId, c.var.runtime.id),
            eq(dispatches.status, "claimed"),
          ),
        );
    }
    return c.json({ ok: true });
  })
  /**
   * Long-poll for work: atomically claim the oldest pending dispatch for this
   * runtime (FOR UPDATE SKIP LOCKED — two claim calls can never both take
   * one), waking on a 1s tick until the wait bound. The response always
   * carries the abort piggyback, which is why an empty poll answers 200
   * with a null dispatch rather than 204.
   */
  .get("/claim", async (c) => {
    const requested = Number(c.req.query("wait") ?? DAEMON_PROTOCOL_HINTS.claimWaitSec);
    const waitSec = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 0), DAEMON_PROTOCOL_HINTS.claimWaitSec)
      : DAEMON_PROTOCOL_HINTS.claimWaitSec;
    const deadline = Date.now() + waitSec * 1000;
    let claimed: DaemonClaimResponse["dispatch"] = null;
    for (;;) {
      // Claimable: pending — or claimed by THIS runtime with zero events and
      // stale contact. The second arm re-offers a claim whose RESPONSE was
      // lost (socket died between the claim UPDATE committing and the daemon
      // reading it) or whose daemon crashed pre-execution: nothing partially
      // executed reached the server (no events), only this runtime can claim
      // its dispatches, and its single-threaded runner is asking for work —
      // so handing it back is safe, and beats stalling until the deadman
      // burns an attempt. 15s staleness (3× the keepalive cadence) keeps an
      // actively-executing dispatch out of reach.
      const rows = (await c.var.db.execute(sql`
        update dispatches set status = 'claimed', claimed_at = now(), last_contact_at = now()
        where id = (
          select id from dispatches d
          where d.runtime_id = ${c.var.runtime.id}
            and (
              d.status = 'pending'
              or (
                d.status = 'claimed'
                and d.last_contact_at < now() - interval '15 seconds'
                and not exists (select 1 from dispatch_events e where e.dispatch_id = d.id)
              )
            )
          order by d.created_at
          limit 1
          for update skip locked
        )
        returning id, run_id, payload
      `)) as unknown as Array<{ id: string; run_id: string; payload: DispatchPayload | string }>;
      const row = rows[0];
      if (row) {
        // drizzle stores jsonb as a JSON-encoded string with this driver; a
        // raw-SQL read gets that string back and must parse the extra layer
        const payload =
          typeof row.payload === "string"
            ? (JSON.parse(row.payload) as DispatchPayload)
            : row.payload;
        claimed = { id: row.id, runId: row.run_id, payload };
        break;
      }
      if (Date.now() >= deadline) break;
      await Bun.sleep(1000);
    }
    const aborted = await c.var.db
      .select({ id: dispatches.id })
      .from(dispatches)
      .where(
        and(
          eq(dispatches.runtimeId, c.var.runtime.id),
          eq(dispatches.status, "claimed"),
          eq(dispatches.abortRequested, true),
        ),
      );
    const response: DaemonClaimResponse = {
      dispatch: claimed,
      abortedDispatchIds: aborted.map((r) => r.id),
    };
    return c.json(response);
  })
  .post(
    "/dispatches/:id/events",
    async (c, next) => {
      // bound the batch BEFORE parsing: a daemon must chunk, not stream blobs
      const length = Number(c.req.header("content-length") ?? 0);
      if (length > DISPATCH_EVENT_BATCH_MAX_BYTES) {
        throw new AppError("dispatch_batch_too_large", 413, "Event batch exceeds the size bound");
      }
      await next();
    },
    validate("json", dispatchEventBatchSchema),
    async (c) => {
      const dispatch = await ownedLiveDispatch(c.var.db, c.var.runtime.id, c.req.param("id"));
      const { batch } = c.req.valid("json");
      if (batch.length > 0) {
        // at-least-once delivery: replays land on the (dispatch, seq) unique
        // index and insert nothing — usage double-counting dies here
        await c.var.db
          .insert(dispatchEvents)
          .values(batch.map((e) => ({ dispatchId: dispatch.id, seq: e.seq, event: e.event })))
          .onConflictDoNothing();
      }
      await c.var.db
        .update(dispatches)
        .set({ lastContactAt: sql`now()` })
        .where(eq(dispatches.id, dispatch.id));
      // an empty batch is the keepalive — abort rides this response either way
      return c.json({ abort: dispatch.abortRequested });
    },
  )
  .post("/dispatches/:id/artifacts/:key", async (c) => {
    const dispatch = await ownedLiveDispatch(c.var.db, c.var.runtime.id, c.req.param("id"));
    if (!isSafeArtifactKey(c.req.param("key"))) {
      throw AppError.validation({ key: "invalid artifact key" });
    }
    const body = c.req.raw.body;
    if (!body) throw AppError.validation("artifact upload requires a request body");
    // the server hashes at store time; any daemon-supplied digest is ignored
    let staged: { staged: string; size: number; sha256: string };
    try {
      staged = await artifactStore.stageDispatchArtifact(dispatch.id, c.req.param("key"), body);
    } catch (err) {
      if (err instanceof ArtifactTooLargeError) {
        throw new AppError("artifact_too_large", 413, err.message);
      }
      throw err;
    }
    await c.var.db
      .update(dispatches)
      .set({ lastContactAt: sql`now()` })
      .where(eq(dispatches.id, dispatch.id));
    return c.json(staged);
  })
  .post("/dispatches/:id/complete", validate("json", dispatchCompleteSchema), async (c) => {
    const body = c.req.valid("json");
    await terminateDispatch(c.var.db, c.var.runtime.id, c.req.param("id"), "completed", body);
    return c.json({ ok: true });
  })
  .post("/dispatches/:id/fail", validate("json", dispatchFailSchema), async (c) => {
    const body = c.req.valid("json");
    await terminateDispatch(c.var.db, c.var.runtime.id, c.req.param("id"), "failed", body);
    return c.json({ ok: true });
  });

const artifactStore = new DiskArtifactStore();

/** A dispatch this runtime claimed and has not terminated; 404 otherwise. */
async function ownedLiveDispatch(db: Db, runtimeId: string, dispatchId: string) {
  const [row] = await db
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.id, dispatchId), eq(dispatches.runtimeId, runtimeId)));
  if (!row) throw AppError.notFound("Dispatch");
  if (row.status !== "claimed") {
    throw new AppError("dispatch_not_live", 409, "Dispatch is not claimed by this runtime");
  }
  return row;
}

/** Terminal CAS claimed → completed|failed; a lost race is a 409. */
async function terminateDispatch(
  db: Db,
  runtimeId: string,
  dispatchId: string,
  status: "completed" | "failed",
  result: Record<string, unknown>,
): Promise<void> {
  const updated = await db
    .update(dispatches)
    .set({ status, result, finishedAt: sql`now()`, lastContactAt: sql`now()` })
    .where(
      and(
        eq(dispatches.id, dispatchId),
        eq(dispatches.runtimeId, runtimeId),
        eq(dispatches.status, "claimed"),
      ),
    )
    .returning({ id: dispatches.id });
  if (updated.length === 0) {
    const [row] = await db
      .select({ id: dispatches.id })
      .from(dispatches)
      .where(and(eq(dispatches.id, dispatchId), eq(dispatches.runtimeId, runtimeId)));
    if (!row) throw AppError.notFound("Dispatch");
    throw new AppError("dispatch_not_live", 409, "Dispatch already terminated");
  }
}
