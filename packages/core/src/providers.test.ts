import { describe, expect, it } from "bun:test";
import { providerServesProtocol, validateProviderBaseUrl } from "./providers";

describe("validateProviderBaseUrl", () => {
  it("accepts the documented regional override hosts", () => {
    expect(
      validateProviderBaseUrl("dashscope", "https://dashscope-intl.aliyuncs.com/apps/anthropic"),
    ).toBeNull();
    expect(
      validateProviderBaseUrl(
        "dashscope",
        "https://ws-123.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
      ),
    ).toBeNull();
    // unknown providers get the generic rules only
    expect(validateProviderBaseUrl("some-gateway", "https://llm.example.com/v1")).toBeNull();
  });

  it("rejects non-https schemes and malformed URLs", () => {
    expect(validateProviderBaseUrl("openai", "http://proxy.example.com/v1")).not.toBeNull();
    expect(validateProviderBaseUrl("openai", "file:///etc/passwd")).not.toBeNull();
    expect(validateProviderBaseUrl("openai", "not a url")).not.toBeNull();
  });

  it("rejects exfiltration-shaped targets: IPs, localhost, dotless hosts, userinfo, query", () => {
    expect(validateProviderBaseUrl("openai", "https://169.254.169.254/latest")).not.toBeNull();
    // WHATWG parsing canonicalizes numeric IPv4 forms before our check
    expect(validateProviderBaseUrl("openai", "https://2130706433/")).not.toBeNull();
    expect(validateProviderBaseUrl("openai", "https://[::1]/v1")).not.toBeNull();
    expect(validateProviderBaseUrl("openai", "https://localhost/v1")).not.toBeNull();
    expect(validateProviderBaseUrl("openai", "https://intranet/v1")).not.toBeNull();
    expect(
      validateProviderBaseUrl("openai", "https://user:pw@proxy.example.com/v1"),
    ).not.toBeNull();
    expect(validateProviderBaseUrl("openai", "https://proxy.example.com/v1?key=x")).not.toBeNull();
  });

  it("pins dashscope to the exact API hosts plus the workspace-gateway suffix", () => {
    expect(
      validateProviderBaseUrl("dashscope", "https://evil.example.com/apps/anthropic"),
    ).toContain("aliyuncs.com");
    // lookalike-suffix tricks
    expect(
      validateProviderBaseUrl("dashscope", "https://aliyuncs.com.evil.example.com/x"),
    ).not.toBeNull();
    // customer-controlled Aliyun neighbors (OSS buckets can log request
    // headers) are NOT acceptable key destinations despite the shared zone
    expect(
      validateProviderBaseUrl("dashscope", "https://bucket.oss-cn-hangzhou.aliyuncs.com/x"),
    ).not.toBeNull();
    expect(
      validateProviderBaseUrl("dashscope", "https://evil.dashscope.aliyuncs.com/x"),
    ).not.toBeNull();
  });
});

describe("providerServesProtocol", () => {
  it("restricts providers with catalog defaults to those protocols", () => {
    expect(providerServesProtocol("dashscope", "anthropic")).toBe(true);
    expect(providerServesProtocol("dashscope", "openai")).toBe(false);
  });

  it("places no restriction on native or unknown providers", () => {
    expect(providerServesProtocol("anthropic", "anthropic")).toBe(true);
    expect(providerServesProtocol("openai", "openai")).toBe(true);
    expect(providerServesProtocol("some-gateway", "openai")).toBe(true);
  });
});
