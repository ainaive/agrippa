import { describe, expect, it } from "bun:test";
import { pickLocale } from "./i18n";

describe("pickLocale", () => {
  const text = { en: "Bug report", "zh-CN": "缺陷描述" };

  it("returns the requested locale", () => {
    expect(pickLocale(text, "zh-CN")).toBe("缺陷描述");
    expect(pickLocale(text, "en")).toBe("Bug report");
  });

  it("falls back to en when the requested locale is missing", () => {
    expect(pickLocale({ en: "Only English" }, "zh-CN")).toBe("Only English");
  });

  it("falls back to the first available value when en is missing", () => {
    expect(pickLocale({ "zh-CN": "只有中文" }, "en")).toBe("只有中文");
  });

  it("returns empty string for null, undefined, or empty objects", () => {
    expect(pickLocale(null, "en")).toBe("");
    expect(pickLocale(undefined, "en")).toBe("");
    expect(pickLocale({}, "en")).toBe("");
  });

  it("skips empty-string values in the fallback chain", () => {
    expect(pickLocale({ en: "", "zh-CN": "中文" }, "en")).toBe("中文");
  });
});
