import enAdmin from "../locales/en/admin.json";
import enAuth from "../locales/en/auth.json";
import enCatalog from "../locales/en/catalog.json";
import enCommon from "../locales/en/common.json";
import enRuns from "../locales/en/runs.json";
import enSettings from "../locales/en/settings.json";
import zhAdmin from "../locales/zh-CN/admin.json";
import zhAuth from "../locales/zh-CN/auth.json";
import zhCatalog from "../locales/zh-CN/catalog.json";
import zhCommon from "../locales/zh-CN/common.json";
import zhRuns from "../locales/zh-CN/runs.json";
import zhSettings from "../locales/zh-CN/settings.json";

export const namespaces = ["common", "auth", "catalog", "runs", "settings", "admin"] as const;
export type Namespace = (typeof namespaces)[number];

export const resources = {
  en: {
    common: enCommon,
    auth: enAuth,
    catalog: enCatalog,
    runs: enRuns,
    settings: enSettings,
    admin: enAdmin,
  },
  "zh-CN": {
    common: zhCommon,
    auth: zhAuth,
    catalog: zhCatalog,
    runs: zhRuns,
    settings: zhSettings,
    admin: zhAdmin,
  },
} as const;
