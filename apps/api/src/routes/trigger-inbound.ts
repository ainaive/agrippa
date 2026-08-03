import { createHmac, timingSafeEqual } from "node:crypto";
import {
  AppError,
  type RunQueue,
  TRIGGER_DELIVERY_ID_HEADER,
  TRIGGER_PAYLOAD_MAX_BYTES,
  TRIGGER_SIGNATURE_HEADER,
  TRIGGER_SIGNATURE_WINDOW_SECONDS,
  TRIGGER_TIMESTAMP_HEADER,
  TRIGGER_TOKEN_PREFIX,
} from "@agrippa/core";
import {
  type Db,
  decryptSecret,
  loadSecretKey,
  secrets,
  triggerDeliveries,
  triggerEndpoints,
} from "@agrippa/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { tokenMatches, tokenPrefixOf } from "../lib/bearer-tokens";

/**
 * The public inbound surface, mounted outside the v1 session gate exactly like
 * the daemon router: requests here carry no session and no user.
 *
 * Every rejection answers the same `401 trigger_request_invalid`. An attacker
 * probing a URL learns nothing about whether the trigger exists, is disabled,
 * has a stale timestamp, or simply signed wrong — the same reasoning the daemon
 * token surface applies (ADR-0017).
 */
export type TriggerEnv = {
  Variables: { db: Db; queue: RunQueue | null; locale: string };
};

function invalid(): AppError {
  return new AppError("trigger_request_invalid", 401, "Invalid trigger request");
}

/** Constant-time hex compare that never throws on a malformed candidate. */
function signatureMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const triggerInboundRoutes = new Hono<TriggerEnv>().post("/:token", async (c) => {
  const token = c.req.param("token");
  if (!token.startsWith(TRIGGER_TOKEN_PREFIX)) throw invalid();

  const [endpoint] = await c.var.db
    .select()
    .from(triggerEndpoints)
    .where(eq(triggerEndpoints.tokenPrefix, tokenPrefixOf(token)));
  if (!endpoint || !tokenMatches(token, endpoint.tokenHash)) throw invalid();
  // a disabled trigger is indistinguishable from a wrong token, on purpose
  if (!endpoint.enabled) throw invalid();

  // Read the body ONCE, as raw bytes: the signature covers the exact bytes the
  // sender hashed, and re-serializing parsed JSON would change them.
  // Bound the body BEFORE reading it, the way the daemon event batch does:
  // deciding after `text()` means an oversized send is already resident in
  // memory by the time we object to it. Content-Length can be absent under
  // chunked encoding, so the post-read check stays as the backstop that
  // actually cannot be evaded — the header check is what keeps the common
  // case from being paid for at all.
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > TRIGGER_PAYLOAD_MAX_BYTES) {
    throw new AppError("trigger_payload_too_large", 413, "Payload exceeds the size limit");
  }
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > TRIGGER_PAYLOAD_MAX_BYTES) {
    throw new AppError("trigger_payload_too_large", 413, "Payload exceeds the size limit");
  }

  const timestamp = c.req.header(TRIGGER_TIMESTAMP_HEADER) ?? "";
  const signature = c.req.header(TRIGGER_SIGNATURE_HEADER) ?? "";
  if (!/^\d+$/.test(timestamp) || !signature.startsWith("v1=")) throw invalid();
  // bounded replay: a captured request stops working once its timestamp ages
  // out, in either direction so a fast sender clock cannot buy a longer window
  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (skew > TRIGGER_SIGNATURE_WINDOW_SECONDS) throw invalid();

  const [secretRow] = await c.var.db
    .select()
    .from(secrets)
    .where(eq(secrets.id, endpoint.secretRef));
  if (!secretRow) throw invalid();
  const secret = decryptSecret(secretRow.ciphertext, loadSecretKey());
  const expected = `v1=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`;
  if (!signatureMatches(expected, signature)) throw invalid();

  // Only now is the sender trusted. The body is still *untrusted content* —
  // it is stored for inspection and never interpolated into a prompt, because
  // a valid signature proves who sent it, not that what they sent is safe.
  let payload: Record<string, unknown> | null = null;
  if (raw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw);
      payload =
        parsed !== null && typeof parsed === "object" ? (parsed as never) : { value: parsed };
    } catch {
      payload = { raw: raw.slice(0, 4096) };
    }
  }

  const externalId = c.req.header(TRIGGER_DELIVERY_ID_HEADER)?.slice(0, 200) ?? null;
  const [delivery] = await c.var.db
    .insert(triggerDeliveries)
    .values({
      endpointId: endpoint.id,
      projectId: endpoint.projectId,
      externalId,
      payload,
    })
    // a sender retrying a request whose response it never saw must not get a
    // second run; without an id we cannot tell a retry from a real second event
    .onConflictDoNothing()
    .returning({ id: triggerDeliveries.id });

  if (!delivery) {
    return c.json({ accepted: true, deduplicated: true }, 200);
  }

  await c.var.queue?.enqueueTriggerDelivery(delivery.id);
  // 202, not 200: the run has not happened yet and may still fail. Saying
  // otherwise would be a lie the sender cannot check.
  return c.json({ accepted: true, deliveryId: delivery.id }, 202);
});
