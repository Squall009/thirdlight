/**
 * KTX2 encoding on import — the shared PNG decoder on texture sources (colour
 * types and depths, tRNS, Adam7, the inflate cap) and the encoder's output (ETC1S sRGB for
 * colour, UASTC linear for normal maps, a full mip chain), in-process.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';
import { ktx2Info } from '@thirdlight/asset-pipeline';
import { decodePngRgba } from '@thirdlight/project-model/png';

import { createWorkerTextureEncoder, encodeKtx2, KTX2_ENCODER, packKtx2 } from './texture-encode';

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

/** Node's inflate with the cap the backend uses, and the decoder's own pure one. */
const INFLATERS = [
  ['node:zlib', (d: Uint8Array, maxOut: number): Uint8Array => inflateSync(d, { maxOutputLength: maxOut })],
  ['pure', undefined],
] as const;
function decode(bytes: Uint8Array, inflate?: (d: Uint8Array, maxOut: number) => Uint8Array): { width: number; height: number; data: Uint8Array } {
  const r = decodePngRgba(bytes, { maxPixels: 4096 * 4096, ...(inflate ? { inflate } : {}) });
  if (!r.ok) throw new Error(r.message);
  return { width: r.png.width, height: r.png.height, data: r.png.rgba };
}

/**
 * A zlib stream of `repeats` × 258 zero bytes (+1) in about 13 bits per 258
 * bytes: one fixed-Huffman block, a literal 0 then length-258 distance-1
 * copies. The Adler-32 is left zero (a capped inflate stops long before it).
 */
function zeroBomb(repeats: number): Uint8Array {
  const out = new Uint8Array(Math.ceil((3 + 8 + repeats * 13 + 7) / 8) + 8);
  let bit = 0;
  const put = (v: number, n: number): void => {
    for (let i = 0; i < n; i++, bit++) if ((v >> i) & 1) out[2 + (bit >> 3)]! |= 1 << (bit & 7);
  };
  // Huffman codes go most significant bit first.
  const code = (c: number, n: number): void => {
    for (let i = n - 1; i >= 0; i--, bit++) if ((c >> i) & 1) out[2 + (bit >> 3)]! |= 1 << (bit & 7);
  };
  out[0] = 0x78;
  out[1] = 0x9c;
  put(1, 1); // last block
  put(1, 2); // fixed Huffman
  code(0x30, 8); // literal 0
  for (let r = 0; r < repeats; r++) {
    code(0xc5, 8); // length symbol 285: 258
    code(0, 5); // distance code 0: 1
  }
  code(0, 7); // end of block
  return out.subarray(0, 2 + Math.ceil(bit / 8) + 4);
}

