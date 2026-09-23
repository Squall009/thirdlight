import { describe, expect, it } from 'vitest';

import { clientAddress, inRanges, isTrustedRequest, parseCidr, parseCidrList } from './trusted';

const lan = parseCidrList('10.0.0.0/16, 127.0.0.1');
const proxy = parseCidrList('10.0.30.201');
const req = (remoteAddress: string, xff?: string) => ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });

describe('trusted networks', () => {
  it('parses ranges and single addresses; refuses junk', () => {
    expect(parseCidr('10.0.0.0/16')).toEqual({ base: 0x0a000000, mask: 0xffff0000 });
    expect(parseCidr('10.0.30.201')).toEqual({ base: 0x0a001ec9, mask: 0xffffffff });
    for (const bad of ['10.0.0/16', '10.0.0.0/33', '300.1.1.1', 'fe80::1/64', '10.0.0.0/x']) expect(parseCidr(bad), bad).toBeNull();
    expect(() => parseCidrList('10.0.0.0/16,nope')).toThrow(/nope/);
  });

  it('matches IPv4, IPv4-mapped and the IPv6 loopback', () => {
    expect(inRanges('10.0.10.145', lan)).toBe(true);
    expect(inRanges('::ffff:10.0.10.145', lan)).toBe(true);
    expect(inRanges('::1', lan)).toBe(true);
    expect(inRanges('10.1.0.1', lan)).toBe(false);
    expect(inRanges('203.0.113.9', lan)).toBe(false);
  });

  it('a direct LAN client is trusted; an outside one is not', () => {
    expect(isTrustedRequest(req('10.0.10.145'), lan, proxy)).toBe(true);
    expect(isTrustedRequest(req('203.0.113.9'), lan, proxy)).toBe(false);
    expect(isTrustedRequest(req('10.0.10.145'), [], proxy)).toBe(false); // nothing configured: nothing trusted
  });

  it('behind the proxy the forwarded client decides; the proxy alone never does', () => {
    expect(clientAddress('10.0.30.201', '10.0.10.145', proxy)).toBe('10.0.10.145');
    expect(isTrustedRequest(req('10.0.30.201', '10.0.10.145'), lan, proxy)).toBe(true);
    expect(isTrustedRequest(req('10.0.30.201', '203.0.113.9'), lan, proxy)).toBe(false);
    expect(isTrustedRequest(req('10.0.30.201'), lan, proxy)).toBe(false);
    // A client cannot vouch for itself by prepending a LAN address: the rightmost non-proxy hop counts.
    expect(isTrustedRequest(req('10.0.30.201', '10.0.10.145, 203.0.113.9'), lan, proxy)).toBe(false);
    // A forwarded header from a peer that is not a listed proxy is ignored.
    expect(isTrustedRequest(req('203.0.113.9', '10.0.10.145'), lan, proxy)).toBe(false);
  });
});
