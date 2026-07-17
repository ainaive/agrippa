import { Hono } from "hono";

export function createApp() {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  return app;
}

export type App = ReturnType<typeof createApp>;
