/**
 * Packing from KTX2 sources, in-process and through the encoder worker. The
 * sources are real KTX2 files made by the backend's own encoder
 * (`encodeKtx2`, the same as a KTX2 import). UASTC layers are joined as
 * stored: each mip level of the array, decoded, is the sources' levels side
 * by side (digests equal), and the transcoder reads every layer's texels back
 * unchanged. ETC1S layers are transcoded and encoded again, and flagged;
 * a lossless PNG given for a source is read instead and the layer is not.
 */
import { createHash } from 'node:crypto';
import { deflateSync, zstdCompressSync } from 'node:zlib';

import { ktx2Info } from '@thirdlight/asset-pipeline';
import * as ktx2Encoder from 'ktx2-encoder';
import { beforeAll, describe, expect, it } from 'vitest';

import { joinUastcLayers, ktx2KeyValues, ktx2LevelData, ktx2LevelDigests, KTX2_TRANSFER_LINEAR, readKtx2, writeKtx2, type Ktx2Container } from './ktx2-container';
import { createWorkerTextureEncoder, encodeKtx2, packKtx2, type Ktx2Mode, type PackLayer } from './texture-encode';

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
/** An RGBA PNG of `px`. */
function png(width: number, height: number, px: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const r = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x++) r.set(px(x, y), 1 + x * 4);
    rows.push(r);
  }
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', new Uint8Array(0))]));
}

/** Three different images: a gradient, a checker, rings. */
const W = 64;
const H = 32;
const IMAGES = [
  png(W, H, (x, y) => [x * 4, y * 8, 128, 255]),
  png(W, H, (x, y) => (((x >> 3) + (y >> 3)) % 2 === 0 ? [230, 40, 40, 255] : [30, 50, 210, 120])),
  png(W, H, (x, y) => [Math.round(127 + 127 * Math.sin(Math.hypot(x - 32, y - 16) / 3)), 200, 90, 255]),
];

async function encoded(bytes: Uint8Array, mode: Ktx2Mode): Promise<Uint8Array> {
  const r = await encodeKtx2(bytes, mode);
  if (!r.ok) throw new Error(r.message);
  return r.ktx2;
}

/** Every layer's whole RGBA from source i. */
const whole = (sources: readonly number[]): PackLayer[] => sources.map((s) => [0, 1, 2, 3].map((channel) => ({ source: s, channel })) as unknown as PackLayer);

interface Transcoder {
  KTX2File: new (b: Uint8Array) => {
    startTranscoding(): boolean;
    getImageTranscodedSizeInBytes(level: number, layer: number, face: number, format: number): number;
    transcodeImage(dst: Uint8Array, level: number, layer: number, face: number, format: number, a: number, c0: number, c1: number): number;
    close(): void;
    delete(): void;
  };
  transcoder_texture_format: { cTFRGBA32: { value: number } };
}
let basis: Transcoder;
beforeAll(async () => {
  const Loader = (ktx2Encoder as unknown as { NodeBasisEncoder: new () => { init(): Promise<unknown> } }).NodeBasisEncoder;
  basis = (await new Loader().init()) as Transcoder;
});
/** The texels Basis Universal decodes from `bytes` at (level, layer), as a digest. */
function texelDigest(bytes: Uint8Array, level: number, layer: number): string {
  const f = new basis.KTX2File(bytes);
  try {
    expect(f.startTranscoding()).toBeTruthy();
    const fmt = basis.transcoder_texture_format.cTFRGBA32.value;
    const out = new Uint8Array(f.getImageTranscodedSizeInBytes(level, layer, 0, fmt));
    expect(f.transcodeImage(out, level, layer, 0, fmt, 0, -1, -1)).toBeTruthy();
    return createHash('sha256').update(out).digest('hex');
  } finally {
    f.close();
    f.delete();
  }
}
/** Layer `layer`'s slice of every decoded mip level of an array, as digests. */
function layerLevelDigests(bytes: Uint8Array, layer: number, layers: number): string[] {
  const c = readKtx2(bytes)!;
  return c.levels.map((_, l) => {
    const data = ktx2LevelData(c, l);
    const n = data.length / layers;
    return createHash('sha256').update(data.subarray(layer * n, (layer + 1) * n)).digest('hex');
  });
}

