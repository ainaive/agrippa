import type { Db } from "@agrippa/db";
import { Hono } from "hono";
import { type Auth, createAuth } from "./auth";
import type { AppEnv } from "./context";
import { requireSession } from "./middleware/auth";
import { errorHandler } from "./middleware/error";
import { catalogRoutes } from "./routes/catalog";
import { meRoutes } from "./routes/me";
import { projectRoutes } from "./routes/projects";
import { registryRoutes } from "./routes/registry";
import { templateRoutes, templateValidateRoute } from "./routes/templates";

export function createApp(deps: { db: Db; auth?: Auth }) {
  const auth = deps.auth ?? createAuth(deps.db);
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("db", deps.db);
    c.set("auth", auth);
    await next();
  });

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  const v1 = new Hono<AppEnv>();
  v1.use("*", requireSession);
  v1.route("/", meRoutes);
  v1.route("/", catalogRoutes);
  v1.route("/", registryRoutes);
  v1.route("/templates", templateValidateRoute);
  v1.route("/templates", templateRoutes);
  v1.route("/projects", projectRoutes);
  app.route("/api/v1", v1);

  app.onError(errorHandler);
  return app;
}

export type App = ReturnType<typeof createApp>;
