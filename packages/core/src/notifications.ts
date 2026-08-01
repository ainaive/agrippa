/** Outbound notification vocabulary shared by the API, worker, and SPA. */

export const NOTIFICATION_ENDPOINT_KINDS = ["generic", "feishu", "dingtalk"] as const;
export type NotificationEndpointKind = (typeof NOTIFICATION_ENDPOINT_KINDS)[number];

/**
 * The run_events types that produce deliveries. Everything here is written
 * transactionally by the run lifecycle, so deliveries derived from these rows
 * inherit exactly-once semantics from the `(endpoint, event)` dedupe key.
 */
export const NOTIFIABLE_EVENT_TYPES = [
  "checkpoint.required",
  "checkpoint.expired",
  "run.succeeded",
  "run.failed",
  "run.cancelled",
  "run.timed_out",
  // appended to affected RUNNING runs when their pinned remote runtime goes
  // silent (ADR-0017); the fleet sweeper writes it with offline dedupe
  "runtime.offline",
] as const;
export type NotifiableEventType = (typeof NOTIFIABLE_EVENT_TYPES)[number];

export function isNotifiableEventType(type: string): type is NotifiableEventType {
  return (NOTIFIABLE_EVENT_TYPES as readonly string[]).includes(type);
}

export type NotificationDeliveryStatus = "pending" | "succeeded" | "failed";

/**
 * IM bot webhooks are capability URLs, so each kind pins the hosts the
 * platform will ever POST to; `generic` accepts any public DNS host.
 */
const KIND_HOSTS: Partial<Record<NotificationEndpointKind, readonly string[]>> = {
  feishu: ["open.feishu.cn", "open.larksuite.com"],
  dingtalk: ["oapi.dingtalk.com"],
};

/**
 * Sibling of validateProviderBaseUrl with one deliberate difference: the query
 * string is allowed (DingTalk bots carry `access_token` there). The worker
 * still resolves the host at send time and requires global-unicast addresses.
 * Returns null when valid, else a short reason.
 */
export function validateWebhookUrl(kind: NotificationEndpointKind, raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  if (url.protocol !== "https:") return "must use https";
  if (url.username !== "" || url.password !== "") return "must not embed credentials";
  if (url.hash !== "") return "must not carry a fragment";
  const host = url.hostname.replace(/\.$/, "");
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) {
    return "must be a DNS hostname, not an IP address";
  }
  if (host === "localhost" || !host.includes(".")) return "must be a public DNS hostname";
  const pinned = KIND_HOSTS[kind];
  if (pinned && !pinned.includes(host)) {
    return `host must be ${pinned.join(" or ")}`;
  }
  return null;
}

/**
 * Display form that hides the path unconditionally — a short path can BE the
 * capability token in full, so there is no "token-free" length exemption. The
 * last 4 chars appear only when the path is long enough that they reveal a
 * negligible fraction of it; query values are never shown.
 */
export function maskWebhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "…";
  }
  const suffix = url.search === "" ? "" : "?…";
  const path = url.pathname;
  const tail = path.length >= 16 ? path.slice(-4) : "";
  return `${url.origin}/…${tail}${suffix}`;
}
