/**
 * The asset thumbnail cache (a data-root cache, never project state).
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { checkThumbnailPng, createThumbnailCache, thumbnailKey } from './thumbnails';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A zlib stream of stored (uncompressed) blocks — enough for a test PNG. */
function stored(raw: Buffer): Buffer {
  const parts: Buffer[] = [Buffer.from([0x78, 0x01])];
  for (let off = 0; off < raw.length || off === 0; off += 65535) {
    const block = raw.subarray(off, off + 65535);
    const last = off + 65535 >= raw.length ? 1 : 0;
    const head = Buffer.alloc(5);
    head[0] = last;
    head.writeUInt16LE(block.length, 1);
    head.writeUInt16LE(~block.length & 0xffff, 3);
    parts.push(head, block);
    if (raw.length === 0) break;
  }
  let a = 1;
  let b = 0;
  for (const x of raw) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(((b << 16) | a) >>> 0);
  parts.push(adler);
  return Buffer.concat(parts);
}
function png(w: number, h: number): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', stored(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const DIGEST = 'ab'.repeat(32);

describe('thumbnail cache', () => {
  it('stores and reads a PNG per (project, digest, piece) under <dataRoot>/cache/thumbnails', () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-thumbs-'));
    dirs.push(root);
    const cache = createThumbnailCache(root);
    expect(cache.read('demo', DIGEST, null)).toBeNull();
    const file = png(128, 128);
    expect(cache.write('demo', DIGEST, null, file)).toBeNull();
    expect(cache.write('demo', DIGEST, 'rock', png(64, 64))).toBeNull();
    expect(Buffer.from(cache.read('demo', DIGEST, null)!)).toEqual(Buffer.from(file));
    expect(cache.read('demo', DIGEST, 'rock')!.byteLength).toBeGreaterThan(0);
    expect(cache.read('demo', DIGEST, 'bush')).toBeNull();
    expect(existsSync(join(root, 'cache', 'thumbnails', 'demo', DIGEST, `${thumbnailKey('rock')}.png`))).toBe(true);
    expect(thumbnailKey('rock')).toMatch(/^p-[0-9a-f]{32}$/);
  });

  it('refuses non-PNG bytes, oversize images, bad ids and path tricks', () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-thumbs-'));
    dirs.push(root);
    const cache = createThumbnailCache(root);
    expect(cache.write('demo', DIGEST, null, new TextEncoder().encode('not a png at all, just some text.'))).toMatch(/PNG/);
    expect(cache.write('demo', DIGEST, null, png(1024, 8))).toMatch(/pixels/);
    expect(cache.write('../x', DIGEST, null, png(8, 8))).toMatch(/invalid/);
    expect(cache.write('demo', '../../etc', null, png(8, 8))).toMatch(/invalid/);
    expect(cache.read('demo', '../../etc', null)).toBeNull();
    expect(checkThumbnailPng(png(8, 8))).toBeNull();
  });
});
