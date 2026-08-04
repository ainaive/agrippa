import enAdmin from "../locales/en/admin.json";
import enAuth from "../locales/en/auth.json";
import enCatalog from "../locales/en/catalog.json";
import enCommon from "../locales/en/common.json";
import enErrors from "../locales/en/errors.json";
import enNotifications from "../locales/en/notifications.json";
import enRuns from "../locales/en/runs.json";
import enSettings from "../locales/en/settings.json";
import enUsage from "../locales/en/usage.json";
import zhAdmin from "../locales/zh-CN/admin.json";
import zhAuth from "../locales/zh-CN/auth.json";
import zhCatalog from "../locales/zh-CN/catalog.json";
import zhCommon from "../locales/zh-CN/common.json";
import zhErrors from "../locales/zh-CN/errors.json";
import zhNotifications from "../locales/zh-CN/notifications.json";
import zhRuns from "../locales/zh-CN/runs.json";
import zhSettings from "../locales/zh-CN/settings.json";
import zhUsage from "../locales/zh-CN/usage.json";

export const namespaces = [
  "common",
  "auth",
  "catalog",
  "runs",
  "settings",
  "admin",
  "usage",
  "errors",
  "notifications",
] as const;
export type Namespace = (typeof namespaces)[number];

export const resources = {
  en: {
    common: enCommon,
    auth: enAuth,
    catalog: enCatalog,
    runs: enRuns,
    settings: enSettings,
    admin: enAdmin,
    usage: enUsage,
    errors: enErrors,
    notifications: enNotifications,
  },
  "zh-CN": {
    common: zhCommon,
    auth: zhAuth,
    catalog: zhCatalog,
    runs: zhRuns,
    settings: zhSettings,
    admin: zhAdmin,
    usage: zhUsage,
    errors: zhErrors,
    notifications: zhNotifications,
  },
} as const;

/** Server-side error-message lookup: code → localized message (undefined if unknown). */
export function errorMessage(code: string, locale: string): string | undefined {
  const table = (locale.startsWith("zh") ? resources["zh-CN"] : resources.en).errors as Record<
    string,
    string
  >;
  return table[code];
}

export type NotificationMessage = { title: string; body: string };
export type NotificationCatalog = typeof resources.en.notifications;

/** Server-side notification-copy lookup (worker card/webhook rendering). */
export function notificationMessages(locale: string): NotificationCatalog {
  return locale.startsWith("zh") ? resources["zh-CN"].notifications : resources.en.notifications;
}

/**
 * A schedule/trigger disabled-reason as a **clause**, not the raw enum.
 *
 * The emitters put a `ScheduleDisabledReason`/`TriggerDisabledReason` on the
 * event payload and the template interpolates it into prose, so without this
 * the operator is told the schedule stopped because `owner_lost_access`.
 *
 * It reads the `notifications` catalog rather than `settings.schedules.reasons`
 * even though the two say the same thing, because the grammar differs: the SPA
 * renders its copy as a standalone status line ("Stopped: its owner…"), and
 * pasting that into a sentence that already says the schedule was disabled
 * yields "was disabled and will not run again: Stopped: its owner… ." — a
 * doubled statement and a doubled terminator. Two surfaces, two shapes.
 *
 * Falls back to the raw code, which beats an empty sentence. Nothing reaches
 * that fallback today and a test pins it that way: every member of both
 * disabled-reason enums must resolve in every locale.
 */
export function disabledReasonText(reason: string, locale: string): string {
  const table = (locale.startsWith("zh") ? resources["zh-CN"] : resources.en).notifications as {
    reasons?: Record<string, string>;
  };
  return table.reasons?.[reason] ?? reason;
}
