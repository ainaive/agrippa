import { beforeAll, describe, expect, it } from "bun:test";
import { invitations, orgs } from "@agrippa/db";
import { eq } from "drizzle-orm";
import type { App } from "../app";
import { createApp } from "../app";
import { freshTestDb, jsonOf, postgresAvailable, signUp, type TestClient } from "./helpers";

const dbUp = await postgresAvailable();

describe.skipIf(!dbUp)("invitations integration (invite-only onboarding)", () => {
  let app: App;
  let admin: TestClient;
  let adminId: string;

  beforeAll(async () => {
    const db = await freshTestDb();
    app = createApp({ db });
    admin = await signUp(app, "Admin", "admin@example.com");
    adminId = (await jsonOf<{ id: string }>(await admin.request("/api/v1/me"))).id;
  });

  it("self-registration is closed (403 registration_closed)", async () => {
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", email: "x@y.z", password: "12345678" }),
    });
    expect(res.status).toBe(403);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("registration_closed");
  });

  it("non-admin cannot create an invitation (403)", async () => {
    const member = await signUp(app, "Member", "m0@example.com");
    const res = await member.request("/api/v1/invitations", {
      method: "POST",
      json: { email: "invitee@example.com" },
    });
    expect(res.status).toBe(403);
  });

  it("admin invites; invitee accepts and signs in as org_member", async () => {
    const createRes = await admin.request("/api/v1/invitations", {
      method: "POST",
      json: { email: "invitee@example.com" },
    });
    expect(createRes.status).toBe(201);
    const created = await jsonOf<{ token: string; inviteUrl: string }>(createRes);
    expect(created.token.length).toBeGreaterThan(0);

    const previewRes = await app.request(
      `/api/auth/accept-invite?token=${encodeURIComponent(created.token)}`,
    );
    expect(previewRes.status).toBe(200);
    expect((await jsonOf<{ email: string }>(previewRes)).email).toBe("invitee@example.com");

    const acceptRes = await app.request("/api/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: created.token,
        name: "Invitee",
        password: "Invitee!1234",
      }),
    });
    expect(acceptRes.status).toBe(200);

    // the new user signs in via the normal endpoint → org_member
    const signInRes = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "invitee@example.com", password: "Invitee!1234" }),
    });
    expect(signInRes.status).toBe(200);
    const setCookie = signInRes.headers.get("set-cookie");
    if (!setCookie) throw new Error("accept-invite sign-in returned no session cookie");
    const cookie = setCookie
      .split(",")
      .map((p) => p.split(";")[0]?.trim())
      .filter(Boolean)
      .join("; ");
    const meRes = await app.request("/api/v1/me", { headers: { cookie } });
    const me = await jsonOf<{ email: string; orgRole: string }>(meRes);
    expect(me.email).toBe("invitee@example.com");
    expect(me.orgRole).toBe("org_member");
  });

  it("reusing an accepted token fails (409)", async () => {
    const createRes = await admin.request("/api/v1/invitations", {
      method: "POST",
      json: { email: "twice@example.com" },
    });
    const { token } = await jsonOf<{ token: string }>(createRes);
    await app.request("/api/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, name: "Twice", password: "Twice!1234" }),
    });
    const reuseRes = await app.request("/api/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, name: "Twice", password: "Twice!1234" }),
    });
    expect(reuseRes.status).toBe(409);
    expect((await jsonOf<{ code: string }>(reuseRes)).code).toBe("invite_already_accepted");
  });

  it("a fake token is rejected (404)", async () => {
    const res = await app.request("/api/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "not-a-real-token", name: "X", password: "12345678" }),
    });
    expect(res.status).toBe(404);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("invite_invalid");
  });

  it("an expired invite is rejected (410)", async () => {
    // insert an already-expired invitation directly
    const db = (await import("@agrippa/db")).createDb(
      process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/agrippa_test",
    );
    const [org] = await db.select().from(orgs).where(eq(orgs.slug, "default"));
    if (!org) throw new Error("default org missing in test db");
    const token = "expired-test-token";
    const { createHash } = await import("node:crypto");
    await db.insert(invitations).values({
      orgId: org.id,
      email: "expired@example.com",
      tokenHash: createHash("sha256").update(token).digest("base64"),
      createdBy: adminId,
      expiresAt: new Date(Date.now() - 1000),
    } as typeof invitations.$inferInsert);
    const res = await app.request("/api/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, name: "X", password: "12345678" }),
    });
    expect(res.status).toBe(410);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("invite_expired");
  });

  it("admin can list and revoke a pending invitation", async () => {
    const createRes = await admin.request("/api/v1/invitations", {
      method: "POST",
      json: { email: "revoke@example.com" },
    });
    const { id } = await jsonOf<{ id: string }>(createRes);
    const listRes = await admin.request("/api/v1/invitations");
    const list = await jsonOf<{ email: string; acceptedAt: string | null }[]>(listRes);
    expect(list.some((r) => r.email === "revoke@example.com")).toBe(true);

    const delRes = await admin.request(`/api/v1/invitations/${id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    const list2 = await jsonOf<{ email: string }[]>(await admin.request("/api/v1/invitations"));
    expect(list2.some((r) => r.email === "revoke@example.com")).toBe(false);
  });

  it("cannot invite yourself (409 invite_self)", async () => {
    const res = await admin.request("/api/v1/invitations", {
      method: "POST",
      json: { email: "admin@example.com" },
    });
    expect(res.status).toBe(409);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("invite_self");
  });
});
