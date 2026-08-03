import { createHmac } from "node:crypto";
import {
  type LocalizedText,
  maskWebhookUrl,
  type NotificationEndpointKind,
  pickLocale,
} from "@agrippa/core";
import {
  type Db,
  decryptSecret,
  loadSecretKey,
  notificationDeliveries,
  notificationEndpoints,
  projects,
  runEvents,
  runs,
  secrets,
  tasks,
} from "@agrippa/db";
import { type NotificationCatalog, notificationMessages } from "@agrippa/i18n";
import { and, eq, sql } from "drizzle-orm";
import { assertPublicHost, type HostLookup } from "./net";

/**
 * Notification delivery (Track N, docs/design/04). One deliverNotification
 * call = one send attempt for one delivery row; pg-boss owns retries, the
 * worker consumer owns terminal bookkeeping at retry exhaustion, and the
 * orchestration sweeper backstops both. Formatters are pluggable per
 * endpoint kind; success is formatter-defined because the IM platforms
 * answer HTTP 200 with an error code in the body.
 */

export type NotificationContext = {
  deliveryId: string;
  eventType: string; // NotifiableEventType | "notification.test"
  eventPayload: Record<string, unknown>;
  occurredAt: Date;
  run: { id: string; number: number } | null;
  task: { title: string } | null;
  project: { id: string; name: string };
  runUrl: string | null;
  locale: string;
};

export type WebhookRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

export type NotificationFormatter = {
  kind: NotificationEndpointKind;
  format(
    ctx: NotificationContext,
    endpoint: { url: string; secret: string | null },
    now: Date,
  ): WebhookRequest;
  /** IM platforms answer 200 with an error code in the body. */
  isSuccess(status: number, responseBody: string): boolean;
  /** What may be persisted for inspection — no sign material, masked URL. */
  redactForSnapshot(req: WebhookRequest): Record<string, unknown>;
};

const MESSAGE_KEYS: Record<string, keyof NotificationCatalog> = {
  "checkpoint.required": "checkpointRequired",
  "checkpoint.expired": "checkpointExpired",
  "run.succeeded": "runSucceeded",
  "run.failed": "runFailed",
  "run.cancelled": "runCancelled",
  "run.timed_out": "runTimedOut",
  "runtime.offline": "runtimeOffline",
  "schedule.disabled": "scheduleDisabled",
  "schedule.failed": "scheduleFailed",
  "trigger.disabled": "triggerDisabled",
  "trigger.failed": "triggerFailed",
  "notification.test": "test",
};

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

/** Render the localized title/body for a delivery context. */
export function renderMessage(ctx: NotificationContext): { title: string; body: string } {
  const catalog = notificationMessages(ctx.locale);
  const key = MESSAGE_KEYS[ctx.eventType] ?? "test";
  const entry = catalog[key] as { title: string; body: string };
  const error = ctx.eventPayload.error as { code?: string; message?: string } | undefined;
  const vars = {
    runNumber: ctx.run ? String(ctx.run.number) : "",
    taskTitle: ctx.task?.title ?? "",
    projectName: ctx.project.name,
    checkpointTitle: pickLocale(ctx.eventPayload.title as LocalizedText | undefined, ctx.locale),
    runtimeName: String(ctx.eventPayload.runtimeName ?? ""),
    scheduleName: String(ctx.eventPayload.scheduleName ?? ""),
    triggerName: String(ctx.eventPayload.triggerName ?? ""),
    reason: String(ctx.eventPayload.reason ?? ""),
    error: error
      ? `${error.code ?? ""}${error.message ? `: ${error.message}` : ""}`
      : String(ctx.eventPayload.error ?? ""),
  };
  return { title: interpolate(entry.title, vars), body: interpolate(entry.body, vars) };
}

function openRunLabel(locale: string): string {
  return notificationMessages(locale).openRun;
}

function truncate(text: string, max = 500): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** Cap on how much of a receiver's response is ever materialized. */
const RESPONSE_READ_LIMIT = 16 * 1024;

/**
 * Read at most `limit` characters of the response body and cancel the rest —
 * only the success-code JSON and a 500-char snippet are ever used, so a
 * hostile receiver must not be able to buffer arbitrary bytes into the worker
 * within the send timeout.
 */
