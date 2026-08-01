import { describe, expect, it } from "bun:test";
import { maskWebhookUrl, validateWebhookUrl } from "./notifications";

describe("validateWebhookUrl", () => {
  it("accepts a public https URL for generic", () => {
    expect(validateWebhookUrl("generic", "https://hooks.example.com/agrippa")).toBeNull();
  });

  it("allows a query string (DingTalk carries access_token there)", () => {
    expect(
      validateWebhookUrl("dingtalk", "https://oapi.dingtalk.com/robot/send?access_token=abc"),
    ).toBeNull();
  });

  it("rejects http, credentials, and fragments", () => {
    expect(validateWebhookUrl("generic", "http://hooks.example.com/x")).toContain("https");
    expect(validateWebhookUrl("generic", "https://user:pw@hooks.example.com/x")).toContain(
      "credentials",
    );
    expect(validateWebhookUrl("generic", "https://hooks.example.com/x#frag")).toContain("fragment");
  });

  it("rejects IP literals, localhost, and dotless names", () => {
    expect(validateWebhookUrl("generic", "https://127.0.0.1/x")).toContain("IP address");
    expect(validateWebhookUrl("generic", "https://[::1]/x")).toContain("IP address");
    expect(validateWebhookUrl("generic", "https://2130706433/x")).toContain("IP address");
    expect(validateWebhookUrl("generic", "https://localhost/x")).toContain("public DNS");
    expect(validateWebhookUrl("generic", "https://intranet/x")).toContain("public DNS");
  });

  it("pins feishu and dingtalk hosts, exact match only", () => {
    expect(
      validateWebhookUrl("feishu", "https://open.feishu.cn/open-apis/bot/v2/hook/abc"),
    ).toBeNull();
    expect(
      validateWebhookUrl("feishu", "https://open.larksuite.com/open-apis/bot/v2/hook/abc"),
    ).toBeNull();
    expect(validateWebhookUrl("feishu", "https://open.feishu.cn.evil.example.com/x")).toContain(
      "host must be",
    );
    expect(validateWebhookUrl("dingtalk", "https://hooks.example.com/x")).toContain("host must be");
    // trailing dot is normalized before the pin check
    expect(
      validateWebhookUrl("feishu", "https://open.feishu.cn./open-apis/bot/v2/hook/abc"),
    ).toBeNull();
  });

  it("generic accepts any public host (no pinning)", () => {
    expect(
      validateWebhookUrl("generic", "https://my-internal-relay.corp.example.com/hook"),
    ).toBeNull();
  });
});

describe("maskWebhookUrl", () => {
  it("hides the capability token but keeps origin and tail", () => {
    const masked = maskWebhookUrl("https://open.feishu.cn/open-apis/bot/v2/hook/0123456789abcdef");
    expect(masked).toBe("https://open.feishu.cn/open-apis/…cdef");
    expect(masked).not.toContain("0123456789");
  });

  it("never shows query values", () => {
    const masked = maskWebhookUrl("https://oapi.dingtalk.com/robot/send?access_token=secret123");
    expect(masked).not.toContain("secret123");
    expect(masked).toEndWith("?…");
  });

  it("keeps short token-free paths as-is", () => {
    expect(maskWebhookUrl("https://hooks.example.com/agrippa")).toBe(
      "https://hooks.example.com/agrippa",
    );
  });

  it("degrades to an ellipsis on unparseable input", () => {
    expect(maskWebhookUrl("not a url")).toBe("…");
  });
});
