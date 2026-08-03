/** Inbound webhook triggers — vocabulary shared by the API, worker, and SPA. */

/**
 * The token that routes an inbound request to its trigger. It travels in the
 * URL path rather than a header, because the senders that matter (CI runners,
 * IM bots, hosted git providers) can all POST to a URL but many cannot set an
 * `Authorization` header. That makes the URL a capability, so it is only half
 * the story: the signature below is what actually authenticates the request.
 */
export const TRIGGER_TOKEN_PREFIX = "agrt_";

/**
 * How long a signed request stays acceptable. Bounds replay of a captured
 * request without demanding tight clock sync from the sender.
 */
export const TRIGGER_SIGNATURE_WINDOW_SECONDS = 300;

/** Largest inbound body accepted; the payload is stored for inspection. */
export const TRIGGER_PAYLOAD_MAX_BYTES = 64 * 1024;

/**
 * Header names, deliberately mirroring what Agrippa *sends* on outbound
 * notifications (`apps/worker/src/deps/notify.ts`) — one signing convention in
 * both directions rather than two dialects to remember.
 *
 * Signature is `v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>">`.
 */
export const TRIGGER_TIMESTAMP_HEADER = "x-agrippa-timestamp";
export const TRIGGER_SIGNATURE_HEADER = "x-agrippa-signature";
/**
 * Optional sender-supplied id. When present it makes delivery idempotent, so
 * a sender that retries after a lost response cannot submit the run twice —
 * the same guarantee outbound gets from `(endpoint, event)`.
 */
export const TRIGGER_DELIVERY_ID_HEADER = "x-agrippa-delivery-id";

export type TriggerDeliveryStatus = "pending" | "succeeded" | "failed";

/**
 * Why a delivery produced no run. Split the same way schedules split, and for
 * the same reason: a trigger that stops silently is indistinguishable from one
 * nobody is sending to. Permanent causes disable the trigger and announce it;
 * everything else is recorded on the delivery and stays replayable.
 */
export const TRIGGER_DISABLED_REASONS = [
  "owner_lost_access",
  "project_archived",
  "task_type_gone",
] as const;
export type TriggerDisabledReason = (typeof TRIGGER_DISABLED_REASONS)[number];