async function readBounded(response: Response, limit = RESPONSE_READ_LIMIT): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (out.length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out.length > limit ? out.slice(0, limit) : out;
}

const genericFormatter: NotificationFormatter = {
  kind: "generic",
  format(ctx, endpoint, now) {
    const message = renderMessage(ctx);
    const body = JSON.stringify({
      event: ctx.eventType,
      deliveryId: ctx.deliveryId,
      occurredAt: ctx.occurredAt.toISOString(),
      message,
      run: ctx.run ? { ...ctx.run, url: ctx.runUrl } : null,
      task: ctx.task,
      project: ctx.project,
      payload: ctx.eventPayload,
    });
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-agrippa-event": ctx.eventType,
      "x-agrippa-delivery": ctx.deliveryId,
      "x-agrippa-timestamp": timestamp,
    };
    if (endpoint.secret !== null) {
      const signature = createHmac("sha256", endpoint.secret)
        .update(`${timestamp}.${body}`)
        .digest("hex");
      headers["x-agrippa-signature"] = `v1=${signature}`;
    }
    return { url: endpoint.url, headers, body };
  },
  isSuccess(status) {
    return status >= 200 && status < 300;
  },
  redactForSnapshot(req) {
    return { url: maskWebhookUrl(req.url), body: req.body };
  },
};

const FEISHU_CARD_COLORS: Record<string, string> = {
  "checkpoint.required": "orange",
  "checkpoint.expired": "orange",
  "run.succeeded": "green",
  "run.failed": "red",
  "run.timed_out": "red",
  "run.cancelled": "grey",
  "notification.test": "blue",
};

/** Body-code check shared by the IM formatters (they answer 200 on errors). */
function imBodyOk(status: number, responseBody: string, codeFields: string[]): boolean {
  if (status < 200 || status >= 300) return false;
  try {
    const parsed = JSON.parse(responseBody) as Record<string, unknown>;
    for (const field of codeFields) {
      if (typeof parsed[field] === "number") return parsed[field] === 0;
    }
    return true; // 2xx with no recognizable code field
  } catch {
    return true; // 2xx non-JSON
  }
}

const feishuFormatter: NotificationFormatter = {
  kind: "feishu",
  format(ctx, endpoint, now) {
    const message = renderMessage(ctx);
    const elements: unknown[] = [{ tag: "div", text: { tag: "lark_md", content: message.body } }];
    if (ctx.runUrl) {
      elements.push({
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: openRunLabel(ctx.locale) },
            type: "primary",
            url: ctx.runUrl,
          },
        ],
      });
    }
    const payload: Record<string, unknown> = {
      msg_type: "interactive",
      card: {
        header: {
          title: { tag: "plain_text", content: message.title },
          template: FEISHU_CARD_COLORS[ctx.eventType] ?? "blue",
        },
        elements,
      },
    };
    if (endpoint.secret !== null) {
      // Feishu custom-bot signing: HMAC-SHA256 with "<ts>\n<secret>" as the
      // KEY over an empty message, base64 — their scheme, not a typo.
      const timestamp = String(Math.floor(now.getTime() / 1000));
      payload.timestamp = timestamp;
      payload.sign = createHmac("sha256", `${timestamp}\n${endpoint.secret}`)
        .update("")
        .digest("base64");
    }
    return {
      url: endpoint.url,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    };
  },
  isSuccess(status, responseBody) {
    return imBodyOk(status, responseBody, ["code", "StatusCode"]);
  },
  redactForSnapshot(req) {
    const parsed = JSON.parse(req.body) as Record<string, unknown>;
    parsed.sign = undefined;
    parsed.timestamp = undefined;
    return { url: maskWebhookUrl(req.url), body: JSON.stringify(parsed) };
  },
};

