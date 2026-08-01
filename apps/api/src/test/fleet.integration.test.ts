import { beforeAll, describe, expect, it } from "bun:test";
import type { RunQueue } from "@agrippa/core";
import { workerHeartbeats } from "@agrippa/db";
import { InProcessEventBus } from "@agrippa/orchestration";
import { sql } from "drizzle-orm";
import type { App } from "../app";
import { createApp } from "../app";
import { freshTestDb, jsonOf, postgresAvailable, signUp, type TestClient } from "./helpers";

const dbUp = await postgresAvailable();

type FleetWorker = {
  containerId: string;
  status: "live" | "stale";
  executors: Array<{ id: string; envAuthProviders?: string[] }>;
  version: string | null;
  consumersReadyAt: string | null;
};

describe.skipIf(!dbUp)("fleet workers endpoint", () => {
  let app: App;
  let db: Awaited<ReturnType<typeof freshTestDb>>;
  let admin: TestClient;
  let member: TestClient;

  const fakeQueue: RunQueue = {
    enqueueRun: async () => {},
    enqueueApprovalExpiry: async () => {},
    enqueueNotificationDelivery: async () => {},
  };

  beforeAll(async () => {
    db = await freshTestDb();
    app = createApp({ db, queue: fakeQueue, bus: new InProcessEventBus() });
    admin = await signUp(app, "Root", "root@example.com");
    member = await signUp(app, "Mia", "mia@example.com");

    await db.insert(workerHeartbeats).values([
      {
        containerId: "w-live",
        executors: [{ id: "fake" }, { id: "claude-agent-sdk", envAuthProviders: ["anthropic"] }],
        version: "abc123",
        consumersReadyAt: sql`now()`,
      },
      // beating recently enough to be listed, long enough ago to be stale
      { containerId: "w-stale", heartbeatAt: sql`now() - interval '10 minutes'` },
      // silent past the 7-day window — never listed, even if the prune hasn't run
      { containerId: "w-ancient", heartbeatAt: sql`now() - interval '8 days'` },
    ]);
  });

  it("is org-admin only", async () => {
    expect((await member.request("/api/v1/fleet/workers")).status).toBe(403);
  });

  it("lists workers with database-clock staleness and advertisements", async () => {
    const { workers } = await jsonOf<{ workers: FleetWorker[] }>(
      await admin.request("/api/v1/fleet/workers"),
    );
    expect(workers.map((w) => w.containerId).sort()).toEqual(["w-live", "w-stale"]);

    const live = workers.find((w) => w.containerId === "w-live");
    expect(live?.status).toBe("live");
    expect(live?.version).toBe("abc123");
    expect(live?.consumersReadyAt).not.toBeNull();
    expect(live?.executors.map((e) => e.id).sort()).toEqual(["claude-agent-sdk", "fake"]);
    expect(live?.executors.find((e) => e.id === "claude-agent-sdk")?.envAuthProviders).toEqual([
      "anthropic",
    ]);

    expect(workers.find((w) => w.containerId === "w-stale")?.status).toBe("stale");
  });
});
