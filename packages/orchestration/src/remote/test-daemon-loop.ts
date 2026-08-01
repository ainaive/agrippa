import type { DispatchPayload } from "@agrippa/core";
import { type Db, dispatchEvents, dispatches } from "@agrippa/db";
import type { Executor, ExecutorEvent, StepExecutionRequest } from "@agrippa/executor-core";
import { and, eq, inArray, sql } from "drizzle-orm";

export type TestDaemonLoop = { stop(): Promise<void> };

/**
 * An in-process daemon for the compliance suite's remote-transport dimension
 * (ADR-0017's acceptance gate): claims dispatches straight off the table (the
 * HTTP+auth layer has its own route tests), drives the SAME executor
 * instances the test introspects, writes events through the identical
 * dedupe-insert path, and honors the abort flag by aborting a local
 * controller — proving the transport semantics, not the plumbing.
 */
export function startTestDaemonLoop(opts: {
  db: Db;
  runtimeId: string;
  executors: Record<string, Executor>;
  pollMs?: number;
}): TestDaemonLoop {
  const pollMs = opts.pollMs ?? 25;
  let stopped = false;
  const inFlight = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();

  const claimNext = async (): Promise<{ id: string; payload: DispatchPayload } | null> => {
    const rows = (await opts.db.execute(sql`
      update dispatches set status = 'claimed', claimed_at = now(), last_contact_at = now()
      where id = (
        select id from dispatches
        where runtime_id = ${opts.runtimeId} and status = 'pending'
        order by created_at limit 1
        for update skip locked
      )
      returning id, payload
    `)) as unknown as Array<{ id: string; payload: DispatchPayload | string }>;
    const row = rows[0];
    if (!row) return null;
    // drizzle writes jsonb as a JSON-encoded string with this driver, so a
    // raw-SQL read must parse one extra layer (drizzle reads do it themselves)
    const payload =
      typeof row.payload === "string" ? (JSON.parse(row.payload) as DispatchPayload) : row.payload;
    return { id: row.id, payload };
  };

  const execute = async (dispatchId: string, payload: DispatchPayload): Promise<void> => {
    const executor = opts.executors[payload.executorId];
    if (!executor) {
      await terminate(dispatchId, "failed", {
        code: "internal",
        message: `executor '${payload.executorId}' not on this test daemon`,
      });
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const abortWatch = setInterval(async () => {
      const [row] = await opts.db
        .select({ abortRequested: dispatches.abortRequested })
        .from(dispatches)
        .where(eq(dispatches.id, dispatchId));
      if (row?.abortRequested) controller.abort("server requested abort");
    }, pollMs);

    let seq = 0;
    try {
      const request = payload.request as unknown as StepExecutionRequest;
      for await (const event of executor.executeStep(request, {
        signal: controller.signal,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      })) {
        seq += 1;
        await opts.db
          .insert(dispatchEvents)
          .values({
            dispatchId,
            seq,
            event: event as unknown as Record<string, unknown>,
          })
          .onConflictDoNothing();
        await opts.db
          .update(dispatches)
          .set({ lastContactAt: sql`now()` })
          .where(eq(dispatches.id, dispatchId));
      }
      await terminate(dispatchId, "completed", {});
    } catch (err) {
      await terminate(dispatchId, "failed", {
        code: "internal",
        message: String(err).slice(0, 500),
      });
    } finally {
      clearInterval(abortWatch);
      controllers.delete(controller);
    }
  };

  const terminate = async (
    dispatchId: string,
    status: "completed" | "failed",
    result: Record<string, unknown>,
  ): Promise<void> => {
    await opts.db
      .update(dispatches)
      .set({ status, result, finishedAt: sql`now()` })
      .where(
        and(eq(dispatches.id, dispatchId), inArray(dispatches.status, ["pending", "claimed"])),
      );
  };

  const timer = setInterval(() => {
    if (stopped) return;
    void (async () => {
      const claimed = await claimNext();
      if (!claimed) return;
      const done = execute(claimed.id, claimed.payload).finally(() => inFlight.delete(done));
      inFlight.add(done);
    })().catch(() => {});
  }, pollMs);

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      for (const controller of controllers) controller.abort("test daemon stopped");
      await Promise.allSettled([...inFlight]);
    },
  };
}