describe('the shared PNG decoder on texture sources', () => {
  for (const [name, inflate] of INFLATERS) {
    it(`reads RGBA, palette + tRNS, 1-bit grey, 16-bit RGB and grey tRNS (${name} inflate)`, () => {
      const a = decode(rgbaPng(2, 1, (x) => (x === 0 ? [10, 20, 30, 40] : [250, 240, 230, 220])), inflate);
      expect([...a.data]).toEqual([10, 20, 30, 40, 250, 240, 230, 220]);
      const pal = decode(png(2, 1, 8, 3, [new Uint8Array([0, 1])], [chunk('PLTE', new Uint8Array([255, 0, 0, 0, 0, 255])), chunk('tRNS', new Uint8Array([0]))]), inflate);
      expect([...pal.data]).toEqual([255, 0, 0, 0, 0, 0, 255, 255]);
      const bits = decode(png(8, 1, 1, 0, [new Uint8Array([0b10100000])]), inflate);
      expect([...bits.data].filter((_, i) => i % 4 === 0)).toEqual([255, 0, 255, 0, 0, 0, 0, 0]);
      const deep = decode(png(1, 1, 16, 2, [new Uint8Array([0xff, 0x00, 0x80, 0x00, 0x00, 0xff])]), inflate);
      expect([...deep.data]).toEqual([255, 128, 0, 255]);
      const key = decode(png(2, 1, 8, 0, [new Uint8Array([7, 9])], [chunk('tRNS', new Uint8Array([0, 7]))]), inflate);
      expect([...key.data]).toEqual([7, 7, 7, 0, 9, 9, 9, 255]);
    });

    it(`reads an Adam7-interlaced image like the plain one (${name} inflate)`, () => {
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
      const img = decode(png(3, 3, 8, 0, rows, [], 1), inflate);
      expect([...img.data].filter((_, i) => i % 4 === 0)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      // One byte more than every pass's rows is refused: the cap is exact.
      expect(() => decode(png(3, 3, 8, 0, [...rows, new Uint8Array(0)], [], 1), inflate)).toThrow();
    });
  }

  it('refuses what it cannot read', () => {
    expect(() => decode(new Uint8Array([1, 2, 3]))).toThrow(/not a PNG/);
  });

  // A 16 × 16 grey image (272 bytes of scanlines) whose 1.6 MB stream inflates
  // to ~258 MB: refused at the header's size, without allocating the rest.
  const bomb = (() => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(16, 0);
    ihdr.writeUInt32BE(16, 4);
    ihdr[8] = 8;
    ihdr[9] = 0;
    return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zeroBomb(1_000_000)), chunk('IEND', new Uint8Array(0))]));
  })();

  it('checks the crafted stream really expands (uncapped, in a bounded probe)', () => {
    // 16 MiB of it inflates without error: the stream is valid deflate far past 272 bytes.
    const zStart = 8 + 25 + 8;
    const z = bomb.subarray(zStart, bomb.length - 12 - 4);
    expect(() => inflateSync(z, { maxOutputLength: 16 << 20 })).toThrow(/larger than|too large/i);
  });

  it('refuses a high-ratio PNG in KTX2 encode and pack without a large allocation', async () => {
    const before = process.memoryUsage().arrayBuffers;
    const enc = await encodeKtx2(bomb, 'color');
    expect(enc).toMatchObject({ ok: false, code: 'texture_encode_failed' });
    const pack = await packKtx2([bomb], [[{ source: 0, channel: 0 }, { value: 0 }, { value: 0 }, { value: 255 }]], 'data');
    expect(pack).toMatchObject({ ok: false, code: 'texture_encode_failed' });
    const pure = decodePngRgba(bomb);
    expect(pure).toMatchObject({ ok: false, message: expect.stringMatching(/larger than expected/) });
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 << 20);
  });
});

describe('encodeKtx2', () => {
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

describe('the encoder worker', () => {
  // The worker script the build makes next to the backend bundle (the deployment's encoder).
  const workerUrl = new URL('../../../dist/backend/ktx2-worker.mjs', import.meta.url);
  const checker = rgbaPng(64, 64, (x, y) => ((x >> 3) + (y >> 3)) % 2 === 0 ? [240, 60, 60, 255] : [40, 40, 200, 255]);

  it('ends once idle, giving its memory back, and starts again for the next encode', async () => {
    const enc = createWorkerTextureEncoder(workerUrl, { idleMs: 200 });
    try {
      const first = await enc.encode(checker, 'color');
      expect(first.ok, JSON.stringify(first).slice(0, 200)).toBe(true);
      expect(enc.workerRunning).toBe(true);
      await expect.poll(() => enc.workerRunning, { timeout: 5_000 }).toBe(false);
      // Jobs queued together keep one worker; both answer.
      const [a, b] = await Promise.all([enc.encode(checker, 'color'), enc.encode(checker, 'data')]);
      expect([a.ok, b.ok]).toEqual([true, true]);
      if (first.ok && a.ok) expect(Buffer.from(a.ktx2).equals(Buffer.from(first.ktx2))).toBe(true);
      expect(enc.workerRunning).toBe(true);
    } finally {
      enc.dispose?.();
    }
    expect(enc.workerRunning).toBe(false);
  }, 60_000);

  it('a job that arrives while an idle worker is ending gets a new worker and its answer', async () => {
    const enc = createWorkerTextureEncoder(workerUrl, { idleMs: 0 });
    try {
      for (let i = 0; i < 4; i++) {
        const r = await enc.encode(checker, 'color');
        expect(r.ok, JSON.stringify(r).slice(0, 200)).toBe(true);
        // The idle end fires first; the old worker's exit comes after the next job started a new one.
        await new Promise((done) => setTimeout(done, 1));
      }
    } finally {
      enc.dispose?.();
    }
  }, 60_000);
});
