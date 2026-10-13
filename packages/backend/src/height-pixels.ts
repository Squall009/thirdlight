/**
 * The pixel side of height in alpha (`height-alpha.ts`): whether an image's A
 * holds a height, and the height made from its brightness where it does not.
 * Import-free, so the KTX2 worker (`texture-encode.ts`) packs the stand-in
 * height without loading the rest of the backend.
 */

/**
 * Alpha levels (of 255) between the darkest and brightest percent of a
 * texture's pixels at or below which its A is flat: no height. Encoders and
 * dithering stir a constant A by a level or two; a painted height spans tens.
 */
export const FLAT_ALPHA_SPREAD = 8;
/** The share of pixels at each end the spread ignores (stray texels, a seam). */
const SPREAD_TAIL = 0.01;

/** What a texture's alpha holds for a height slot. */
export type HeightAlpha = 'height' | 'flat';

/** The value at the `tail` and `1 − tail` points of a 256-bin histogram of `n` values. */
function spreadOf(hist: Uint32Array, n: number): { lo: number; hi: number } {
  const cut = Math.floor(n * SPREAD_TAIL);
  let lo = 0;
  for (let seen = 0; lo < 255; lo++) {
    seen += hist[lo]!;
    if (seen > cut) break;
  }
  let hi = 255;
  for (let seen = 0; hi > 0; hi--) {
    seen += hist[hi]!;
    if (seen > cut) break;
  }
  return { lo, hi: Math.max(lo, hi) };
}

/** The spread of A over an RGBA image (levels between its 1st and 99th percentile). */
export function alphaSpread(rgba: Uint8Array): number {
  const n = rgba.length >> 2;
  if (n === 0) return 0;
  const hist = new Uint32Array(256);
  for (let i = 3; i < rgba.length; i += 4) hist[rgba[i]!]! += 1;
  const { lo, hi } = spreadOf(hist, n);
  return hi - lo;
}

/**
 * Whether an RGBA image carries a height in A: a spread above
 * `FLAT_ALPHA_SPREAD`, or a constant A below opaque. An opaque A is what an
 * image without alpha decodes to; a constant at another level was put there
 * on purpose (a layer that is uniformly high or low wins or loses every blend
 * crisply, which is a height), so only the opaque one stands for "missing".
 */
export function heightAlphaOf(rgba: Uint8Array): HeightAlpha {
  const n = rgba.length >> 2;
  if (n === 0) return 'flat';
  const hist = new Uint32Array(256);
  for (let i = 3; i < rgba.length; i += 4) hist[rgba[i]!]! += 1;
  const { lo, hi } = spreadOf(hist, n);
  if (hi - lo > FLAT_ALPHA_SPREAD) return 'height';
  return hi >= 255 - FLAT_ALPHA_SPREAD ? 'flat' : 'height';
}

/** Brightness of one sRGB texel, 0–255 (Rec. 709 weights in 1/256ths: 54 + 183 + 19). */
const luma = (r: number, g: number, b: number): number => (54 * r + 183 * g + 19 * b) >> 8;

/**
 * The height that stands in for a missing one: each pixel's brightness,
 * stretched so the image's 1st–99th percentile fills 0–255 (dark joints and
 * crevices low, bright faces high; a dull texture still gets a full range for
 * the blend's contrast to work on). A plain-coloured image gets a flat 128.
 */
export function brightnessHeight(rgba: Uint8Array): Uint8Array {
  const n = rgba.length >> 2;
  const l = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const v = luma(rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!);
    l[i] = v;
    hist[v]! += 1;
  }
  const { lo, hi } = spreadOf(hist, n);
  if (hi - lo < 1) return l.fill(128);
  const scale = 255 / (hi - lo);
  for (let i = 0; i < n; i++) l[i] = Math.max(0, Math.min(255, Math.round((l[i]! - lo) * scale)));
  return l;
}
