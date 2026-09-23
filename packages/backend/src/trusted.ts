/**
 * Trusted networks: requests from these addresses count as the owner without
 * a token (THIRDLIGHT_TRUSTED_NETWORKS). For a single-user install that is
 * only reachable on the owner's own network.
 *
 * Behind a reverse proxy the socket address is the proxy's, so for a request
 * from a listed proxy (THIRDLIGHT_TRUSTED_PROXIES) the client is the rightmost
 * X-Forwarded-For address that is not itself a listed proxy. A request from a
 * proxy that forwards no client address is never trusted — the proxy's own
 * (local) address does not stand in for an unknown client. IPv4 ranges only
 * (plus the IPv6 loopback `::1` and IPv4-mapped `::ffff:a.b.c.d`).
 */

export interface Cidr {
  readonly base: number;
  readonly mask: number;
}

function ipv4(text: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (m === null) return null;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return (((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0);
}

/** Normalize a socket/forwarded address: `::ffff:1.2.3.4` → `1.2.3.4`, `::1` → `127.0.0.1`. */
export function normalizeAddress(text: string): string {
  const t = text.trim().replace(/^\[|\]$/g, '');
  if (t === '::1') return '127.0.0.1';
  return t.startsWith('::ffff:') ? t.slice(7) : t;
}

/** Parse `a.b.c.d/n` or a single `a.b.c.d`; `null` when malformed. */
export function parseCidr(text: string): Cidr | null {
  const [addr, bits] = text.trim().split('/');
  const base = ipv4(normalizeAddress(addr ?? ''));
  if (base === null) return null;
  const n = bits === undefined ? 32 : Number(bits);
  if (!Number.isInteger(n) || n < 0 || n > 32 || (bits !== undefined && !/^\d+$/.test(bits))) return null;
  const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

/** Parse a comma-separated list; throws naming the first bad entry. */
export function parseCidrList(text: string | undefined): Cidr[] {
  if (text === undefined || text.trim() === '') return [];
  return text.split(',').map((entry) => {
    const c = parseCidr(entry);
    if (c === null) throw new Error(`not an IPv4 address or range: "${entry.trim()}"`);
    return c;
  });
}

export function inRanges(address: string, ranges: readonly Cidr[]): boolean {
  const ip = ipv4(normalizeAddress(address));
  if (ip === null) return false;
  return ranges.some((r) => ((ip & r.mask) >>> 0) === r.base);
}

/**
 * The client address of a request: the socket peer, or — when the peer is a
 * trusted proxy — the rightmost forwarded address that is not a trusted proxy.
 * `null` when a trusted proxy forwarded no usable client address.
 */
export function clientAddress(socketAddress: string | undefined, forwardedFor: string | string[] | undefined, proxies: readonly Cidr[]): string | null {
  if (socketAddress === undefined) return null;
  const peer = normalizeAddress(socketAddress);
  if (!inRanges(peer, proxies)) return peer;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  if (header === undefined) return null;
  const hops = header.split(',').map(normalizeAddress).filter((h) => h.length > 0);
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    if (!inRanges(hops[i]!, proxies)) return ipv4(hops[i]!) === null ? null : hops[i]!;
  }
  return null;
}

/** Is this request from a trusted network (see the module comment)? */
export function isTrustedRequest(
  req: { socket: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined> },
  networks: readonly Cidr[],
  proxies: readonly Cidr[],
): boolean {
  if (networks.length === 0) return false;
  const client = clientAddress(req.socket.remoteAddress, req.headers['x-forwarded-for'], proxies);
  return client !== null && inRanges(client, networks);
}
