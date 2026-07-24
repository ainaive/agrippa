import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { ProviderCredentialError } from "@agrippa/orchestration";

/**
 * SSRF guard for provider base URLs: the executor subprocess sends a
 * decrypted API key to this host, so every resolved address must be ordinary
 * global-unicast space. Checked at credential materialization (per step); a
 * rebind after the check remains possible (TOCTOU, recorded in ADR-0013) —
 * this raises the bar, it is not a network boundary.
 */

const nonPublicV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // this network / unspecified
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (incl. cloud metadata)
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // deprecated 6to4 relay
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + limited broadcast
] as const) {
  nonPublicV4.addSubnet(network, prefix, "ipv4");
}

const nonPublicV6 = new BlockList();
for (const [network, prefix] of [
  ["::", 96], // unspecified, loopback, and IPv4-compatible
  ["::ffff:0:0", 96], // IPv4-mapped
  ["64:ff9b::", 96], // IPv4/IPv6 translation
  ["64:ff9b:1::", 48], // local-use translation
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo
  ["2001:2::", 48], // benchmarking
  ["2001:10::", 28], // deprecated ORCHID
  ["2001:20::", 28], // ORCHIDv2
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["3fff::", 20], // documentation
  ["5f00::", 16], // segment-routing SIDs
  ["fc00::", 7], // unique-local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
] as const) {
  nonPublicV6.addSubnet(network, prefix, "ipv6");
}

/** True only for a syntactically valid, ordinary global-unicast address. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !nonPublicV4.check(ip, "ipv4");
  if (family === 6) return !nonPublicV6.check(ip, "ipv6");
  return false;
}

type LookupResult = Array<{ address: string; family: number }>;
export type HostLookup = (hostname: string, options: { all: true }) => Promise<LookupResult>;

function isPermanentLookupFailure(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const code = (err as { code?: unknown }).code;
  return code === "ENOTFOUND" || code === "ENODATA";
}

/** Resolve the host and reject when ANY address is not global-unicast. */
export async function assertPublicHost(
  hostname: string,
  resolve: HostLookup = lookup,
): Promise<void> {
  let addresses: LookupResult;
  try {
    addresses = await resolve(hostname, { all: true });
  } catch (err) {
    if (isPermanentLookupFailure(err)) {
      throw new ProviderCredentialError(`provider base URL host '${hostname}' does not resolve`);
    }
    throw err;
  }
  if (addresses.length === 0) {
    throw new ProviderCredentialError(`provider base URL host '${hostname}' does not resolve`);
  }
  for (const { address } of addresses) {
    if (!isPublicAddress(address)) {
      throw new ProviderCredentialError(
        `provider base URL host '${hostname}' resolves to a non-public address (${address})`,
      );
    }
  }
}
