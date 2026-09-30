/**
 * A KTX2 file's levels by byte range: the parts a streamed texture is cut
 * into cover the file exactly, and the smaller files the page builds from
 * those parts (the mip tail, one level alone) transcode to the same pixels
 * as the whole file's levels. Encoded with the backend's encoder (ETC1S with
 * BasisLZ, UASTC with Zstandard) and transcoded with three's own Basis
 * transcoder, the one the pages load.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { buildKtx2Subset, ktx2LevelSize, planKtx2Parts, readKtx2Layout, type Ktx2Layout } from '../packages/project-model/src/ktx2-levels';
import { encodeKtx2 } from '../packages/backend/src/texture-encode';

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
/** An RGB PNG: a checkerboard of 4-texel squares over a gradient (so every level differs). */
function checkerPng(size: number): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const r = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const on = ((x >> 2) + (y >> 2)) % 2 === 0;
      r[1 + x * 3] = on ? 230 : 20;
      r[2 + x * 3] = Math.round((x / size) * 255);
      r[3 + x * 3] = Math.round((y / size) * 255);
    }
    rows.push(r);
  }
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', new Uint8Array(0))]));
}

interface BasisFile {
  getWidth(): number;
  getHeight(): number;
  getLevels(): number;
  startTranscoding(): boolean;
  getImageTranscodedSizeInBytes(l: number, layer: number, f: number, fmt: number): number;
  transcodeImage(dst: Uint8Array, l: number, layer: number, f: number, fmt: number, a: number, b: number, c: number): boolean;
  close(): void;
  delete(): void;
}
let basis: Promise<{ KTX2File: new (b: Uint8Array) => BasisFile }> | null = null;
/** three's Basis transcoder in Node (a classic script: run with Node's require, take its BASIS factory). */
function transcoder(): Promise<{ KTX2File: new (b: Uint8Array) => BasisFile }> {
  basis ??= (async () => {
    const dir = join(process.cwd(), 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');
    const factory = new Function('require', '__filename', '__dirname', `${readFileSync(join(dir, 'basis_transcoder.js'), 'utf8')}\n;return BASIS;`) as (r: NodeJS.Require, f: string, d: string) => (m: { wasmBinary: Uint8Array }) => Promise<{ initializeBasis(): void; KTX2File: new (b: Uint8Array) => BasisFile }>;
    const mod = await factory(createRequire(import.meta.url), join(dir, 'basis_transcoder.js'), dir)({ wasmBinary: new Uint8Array(readFileSync(join(dir, 'basis_transcoder.wasm'))) });
    mod.initializeBasis();
    return mod;
  })();
  return basis;
}
/** Every level of a KTX2 as RGBA8 (level 0 first). */
async function levelsRgba(ktx2: Uint8Array): Promise<{ width: number; levels: Uint8Array[] }> {
  const mod = await transcoder();
  const f = new mod.KTX2File(ktx2);
  try {
    expect(Boolean(f.startTranscoding())).toBe(true);
    const levels: Uint8Array[] = [];
    // 13: cTFRGBA32.
    for (let l = 0; l < f.getLevels(); l++) {
      const dst = new Uint8Array(f.getImageTranscodedSizeInBytes(l, 0, 0, 13));
      expect(Boolean(f.transcodeImage(dst, l, 0, 0, 13, 0, -1, -1))).toBe(true);
      levels.push(dst);
    }
    return { width: f.getWidth(), levels };
  } finally {
    f.close();
    f.delete();
  }
}

const reader = (file: Uint8Array) => (r: { offset: number; length: number }): Uint8Array => file.subarray(r.offset, r.offset + r.length);

describe('KTX2 levels by byte range', () => {
  for (const mode of ['color', 'normal'] as const) {
    it(`${mode === 'color' ? 'ETC1S (BasisLZ)' : 'UASTC (Zstandard)'}: parts cover the file, the tail and each level transcode as in the whole file`, async () => {
      const enc = await encodeKtx2(checkerPng(512), mode);
      expect(enc.ok).toBe(true);
      if (!enc.ok) return;
      const file = enc.ktx2;
      const r = readKtx2Layout(file);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const layout: Ktx2Layout = r.layout;
      expect(layout).toMatchObject({ width: 512, height: 512, supercompression: mode === 'color' ? 1 : 2 });
      expect(layout.levels).toHaveLength(10);
      // The header and index alone are enough to read the layout (what a streamed head holds).
      expect(readKtx2Layout(file.subarray(0, 80 + 24 * 10), file.length).ok).toBe(true);

      const parts = planKtx2Parts(layout, file.length, 128);
      expect(parts).not.toBeNull();
      if (parts === null) return;
      // Head: metadata and levels 2..9 (128 px down); then levels 1 and 0, one part each.
      expect(parts.map((p) => p.levels)).toEqual([[2, 3, 4, 5, 6, 7, 8, 9], [1], [0]]);
      let at = 0;
      for (const p of parts) {
        expect(p.offset).toBe(at);
        at += p.length;
        for (const l of p.levels) {
          const lv = layout.levels[l]!;
          expect(lv.offset).toBeGreaterThanOrEqual(p.offset);
          expect(lv.offset + lv.length).toBeLessThanOrEqual(p.offset + p.length);
        }
      }
      expect(at).toBe(file.length);
      expect(parts[0]!.offset + parts[0]!.length).toBeGreaterThanOrEqual(layout.metadataEnd);

      const whole = await levelsRgba(file);
      // Only the head's bytes are read for the tail file.
      const head = file.slice(0, parts[0]!.length);
      const tail = await levelsRgba(buildKtx2Subset(layout, 2, 9, reader(head)));
      expect(tail.width).toBe(128);
      expect(tail.levels).toHaveLength(8);
      for (let l = 0; l < 8; l++) expect(Buffer.compare(Buffer.from(tail.levels[l]!), Buffer.from(whole.levels[l + 2]!))).toBe(0);
      // Level 0 alone, from the head's metadata and its own part.
      const level0 = file.slice(parts[2]!.offset, parts[2]!.offset + parts[2]!.length);
      const one = await levelsRgba(
        buildKtx2Subset(layout, 0, 0, (range) => (range.offset >= parts[2]!.offset ? level0.subarray(range.offset - parts[2]!.offset, range.offset - parts[2]!.offset + range.length) : head.subarray(range.offset, range.offset + range.length))),
      );
      expect(one.width).toBe(512);
      expect(one.levels).toHaveLength(1);
      expect(Buffer.compare(Buffer.from(one.levels[0]!), Buffer.from(whole.levels[0]!))).toBe(0);
      expect(ktx2LevelSize(layout, 1)).toEqual({ width: 256, height: 256 });
    }, 120_000);
  }

  it('nothing to stream: a texture whose every level is in the tail, a single level', async () => {
    const enc = await encodeKtx2(checkerPng(64), 'color');
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;
    const r = readKtx2Layout(enc.ktx2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(planKtx2Parts(r.layout, enc.ktx2.length, 128)).toBeNull();
    expect(planKtx2Parts({ ...r.layout, levels: r.layout.levels.slice(0, 1) }, enc.ktx2.length, 1)).toBeNull();
  }, 60_000);

  it('refuses what is not a KTX2 or lies outside the file, with the reason', () => {
    expect(readKtx2Layout(new Uint8Array(100))).toEqual({ ok: false, message: 'not a KTX2 file' });
    const bytes = new Uint8Array(80 + 24);
    bytes.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
    const v = new DataView(bytes.buffer);
    v.setUint32(20, 16, true);
    v.setUint32(40, 1, true);
    v.setUint32(80, 200, true);
    v.setUint32(88, 10, true);
    expect(readKtx2Layout(bytes)).toMatchObject({ ok: false, message: 'KTX2 level 0 lies outside the file' });
    v.setUint32(40, 3, true);
    expect(readKtx2Layout(bytes)).toMatchObject({ ok: false, message: 'the KTX2 level index is cut short' });
  });
});
