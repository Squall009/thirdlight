/**
 * The marks a voxel chunk coming, going or drawn again makes on the cache
 * (`SurfaceChanges.castersChanged`): on a generated street of surfaces lit by
 * lamps, an area light and the sun, every unit some sampled segment from it
 * to a light (or ray toward the sun) crosses the changed box is marked (none
 * missed), and far fewer are marked than the rule for any other geometry
 * (the whole reach of every light the box touches).
 */
import { mulberry32 } from '@thirdlight/shared';
import { describe, expect, it } from 'vitest';

import { SurfaceChanges, boxShadowsBox, lightRadius, lightReach, type CacheLight } from './surface-changes';
import { SurfaceRelight, type RelightUnit } from './surface-relight';
import { SUN_DISC_RADIANS } from './surface-light-frame';

/** Whether segment a → b meets box [min, max] (slabs). */
function segmentMeetsBox(a: readonly number[], b: readonly number[], min: readonly number[], max: readonly number[]): boolean {
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 3; k++) {
    const d = b[k]! - a[k]!;
    if (Math.abs(d) < 1e-12) {
      if (a[k]! < min[k]! || a[k]! > max[k]!) return false;
      continue;
    }
    let t0 = (min[k]! - a[k]!) / d;
    let t1 = (max[k]! - a[k]!) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    lo = Math.max(lo, t0);
    hi = Math.min(hi, t1);
    if (lo > hi) return false;
  }
  return true;
}

/** Surfaces of a street 120 m long: ground patches, house walls (flat units facing ±x), roofs. */
function units(seed: number): RelightUnit[] {
  const r = mulberry32(seed);
  const out: RelightUnit[] = [];
  for (let i = 0; i < 700; i++) {
    const x = r() * 120 - 60;
    const z = r() * 60 - 30;
    const kind = r();
    if (kind < 0.5) out.push({ key: `g${i}`, min: [x, 0, z], max: [x + 1 + r() * 2, 0.2 + r() * 0.5, z + 1 + r() * 2], texels: 100, plane: [0, 1, 0, 0] });
    else if (kind < 0.8) {
      const sgn = r() < 0.5 ? 1 : -1;
      out.push({ key: `w${i}`, min: [x, r() * 4, z], max: [x, 1 + r() * 6, z + 1 + r() * 3], texels: 100, plane: [sgn, 0, 0, sgn * x] });
    } else out.push({ key: `r${i}`, min: [x, 5 + r() * 3, z], max: [x + 2, 7 + r() * 3, z + 2], texels: 100 });
  }
  return out;
}

const lamp = (id: string, p: number[], range: number): CacheLight => ({ id, kind: 'point', on: true, position: p, direction: [0, -1, 0], color: [5, 4, 3], range, cone: 0, penumbra: 0 });

function lights(sunUp: boolean): CacheLight[] {
  const out = [lamp('a', [-20, 3, 0], 14), lamp('b', [5, 4, 6], 18), lamp('c', [30, 2.5, -8], 12)];
  out.push({ id: 'area', kind: 'area', on: true, position: [-5, 3, -10], direction: [0, 0, 1], color: [8, 8, 8], range: 15, cone: 0, penumbra: 0, area: { u: [1, 0, 0], v: [0, 0.5, 0], twoSided: false } });
  if (sunUp) {
    const d = [0.4, 1, 0.3];
    const l = Math.hypot(...d);
    out.push({ id: 'sun', kind: 'directional', on: true, position: [0, 0, 0], direction: d.map((v) => v / l), color: [3, 3, 3], range: 0, cone: 0, penumbra: 0 });
  }
  return out;
}

/** A relight holding `us`, all lit, its lights seen. */
function settled(us: readonly RelightUnit[], ls: readonly CacheLight[]): { relight: SurfaceRelight; changes: SurfaceChanges } {
  const relight = new SurfaceRelight(1, true);
  for (const u of us) relight.add(u);
  const changes = new SurfaceChanges(relight);
  changes.setLights(ls);
  for (const u of us) relight.settle(u.key);
  return { relight, changes };
}

/** Points on a unit's box: a grid of 4 a side. */
function samples(u: RelightUnit): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) out.push([0, 1, 2].map((a) => u.min[a]! + ((u.max[a]! - u.min[a]!) * [i, j, k][a]!) / 3));
  return out;
}

