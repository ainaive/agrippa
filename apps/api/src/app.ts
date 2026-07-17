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
import { catalogRoutes } from "./routes/catalog";
import { executionRoutes } from "./routes/execution";
import { meRoutes } from "./routes/me";
import { projectRoutes } from "./routes/projects";
import { registryRoutes } from "./routes/registry";
import { templateRoutes, templateValidateRoute } from "./routes/templates";

export function createApp(deps: {
  db: Db;
  auth?: Auth;
  queue?: RunQueue | null;
  bus?: RunEventBus | null;
}) {
  const auth = deps.auth ?? createAuth(deps.db);
  const app = new Hono<AppEnv>();

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
  });

  app.get("/healthz", async (c) => {
    try {
      await deps.db.execute(sql`select 1`);
      return c.json({ status: "ok" });
    } catch {
      return c.json({ status: "degraded", db: "unreachable" }, 503);
    }
  });
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  const v1 = new Hono<AppEnv>();
  v1.use("*", requireSession);
  v1.route("/", meRoutes);
  v1.route("/", catalogRoutes);
  v1.route("/", registryRoutes);
  v1.route("/templates", templateValidateRoute);
  v1.route("/templates", templateRoutes);
  v1.route("/projects", projectRoutes);
  v1.route("/", executionRoutes);
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
