/**
 * Area lights in the light clusters' loop (`cluster-area.ts`): the record a
 * rect or line light is listed with (`cluster-build.ts`), turned into the
 * corners and radiance the shader hands three's LTC, gives the light the
 * surface cache holds. The check: the exact form factor of that polygon
 * (Lambert's formula, worked out here, not three's fitted one) on the side
 * three's LTC lights, times the radiance, against the cache's own
 * irradiance ÷ π from its CPU twin. A moving object lit by the loop and a
 * static wall lit by the cache next to it get the same light.
 */
import { describe, expect, it } from 'vitest';

import { ClusterLights } from './cluster-build';
import type { CacheLight } from './surface-changes';
import { LINE_HIGHLIGHT_METRES } from './surface-highlights';
import { lightFrameCpu } from './surface-light-cpu';
import type { LightPassFrame } from './surface-light-frame';
import { SHADOW_TRACE } from './surface-light-pass';
import { packTraceScene } from './tracer-scene';

type V3 = [number, number, number];
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const unit = (a: readonly number[]): V3 => {
  const l = Math.hypot(a[0]!, a[1]!, a[2]!);
  return [a[0]! / l, a[1]! / l, a[2]! / l];
};

function area(over: Partial<CacheLight>): CacheLight {
  return { id: 'lamp', kind: 'area', on: true, position: [0, 2.5, 0], direction: [0, -1, 0], color: [40, 40, 40], range: 60, cone: 0, penumbra: 0, area: { u: [0.4, 0, 0], v: [0, 0, 0.25], twoSided: false }, ...over };
}

/** The light as the clusters list it (world space): centre, two-sided, half sides (`u × v` along its facing), colour. */
type Listed = { c: V3; two: boolean; u: V3; v: V3; colour: V3 };
function listed(l: CacheLight): Listed {
  const lights = new ClusterLights();
  const line = l.area!.v.every((x) => x === 0);
  lights.add({ kind: line ? 'line' : 'rect', position: l.position, reach: 60, color: l.color, direction: l.direction, u: l.area!.u, v: l.area!.v, twoSided: l.area!.twoSided });
  const at = (a: ArrayLike<number>): V3 => [a[0]!, a[1]!, a[2]!];
  return { c: at(l.position), two: l.area!.twoSided, u: at(lights.u), v: at(lights.v), colour: at(lights.color) };
}

/**
 * The shader's slot (`shadeAreaLight`): its corners c ± u ± v' with v' = −v (three's LTC lights the side
 * (p1 − p0) × (p3 − p0) = −4 u × v' faces), v' = v seen from behind a two-sided light; its radiance the
 * colour over the emitting area.
 */
function slotOf(l: Listed, p: V3): { c: V3; u: V3; v: V3; radiance: number } {
  const back = l.two && dot(sub(l.c, p), cross(l.u, l.v)) > 0;
  const v = back ? l.v : (l.v.map((x) => -x) as V3);
  const area = 4 * Math.hypot(...l.u) * Math.hypot(...l.v);
  return { c: l.c, u: l.u, v, radiance: l.colour[0]! / area };
}

/**
 * What the listed light gives a surface at `p` facing `n` per unit albedo (irradiance ÷ π): the slot's
 * radiance × the exact form factor of its corners, on the side three's LTC lights.
 */
function slotIrradiance(l: Listed, p: V3, n: V3): number {
  const slot = slotOf(l, p);
  const corner = (a: number, b: number): V3 => [0, 1, 2].map((k) => slot.c[k]! + a * slot.u[k]! + b * slot.v[k]!) as V3;
  const q = [corner(1, -1), corner(-1, -1), corner(-1, 1), corner(1, 1)];
  if (dot(cross(sub(q[1]!, q[0]!), sub(q[3]!, q[0]!)), sub(p, q[0]!)) < 0) return 0;
  // Lambert: F = (1 / 2π) Σ θ_i n · normalize(r_i × r_{i+1}), the corners as seen from p (clipped by the horizon here: every test's light stands above it).
  let f = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = unit(sub(q[i]!, p));
    const b = unit(sub(q[(i + 1) % 4]!, p));
    f += Math.acos(Math.min(1, Math.max(-1, dot(a, b)))) * dot(n, unit(cross(a, b)));
  }
  return (slot.radiance * Math.abs(f)) / (2 * Math.PI);
}

/** The cache's irradiance ÷ π at p (normal n) from `l`, the mean of many texels (its rays' expectation). */
function cacheIrradiance(l: CacheLight, p: V3, n: V3): number {
  const copies = 400;
  const points = new Float32Array(copies * 6);
  for (let i = 0; i < copies; i += 1) points.set([...p, ...n], i * 6);
  const frame: LightPassFrame = { points, slices: [{ texels: copies, lights: [0], suns: 0, level: 0 }], lights: [l], suns: [] };
  const e = lightFrameCpu(frame, packTraceScene({}), 7, SHADOW_TRACE);
  let s = 0;
  for (let i = 0; i < copies; i += 1) s += e[i * 3]!;
  return s / copies / Math.PI;
}

describe('area lights in the clusters\' loop: the light the surface cache holds', () => {
  it('a rectangle gives the light the cache holds, on its lit side only', () => {
    const lamp = area({});
    const s = listed(lamp);
    // Listed with u × v along its facing; the shader's radiance is the intensity over its area.
    expect(dot(cross(s.u, s.v), lamp.direction)).toBeGreaterThan(0);
    expect(slotOf(s, [0, 0, 0]).radiance).toBeCloseTo(40 / (4 * 0.4 * 0.25), 4);
    for (const [p, n] of [[[0, 0, 0], [0, 1, 0]], [[1.2, 0, -0.5], [0, 1, 0]], [[1.5, 1, 0], [-1, 0, 0]]] as [V3, V3][]) {
      const want = cacheIrradiance(lamp, p, n);
      expect(Math.abs(slotIrradiance(s, p, n) - want) / want, `at ${p.join(',')}`).toBeLessThan(0.04);
    }
    // Above a one-sided lamp: nothing; a two-sided one lights there as below.
    expect(slotIrradiance(s, [0, 4, 0], [0, -1, 0])).toBe(0);
    const two = area({ area: { u: [0.4, 0, 0], v: [0, 0, 0.25], twoSided: true } });
    const t = listed(two);
    const above = cacheIrradiance(two, [0, 4, 0], [0, -1, 0]);
    expect(Math.abs(slotIrradiance(t, [0, 4, 0], [0, -1, 0]) - above) / above).toBeLessThan(0.04);
  });

  it('a line is a thin strip across it, as bright along its facing as the cache\'s line', () => {
    const line = area({ position: [0, 2, 0], direction: [0, -1, 0], area: { u: [0.6, 0, 0], v: [0, 0, 0], twoSided: false } });
    const s = listed(line);
    expect(Math.hypot(...s.v)).toBeCloseTo(LINE_HIGHLIGHT_METRES / 2, 6);
    expect(Math.abs(dot(s.v, s.u))).toBeLessThan(1e-9);
    expect(Math.abs(dot(s.v, line.direction))).toBeLessThan(1e-9);
    // Straight under it the strip's Lambertian light and the cache's isotropic line agree; toward grazing the strip is dimmer.
    const under = cacheIrradiance(line, [0, 0, 0], [0, 1, 0]);
    expect(Math.abs(slotIrradiance(s, [0, 0, 0], [0, 1, 0]) - under) / under).toBeLessThan(0.05);
    expect(slotIrradiance(s, [0, 0, 3], [0, 1, 0])).toBeLessThan(cacheIrradiance(line, [0, 0, 3], [0, 1, 0]));
  });
});
