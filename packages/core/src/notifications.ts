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
 * Display form that keeps the origin and the path's tail while hiding the
 * capability token most webhook URLs embed. Query values are never shown.
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
  if (path.length <= 12) return `${url.origin}${path}${suffix}`;
  const head = path.split("/").slice(0, 2).join("/");
  return `${url.origin}${head}/…${path.slice(-4)}${suffix}`;
}
