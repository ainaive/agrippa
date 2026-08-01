import { beforeAll, describe, expect, it } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import {
  createDb,
  encryptSecret,
  loadSecretKey,
  migrateDb,
  notificationDeliveries,
  notificationEndpoints,
  orgs,
  projects,
  secrets,
  users,
} from "@agrippa/db";
import { ProviderCredentialError } from "@agrippa/orchestration";
import { eq, sql } from "drizzle-orm";
import type { HostLookup } from "./net";
import { deliverNotification, formatters, type NotificationContext, renderMessage } from "./notify";

process.env.AGRIPPA_SECRET_KEY ??= randomBytes(32).toString("base64");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/agrippa_test";

// one pool for the whole suite — a pool per fixture exhausts max_connections
const db = createDb(TEST_DATABASE_URL);
let dbUp = true;
try {
  await db.execute(sql`select 1`);
} catch {
  dbUp = false;
  console.warn("[test] postgres unreachable — skipping notify suite");
}

const ctx = (over: Partial<NotificationContext> = {}): NotificationContext => ({
  deliveryId: "d-1",
  eventType: "checkpoint.required",
  eventPayload: { title: { en: "Review the plan", "zh-CN": "评审计划" } },
  occurredAt: new Date("2026-08-01T04:00:00Z"),
  run: { id: "r-1", number: 3 },
  task: { title: "Fix the widget" },
  project: { id: "p-1", name: "Widgets" },
  runUrl: "https://agrippa.example.com/projects/p-1/runs/r-1",
  locale: "en",
  ...over,
});

const NOW = new Date("2026-08-01T04:05:00Z");

describe("renderMessage", () => {
  it("renders english with the checkpoint title picked by locale", () => {
    const msg = renderMessage(ctx());
    expect(msg.title).toBe("Approval needed");
    expect(msg.body).toContain('Run #3 "Fix the widget"');
    expect(msg.body).toContain('"Review the plan"');
    expect(msg.body).toContain("Widgets");
  });

  it("renders zh-CN and falls back through pickLocale for missing locales", () => {
    const zh = renderMessage(ctx({ locale: "zh-CN" }));
    expect(zh.title).toBe("等待审批");
    expect(zh.body).toContain("评审计划");

    const fallback = renderMessage(
      ctx({ locale: "zh-CN", eventPayload: { title: { en: "English only" } } }),
    );
    expect(fallback.body).toContain("English only");
  });

  it("includes the error on run.failed", () => {
    const msg = renderMessage(
      ctx({
        eventType: "run.failed",
        eventPayload: { error: { code: "usage_limit_exceeded", message: "token cap hit" } },
      }),
    );
    expect(msg.body).toContain("usage_limit_exceeded: token cap hit");
  });
});

describe("generic formatter", () => {
  it("signs the exact timestamp.body string with HMAC-SHA256", () => {
    const req = formatters.generic.format(
      ctx(),
      { url: "https://h.example.com/x", secret: "s3cret-key" },
      NOW,
    );
    const ts = req.headers["x-agrippa-timestamp"] as string;
    const expected = `v1=${createHmac("sha256", "s3cret-key").update(`${ts}.${req.body}`).digest("hex")}`;
    expect(req.headers["x-agrippa-signature"]).toBe(expected);
    expect(req.headers["x-agrippa-event"]).toBe("checkpoint.required");
    const parsed = JSON.parse(req.body) as { run: { url: string } };
    expect(parsed.run.url).toContain("/runs/r-1");
  });

  it("omits the signature when unsigned and never leaks the secret in snapshots", () => {
    const unsigned = formatters.generic.format(
      ctx(),
      { url: "https://h.example.com/x", secret: null },
      NOW,
    );
    expect(unsigned.headers["x-agrippa-signature"]).toBeUndefined();
    const snapshot = formatters.generic.redactForSnapshot(
      formatters.generic.format(
        ctx(),
        { url: "https://h.example.com/hook/abcdef0123456789", secret: "s3cret-key" },
        NOW,
      ),
    );
    expect(JSON.stringify(snapshot)).not.toContain("s3cret-key");
    expect(JSON.stringify(snapshot)).not.toContain("abcdef0123456789");
  });
});

describe("feishu formatter", () => {
  const HOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/abc";

  it("builds a signed interactive card with an open-run button", () => {
    const req = formatters.feishu.format(ctx(), { url: HOOK, secret: "feishu-secret" }, NOW);
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.msg_type).toBe("interactive");
    const ts = body.timestamp as string;
    const expected = createHmac("sha256", `${ts}\nfeishu-secret`).update("").digest("base64");
    expect(body.sign).toBe(expected);
    expect(JSON.stringify(body.card)).toContain("Approval needed");
    expect(JSON.stringify(body.card)).toContain("/runs/r-1");
  });

  it("judges success by the body code, not just HTTP status", () => {
    expect(formatters.feishu.isSuccess(200, '{"code":0,"msg":"success"}')).toBe(true);
    expect(formatters.feishu.isSuccess(200, '{"code":19001,"msg":"sign error"}')).toBe(false);
    expect(formatters.feishu.isSuccess(500, '{"code":0}')).toBe(false);
    expect(formatters.feishu.isSuccess(200, "ok")).toBe(true);
  });

  it("strips sign material from snapshots", () => {
    const req = formatters.feishu.format(ctx(), { url: HOOK, secret: "feishu-secret" }, NOW);
    const snapshot = formatters.feishu.redactForSnapshot(req);
    expect(JSON.stringify(snapshot)).not.toContain("sign");
  });
});

