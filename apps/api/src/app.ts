import type { RunQueue } from "@agrippa/core";
import type { Db } from "@agrippa/db";
import type { RunEventBus } from "@agrippa/orchestration";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { type Auth, createAuth } from "./auth";
import type { AppEnv } from "./context";
import { requireSession } from "./middleware/auth";
import { errorHandler } from "./middleware/error";
import { apiKeyRoutes } from "./routes/api-keys";
import { catalogRoutes } from "./routes/catalog";
import { daemonRoutes } from "./routes/daemon";
import { executionRoutes } from "./routes/execution";
import { fleetRoutes } from "./routes/fleet";
import { governanceRoutes } from "./routes/governance";
import { acceptInviteRoutes, invitationRoutes } from "./routes/invitations";
import { meRoutes } from "./routes/me";
import { notificationRoutes } from "./routes/notifications";
import { projectRoutes } from "./routes/projects";
import { registryRoutes } from "./routes/registry";
import { runtimeRoutes } from "./routes/runtimes";
import { scheduleRoutes } from "./routes/schedules";
import { templateRoutes, templateValidateRoute } from "./routes/templates";

const HSTS_DEFAULT_MAX_AGE = 31_536_000; // 1 year

/**
 * How long browsers should remember to reach this instance over HTTPS only.
 * `0` is meaningful and supported: it emits `max-age=0`, which *clears* a pin
 * already cached by a browser — the rollback path for an operator returning to
 * plain HTTP. Anything unparseable falls back to the default rather than
 * silently disabling the header.
 */
function hstsMaxAge(): number {
  const raw = process.env.AGRIPPA_HSTS_MAX_AGE;
  if (raw === undefined || raw.trim() === "") return HSTS_DEFAULT_MAX_AGE;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : HSTS_DEFAULT_MAX_AGE;
}

export function createApp(deps: {
  db: Db;
  auth?: Auth;
  queue?: RunQueue | null;
  bus?: RunEventBus | null;
}) {
  const auth = deps.auth ?? createAuth(deps.db);
  const app = new Hono<AppEnv>();
  const maxAge = hstsMaxAge();

  app.use("*", async (c, next) => {
    c.set("db", deps.db);
    c.set("auth", auth);
    c.set("queue", deps.queue ?? null);
    c.set("bus", deps.bus ?? null);
    // pre-auth locale: ?lang → Accept-Language → en (requireSession refines)
    const lang = c.req.query("lang");
    const header = c.req.header("accept-language") ?? "";
    c.set("locale", lang ?? (header.toLowerCase().startsWith("zh") ? "zh-CN" : "en"));
    await next();
    // HSTS, only for requests the proxy tells us arrived over TLS. Some ISPs
    // (CN, for a domain without an ICP filing) reset plain HTTP by inspecting
    // the cleartext Host header, so an http:// URL to such an instance is a
    // dead end no redirect can rescue — the request never reaches us. This
    // header is the fix that works from the other side: the browser rewrites
    // http:// to https:// itself, before anything goes on the wire.
    // Set after next() so it lands on every response shape, including the raw
    // ones better-auth and serveStatic return (this is what hono's own
    // secureHeaders middleware does).
    if (c.req.header("x-forwarded-proto") === "https") {
      c.res.headers.set("Strict-Transport-Security", `max-age=${maxAge}`);
    }
  });

  app.get("/healthz", async (c) => {
    try {
      await deps.db.execute(sql`select 1`);
      return c.json({ status: "ok" });
    } catch {
      return c.json({ status: "degraded", db: "unreachable" }, 503);
    }
  });

  // Self-registration is closed; onboarding is invite-only (docs/design/05).
  // Block the better-auth sign-up endpoint before the wildcard hands it off.
  // More specific than /api/auth/*, so it wins; sign-in/sign-out pass through.
  app.on("POST", "/api/auth/sign-up/*", (c) => {
    const locale = c.var.locale ?? "en";
    return c.json(
      {
        code: "registration_closed",
        message:
          locale === "zh-CN"
            ? "自助注册已关闭，请联系管理员获取邀请"
            : "Self-registration is disabled; ask an administrator for an invite",
      },
      403,
    );
  });

  // Public invite-accept flow (unauthenticated, gated by the invite token).
  // Registered before the better-auth wildcard so it isn't swallowed by it.
  app.route("/api/auth/accept-invite", acceptInviteRoutes);
  // daemon surface: bearer runtime-token auth, no session — mounted outside
  // the v1 session gate exactly like accept-invite (ADR-0017 Decision 3)
  app.route("/api/daemon", daemonRoutes);

  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  const v1 = new Hono<AppEnv>();
  v1.use("*", requireSession);
  v1.route("/", meRoutes);
  v1.route("/", catalogRoutes);
  v1.route("/", registryRoutes);
  v1.route("/templates", templateValidateRoute);
  v1.route("/templates", templateRoutes);
  v1.route("/projects", projectRoutes);
  v1.route("/projects", notificationRoutes);
  v1.route("/projects", apiKeyRoutes);
  v1.route("/projects", scheduleRoutes);
  v1.route("/invitations", invitationRoutes);
  v1.route("/", executionRoutes);
  v1.route("/", governanceRoutes);
  v1.route("/", fleetRoutes);
  v1.route("/", runtimeRoutes);
  app.route("/api/v1", v1);

  // production: serve the built SPA from the same origin (no CORS, ADR-0001)
  const webDist = process.env.AGRIPPA_WEB_DIST;
  if (webDist) {
    app.use("/assets/*", serveStatic({ root: webDist }));
    app.get("*", serveStatic({ root: webDist, path: "index.html" }));
  }

  app.onError(errorHandler);
  return app;
}

export type App = ReturnType<typeof createApp>;
