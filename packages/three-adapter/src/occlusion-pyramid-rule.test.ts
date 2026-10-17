/**
 * The depth pyramid's rule against a brute force over every pixel: each
 * texel is the farthest depth of the pixels it covers (odd sizes included),
 * for standard and reversed depth and multisampled depth, and a stand-in
 * makes the texels it covers nearer without ever going nearer than itself.
 */
import { describe, expect, it } from 'vitest';

import { fartherDepth, pyramidBreaks, pyramidLayout, reducePyramid } from './occlusion-pyramid-rule';

/** A seeded pseudo-random depth image (values in [0, 1)). */
function depthImage(w: number, h: number, seed: number, samples = 1): Float32Array {
  const out = new Float32Array(w * h * samples);
  let s = seed >>> 0;
  for (let i = 0; i < out.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = Math.fround((s >>> 8) / 16777216);
  }
  return out;
}

/** The farthest depth of every pixel (and sample) under texel (x, y) of `level`, by brute force. */
function bruteForce(depth: Float32Array, w: number, h: number, level: number, x: number, y: number, reversed: boolean, samples = 1): number {
  const span = 2 ** (level + 1);
  let far: number | null = null;
  for (let py = y * span; py < Math.min(h, (y + 1) * span); py++) {
    for (let px = x * span; px < Math.min(w, (x + 1) * span); px++) {
      for (let s = 0; s < samples; s++) {
        const d = depth[(py * w + px) * samples + s]!;
        far = far === null ? d : fartherDepth(far, d, reversed);
      }
    }
  }
  return far!;
}

describe('depth pyramid layout', () => {
  it('halves each level rounding up, down to 1 × 1, packed one after another', () => {
    const l = pyramidLayout(1920, 1080);
    expect(l.levels.slice(0, 4).map((v) => [v.width, v.height])).toEqual([[960, 540], [480, 270], [240, 135], [120, 68]]);
    expect(l.levels.at(-1)).toMatchObject({ width: 1, height: 1 });
    expect(l.levels).toHaveLength(11);
    let at = 0;
    for (const v of l.levels) {
      expect(v.offset).toBe(at);
      at += v.width * v.height;
    }
    expect(l.texels).toBe(at);
    // 1080p: under 4 MB of 32-bit texels.
    expect(l.texels * 4).toBeLessThan(4 * 1024 * 1024);
    expect(pyramidLayout(1, 1).levels).toEqual([{ width: 1, height: 1, offset: 0 }]);
    expect(pyramidLayout(7, 3).levels.map((v) => [v.width, v.height])).toEqual([[4, 2], [2, 1], [1, 1]]);
  });
});

describe('depth pyramid reduction', () => {
  for (const [w, h] of [[16, 8], [13, 7], [1, 5], [33, 1], [5, 5]] as const) {
    for (const reversed of [false, true]) {
      it(`each texel is the farthest pixel under it (${w} × ${h}, ${reversed ? 'reversed' : 'standard'} depth)`, () => {
        const depth = depthImage(w, h, w * 31 + h + (reversed ? 7 : 0));
        const layout = pyramidLayout(w, h);
        const p = reducePyramid(depth, w, h, reversed);
        layout.levels.forEach((lv, k) => {
          for (let y = 0; y < lv.height; y++) for (let x = 0; x < lv.width; x++) expect(p[lv.offset + y * lv.width + x], `level ${k} (${x}, ${y})`).toBe(bruteForce(depth, w, h, k, x, y, reversed));
        });
        expect(pyramidBreaks(p, layout, reversed)).toBeNull();
      });
    }
  }

  it('takes the farthest sample of a multisampled pixel', () => {
    const [w, h, s] = [9, 6, 4];
    const depth = depthImage(w, h, 99, s);
    const layout = pyramidLayout(w, h);
    const p = reducePyramid(depth, w, h, false, s);
    layout.levels.forEach((lv, k) => {
      for (let y = 0; y < lv.height; y++) for (let x = 0; x < lv.width; x++) expect(p[lv.offset + y * lv.width + x]).toBe(bruteForce(depth, w, h, k, x, y, false, s));
    });
  });

  it('a stand-in brings the texels it covers nearer, never nearer than itself, and only where it covers every pixel of a texel', () => {
    const [w, h] = [4, 4];
    // The scene is far (the sky: 1) everywhere.
    const depth = new Float32Array(w * h).fill(1);
    const layout = pyramidLayout(w, h);
    const mask = new Uint8Array(layout.levels[0]!.width * layout.levels[0]!.height);
    const at = new Float32Array(mask.length);
    // Texel (0, 0): all four pixels behind a stand-in at 0.4; texel (1, 0): three of four at 0.3.
    mask[0] = 0b1111;
    at[0] = 0.4;
    mask[1] = 0b0111;
    at[1] = 0.3;
    const p = reducePyramid(depth, w, h, false, 1, { mask, depth: at });
    expect(Array.from(p.slice(0, 4))).toEqual([Math.fround(0.4), 1, 1, 1]);
    // A pixel nearer than the stand-in keeps its own depth (the stand-in is behind it).
    depth[0] = 0.2;
    const q = reducePyramid(depth, w, h, false, 1, { mask, depth: at });
    expect(q[0]).toBe(Math.fround(0.4));
    // Reversed Z: far is 0, the stand-in at 0.6 is nearer than the sky.
    const rev = new Float32Array(w * h).fill(0);
    const r = reducePyramid(rev, w, h, true, 1, { mask, depth: Float32Array.from([0.6, 0.7, 0, 0]) });
    expect(Array.from(r.slice(0, 4))).toEqual([Math.fround(0.6), 0, 0, 0]);
  });

  it('pyramidBreaks finds a texel that is not the farthest under it', () => {
    const depth = depthImage(8, 8, 5);
    const layout = pyramidLayout(8, 8);
    const p = reducePyramid(depth, 8, 8, false);
    p[layout.levels[1]!.offset + 1] = 0;
    expect(pyramidBreaks(p, layout, false)).toMatchObject({ level: 1, x: 1, y: 0, value: 0 });
  });
});
