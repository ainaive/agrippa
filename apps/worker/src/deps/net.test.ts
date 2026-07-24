import { describe, expect, it } from "bun:test";
import { isPrivateAddress } from "./net";

describe("isPrivateAddress", () => {
  it("rejects loopback, private, link-local, CGNAT, and unspecified space", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:127.0.0.1", // v4-mapped v6
      "::ffff:10.0.0.1",
      "not-an-ip", // unparseable → refuse, never allow
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  it("accepts public addresses", () => {
    for (const ip of [
      "8.8.8.8",
      "47.246.0.1", // Aliyun public range
      "172.15.0.1",
      "172.32.0.1",
      "100.63.0.1",
      "100.128.0.1",
      "2606:4700::1111",
      "::ffff:8.8.8.8",
    ]) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });
});
