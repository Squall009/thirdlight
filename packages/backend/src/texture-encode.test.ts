/**
 * Phase 25.19: KTX2 encoding on import — the PNG decoder (colour types and
 * depths, palette with tRNS, Adam7) and the encoder's output (ETC1S sRGB for
 * colour, UASTC linear for normal maps, a full mip chain), in-process.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';
import { ktx2Info } from '@thirdlight/asset-pipeline';

import { decodePng } from './png-decode';
import { encodeKtx2, KTX2_ENCODER } from './texture-encode';

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}
/** A PNG from raw scanlines (each row: filter byte 0 + the packed samples). */
function png(width: number, height: number, depth: number, colorType: number, rows: Uint8Array[], extra: Buffer[] = [], interlace = 0): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  const raw = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([0]), Buffer.from(r)])));
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]));
}
function rgbaPng(width: number, height: number, px: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const r = new Uint8Array(width * 4);
    for (let x = 0; x < width; x++) r.set(px(x, y), x * 4);
    rows.push(r);
  }
  return png(width, height, 8, 6, rows);
}

describe('decodePng (phase 25.19)', () => {
  it('reads RGBA, palette + tRNS, 1-bit grey and 16-bit RGB', () => {
    const a = decodePng(rgbaPng(2, 1, (x) => (x === 0 ? [10, 20, 30, 40] : [250, 240, 230, 220])));
    expect([...a.data]).toEqual([10, 20, 30, 40, 250, 240, 230, 220]);
    const pal = decodePng(png(2, 1, 8, 3, [new Uint8Array([0, 1])], [chunk('PLTE', new Uint8Array([255, 0, 0, 0, 0, 255])), chunk('tRNS', new Uint8Array([0]))]));
    expect([...pal.data]).toEqual([255, 0, 0, 0, 0, 0, 255, 255]);
    const bits = decodePng(png(8, 1, 1, 0, [new Uint8Array([0b10100000])]));
    expect([...bits.data].filter((_, i) => i % 4 === 0)).toEqual([255, 0, 255, 0, 0, 0, 0, 0]);
    const deep = decodePng(png(1, 1, 16, 2, [new Uint8Array([0xff, 0x00, 0x80, 0x00, 0x00, 0xff])]));
    expect([...deep.data]).toEqual([255, 128, 0, 255]);
  });

  it('reads an Adam7-interlaced image like the plain one', () => {
    // 3 × 3 grey, interlaced: passes 1 (0,0), 4 (0,2)? — pass 1 (x0 y0), pass 6 (x1 y0 step 2), pass 7 (rows 1), …
    const plain = [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ];
    const passes: [number, number, number, number][] = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
    const rows: Uint8Array[] = [];
    for (const [x0, y0, dx, dy] of passes) {
      for (let y = y0; y < 3; y += dy) {
        const row: number[] = [];
        for (let x = x0; x < 3; x += dx) row.push(plain[y]![x]!);
        if (row.length > 0) rows.push(new Uint8Array(row));
      }
    }
    const img = decodePng(png(3, 3, 8, 0, rows, [], 1));
    expect([...img.data].filter((_, i) => i % 4 === 0)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('refuses what it cannot read', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/not a PNG/);
  });
});

describe('encodeKtx2 (phase 25.19)', () => {
  const checker = rgbaPng(64, 32, (x, y) => ((x >> 3) + (y >> 3)) % 2 === 0 ? [240, 60, 60, 255] : [40, 40, 200, 255]);
  /** The DFD's transfer function: 2 = sRGB, 1 = linear. */
  const transfer = (k: Uint8Array): number => k[new DataView(k.buffer, k.byteOffset).getUint32(48, true) + 14]!;

  it('colour: ETC1S, sRGB, every mip level down to 1 × 1', async () => {
    const r = await encodeKtx2(checker, 'color');
    expect(r.ok, JSON.stringify(r).slice(0, 200)).toBe(true);
    if (!r.ok) return;
    expect(r.source).toEqual({ format: 'png', width: 64, height: 32 });
    expect(ktx2Info(r.ktx2)).toEqual({ width: 64, height: 32, levels: 7, codec: 'etc1s' });
    expect(transfer(r.ktx2)).toBe(2);
  }, 60_000);

  it('normal: UASTC, linear, the mip chain', async () => {
    const flat = rgbaPng(32, 32, () => [128, 128, 255, 255]);
    const r = await encodeKtx2(flat, 'normal');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ktx2Info(r.ktx2)).toEqual({ width: 32, height: 32, levels: 6, codec: 'uastc' });
    expect(transfer(r.ktx2)).toBe(1);
  }, 60_000);

  it('refuses WebP, KTX2 and garbage with a reason; names the pinned encoder', async () => {
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(await encodeKtx2(webp, 'color')).toMatchObject({ ok: false, code: 'texture_encode_unsupported', message: expect.stringMatching(/PNG/) });
    expect(await encodeKtx2(new Uint8Array([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]), 'color')).toMatchObject({ ok: false, message: expect.stringMatching(/already KTX2/) });
    expect((await encodeKtx2(new Uint8Array([1, 2, 3]), 'color')).ok).toBe(false);
    // The recorded version is the installed pin's.
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'node_modules', 'ktx2-encoder', 'package.json'), 'utf8')) as { version: string };
    expect(KTX2_ENCODER.version).toBe(pkg.version);
  });
});
