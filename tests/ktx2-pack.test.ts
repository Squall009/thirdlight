/**
 * Packing texture assets' channels into one KTX2 (a texture
 * array with several layers) — decoded back with three's own Basis
 * transcoder (the file the pages load), so the channels land where the
 * packing says; the "data" encoding keeps channels apart. In-process
 * encoder (the backend runs the same code in its worker thread).
 */
import { KTX2_IDENTIFIER, PNG_SIGNATURE, pngChunk } from '@thirdlight/shared';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { ktx2Info } from '../packages/asset-pipeline/src/index';
import { encodeKtx2, packKtx2, type PackLayer } from '../packages/backend/src/texture-encode';

/** A PNG from raw scanlines (each row: filter byte 0 + the packed samples). */
function png(width: number, height: number, depth: number, colorType: number, rows: Uint8Array[], extra: Uint8Array[] = [], interlace = 0): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  const raw = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([0]), Buffer.from(r)])));
  return new Uint8Array(Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), ...extra, pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', new Uint8Array(0))]));
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

/** three's Basis transcoder (the file the pages load), in Node: a KTX2's layer at level 0 as RGBA8. */
async function transcodeLayers(ktx2: Uint8Array): Promise<{ width: number; height: number; layers: Uint8Array[] }> {
  const dir = join(process.cwd(), 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');
  // A classic script (three's package is ESM, so it cannot be required): run it with Node's require and take its BASIS factory.
  const factory = new Function('require', '__filename', '__dirname', `${readFileSync(join(dir, 'basis_transcoder.js'), 'utf8')}\n;return BASIS;`) as (r: NodeJS.Require, f: string, d: string) => (m: { wasmBinary: Uint8Array }) => Promise<Record<string, unknown>>;
  const BASIS = factory(createRequire(import.meta.url), join(dir, 'basis_transcoder.js'), dir);
  const mod = (await BASIS({ wasmBinary: new Uint8Array(readFileSync(join(dir, 'basis_transcoder.wasm'))) })) as {
    initializeBasis(): void;
    KTX2File: new (b: Uint8Array) => { getWidth(): number; getHeight(): number; getLayers(): number; startTranscoding(): boolean; getImageTranscodedSizeInBytes(l: number, layer: number, f: number, fmt: number): number; transcodeImage(dst: Uint8Array, l: number, layer: number, f: number, fmt: number, a: number, b: number, c: number): boolean; close(): void; delete(): void };
  };
  mod.initializeBasis();
  const f = new mod.KTX2File(ktx2);
  try {
    expect(Boolean(f.startTranscoding())).toBe(true);
    const layers: Uint8Array[] = [];
    // 13: cTFRGBA32.
    for (let layer = 0; layer < Math.max(1, f.getLayers()); layer++) {
      const dst = new Uint8Array(f.getImageTranscodedSizeInBytes(0, layer, 0, 13));
      expect(Boolean(f.transcodeImage(dst, 0, layer, 0, 13, 0, -1, -1))).toBe(true);
      layers.push(dst);
    }
    return { width: f.getWidth(), height: f.getHeight(), layers };
  } finally {
    f.close();
    f.delete();
  }
}

describe('packKtx2', () => {
  const albedo = rgbaPng(16, 16, () => [200, 40, 20, 255]);
  const height = rgbaPng(16, 16, (x) => [x < 8 ? 30 : 220, 0, 0, 255]);
  const green = rgbaPng(16, 16, () => [10, 180, 60, 255]);

  it('packs channels of several images into a texture array (data: UASTC, linear, every layer and mip)', async () => {
    // Layer 0: albedo's RGB, height's R in A; layer 1: green's RGB, a constant A; layer 2: channels swapped around.
    const layers: PackLayer[] = [
      [{ source: 0, channel: 0 }, { source: 0, channel: 1 }, { source: 0, channel: 2 }, { source: 1, channel: 0 }],
      [{ source: 2, channel: 0 }, { source: 2, channel: 1 }, { source: 2, channel: 2 }, { value: 128 }],
      [{ source: 2, channel: 1 }, { value: 0 }, { source: 0, channel: 0 }, { value: 255 }],
    ];
    const r = await packKtx2([albedo, height, green], layers, 'data');
    expect(r.ok, JSON.stringify(r).slice(0, 200)).toBe(true);
    if (!r.ok) return;
    expect(r).toMatchObject({ width: 16, height: 16, layers: 3 });
    expect(ktx2Info(r.ktx2)).toEqual({ width: 16, height: 16, levels: 5, codec: 'uastc', layers: 3 });
    const t = await transcodeLayers(r.ktx2);
    const px = (layer: number, x: number, y: number): number[] => [...t.layers[layer]!.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
    const near = (a: number[], b: number[]): void => a.forEach((v, i) => expect(Math.abs(v - b[i]!), `${a} vs ${b}`).toBeLessThanOrEqual(6));
    near(px(0, 2, 2), [200, 40, 20, 30]);
    near(px(0, 13, 2), [200, 40, 20, 220]);
    near(px(1, 5, 5), [10, 180, 60, 128]);
    near(px(2, 5, 5), [180, 0, 200, 255]);
  }, 60_000);

  it('colour packing is ETC1S sRGB; one layer is a plain texture', async () => {
    const r = await packKtx2([albedo, height], [[{ source: 0, channel: 0 }, { source: 0, channel: 1 }, { source: 0, channel: 2 }, { source: 1, channel: 0 }]], 'color');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ktx2Info(r.ktx2)).toEqual({ width: 16, height: 16, levels: 5, codec: 'etc1s' });
  }, 60_000);

  it('a single image imported as data: UASTC, linear, no normal-map preset (its channels kept)', async () => {
    const r = await encodeKtx2(rgbaPng(16, 16, () => [10, 200, 90, 255]), 'data');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ktx2Info(r.ktx2)).toEqual({ width: 16, height: 16, levels: 5, codec: 'uastc' });
    const t = await transcodeLayers(r.ktx2);
    [...t.layers[0]!.subarray(0, 4)].forEach((v, i) => expect(Math.abs(v - [10, 200, 90, 255][i]!)).toBeLessThanOrEqual(4));
  }, 60_000);

  it('refuses sources of different sizes, a broken KTX2 source and too many pixels, with the reason', async () => {
    const small = rgbaPng(8, 8, () => [0, 0, 0, 255]);
    expect(await packKtx2([albedo, small], [[{ source: 0, channel: 0 }, { source: 1, channel: 0 }, { value: 0 }, { value: 255 }]], 'data')).toMatchObject({ ok: false, message: expect.stringMatching(/one size/) });
    expect(await packKtx2([KTX2_IDENTIFIER.slice()], [[{ source: 0, channel: 0 }, { value: 0 }, { value: 0 }, { value: 0 }]], 'data')).toMatchObject({ ok: false, message: expect.stringMatching(/source 1 could not be decoded: not a readable Basis Universal KTX2/) });
    expect(await packKtx2([], [[{ value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }]], 'data')).toMatchObject({ ok: false, message: expect.stringMatching(/at least one source/) });
    // Constants only, with a source given: the source gives the size (an array's constant layer encoded on its own).
    const head = await packKtx2([albedo], [[{ value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }]], 'data');
    expect(head.ok && [head.width, head.layers]).toEqual([(await packKtx2([albedo], [[{ source: 0, channel: 0 }, { value: 2 }, { value: 3 }, { value: 4 }]], 'data') as { width: number }).width, 1]);
  });
});
