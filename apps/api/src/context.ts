import type { ProjectRole, RunQueue } from "@agrippa/core";
import type { Db } from "@agrippa/db";
import type { RunEventBus } from "@agrippa/orchestration";
import type { Auth, SessionUser } from "./auth";

export type AppEnv = {
  Variables: {
    db: Db;
    auth: Auth;
    user: SessionUser;
    /** Set by requireProjectRole for downstream handlers. */
    projectRole: ProjectRole;
    /** Absent in tests that don't exercise execution. */
    queue: RunQueue | null;
    /** Live-event fan-out; SSE falls back to DB polling when null. */
    bus: RunEventBus | null;
  };
};
