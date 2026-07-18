import enAdmin from "../locales/en/admin.json";
import enAuth from "../locales/en/auth.json";
import enCatalog from "../locales/en/catalog.json";
import enCommon from "../locales/en/common.json";
import enErrors from "../locales/en/errors.json";
import enRuns from "../locales/en/runs.json";
import enSettings from "../locales/en/settings.json";
import enUsage from "../locales/en/usage.json";
import zhAdmin from "../locales/zh-CN/admin.json";
import zhAuth from "../locales/zh-CN/auth.json";
import zhCatalog from "../locales/zh-CN/catalog.json";
import zhCommon from "../locales/zh-CN/common.json";
import zhErrors from "../locales/zh-CN/errors.json";
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