describe('packing from KTX2 sources', () => {
  it('joins UASTC layers without re-encoding: every decoded level and texel is the sources\'', async () => {
    const sources = await Promise.all(IMAGES.map((b) => encoded(b, 'data')));
    const t0 = performance.now();
    const r = await packKtx2(sources, whole([0, 1, 2]), 'data');
    const ms = performance.now() - t0;
    expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true);
    if (!r.ok) return;
    expect(r).toMatchObject({ joined: true, reencoded: [false, false, false], width: W, height: H, layers: 3 });
    expect(ktx2Info(r.ktx2)).toEqual({ width: W, height: H, levels: 7, codec: 'uastc', layers: 3 });
    for (let i = 0; i < 3; i++) {
      const own = ktx2LevelDigests(readKtx2(sources[i]!)!);
      expect(layerLevelDigests(r.ktx2, i, 3)).toEqual(own);
      for (let l = 0; l < own.length; l++) expect(texelDigest(r.ktx2, l, i)).toBe(texelDigest(sources[i]!, l, 0));
    }
    // About the sources' size together (one Zstandard stream per level instead of three).
    const apart = sources.reduce((n, s) => n + s.length, 0);
    expect(r.ktx2.length).toBeLessThan(apart * 1.1);
    console.info(`joined 3 UASTC ${W}×${H} layers in ${ms.toFixed(1)} ms: ${apart} B apart → ${r.ktx2.length} B`);
  }, 60_000);

  it('joins normal maps (linear UASTC); an sRGB colour encoding re-encodes them, flagged', async () => {
    const normals = await Promise.all([png(W, H, () => [128, 128, 255, 255]), png(W, H, (x) => [100 + x, 140, 240, 255])].map((b) => encoded(b, 'normal')));
    const joined = await packKtx2(normals, whole([0, 1]), 'normal');
    expect(joined).toMatchObject({ ok: true, joined: true, reencoded: [false, false] });
    // The colour encoding wants sRGB texels: the linear ones are transcoded and encoded as ETC1S.
    const colour = await packKtx2(normals, whole([0, 1]), 'color');
    expect(colour).toMatchObject({ ok: true, joined: false, reencoded: [true, true] });
    if (colour.ok) expect(ktx2Info(colour.ktx2)).toMatchObject({ codec: 'etc1s', layers: 2 });
  }, 60_000);

  it('re-encodes ETC1S layers once and flags them; a lossless PNG given is read instead', async () => {
    const etc = await Promise.all(IMAGES.slice(0, 2).map((b) => encoded(b, 'color')));
    const r = await packKtx2(etc, whole([0, 1]), 'color');
    expect(r).toMatchObject({ ok: true, joined: false, reencoded: [true, true] });
    if (!r.ok) return;
    expect(ktx2Info(r.ktx2)).toEqual({ width: W, height: H, levels: 7, codec: 'etc1s', layers: 2 });
    // The checker's red and blue survive the second generation.
    const f = new basis.KTX2File(r.ktx2);
    f.startTranscoding();
    const fmt = basis.transcoder_texture_format.cTFRGBA32.value;
    const px = new Uint8Array(f.getImageTranscodedSizeInBytes(0, 1, 0, fmt));
    f.transcodeImage(px, 0, 1, 0, fmt, 0, -1, -1);
    f.close();
    f.delete();
    expect(px[0]!).toBeGreaterThan(180);
    expect(px[(8 * 4) + 2]!).toBeGreaterThan(160);
    // Layer 1's PNG found: only layer 2 is a second generation.
    const mixed = await packKtx2(etc, whole([0, 1]), 'color', [IMAGES[0]!, null]);
    expect(mixed).toMatchObject({ ok: true, joined: false, reencoded: [false, true] });
  }, 60_000);

  it('re-encodes when UASTC layers differ in size or a channel is repacked', async () => {
    const [a, b] = await Promise.all([encoded(IMAGES[0]!, 'data'), encoded(IMAGES[1]!, 'data')]);
    const small = await encoded(png(32, 32, () => [1, 2, 3, 255]), 'data');
    expect(joinUastcLayers([a, small], KTX2_TRANSFER_LINEAR)).toMatchObject({ ok: false, reason: expect.stringMatching(/layer 2 is 32×32/) });
    // Different sizes cannot be encoded together either.
    expect(await packKtx2([a, small], whole([0, 1]), 'data')).toMatchObject({ ok: false, message: expect.stringMatching(/one size/) });
    // Height (b's red) into a's alpha: a repack, so the layer is transcoded and encoded again.
    const repack = await packKtx2([a, b], [[{ source: 0, channel: 0 }, { source: 0, channel: 1 }, { source: 0, channel: 2 }, { source: 1, channel: 0 }], [{ value: 0 }, { value: 0 }, { value: 0 }, { value: 255 }]], 'data');
    expect(repack).toMatchObject({ ok: true, joined: false, reencoded: [true, false] });
  }, 60_000);

  it('the deployment\'s worker takes KTX2 sources and their lossless originals', async () => {
    const enc = createWorkerTextureEncoder(new URL('../../../dist/backend/ktx2-worker.mjs', import.meta.url), { idleMs: 200 });
    try {
      const uastc = await Promise.all(IMAGES.slice(0, 2).map((b) => encoded(b, 'data')));
      const joined = await enc.pack(uastc, whole([0, 1]), 'data');
      expect(joined).toMatchObject({ ok: true, joined: true, reencoded: [false, false] });
      const etc = await Promise.all(IMAGES.slice(0, 2).map((b) => encoded(b, 'color')));
      const mixed = await enc.pack(etc, whole([0, 1]), 'color', [null, IMAGES[1]!]);
      expect(mixed).toMatchObject({ ok: true, joined: false, reencoded: [true, false] });
    } finally {
      enc.dispose?.();
    }
  }, 60_000);
});

