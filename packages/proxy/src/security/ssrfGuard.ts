import { promises as dns } from "node:dns";
import { BlockList, isIPv4, isIPv6 } from "node:net";
import { BridgeError } from "@https2wss/protocol";

export const SSRF_DENY_REASONS = [
  "loopback",
  "link_local",
  "unspecified",
  "broadcast",
  "multicast",
  "metadata",
  "private_v4",
  "private_v6",
  "ipv4_mapped",
  "reserved",
] as const;

export type SsrfDenyReason = (typeof SSRF_DENY_REASONS)[number];

export interface SsrfGuardOptions {
  /** Inject a resolver for tests. Default: dns.lookup style that returns all addresses. */
  resolver?: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
  /** When true, private networks (10/8, 172.16/12, 192.168/16, fc00::/7) are allowed. Other denies still apply. */
  allowPrivateNetwork: boolean;
}

type DenyEntry = { reason: SsrfDenyReason };

/** Build a deny-map for quick IP classification. We use BlockList for subnet membership, plus a side-table for the reason. */
function buildDenyList(
  allowPrivateNetwork: boolean,
): Array<{ list: BlockList; reason: SsrfDenyReason }> {
  // Each group gets its own BlockList so we can report the reason.
  const groups: Array<{ list: BlockList; reason: SsrfDenyReason }> = [];

  function group(reason: SsrfDenyReason): BlockList {
    const bl = new BlockList();
    groups.push({ list: bl, reason });
    return bl;
  }

  // loopback
  const loopback = group("loopback");
  loopback.addSubnet("127.0.0.0", 8, "ipv4");
  loopback.addAddress("::1", "ipv6");

  // link-local
  const linkLocal = group("link_local");
  linkLocal.addSubnet("169.254.0.0", 16, "ipv4");
  linkLocal.addSubnet("fe80::", 10, "ipv6");

  // unspecified
  const unspecified = group("unspecified");
  unspecified.addAddress("0.0.0.0", "ipv4");
  unspecified.addAddress("::", "ipv6");

  // broadcast
  const broadcast = group("broadcast");
  broadcast.addAddress("255.255.255.255", "ipv4");

  // multicast
  const multicast = group("multicast");
  multicast.addSubnet("224.0.0.0", 4, "ipv4");
  multicast.addSubnet("ff00::", 8, "ipv6");

  // metadata — more specific than link-local; must also be checked when private is allowed
  const metadata = group("metadata");
  metadata.addAddress("169.254.169.254", "ipv4");
  metadata.addAddress("fd00:ec2::254", "ipv6");

  // reserved (240.0.0.0/4)
  const reserved = group("reserved");
  reserved.addSubnet("240.0.0.0", 4, "ipv4");

  // IPv4-mapped IPv6 ::ffff:0.0.0.0/96
  const ipv4mapped = group("ipv4_mapped");
  ipv4mapped.addSubnet("::ffff:0.0.0.0", 96, "ipv6");

  if (!allowPrivateNetwork) {
    const privateV4 = group("private_v4");
    privateV4.addSubnet("10.0.0.0", 8, "ipv4");
    privateV4.addSubnet("172.16.0.0", 12, "ipv4");
    privateV4.addSubnet("192.168.0.0", 16, "ipv4");

    const privateV6 = group("private_v6");
    privateV6.addSubnet("fc00::", 7, "ipv6");
  }

  return groups;
}

function classifyAddress(
  address: string,
  family: 4 | 6,
  groups: Array<{ list: BlockList; reason: SsrfDenyReason }>,
): DenyEntry | null {
  const netFamily = family === 4 ? "ipv4" : "ipv6";
  for (const g of groups) {
    // Skip the ipv4_mapped group when checking a native IPv4 address.
    // Node's BlockList matches ::ffff:0.0.0.0/96 against IPv4 family addresses
    // (as a quirk of the underlying implementation), which would cause all IPv4
    // addresses to be classified as ipv4_mapped. The ipv4_mapped group is only
    // relevant for IPv6 addresses that embed an IPv4 address.
    if (g.reason === "ipv4_mapped" && family === 4) {
      continue;
    }
    if (g.list.check(address, netFamily)) {
      return { reason: g.reason };
    }
  }
  return null;
}

async function defaultResolver(
  hostname: string,
): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
}

export class SsrfGuard {
  private readonly denyGroups: Array<{ list: BlockList; reason: SsrfDenyReason }>;
  private readonly resolver: (
    hostname: string,
  ) => Promise<Array<{ address: string; family: 4 | 6 }>>;

  constructor(opts: SsrfGuardOptions) {
    this.denyGroups = buildDenyList(opts.allowPrivateNetwork);
    this.resolver = opts.resolver ?? defaultResolver;
  }

  /** Resolves the hostname and verifies every returned IP is not blocked. */
  async assertAllowed(url: URL): Promise<void> {
    const hostname = url.hostname;

    // Detect if it is a literal IP — bypass resolver in that case.
    if (isIPv4(hostname)) {
      const entry = classifyAddress(hostname, 4, this.denyGroups);
      if (entry !== null) {
        throw new BridgeError("POLICY_DENIED", "upstream IP not allowed", {
          retryable: false,
          details: { hostname, address: hostname, reason: entry.reason },
        });
      }
      return;
    }

    // Strip brackets from IPv6 literals: [::1] → ::1
    const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
    if (isIPv6(bare)) {
      const entry = classifyAddress(bare, 6, this.denyGroups);
      if (entry !== null) {
        throw new BridgeError("POLICY_DENIED", "upstream IP not allowed", {
          retryable: false,
          details: { hostname, address: bare, reason: entry.reason },
        });
      }
      return;
    }

    // Hostname — resolve via DNS
    const addresses = await this.resolver(hostname);
    for (const { address, family } of addresses) {
      const entry = classifyAddress(address, family, this.denyGroups);
      if (entry !== null) {
        throw new BridgeError("POLICY_DENIED", "upstream IP not allowed", {
          retryable: false,
          details: { hostname, address, reason: entry.reason },
        });
      }
    }
  }
}
