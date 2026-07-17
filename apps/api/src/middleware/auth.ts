import { AppError } from "@agrippa/core";
import { createMiddleware } from "hono/factory";
import type { SessionUser } from "../auth";
import type { AppEnv } from "../context";

/** Resolves the better-auth session and sets c.var.user, or 401s. */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw AppError.unauthorized();
  const user = session.user as unknown as SessionUser;
  c.set("user", user);
  // profile locale wins unless the request pins ?lang explicitly
  if (!c.req.query("lang") && user.locale) c.set("locale", user.locale);
  await next();
});
