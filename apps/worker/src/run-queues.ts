import {
  EXECUTOR_ID_PATTERN,
  executorSubsets,
  isExecutorId,
  QUEUE_RUN_EXECUTE,
  runExecuteQueueName,
  runExecuteSubsetQueues,
} from "@agrippa/core";

/** A daemon ad expands to at most 2^8−1 = 255 subset queues; legit daemons advertise ≤3. */
const MAX_RUNTIME_AD_IDS = 8;
/** Hard ceiling on the polled queue set — past this, something is advertising garbage. */
const MAX_TOTAL_QUEUES = 1024;

export type RunQueueLogger = { warn(message: string): void };

/**
 * The run-execute queues this worker should poll (pure — callers do the
 * selects and the createQueue gating):
 *
 * - all subsets of its OWN executor set — the A1 contract;
 * - subsets derived from live daemon advertisements, but ONLY those no live
 *   central worker's executor set covers. A centrally-coverable set is polled
 *   by that capable worker itself; adding it here would let an incapable
 *   worker fetch the job, route it central (a capable peer exists), and
 *   decline — a sweeper-mediated steal loop that can starve the run. Sets no
 *   central worker covers always route remote, and ANY worker can host the
 *   engine for a remote run (RemoteExecutor proxies), so polling them broadly
 *   is safe;
 * - the legacy `run.execute` queue (deploy-skew fallback).
 *
 * Daemon-supplied ids are untrusted input from another trust domain: ids must
 * be catalog members (registration enforces this too, but rows may predate
 * that; each FRESH id would cost up to 2^n−1 persistent pg-boss queues, so
 * rotation must be impossible, not just capped) and pass EXECUTOR_ID_PATTERN
 * (queue-name safety), oversized ads skip expansion entirely, and the total
 * is hard-capped as a backstop for catalog growth. Every bound logs what it
 * dropped — silent truncation would read as full coverage.
 */
export function selectRunQueues(input: {
  localExecutorIds: readonly string[];
  /** Executor-id sets of live central workers (from worker_heartbeats). */
  centralWorkerSets: readonly (readonly string[])[];
  /** Executor ids advertised by each live runtime, with a label for logging. */
  runtimeAds: readonly { name: string; ids: readonly string[] }[];
  logger: RunQueueLogger;
  /** Advertised-id gate — defaults to catalog membership; tests inject a permissive one. */
  isAllowedId?: (id: string) => boolean;
}): string[] {
  const isAllowedId = input.isAllowedId ?? isExecutorId;
  const names = new Set<string>(runExecuteSubsetQueues(input.localExecutorIds));
  const centralSets = input.centralWorkerSets.map((ids) => new Set(ids));
  const centrallyCovered = (ids: readonly string[]): boolean =>
    centralSets.some((set) => ids.every((id) => set.has(id)));

  for (const runtime of input.runtimeAds) {
    const ids = [...new Set(runtime.ids)];
    const valid = ids.filter((id) => EXECUTOR_ID_PATTERN.test(id) && isAllowedId(id));
    if (valid.length < ids.length) {
      input.logger.warn(
        `runtime '${runtime.name}': dropped ${ids.length - valid.length} unknown or queue-unsafe executor id(s) from its advertisement`,
      );
    }
    if (valid.length > MAX_RUNTIME_AD_IDS) {
      input.logger.warn(
        `runtime '${runtime.name}': advertises ${valid.length} executors (max ${MAX_RUNTIME_AD_IDS} for queue expansion) — skipping its queues`,
      );
      continue;
    }
    for (const subset of executorSubsets(valid)) {
      if (centrallyCovered(subset)) continue;
      if (names.size >= MAX_TOTAL_QUEUES) {
        input.logger.warn(
          `run queue set hit the ${MAX_TOTAL_QUEUES} cap — dropping the remainder; check runtime advertisements`,
        );
        names.add(QUEUE_RUN_EXECUTE);
        return [...names];
      }
      names.add(runExecuteQueueName(subset));
    }
  }
  names.add(QUEUE_RUN_EXECUTE);
  return [...names];
}
