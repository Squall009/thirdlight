/**
 * Images larger than one encode of the pinned KTX2 encoder takes, made in
 * UASTC stripes and assembled (backend `ktx2-striped.ts`): the real encoder
 * on real pixels, with a small stripe limit so the test runs in seconds,
 * the result decoded by three's Basis transcoder (what a page draws).
 */
import { describe, expect, it } from 'vitest';

import { readKtx2, ktx2LevelData } from '../packages/backend/src/ktx2-container';
import { encodeUastcStriped, halveRgba, stripeRows } from '../packages/backend/src/ktx2-striped';
import { KTX2_IMAGE_PIXELS_MAX, KTX2_SOURCE_PIXELS_MAX, uastcEncodeOf } from '../packages/backend/src/texture-encode';
import { transcodeKtx2Levels } from '../tools/voxel-bench/three-basis';

/** Noise over gradients (every block different, nothing a stripe edge could hide), alpha a ramp. */
function pixels(w: number, h: number, seed = 1): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  let s = seed;
  const rnd = (): number => ((s = (s * 1103515245 + 12345) >>> 0) >>> 24) / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      px[o] = Math.round((x / w) * 200 + rnd() * 55);
      px[o + 1] = Math.round((y / h) * 200 + rnd() * 55);
      px[o + 2] = Math.round(((x ^ y) & 31) * 6 + rnd() * 50);
      px[o + 3] = Math.round(((x + y) / (w + h)) * 255);
    }
  }
  return px;
}

/** Mean absolute difference of two RGBA images' channel `c` (0–3; all four when absent). */
function meanDiff(a: Uint8Array, b: Uint8Array, c?: number): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (c !== undefined && i % 4 !== c) continue;
    sum += Math.abs(a[i]! - b[i]!);
    n++;
  }
  return sum / n;
}

describe('KTX2 in UASTC stripes', () => {
  it('lays the stripes\' blocks into the level one encode of the whole image makes, byte for byte', async () => {
    const w = 256;
    const h = 200;
    const px = pixels(w, h);
    const encode = uastcEncodeOf('data', 'assembled');
    const whole = await encode(px, w, h, true);
    if (!whole.ok) throw new Error(whole.message);
    // 48 rows a stripe: five stripes, the last 8 rows high.
    const limit = w * 48;
    expect(stripeRows(w, limit)).toBe(48);
    const striped = await encodeUastcStriped(px, w, h, 'data', limit, encode);
    if (!striped.ok) throw new Error(striped.message);
    const a = readKtx2(whole.ktx2)!;
    const b = readKtx2(striped.ktx2)!;
    expect([b.width, b.height, b.levels.length]).toEqual([256, 200, 9]);
    expect(Buffer.from(ktx2LevelData(b, 0)).equals(Buffer.from(ktx2LevelData(a, 0)))).toBe(true);
    // Level 1 (128 × 100 = 12,800 px) is still past the limit: two stripes of 96 and 4 rows; the rest one encode.
    expect(striped.encodes).toBe(5 + 2 + 1);
    expect(b.transfer).toBe(a.transfer);
  });

  it('decodes in three\'s transcoder level by level close to the source and its box halvings', async () => {
    const w = 200;
    const h = 136;
    for (const mode of ['color', 'normal', 'data'] as const) {
      let px = pixels(w, h, mode.length);
      if (mode === 'normal') {
        // Unit vectors (alpha a height), as a normal map stores them.
        for (let i = 0; i < px.length; i += 4) {
          const x = px[i]! / 127.5 - 1;
          const y = px[i + 1]! / 127.5 - 1;
          const z = Math.sqrt(Math.max(0, 1 - x * x - y * y)) + 0.3;
          const len = Math.hypot(x, y, z);
          px[i] = Math.round((x / len + 1) * 127.5);
          px[i + 1] = Math.round((y / len + 1) * 127.5);
          px[i + 2] = Math.round((z / len + 1) * 127.5);
        }
      }
      const striped = await encodeUastcStriped(px, w, h, mode, w * 40, uastcEncodeOf(mode, 'assembled'));
      if (!striped.ok) throw new Error(striped.message);
      const { levels } = await transcodeKtx2Levels(striped.ktx2);
      expect(levels.map((l) => [l.width, l.height])).toEqual([200, 100, 50, 25, 12, 6, 3, 1].map((s, i) => [s, Math.max(1, 136 >> i)]));
      // Level 0 against the source and level 1 against the box halving: UASTC's error, not a misplaced stripe.
      expect(meanDiff(levels[0]!.data, px)).toBeLessThan(6);
      const half = halveRgba(px, w, h, mode);
      expect(meanDiff(levels[1]!.data, half.data)).toBeLessThan(6);
      // A few texels by position: the stripe edges (rows 39/40, 79/80, 119/120) read their own rows.
      for (const [x, y] of [[0, 0], [199, 39], [5, 40], [120, 80], [77, 119], [3, 120], [199, 135]] as const) {
        const o = (y * w + x) * 4;
        for (let c = 0; c < 4; c++) expect(Math.abs(levels[0]!.data[o + c]! - px[o + c]!)).toBeLessThan(40);
      }
      px = new Uint8Array(0);
    }
  });

  it('halves colour in linear light, renormalizes normals and keeps data as stored', () => {
    // 2 × 2 → 1: black and white average to sRGB 188 in linear light (not 128); data to 128.
    const bw = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    expect([...halveRgba(bw, 2, 2, 'color').data]).toEqual([188, 188, 188, 255]);
    expect([...halveRgba(bw, 2, 2, 'data').data]).toEqual([128, 128, 128, 255]);
    // Two tilted normals average to an upright unit vector, not a shorter one.
    const n = new Uint8Array([218, 128, 218, 10, 38, 128, 218, 30, 218, 128, 218, 10, 38, 128, 218, 30]);
    expect([...halveRgba(n, 2, 2, 'normal').data]).toEqual([128, 128, 255, 20]);
    // An odd edge keeps its last column out (sides rounded down), one row stays one row.
    expect(halveRgba(new Uint8Array(3 * 1 * 4), 3, 1, 'data')).toMatchObject({ width: 1, height: 1 });
  });

  it('takes one 4096² layer (the authored tile) within the image limit, in stripes of 3072 rows', () => {
    expect(4096 * 4096).toBeGreaterThan(KTX2_SOURCE_PIXELS_MAX);
    expect(4096 * 4096).toBeLessThanOrEqual(KTX2_IMAGE_PIXELS_MAX);
    expect(stripeRows(4096, KTX2_SOURCE_PIXELS_MAX)).toBe(3072);
  });
});
