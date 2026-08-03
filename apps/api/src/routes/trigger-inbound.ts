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
import { and, eq } from "drizzle-orm";
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

/**
 * Read a request body into a string, refusing anything past `limit`.
 *
 * The cap is enforced per chunk, so an oversized send is rejected after one
 * buffer rather than after all of it — the pattern `stageDispatchArtifact`
 * uses for daemon artifact uploads. The reader is always cancelled, so the
 * sender is not left streaming into a request nobody is reading.
 */
async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let seen = 0;
  let out = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      if (seen > limit) {
        throw new AppError("trigger_payload_too_large", 413, "Payload exceeds the size limit");
      }
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out + decoder.decode();
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

  // Read the body ONCE, as raw bytes — the signature covers exactly these, and
  // re-serializing parsed JSON would change them — and bound it WHILE reading.
  // A Content-Length check alone is not a bound: the header is absent under
  // chunked encoding, and `Number("abc")` is
  // NaN — and `NaN > limit` is false — so either one walks straight past it
  // into a full buffer of whatever the runtime's body limit allows. The header
  // is still worth consulting as a fast reject for honest senders; the
  // streaming count is what actually cannot be evaded.
  //
  // Oversize THROWS rather than truncating (unlike `readBounded`, which is
  // reading a response nobody signed): the signature covers these exact bytes,
  // so a silently truncated body would fail verification and report itself as
  // a wrong secret.
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > TRIGGER_PAYLOAD_MAX_BYTES) {
    throw new AppError("trigger_payload_too_large", 413, "Payload exceeds the size limit");
  }
  const raw = await readBoundedText(c.req.raw.body, TRIGGER_PAYLOAD_MAX_BYTES);

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

  // Only a non-null externalId can conflict: the dedupe index is partial, so a
  // delivery without one always inserts and `delivery` is defined below.
  if (!delivery) {
    if (externalId === null) throw new Error("trigger delivery insert returned no row");
    // A duplicate id means the sender is retrying — usually because it never
    // saw our first response, which is exactly the case where our first
    // enqueue may also have been lost. Re-enqueue the existing row if it is
    // still pending: the job is singleton-keyed, so this cannot produce a
    // second run, and without it the delivery is unreachable (Retry only
    // moves failed → pending).
    const [existing] = await c.var.db
      .select({ id: triggerDeliveries.id, status: triggerDeliveries.status })
      .from(triggerDeliveries)
      .where(
        and(
          eq(triggerDeliveries.endpointId, endpoint.id),
          eq(triggerDeliveries.externalId, externalId),
        ),
      );
    if (existing?.status === "pending") {
      await c.var.queue?.enqueueTriggerDelivery(existing.id);
    }
    return c.json({ accepted: true, deduplicated: true }, 200);
  }

  await c.var.queue?.enqueueTriggerDelivery(delivery.id);
  // 202, not 200: the run has not happened yet and may still fail. Saying
  // otherwise would be a lie the sender cannot check.
  return c.json({ accepted: true, deliveryId: delivery.id }, 202);
});
