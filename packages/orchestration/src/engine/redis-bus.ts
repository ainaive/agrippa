import { Redis } from "ioredis";
import type { BusEvent, RunEventBus, Subscription } from "./bus";

const eventChannel = (runId: string) => `run:${runId}:events`;
const controlChannel = (runId: string) => `run:${runId}:control`;

/**
 * Redis pubsub fan-out between worker (publisher) and api (SSE subscriber).
 * Pure latency optimization: if Redis drops, clients reconnect and replay
 * from run_events (ADR-0003/0007).
 */
export class RedisEventBus implements RunEventBus {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly listeners = new Map<string, Set<(event: BusEvent) => void>>();
  private readonly controlListeners = new Map<string, Set<(message: string) => void>>();

  constructor(url: string) {
    this.pub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
    this.sub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
    this.sub.on("message", (channel: string, raw: string) => {
      if (channel.endsWith(":events")) {
        const event = JSON.parse(raw) as BusEvent;
        for (const listener of this.listeners.get(event.runId) ?? []) listener(event);
      } else if (channel.endsWith(":control")) {
        const runId = channel.slice("run:".length, -":control".length);
        for (const listener of this.controlListeners.get(runId) ?? []) listener(raw);
      }
    });
    this.pub.on("error", () => {});
    this.sub.on("error", () => {});
  }

  async publish(event: BusEvent): Promise<void> {
    try {
      await this.pub.publish(eventChannel(event.runId), JSON.stringify(event));
    } catch {
      // best-effort: SSE clients fall back to replay
    }
  }

  subscribe(runId: string, listener: (event: BusEvent) => void): Subscription {
    const set = this.listeners.get(runId) ?? new Set();
    set.add(listener);
    this.listeners.set(runId, set);
    // `ready` resolves once Redis acknowledges SUBSCRIBE; the SSE handler awaits
    // it before replaying so an event published in that window isn't lost
    const ready = this.sub
      .subscribe(eventChannel(runId))
      .then(() => undefined)
      .catch(() => undefined); // Redis down → SSE falls back to DB replay
    return {
      unsubscribe: () => {
        set.delete(listener);
        if (set.size === 0) {
          this.listeners.delete(runId);
          void this.sub.unsubscribe(eventChannel(runId));
        }
      },
      ready,
    };
  }

  async publishControl(runId: string, message: string): Promise<void> {
    try {
      await this.pub.publish(controlChannel(runId), message);
    } catch {
      // engine polls runs.cancel_requested at step boundaries as backstop
    }
  }

  subscribeControl(runId: string, listener: (message: string) => void): () => void {
    const set = this.controlListeners.get(runId) ?? new Set();
    set.add(listener);
    this.controlListeners.set(runId, set);
    void this.sub.subscribe(controlChannel(runId));
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.controlListeners.delete(runId);
        void this.sub.unsubscribe(controlChannel(runId));
      }
    };
  }

  async close(): Promise<void> {
    this.pub.disconnect();
    this.sub.disconnect();
  }
}
