import { z } from "zod";

/**
 * Wire contract for remote runtime daemons (ADR-0017 Decision 3). Lives in
 * core because both sides need it and the daemon may import neither
 * `@agrippa/db` nor `@agrippa/orchestration` (dependency direction).
 */

/**
 * Protocol hints served by `register`: the daemon paces itself from these
 * rather than hardcoding cadences, so the server can retune a fleet without
 * shipping new binaries.
 */
export const DAEMON_PROTOCOL_HINTS = {
  /** Server-side long-poll bound for `claim` (under common 30s proxy timeouts). */
  claimWaitSec: 25,
  /** Idle liveness cadence; the 60s routing window tolerates three misses. */
  heartbeatSec: 15,
  /**
   * Max gap between event batches during an active dispatch — an empty batch
   * is a keepalive. Abort rides batch responses, so this bounds abort latency.
   */
  keepaliveSec: 5,
} as const;

export type DaemonProtocolHints = typeof DAEMON_PROTOCOL_HINTS;

export const daemonExecutorAdSchema = z.object({
  id: z.string().min(1).max(100),
  envAuthProviders: z.array(z.string().min(1).max(100)).max(20).optional(),
});

export const daemonRegisterSchema = z.object({
  hostname: z.string().min(1).max(255),
  version: z.string().max(100).nullish(),
  executors: z.array(daemonExecutorAdSchema).max(16),
});
export type DaemonRegisterBody = z.infer<typeof daemonRegisterSchema>;

export const daemonHeartbeatSchema = z.object({
  /** Dispatches the daemon is still executing — bumps their contact deadline. */
  activeDispatchIds: z.array(z.uuid()).max(64).default([]),
});
export type DaemonHeartbeatBody = z.infer<typeof daemonHeartbeatSchema>;
