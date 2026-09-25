/**
 * Phase 20.1: curve and gradient evaluation (the framework's `curve` and
 * `gradient` field types) and colour conversion.
 *
 * A curve is keys [t0, v0, t1, v1, …] (t ascending in 0–1): linear between
 * keys, the first/last value outside them. A gradient is stops
 * [t, r, g, b, a, …] with sRGB colour components (as picked in the editor)
 * and a linear alpha: interpolated linearly in sRGB like the editor's
 * preview, then converted to linear RGB for the simulation.
 */
import type { Vec4 } from './math';

export function evalCurve(keys: readonly number[], t: number): number {
  const n = keys.length >> 1;
  if (n === 0) return 0;
  if (t <= keys[0]!) return keys[1]!;
  for (let i = 1; i < n; i++) {
    const t1 = keys[i * 2]!;
    if (t <= t1) {
      const t0 = keys[i * 2 - 2]!;
      const v0 = keys[i * 2 - 1]!;
      const v1 = keys[i * 2 + 1]!;
      return t1 > t0 ? v0 + ((v1 - v0) * (t - t0)) / (t1 - t0) : v1;
    }
  }
  return keys[n * 2 - 1]!;
}

/** sRGB (0–1) → linear. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** A gradient's sRGB colour and alpha at t (not converted). */
export function evalGradientSrgb(stops: readonly number[], t: number): Vec4 {
  const n = Math.floor(stops.length / 5);
  if (n === 0) return [1, 1, 1, 1];
  const at = (i: number): Vec4 => [stops[i * 5 + 1]!, stops[i * 5 + 2]!, stops[i * 5 + 3]!, stops[i * 5 + 4]!];
  if (t <= stops[0]!) return at(0);
  for (let i = 1; i < n; i++) {
    const t1 = stops[i * 5]!;
    if (t <= t1) {
      const t0 = stops[(i - 1) * 5]!;
      const a = at(i - 1);
      const b = at(i);
      const f = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
    }
  }
  return at(n - 1);
}

/** A gradient's colour at t in linear RGB with alpha. */
export function evalGradient(stops: readonly number[], t: number): Vec4 {
  const c = evalGradientSrgb(stops, t);
  return [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]), c[3]];
}

/** "#rrggbb" → linear RGB with the given alpha. */
export function hexToLinear(hex: string, alpha = 1): Vec4 {
  const n = /^#[0-9a-fA-F]{6}$/.test(hex) ? parseInt(hex.slice(1), 16) : 0xffffff;
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255), alpha];
}
