import { describe, expect, it } from "bun:test";
import { ProviderCredentialError } from "@agrippa/orchestration";
import { assertPublicHost, type HostLookup, isPublicAddress } from "./net";

function resolver(...addresses: string[]): HostLookup {
  return async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
}

function dnsError(code: string): Error & { code: string } {
  return Object.assign(new Error(`DNS ${code}`), { code });
}

describe("isPublicAddress", () => {
  it("rejects IPv4 private and special-use space", () => {
    for (const ip of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.0.2.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
  });

  it("rejects IPv6 private, special-use, mapped, and transition space", () => {
    for (const ip of [
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:8.8.8.8",
      "64:ff9b::808:808",
      "100::1",
      "2001::1",
      "2001:2::1",
      "2001:db8::1",
      "2002::1",
      "3fff::1",
      "5f00::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "fec0::1",
      "ff00::1",
    ]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
  });

  it("rejects unallocated IPv6 space — only 2000::/3 is global unicast", () => {
    // a denylist can never enumerate what IANA hasn't allocated; an internal
    // network squatting on these prefixes must not pass the SSRF guard
    for (const ip of ["4000::1", "8000::1", "a000::1", "c000::1", "e000::1", "f000::1"]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
    // the 2000::/3 boundary itself
    expect(isPublicAddress("2000::1")).toBe(true);
    expect(isPublicAddress("3ffe::1")).toBe(true);
    expect(isPublicAddress("1fff:ffff::1")).toBe(false);
  });

  it("accepts ordinary public IPv4 and IPv6 addresses and fails closed on invalid input", () => {
    for (const ip of [
      "8.8.8.8",
      "47.246.0.1",
      "172.15.0.1",
      "172.32.0.1",
      "100.63.0.1",
      "100.128.0.1",
      "2606:4700::1111",
    ]) {
      expect(isPublicAddress(ip)).toBe(true);
    }
    expect(isPublicAddress("not-an-ip")).toBe(false);
  });
});

describe("assertPublicHost", () => {
  it("accepts only when every DNS answer is public", async () => {
    await expect(
      assertPublicHost("api.example.com", resolver("8.8.8.8", "2606:4700::1111")),
    ).resolves.toBeUndefined();

    await expect(
      assertPublicHost("api.example.com", resolver("8.8.8.8", "198.18.0.1")),
    ).rejects.toBeInstanceOf(ProviderCredentialError);
  });

  it("classifies permanent non-resolution as provider misconfiguration", async () => {
    for (const code of ["ENOTFOUND", "ENODATA"]) {
      await expect(
        assertPublicHost("missing.example.com", async () => {
          throw dnsError(code);
        }),
      ).rejects.toBeInstanceOf(ProviderCredentialError);
    }
    await expect(assertPublicHost("empty.example.com", resolver())).rejects.toBeInstanceOf(
      ProviderCredentialError,
    );
  });

  it("preserves transient and unknown resolver errors for queue retry", async () => {
    for (const code of ["EAI_AGAIN", "ETIMEOUT", "SERVFAIL"]) {
      const err = dnsError(code);
      try {
        await assertPublicHost("api.example.com", async () => {
          throw err;
        });
        throw new Error("expected assertPublicHost to reject");
      } catch (caught) {
        expect(caught).toBe(err);
      }
    }
  });
});
