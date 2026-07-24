import { lookup } from "node:dns/promises";
import { ProviderCredentialError } from "@agrippa/orchestration";

/**
 * SSRF guard for provider base URLs: the executor subprocess sends a
 * decrypted API key to this host, so a DNS name resolving into private
 * address space must never pass — the API's syntactic checks only reject IP
 * *literals*. Checked at credential materialization (per step); a rebind
 * after the check remains possible (TOCTOU, recorded in ADR-0013) — this
 * raises the bar, it is not a network boundary.
 */

/** Loopback / private / link-local / CGNAT / unspecified — v4 and v6. */
export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPrivateAddress(mapped[1] as string);
  if (ip.includes(":")) {
    const head = ip.toLowerCase();
    if (head === "::" || head === "::1") return true;
    // fc00::/7 (ULA) and fe80::/10 (link-local)
    return /^f[cd]/.test(head) || /^fe[89ab]/.test(head);
  }
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) return true; // unparseable → refuse
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** Resolve the host and reject when ANY address lands in private space. */
export async function assertPublicHost(hostname: string): Promise<void> {
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new ProviderCredentialError(`provider base URL host '${hostname}' does not resolve`);
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new ProviderCredentialError(
        `provider base URL host '${hostname}' resolves to a private address (${address})`,
      );
    }
  }
}