const dingtalkFormatter: NotificationFormatter = {
  kind: "dingtalk",
  format(ctx, endpoint, now) {
    const message = renderMessage(ctx);
    const url = new URL(endpoint.url);
    if (endpoint.secret !== null) {
      // DingTalk signing: HMAC-SHA256 keyed by the secret over "<ms>\n<secret>",
      // base64, sent as query params.
      const timestamp = String(now.getTime());
      const sign = createHmac("sha256", endpoint.secret)
        .update(`${timestamp}\n${endpoint.secret}`)
        .digest("base64");
      url.searchParams.set("timestamp", timestamp);
      url.searchParams.set("sign", sign);
    }
    const body = ctx.runUrl
      ? {
          msgtype: "actionCard",
          actionCard: {
            title: message.title,
            text: `### ${message.title}\n\n${message.body}`,
            singleTitle: openRunLabel(ctx.locale),
            singleURL: ctx.runUrl,
          },
        }
      : {
          msgtype: "markdown",
          markdown: { title: message.title, text: `### ${message.title}\n\n${message.body}` },
        };
    return {
      url: url.toString(),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
  },
  isSuccess(status, responseBody) {
    return imBodyOk(status, responseBody, ["errcode"]);
  },
  redactForSnapshot(req) {
    return { url: maskWebhookUrl(req.url), body: req.body };
  },
};

export const formatters: Record<NotificationEndpointKind, NotificationFormatter> = {
  generic: genericFormatter,
  feishu: feishuFormatter,
  dingtalk: dingtalkFormatter,
};

export type DeliverDeps = {
  fetchImpl?: typeof fetch;
  lookup?: HostLookup;
  now?: () => Date;
  /** Base for run deep links; AGRIPPA_BASE_URL in production. */
  baseUrl?: string;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * One delivery attempt. Loads the row + endpoint + event context, renders,
 * signs, sends. Success finalizes the row; any failure records the attempt
 * and throws so pg-boss retries — the consumer marks the row failed at
 * retry exhaustion. No-ops (already succeeded, endpoint gone) return quietly.
 */
export async function deliverNotification(
  db: Db,
  deliveryId: string,
  deps: DeliverDeps = {},
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const baseUrl = deps.baseUrl ?? process.env.AGRIPPA_BASE_URL ?? "http://localhost:3000";

  // pending-only: a delayed duplicate job must never resend a row already
  // finalized (failed rows re-enter only through the retry endpoint's CAS)
  const [delivery] = await db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.id, deliveryId));
  if (delivery?.status !== "pending") return;

  const [endpoint] = await db
    .select()
    .from(notificationEndpoints)
    .where(eq(notificationEndpoints.id, delivery.endpointId));
  if (!endpoint) return; // cascade raced the job; nothing to deliver to
  if (!endpoint.enabled) {
    await db
      .update(notificationDeliveries)
      .set({ status: "failed", lastError: "endpoint disabled" })
      .where(eq(notificationDeliveries.id, deliveryId));
    return;
  }

  // Activation-watermark guard: a row minted before the endpoint's current
  // configuration must not fire under it. The PATCH that resets the
  // watermark also fails pending rows, but a row in flight at that instant
  // slips past the transaction — delivery.createdAt is a conservative proxy
  // for the event time (sync creates rows at/after their event), so no
  // event join is needed here.
  if (delivery.createdAt < endpoint.activatedAt) {
    await db
      .update(notificationDeliveries)
      .set({ status: "failed", lastError: "superseded by endpoint reconfiguration" })
      .where(
        and(
          eq(notificationDeliveries.id, deliveryId),
          eq(notificationDeliveries.status, "pending"),
        ),
      );
    return;
  }

  // Claim this attempt by CAS before doing anything observable: the attempts
  // counter is the version, and the recency window (longer than the 10s send
  // timeout so it covers an in-flight post, shorter than pg-boss's 30s first
  // retry and the sweeper's 60s stale threshold so legitimate retries pass)
  // keeps a concurrent duplicate job from posting while this one is in
  // flight. Losing the race is a quiet no-op — the owner records the outcome.
  const claimed = await db
    .update(notificationDeliveries)
    .set({ attempts: delivery.attempts + 1, lastAttemptAt: now() })
    .where(
      and(
        eq(notificationDeliveries.id, deliveryId),
        eq(notificationDeliveries.status, "pending"),
        eq(notificationDeliveries.attempts, delivery.attempts),
        sql`(${notificationDeliveries.lastAttemptAt} IS NULL OR ${notificationDeliveries.lastAttemptAt} < now() - interval '20 seconds')`,
      ),
    )
    .returning({ id: notificationDeliveries.id });
  if (claimed.length === 0) return;

  const [project] = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.id, delivery.projectId));

  let run: NotificationContext["run"] = null;
  let task: NotificationContext["task"] = null;
  let eventPayload: Record<string, unknown> = {};
  let occurredAt = delivery.createdAt;
  if (delivery.runId !== null) {
    const [row] = await db
      .select({ id: runs.id, number: runs.number, taskId: runs.taskId })
      .from(runs)
      .where(eq(runs.id, delivery.runId));
    if (row) {
      run = { id: row.id, number: row.number };
      const [taskRow] = await db
        .select({ title: tasks.title })
        .from(tasks)
        .where(eq(tasks.id, row.taskId));
      task = taskRow ?? null;
    }
  }
  if (delivery.eventId !== null) {
    const [eventRow] = await db
      .select({ payload: runEvents.payload, createdAt: runEvents.createdAt })
      .from(runEvents)
      .where(eq(runEvents.id, delivery.eventId));
    if (eventRow) {
      eventPayload = eventRow.payload;
      occurredAt = eventRow.createdAt;
    }
  }

  const ctx: NotificationContext = {
    deliveryId,
    eventType: delivery.eventType,
    eventPayload,
    occurredAt,
    run,
    task,
    project: project ?? { id: delivery.projectId, name: "" },
    runUrl: run ? `${baseUrl}/projects/${delivery.projectId}/runs/${run.id}` : null,
    locale: endpoint.locale,
  };

  // attempts/lastAttemptAt were already written by the claim above
  const recordFailure = async (patch: {
    lastError: string;
    responseStatus?: number;
    responseSnippet?: string;
  }) => {
    await db
      .update(notificationDeliveries)
      .set({
        lastError: truncate(patch.lastError),
        responseStatus: patch.responseStatus ?? null,
        responseSnippet:
          patch.responseSnippet !== undefined ? truncate(patch.responseSnippet) : null,
      })
      .where(eq(notificationDeliveries.id, deliveryId));
  };

  const formatter = formatters[endpoint.kind as NotificationEndpointKind];
  if (!formatter) {
    await db
      .update(notificationDeliveries)
      .set({ status: "failed", lastError: `unknown endpoint kind '${endpoint.kind}'` })
      .where(eq(notificationDeliveries.id, deliveryId));
    return;
  }

  let request: WebhookRequest;
  try {
    // send-time SSRF guard: the stored URL was policy-checked at write time,
    // but DNS is re-resolved on every attempt
    await assertPublicHost(new URL(endpoint.url).hostname, deps.lookup, "webhook URL");
    let secret: string | null = null;
    if (endpoint.secretRef !== null) {
      const [secretRow] = await db
        .select({ ciphertext: secrets.ciphertext })
        .from(secrets)
        .where(eq(secrets.id, endpoint.secretRef));
      if (!secretRow) throw new Error("signing secret row is missing");
      secret = decryptSecret(secretRow.ciphertext, loadSecretKey());
    }
    request = formatter.format(ctx, { url: endpoint.url, secret }, now());
  } catch (err) {
    await recordFailure({ lastError: String(err) });
    throw err;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  let responseBody: string;
  try {
    response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      // never follow redirects: the SSRF guard validated THIS host only, and a
      // 307/308 would re-POST the signed body to an unvalidated destination
      redirect: "manual",
    });
    responseBody = await readBounded(response);
  } catch (err) {
    await recordFailure({ lastError: String(err) });
    throw err;
  }

  if (response.status >= 300 && response.status < 400) {
    const message = `receiver redirected (HTTP ${response.status}) — redirects are not followed`;
    await recordFailure({ lastError: message, responseStatus: response.status });
    throw new Error(message);
  }

  if (!formatter.isSuccess(response.status, responseBody)) {
    const message = `receiver rejected delivery (HTTP ${response.status})`;
    await recordFailure({
      lastError: message,
      responseStatus: response.status,
      responseSnippet: responseBody,
    });
    throw new Error(message);
  }

  await db
    .update(notificationDeliveries)
    .set({
      status: "succeeded",
      lastError: null,
      responseStatus: response.status,
      responseSnippet: truncate(responseBody),
      payload: formatter.redactForSnapshot(request),
    })
    .where(eq(notificationDeliveries.id, deliveryId));
}
