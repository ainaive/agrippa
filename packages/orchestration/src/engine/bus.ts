/**
 * Live-event fan-out. Correctness never depends on the bus: run_events in
 * Postgres is the source of truth and SSE replays from it; the bus only
 * shortens the path to connected clients (ADR-0007).
 */
export type BusEvent = {
  runId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

/**
 * A live subscription. `ready` resolves once the underlying transport has
 * actually begun delivering (for Redis, once SUBSCRIBE is acknowledged) — the
 * SSE handler awaits it before replaying history so no event is lost in the gap
 * between replay and an as-yet-inactive subscription.
 */
export type Subscription = { unsubscribe: () => void; ready: Promise<void> };

export interface RunEventBus {
  publish(event: BusEvent): Promise<void>;
  subscribe(runId: string, listener: (event: BusEvent) => void): Subscription;
  /** Control channel — today only "cancel". */
  publishControl(runId: string, message: string): Promise<void>;
  subscribeControl(runId: string, listener: (message: string) => void): () => void;
}

/** Single-process bus for tests and same-process dev setups. */
export class InProcessEventBus implements RunEventBus {
  private readonly listeners = new Map<string, Set<(event: BusEvent) => void>>();
  private readonly controlListeners = new Map<string, Set<(message: string) => void>>();

  async publish(event: BusEvent): Promise<void> {
    for (const listener of this.listeners.get(event.runId) ?? []) listener(event);
  }

  subscribe(runId: string, listener: (event: BusEvent) => void): Subscription {
    const set = this.listeners.get(runId) ?? new Set();
    set.add(listener);
    this.listeners.set(runId, set);
    return { unsubscribe: () => set.delete(listener), ready: Promise.resolve() };
  }

  async publishControl(runId: string, message: string): Promise<void> {
    for (const listener of this.controlListeners.get(runId) ?? []) listener(message);
  }

  subscribeControl(runId: string, listener: (message: string) => void): () => void {
    const set = this.controlListeners.get(runId) ?? new Set();
    set.add(listener);
    this.controlListeners.set(runId, set);
    return () => set.delete(listener);
  }
}
