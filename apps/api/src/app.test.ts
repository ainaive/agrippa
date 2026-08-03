import { describe, expect, it } from "bun:test";
import type { Db } from "@agrippa/db";
import { createApp } from "./app";
import type { Auth } from "./auth";

const stubAuth = {
  handler: async () => new Response("stub"),
  api: { getSession: async () => null },
} as unknown as Auth;

describe("api", () => {
  it("healthz reports degraded when the database is unreachable", async () => {
    const app = createApp({ db: null as unknown as Db, auth: stubAuth });
    const res = await app.request("/healthz");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { status: string }).status).toBe("degraded");
  });

  it("healthz reports ok when the database answers", async () => {
    const db = { execute: async () => [{ one: 1 }] } as unknown as Db;
    const app = createApp({ db, auth: stubAuth });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 401 with our error shape when unauthenticated", async () => {
    const app = createApp({ db: null as unknown as Db, auth: stubAuth });
    const res = await app.request("/api/v1/me");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("unauthorized");
  });
});

describe("HSTS", () => {
  const hsts = (res: Response) => res.headers.get("strict-transport-security");
  const appWith = (maxAge?: string) => {
    if (maxAge === undefined) delete process.env.AGRIPPA_HSTS_MAX_AGE;
    else process.env.AGRIPPA_HSTS_MAX_AGE = maxAge;
    // read once at construction, so build the app after setting the env
    const app = createApp({ db: null as unknown as Db, auth: stubAuth });
    delete process.env.AGRIPPA_HSTS_MAX_AGE;
    return app;
  };
  const https = { headers: { "x-forwarded-proto": "https" } };

  it("is sent when the proxy reports TLS, with a one-year default", async () => {
    const res = await appWith().request("/healthz", https);
    expect(hsts(res)).toBe("max-age=31536000");
  });

  it("is withheld when the request did not arrive over TLS", async () => {
    const app = appWith();
    expect(hsts(await app.request("/healthz"))).toBeNull();
    expect(
      hsts(await app.request("/healthz", { headers: { "x-forwarded-proto": "http" } })),
    ).toBeNull();
  });

  it("lands on raw responses too, not just c.json ones", async () => {
    // better-auth's handler returns a bare Response; so does serveStatic. The
    // header is set after next() precisely so those are covered.
    const res = await appWith().request("/api/auth/get-session", https);
    expect(await res.text()).toBe("stub");
    expect(hsts(res)).toBe("max-age=31536000");
  });

  it("honours AGRIPPA_HSTS_MAX_AGE, including 0 to clear a cached pin", async () => {
    expect(hsts(await appWith("300").request("/healthz", https))).toBe("max-age=300");
    expect(hsts(await appWith("0").request("/healthz", https))).toBe("max-age=0");
  });

  it("falls back to the default rather than dropping the header when unparseable", async () => {
    for (const bad of ["forever", "-1", "1.5"]) {
      expect(hsts(await appWith(bad).request("/healthz", https))).toBe("max-age=31536000");
    }
  });
});