describe("dingtalk formatter", () => {
  const HOOK = "https://oapi.dingtalk.com/robot/send?access_token=tok123";

  it("appends timestamp+sign query params with DingTalk's keying", () => {
    const req = formatters.dingtalk.format(ctx(), { url: HOOK, secret: "ding-secret" }, NOW);
    const url = new URL(req.url);
    const ts = url.searchParams.get("timestamp") as string;
    const expected = createHmac("sha256", "ding-secret")
      .update(`${ts}\nding-secret`)
      .digest("base64");
    expect(url.searchParams.get("sign")).toBe(expected);
    expect(url.searchParams.get("access_token")).toBe("tok123");
    const body = JSON.parse(req.body) as { msgtype: string };
    expect(body.msgtype).toBe("actionCard");
  });

  it("judges success by errcode", () => {
    expect(formatters.dingtalk.isSuccess(200, '{"errcode":0,"errmsg":"ok"}')).toBe(true);
    expect(formatters.dingtalk.isSuccess(200, '{"errcode":310000,"errmsg":"sign not match"}')).toBe(
      false,
    );
  });
});

describe.skipIf(!dbUp)("deliverNotification", () => {
  let projectId: string;
  let signedEndpointId: string;
  const publicLookup: HostLookup = async () => [{ address: "93.184.216.34", family: 4 }];

  const newDelivery = async (endpointId: string) => {
    const [row] = await db
      .insert(notificationDeliveries)
      .values({ endpointId, projectId, eventType: "notification.test" })
      .returning({ id: notificationDeliveries.id });
    return row?.id as string;
  };

  beforeAll(async () => {
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`create schema public`);
    await db.execute(sql`drop schema if exists drizzle cascade`);
    await migrateDb(db);

    const [org] = await db.insert(orgs).values({ slug: "t", name: "T" }).returning();
    const orgId = org?.id as string;
    const [user] = await db
      .insert(users)
      .values({ id: Bun.randomUUIDv7(), name: "U", email: "u@example.com", orgId })
      .returning();
    const [project] = await db
      .insert(projects)
      .values({ orgId, slug: "p", name: "Widgets", createdBy: user?.id as string })
      .returning();
    projectId = project?.id as string;

    const [secret] = await db
      .insert(secrets)
      .values({
        orgId,
        kind: "webhook_secret",
        ciphertext: encryptSecret("s3cret-key", loadSecretKey()),
      })
      .returning();
    const [endpoint] = await db
      .insert(notificationEndpoints)
      .values({
        projectId,
        kind: "generic",
        name: "relay",
        url: "https://hooks.example.com/agrippa",
        secretRef: secret?.id,
        locale: "en",
      })
      .returning();
    signedEndpointId = endpoint?.id as string;
  });

  it("delivers, verifies the signature server-side, and finalizes the row", async () => {
    const deliveryId = await newDelivery(signedEndpointId);
    let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
    const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen = {
        url: String(url),
        headers: init?.headers as Record<string, string>,
        body: String(init?.body),
      };
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;

    await deliverNotification(db, deliveryId, { fetchImpl, lookup: publicLookup });

    const observed = seen as unknown as { headers: Record<string, string>; body: string };
    const ts = observed.headers["x-agrippa-timestamp"] as string;
    const expected = `v1=${createHmac("sha256", "s3cret-key").update(`${ts}.${observed.body}`).digest("hex")}`;
    expect(observed.headers["x-agrippa-signature"]).toBe(expected);

    const [row] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveryId));
    expect(row?.status).toBe("succeeded");
    expect(row?.attempts).toBe(1);
    expect(row?.responseStatus).toBe(200);
    expect(JSON.stringify(row?.payload)).not.toContain("s3cret-key");
  });

  it("records a rejected attempt (truncated snippet) and throws for pg-boss", async () => {
    const deliveryId = await newDelivery(signedEndpointId);
    const fetchImpl = (async () =>
      new Response(`err ${"x".repeat(600)}`, { status: 503 })) as unknown as typeof fetch;

    await expect(
      deliverNotification(db, deliveryId, { fetchImpl, lookup: publicLookup }),
    ).rejects.toThrow("HTTP 503");

    const [row] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveryId));
    expect(row?.status).toBe("pending"); // consumer flips to failed only at exhaustion
    expect(row?.attempts).toBe(1);
    expect(row?.responseStatus).toBe(503);
    expect(row?.responseSnippet?.length).toBe(500);
  });

  it("refuses hosts that resolve to private addresses", async () => {
    const deliveryId = await newDelivery(signedEndpointId);
    const privateLookup: HostLookup = async () => [{ address: "10.0.0.8", family: 4 }];
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response("ok");
    }) as unknown as typeof fetch;

    await expect(
      deliverNotification(db, deliveryId, { fetchImpl, lookup: privateLookup }),
    ).rejects.toThrow(ProviderCredentialError);
    expect(fetched).toBe(false);

    const [row] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveryId));
    expect(row?.lastError).toContain("non-public address");
  });

  it("fails a delivery whose endpoint was disabled, and no-ops a finished one", async () => {
    await db
      .update(notificationEndpoints)
      .set({ enabled: false })
      .where(eq(notificationEndpoints.id, signedEndpointId));
    const deliveryId = await newDelivery(signedEndpointId);
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response("ok");
    }) as unknown as typeof fetch;

    await deliverNotification(db, deliveryId, { fetchImpl, lookup: publicLookup });
    const [row] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveryId));
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toBe("endpoint disabled");
    expect(fetched).toBe(false);

    // already-terminal rows are not re-sent
    await db
      .update(notificationDeliveries)
      .set({ status: "succeeded" })
      .where(eq(notificationDeliveries.id, deliveryId));
    await deliverNotification(db, deliveryId, { fetchImpl, lookup: publicLookup });
    expect(fetched).toBe(false);
  });
});
