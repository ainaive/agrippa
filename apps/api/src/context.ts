import type { ProjectRole, RunQueue } from "@agrippa/core";
import type { Db } from "@agrippa/db";
import type { RunEventBus } from "@agrippa/orchestration";
import type { Auth, SessionUser } from "./auth";

/**
 * Who is making the request, in the terms authorization actually needs. A
 * session and an `agr_` API key both resolve to one of these: a key acts as its
 * creating user (so project membership stays the single source of access), and
 * carries the two things a session doesn't — the key row to audit against, and
 * an optional binding that pins the request to one project.
 *
 * `assertProjectRole` takes this rather than a bare user id precisely so the
 * binding cannot be forgotten at a call site: there is no way to ask "may this
 * user touch that project" without also answering "may this credential".
 */
export type RequestPrincipal = {
  userId: string;
  orgId: string;
  /** Non-null only for API keys bound to a single project. */
  boundProjectId: string | null;
  /** The `api_keys` row that authenticated this request; null for sessions. */
  apiKeyId: string | null;
};

export type AppEnv = {
  Variables: {
    db: Db;
    auth: Auth;
    user: SessionUser;
    principal: RequestPrincipal;
    /** Set by requireProjectRole for downstream handlers. */
    projectRole: ProjectRole;
    /** Absent in tests that don't exercise execution. */
    queue: RunQueue | null;
    /** Live-event fan-out; SSE falls back to DB polling when null. */
    bus: RunEventBus | null;
    /** Response locale: ?lang → user profile → Accept-Language → en. */
    locale: string;
  };
};