/** The units brute force finds the box can shadow: some sampled segment to a light's sampled point, or ray toward the sun's disc, crosses it. */
function bruteForce(us: readonly RelightUnit[], ls: readonly CacheLight[], min: number[], max: number[]): Set<string> {
  const hit = new Set<string>();
  const r = mulberry32(3);
  for (const u of us) {
    if ([0, 1, 2].every((k) => u.max[k]! >= min[k]! && u.min[k]! <= max[k]!)) {
      hit.add(u.key);
      continue;
    }
    const pts = samples(u);
    for (const l of ls) {
      if (l.kind === 'directional') {
        for (const p of pts) for (let s = 0; s < 6 && !hit.has(u.key); s++) {
          const q = s === 0 ? 0 : SUN_DISC_RADIANS;
          const t = r() * Math.PI * 2;
          const d = [l.direction[0]! + q * Math.cos(t), l.direction[1]!, l.direction[2]! + q * Math.sin(t)];
          if (segmentMeetsBox(p, p.map((v, k) => v + d[k]! * 1000), min, max)) hit.add(u.key);
        }
        continue;
      }
      const reach = lightReach(l);
      const near = [0, 1, 2].reduce((s, k) => s + Math.max(u.min[k]! - l.position[k]!, 0, l.position[k]! - u.max[k]!) ** 2, 0);
      if (Math.sqrt(near) > reach) continue;
      if (u.plane !== undefined && u.plane[0]! * l.position[0]! + u.plane[1]! * l.position[1]! + u.plane[2]! * l.position[2]! - u.plane[3]! < -1e-3) continue;
      const rad = lightRadius(l);
      const lightPts = [l.position, ...[0, 1, 2].flatMap((k) => [-1, 1].map((sg) => l.position.map((v, a) => (a === k ? v + sg * rad : v))))];
      for (const p of pts) for (const lp of lightPts) if (!hit.has(u.key) && segmentMeetsBox(p, lp, min, max)) hit.add(u.key);
    }
  }
  return hit;
}

describe('marks from voxel casters that came, went or changed', () => {
  for (const sunUp of [true, false]) {
    it(`mark every unit brute force finds the box can shadow, and fewer than a light's whole reach (${sunUp ? 'noon' : 'night'})`, () => {
      const us = units(sunUp ? 1 : 2);
      const ls = lights(sunUp);
      const r = mulberry32(sunUp ? 9 : 10);
      let narrowed = 0;
      let whole = 0;
      for (let trial = 0; trial < 24; trial++) {
        // A chunk's box (16 m with its cell of margin) or an edit's smaller one, somewhere on the street.
        const side = trial % 3 === 0 ? 4 : 17;
        const x = r() * 100 - 50;
        const z = r() * 50 - 25;
        const y = r() * 4 - 2;
        const min = [x, y, z];
        const max = [x + side, y + side, z + side];
        const a = settled(us, ls);
        const n = a.changes.castersChanged(min, max);
        const marked = new Set(us.filter((u) => a.relight.isStale(u.key)).map((u) => u.key));
        expect(n).toBe(marked.size);
        for (const key of bruteForce(us, ls, min, max)) expect(marked.has(key), `${key} in trial ${trial}`).toBe(true);
        const b = settled(us, ls);
        b.changes.geometryChanged(min, max);
        narrowed += marked.size;
        whole += us.filter((u) => b.relight.isStale(u.key)).length;
      }
      expect(narrowed).toBeGreaterThan(0);
      expect(narrowed).toBeLessThan(whole * 0.7);
    });
  }

  it('a light inside the box, and a box the light cannot see past, decide as they should', () => {
    // The light inside: everything it reaches.
    expect(boxShadowsBox([1, 1, 1], 0, [0, 0, 0], [2, 2, 2], [10, 0, 0], [11, 1, 1])).toBe(true);
    // Behind the box from the light: shadowed; beside it, out of its shadow: not.
    expect(boxShadowsBox([0, 1, 0], 0, [4, 0, -1], [5, 2, 1], [8, 0, -0.5], [9, 2, 0.5])).toBe(true);
    expect(boxShadowsBox([0, 1, 0], 0, [4, 0, -1], [5, 2, 1], [8, 0, 6], [9, 2, 7])).toBe(false);
    // Between the light and the box: the box is behind it, it shadows nothing there.
    expect(boxShadowsBox([0, 1, 0], 0, [4, 0, -1], [5, 2, 1], [2, 0, -0.5], [3, 2, 0.5])).toBe(false);
  });
});
