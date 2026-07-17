import enCommon from "../locales/en/common.json";
import zhCommon from "../locales/zh-CN/common.json";

export const namespaces = ["common"] as const;
export type Namespace = (typeof namespaces)[number];

export const resources = {
  en: { common: enCommon },
  "zh-CN": { common: zhCommon },
} as const;
