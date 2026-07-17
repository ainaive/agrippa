import { describe, expect, it } from "bun:test";
import { namespaces, resources } from "./index";

function collectKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value !== null && typeof value === "object"
      ? collectKeys(value as Record<string, unknown>, path)
      : [path];
  });
}

describe("locale key parity (en ↔ zh-CN)", () => {
  for (const ns of namespaces) {
    it(`namespace "${ns}" has identical keys in both locales`, () => {
      const en = collectKeys(resources.en[ns]).sort();
      const zh = collectKeys(resources["zh-CN"][ns]).sort();
      expect(zh).toEqual(en);
    });
  }
});
