import type { ProjectRole } from "@agrippa/core";
import type { Db } from "@agrippa/db";
import type { Auth, SessionUser } from "./auth";

export type AppEnv = {
  Variables: {
    db: Db;
    auth: Auth;
    user: SessionUser;
    /** Set by requireProjectRole for downstream handlers. */
    projectRole: ProjectRole;
  };
};