/** A KTX2 key/value block of `entries` (string values, NUL-terminated, each entry padded to 4 bytes). */
function kvdOf(entries: Record<string, string>): Uint8Array {
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(entries)) {
    const body = Buffer.from(`${k}\0${v}\0`, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(body.length, 0);
    parts.push(len, body, Buffer.alloc((4 - (body.length % 4)) % 4));
  }
  return new Uint8Array(Buffer.concat(parts));
}
/** `bytes` written again with `change` applied to its container (levels as stored unless given). */
function rewritten(bytes: Uint8Array, change: (c: Ktx2Container) => Partial<Ktx2Container>, levels?: { data: Uint8Array; uncompressed: number }[]): Uint8Array {
  const c = readKtx2(bytes)!;
  return writeKtx2({ ...c, ...change(c) }, levels ?? c.levels.map((l) => ({ data: l.stored, uncompressed: l.uncompressedByteLength })));
}

describe('KTX2 container checks', () => {
  it('a level declaring more bytes than its size is refused before inflating; inflation stops at the size', async () => {
    const src = await encoded(IMAGES[0]!, 'data');
    const c = readKtx2(src)!;
    // 64×32 UASTC: 16×8 blocks of 16 bytes.
    expect(ktx2LevelData(c, 0).length).toBe(16 * 8 * 16);
    const declared = rewritten(src, () => ({}), c.levels.map((l, i) => ({ data: l.stored, uncompressed: i === 0 ? 1 << 30 : l.uncompressedByteLength })));
    expect(() => ktx2LevelData(readKtx2(declared)!, 0)).toThrow(/declares 1073741824 bytes, not the 2048/);
    // A level that inflates to 64 MiB while declaring its true size: refused at the bound, not inflated.
    const bomb = zstdCompressSync(Buffer.alloc(64 * 1024 * 1024));
    const inflating = rewritten(src, () => ({}), c.levels.map((l, i) => ({ data: i === 0 ? new Uint8Array(bomb) : l.stored, uncompressed: l.uncompressedByteLength })));
    const before = process.memoryUsage().arrayBuffers;
    expect(() => ktx2LevelData(readKtx2(inflating)!, 0)).toThrow();
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * 1024 * 1024);
    expect(joinUastcLayers([src, inflating], KTX2_TRANSFER_LINEAR)).toMatchObject({ ok: false, reason: expect.stringMatching(/could not be decompressed/) });
  }, 60_000);

  it('layers differing in premultiplied alpha or orientation are not joined but encoded again; mips left to the loader stay so', async () => {
    const [a, b] = await Promise.all([encoded(IMAGES[0]!, 'data'), encoded(IMAGES[1]!, 'data')]);
    expect(joinUastcLayers([a, b], KTX2_TRANSFER_LINEAR).ok).toBe(true);
    const premultiplied = rewritten(b, (c) => {
      const dfd = new Uint8Array(c.dfd);
      dfd[15] = dfd[15]! | 1;
      return { dfd };
    });
    expect(readKtx2(premultiplied)!.dfdFlags & 1).toBe(1);
    expect(joinUastcLayers([a, premultiplied], KTX2_TRANSFER_LINEAR)).toMatchObject({ ok: false, reason: 'layer 2\'s alpha is premultiplied, layer 1\'s is not' });
    const up = rewritten(b, () => ({ kvd: kvdOf({ KTXorientation: 'ru', KTXwriter: 'test' }) }));
    expect(Buffer.from(ktx2KeyValues(readKtx2(up)!.kvd).get('KTXorientation')!).toString()).toBe('ru\0');
    expect(joinUastcLayers([a, up], KTX2_TRANSFER_LINEAR)).toMatchObject({ ok: false, reason: expect.stringMatching(/layer 2's orientation \(KTXorientation "ru"\) is not layer 1's \(""\)/) });
    // The same orientation written out ("rd", the default) on both joins.
    const rdA = rewritten(a, () => ({ kvd: kvdOf({ KTXorientation: 'rd' }) }));
    const rdB = rewritten(b, () => ({ kvd: kvdOf({ KTXorientation: 'rd' }) }));
    expect(joinUastcLayers([rdA, rdB], KTX2_TRANSFER_LINEAR).ok).toBe(true);
    // The pack falls back to transcoding and encoding, flagged.
    expect(await packKtx2([a, up], whole([0, 1]), 'data')).toMatchObject({ ok: true, joined: false, reencoded: [true, true] });
    // Level count 0 (one level stored, the loader makes the mips): kept by the join, not mixed with stored mips.
    const topOnly = (bytes: Uint8Array, mipsAtLoad: boolean): Uint8Array => {
      const c = readKtx2(bytes)!;
      return rewritten(bytes, () => ({ mipsAtLoad }), [{ data: c.levels[0]!.stored, uncompressed: c.levels[0]!.uncompressedByteLength }]);
    };
    const atLoad = (bytes: Uint8Array): Uint8Array => topOnly(bytes, true);
    const joined = joinUastcLayers([atLoad(a), atLoad(b)], KTX2_TRANSFER_LINEAR);
    expect(joined.ok).toBe(true);
    if (joined.ok) {
      expect(new DataView(joined.ktx2.buffer, joined.ktx2.byteOffset).getUint32(40, true)).toBe(0);
      expect(readKtx2(joined.ktx2)!.levels).toHaveLength(1);
    }
    expect(joinUastcLayers([topOnly(a, false), atLoad(b)], KTX2_TRANSFER_LINEAR)).toMatchObject({ ok: false, reason: expect.stringMatching(/layer 2 leaves its mips to the loader/) });
  }, 60_000);
});
