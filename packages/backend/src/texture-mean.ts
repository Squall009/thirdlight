/**
 * A texture's mean colour: what a view draws a layer as while its texture
 * array is still being encoded (seconds for a large sheet), so a surface
 * shows roughly its colours instead of plain white.
 *
 * Two means, 0–255 per channel: `srgb` averages R, G and B as light (each
 * texel decoded from sRGB, the sum encoded again), which is how a colour
 * texture looks from far away; `plain` averages the stored values, which is
 * what a normal map or a data texture reads as. A is averaged as stored in
 * both.
 */

export interface TextureMean {
  readonly srgb: readonly [number, number, number, number];
  readonly plain: readonly [number, number, number, number];
}

/** sRGB byte → linear light (0–1), once. */
const LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

const toSrgbByte = (l: number): number => {
  const c = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

/** The means of an RGBA image (an empty one: mid grey, opaque). */
export function meanOfRgba(rgba: Uint8Array): TextureMean {
  const n = rgba.length >> 2;
  if (n === 0) return { srgb: [128, 128, 128, 255], plain: [128, 128, 128, 255] };
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let lr = 0;
  let lg = 0;
  let lb = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const R = rgba[i]!;
    const G = rgba[i + 1]!;
    const B = rgba[i + 2]!;
    r += R;
    g += G;
    b += B;
    a += rgba[i + 3]!;
    lr += LINEAR[R]!;
    lg += LINEAR[G]!;
    lb += LINEAR[B]!;
  }
  const A = Math.round(a / n);
  return { srgb: [toSrgbByte(lr / n), toSrgbByte(lg / n), toSrgbByte(lb / n), A], plain: [Math.round(r / n), Math.round(g / n), Math.round(b / n), A] };
}
