/**
 * A composed decal page's pixels: rectangles of source images copied onto
 * one square RGBA image over a fill (project-model `decal-pages.ts` plans
 * where each goes).
 *
 * Each rectangle fills its padded box: inside the destination rectangle it
 * reads its source region, in the gutter around it the nearest edge pixel
 * of the rectangle (the edge repeated, as the Texture Designer's cells do),
 * so filtering and the mip levels up to the rectangle's cap read only its
 * own colours. A source region the destination's size is copied pixel for
 * pixel (each destination pixel's centre lands on a source pixel's centre);
 * a region of another size is read bilinearly, never past the region's
 * own pixels (a sheet's neighbouring cell does not bleed in).
 *
 * Pure: decoded images in, pixels out (the encoder thread runs it).
 */
import type { DecodedImage } from './image-decode';

/** One channel of a placement: a decoded source's channel, the largest of its R, G and B, or a constant. */
export type ComposeChannel = { readonly source: number; readonly channel: 0 | 1 | 2 | 3 | 'max' } | { readonly value: number };

export interface ComposePlacement {
  readonly channels: readonly [ComposeChannel, ComposeChannel, ComposeChannel, ComposeChannel];
  /** [u0, v0, u1, v1] of each source, 0–1 from its top-left. */
  readonly src: readonly [number, number, number, number];
  /** [x, y, width, height] on the page. */
  readonly dst: readonly [number, number, number, number];
  /** [x0, y0, x1, y1]: the box the rectangle's edges are repeated into. */
  readonly pad: readonly [number, number, number, number];
}

export interface ComposeLayer {
  readonly fill: readonly [number, number, number, number];
  readonly place: readonly ComposePlacement[];
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Where a destination pixel column (or row) reads its source: the two pixels and the weight of the second. */
function axisTaps(dst0: number, dstLen: number, padLo: number, padHi: number, u0: number, u1: number, srcLen: number): { i0: Int32Array; i1: Int32Array; f: Float32Array } {
  const n = padHi - padLo;
  const i0 = new Int32Array(n);
  const i1 = new Int32Array(n);
  const f = new Float32Array(n);
  // The region's own pixels (a sample never reads past them).
  const lo = clamp(Math.floor(u0 * srcLen + 1e-6), 0, srcLen - 1);
  const hi = clamp(Math.ceil(u1 * srcLen - 1e-6) - 1, lo, srcLen - 1);
  for (let k = 0; k < n; k++) {
    // The gutter repeats the rectangle's edge pixel.
    const d = clamp(padLo + k, dst0, dst0 + dstLen - 1) - dst0;
    const s = (u0 + ((d + 0.5) / dstLen) * (u1 - u0)) * srcLen - 0.5;
    const a = Math.floor(s + 1e-6);
    const w = s - a;
    i0[k] = clamp(a, lo, hi);
    i1[k] = clamp(a + 1, lo, hi);
    f[k] = w < 1e-6 ? 0 : w;
  }
  return { i0, i1, f };
}

/** A square page of side `size`: the fill, then each placement over its padded box. */
export function composePageRgba(size: number, layer: ComposeLayer, images: readonly (DecodedImage | undefined)[]): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const [fr, fg, fb, fa] = layer.fill;
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = fr;
    out[i * 4 + 1] = fg;
    out[i * 4 + 2] = fb;
    out[i * 4 + 3] = fa;
  }
  for (const p of layer.place) {
    const [x, y, w, h] = p.dst;
    const x0 = clamp(p.pad[0], 0, size);
    const y0 = clamp(p.pad[1], 0, size);
    const x1 = clamp(p.pad[2], x0, size);
    const y1 = clamp(p.pad[3], y0, size);
    // Taps per source (channels of one source share them).
    const taps = new Map<number, { xs: ReturnType<typeof axisTaps>; ys: ReturnType<typeof axisTaps>; img: DecodedImage }>();
    for (const c of p.channels) {
      if (!('source' in c) || taps.has(c.source)) continue;
      const img = images[c.source];
      if (img === undefined) throw new Error(`a decal page placement reads source ${c.source + 1}, which is not given`);
      taps.set(c.source, { img, xs: axisTaps(x, w, x0, x1, p.src[0], p.src[2], img.width), ys: axisTaps(y, h, y0, y1, p.src[1], p.src[3], img.height) });
    }
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const o = (py * size + px) * 4;
        for (let ch = 0; ch < 4; ch++) {
          const c = p.channels[ch]!;
          if (!('source' in c)) {
            out[o + ch] = clamp(Math.round(c.value), 0, 255);
            continue;
          }
          const t = taps.get(c.source)!;
          const kx = px - x0;
          const ky = py - y0;
          const d = t.img.data;
          const W = t.img.width;
          const a = (t.ys.i0[ky]! * W + t.xs.i0[kx]!) * 4;
          const b = (t.ys.i0[ky]! * W + t.xs.i1[kx]!) * 4;
          const cc = (t.ys.i1[ky]! * W + t.xs.i0[kx]!) * 4;
          const dd = (t.ys.i1[ky]! * W + t.xs.i1[kx]!) * 4;
          const fx = t.xs.f[kx]!;
          const fy = t.ys.f[ky]!;
          const sample = (k: number): number => {
            const top = d[a + k]! + (d[b + k]! - d[a + k]!) * fx;
            const bottom = d[cc + k]! + (d[dd + k]! - d[cc + k]!) * fx;
            return top + (bottom - top) * fy;
          };
          const v = c.channel === 'max' ? Math.max(sample(0), sample(1), sample(2)) : sample(c.channel);
          out[o + ch] = clamp(Math.round(v), 0, 255);
        }
      }
    }
  }
  return out;
}
