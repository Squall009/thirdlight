/**
 * The area lights' highlight slots (`surface-highlights.ts`): which lights
 * a frame's reading programs get, and that a slot's rectangle, side and
 * radiance give the light the surface cache holds. The check: the exact
 * form factor of the slot's polygon (Lambert's formula, worked out here,
 * not three's fitted one) on the side three's LTC lights, times the slot's
 * radiance, against the cache's own irradiance ÷ π from its CPU twin.
 */
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import type { CacheLight } from './surface-changes';
import { AREA_HIGHLIGHT_LIGHTS, AreaHighlights, GLOW_LIGHT_MARK, LINE_HIGHLIGHT_METRES } from './surface-highlights';
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

/** The slots `h` holds now: centre, two-sided, half sides, radiance. */
function slots(h: AreaHighlights): { c: V3; two: boolean; u: V3; v: V3; radiance: V3 }[] {
  const s = (h.slots as unknown as { array: THREE.Vector4[] }).array;
  const n = (h.count as unknown as { value: number }).value;
  return Array.from({ length: n }, (_, i) => {
    const [a, b, c, d] = [0, 1, 2, 3].map((k) => s[i * 4 + k]!);
    return { c: [a!.x, a!.y, a!.z], two: a!.w > 0.5, u: [b!.x, b!.y, b!.z], v: [c!.x, c!.y, c!.z], radiance: [d!.x, d!.y, d!.z] };
  });
}

/**
 * What a slot gives a surface at `p` facing `n` per unit albedo (irradiance ÷ π): the slot's radiance
 * × the exact form factor of its corners c ± u ± v, on the side three's LTC lights (the side
 * (p1 − p0) × (p3 − p0) faces; a two-sided slot turned toward `p` as the shader turns it).
 */
function slotIrradiance(slot: ReturnType<typeof slots>[number], p: V3, n: V3): number {
  const flip = slot.two && dot(sub(p, slot.c), cross(slot.u, slot.v)) > 0;
  const u = flip ? (slot.u.map((x) => -x) as V3) : slot.u;
  const corner = (a: number, b: number): V3 => [0, 1, 2].map((k) => slot.c[k]! + a * u[k]! + b * slot.v[k]!) as V3;
  const q = [corner(1, -1), corner(-1, -1), corner(-1, 1), corner(1, 1)];
  if (dot(cross(sub(q[1]!, q[0]!), sub(q[3]!, q[0]!)), sub(p, q[0]!)) < 0) return 0;
  // Lambert: F = (1 / 2π) Σ θ_i n · normalize(r_i × r_{i+1}), the corners as seen from p (clipped by the horizon here: every test's light stands above it).
  let f = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = unit(sub(q[i]!, p));
    const b = unit(sub(q[(i + 1) % 4]!, p));
    f += Math.acos(Math.min(1, Math.max(-1, dot(a, b)))) * dot(n, unit(cross(a, b)));
  }
  return (slot.radiance[0]! * Math.abs(f)) / (2 * Math.PI);
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

describe('surface highlights: the area lights reading pixels draw', () => {
  it('a rectangle\'s slot gives the light the cache holds, on its lit side only', () => {
    const h = new AreaHighlights();
    const lamp = area({});
    h.set([lamp], [0, 1.6, 3]);
    const [s] = slots(h);
    expect(s).toBeDefined();
    // Its sides turned against its facing (LTC lights −(u × v)), its radiance the intensity over its area.
    expect(dot(cross(s!.u, s!.v), lamp.direction)).toBeLessThan(0);
    expect(s!.radiance[0]).toBeCloseTo(40 / (4 * 0.4 * 0.25), 6);
    for (const [p, n] of [[[0, 0, 0], [0, 1, 0]], [[1.2, 0, -0.5], [0, 1, 0]], [[1.5, 1, 0], [-1, 0, 0]]] as [V3, V3][]) {
      const want = cacheIrradiance(lamp, p, n);
      expect(Math.abs(slotIrradiance(s!, p, n) - want) / want, `at ${p.join(',')}`).toBeLessThan(0.04);
    }
    // Above a one-sided lamp: nothing; a two-sided one lights there as below.
    expect(slotIrradiance(s!, [0, 4, 0], [0, -1, 0])).toBe(0);
    const two = area({ area: { u: [0.4, 0, 0], v: [0, 0, 0.25], twoSided: true } });
    h.set([two], [0, 1.6, 3]);
    const [t] = slots(h);
    expect(t!.two).toBe(true);
    const above = cacheIrradiance(two, [0, 4, 0], [0, -1, 0]);
    expect(Math.abs(slotIrradiance(t!, [0, 4, 0], [0, -1, 0]) - above) / above).toBeLessThan(0.04);
  });

  it('a line\'s slot is a thin strip across it, as bright along its facing as the cache\'s line', () => {
    const h = new AreaHighlights();
    const line = area({ position: [0, 2, 0], direction: [0, -1, 0], area: { u: [0.6, 0, 0], v: [0, 0, 0], twoSided: false } });
    h.set([line], [0, 1, 2]);
    const [s] = slots(h);
    expect(Math.hypot(...s!.v)).toBeCloseTo(LINE_HIGHLIGHT_METRES / 2, 6);
    expect(Math.abs(dot(s!.v, s!.u))).toBeLessThan(1e-9);
    expect(Math.abs(dot(s!.v, line.direction))).toBeLessThan(1e-9);
    // Straight under it the strip's Lambertian light and the cache's isotropic line agree; toward grazing the strip is dimmer.
    const under = cacheIrradiance(line, [0, 0, 0], [0, 1, 0]);
    expect(Math.abs(slotIrradiance(s!, [0, 0, 0], [0, 1, 0]) - under) / under).toBeLessThan(0.05);
    expect(slotIrradiance(s!, [0, 0, 3], [0, 1, 0])).toBeLessThan(cacheIrradiance(line, [0, 0, 3], [0, 1, 0]));
  });

  it(`a frame takes the ${AREA_HIGHLIGHT_LIGHTS} area lights that matter most at the eye; glowing surfaces and lights off give none`, () => {
    const h = new AreaHighlights();
    expect(h.present).toBe(false);
    const lamps = Array.from({ length: 7 }, (_, i) => area({ id: `lamp${i}`, position: [i * 5, 2.5, 0] }));
    const glow = area({ id: `box${GLOW_LIGHT_MARK}1+`, position: [0, 1, 0], color: [1e6, 1e6, 1e6] });
    const off = area({ id: 'off', position: [0, 2, 0.1], on: false });
    h.set([...lamps, glow, off], [9, 1.6, 0]);
    expect(h.present).toBe(true);
    const got = slots(h).map((s) => s.c[0]);
    expect(got).toHaveLength(AREA_HIGHLIGHT_LIGHTS);
    expect(new Set(got)).toEqual(new Set([10, 5, 15, 0]));
    // Only glowing surfaces (no area light of its own): the programs leave the slots out.
    h.set([glow, { ...lamps[0]!, kind: 'point' }], [0, 0, 0]);
    expect(h.present).toBe(false);
    expect(slots(h)).toHaveLength(0);
    // A scene whose area lights are all off keeps its programs (they read no slot).
    h.set([off], [0, 0, 0]);
    expect(h.present).toBe(true);
    expect(slots(h)).toHaveLength(0);
  });
});
