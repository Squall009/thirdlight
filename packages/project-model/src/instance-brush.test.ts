/**
 * The instance brush: candidates from the seed (the same stroke, the same
 * places, however the dabs overlap), the density it aims for, spacing,
 * random scale and turn within their ranges, leaning to the surface,
 * dropping onto block-layer tops, erasing, the set's own transform, and the
 * stroke's bounds. Neutral fixtures only.
 */
import { describe, expect, it } from 'vitest';

import { BlockGrid, applyBlockEdits } from './block-grid';
import type { BlockLayerComponent, BlockType } from './block-layers';
import {
  INSTANCE_BRUSH_LIMITS,
  StrokeCandidates,
  applyInstanceStroke,
  dropOntoBlockLayers,
  instanceStrokeError,
  strokeCandidates,
  type InstanceBrush,
  type InstanceSetSpace,
  type InstanceStroke,
} from './instance-brush';
import { INSTANCE_FLOATS, MAX_INSTANCES } from './types-v3';

const BRUSH: InstanceBrush = { radius: 2, density: 2, spacing: 0, scale: [0.5, 1.5], yaw: 360, align: 0, seed: 7 };
const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const AT_ORIGIN: InstanceSetSpace = { toWorld: ID, toLocal: ID, rotation: [0, 0, 0, 1], scale: 1 };
const flat = (y = 0) => (): [number, number, number] => [y, 0, 0];
const one = new Float32Array([100, 0, 100, 0, 0, 0, 1, 1, 1, 1]);
const paint = (dabs: [number, number, number][], brush: Partial<InstanceBrush> = {}, floats = one, space = AT_ORIGIN): Float32Array => {
  const r = applyInstanceStroke(floats, { mode: 'paint', dabs, brush: { ...BRUSH, ...brush } }, space, flat());
  if (!r.ok) throw new Error(r.message);
  return r.floats;
};
const copies = (f: Float32Array): number[][] => Array.from({ length: f.length / INSTANCE_FLOATS }, (_, i) => Array.from(f.subarray(i * INSTANCE_FLOATS, (i + 1) * INSTANCE_FLOATS)));

describe('instance brush candidates', () => {
  it('the same stroke gives the same places; another seed other places', () => {
    const dabs: [number, number, number][] = [[0, 0, 0], [1, 0, 0.5], [2, 0, 1]];
    const a = strokeCandidates(dabs, BRUSH)!;
    expect(strokeCandidates(dabs, BRUSH)).toEqual(a);
    expect(a.length).toBeGreaterThan(10);
    const b = strokeCandidates(dabs, { ...BRUSH, seed: 8 })!;
    expect(b.map((c) => [c.x, c.z])).not.toEqual(a.map((c) => [c.x, c.z]));
  });

  it('places do not depend on how the dabs overlap: one dab, or that dab twice, or inside a longer stroke', () => {
    const single = strokeCandidates([[3, 0, 3]], BRUSH)!;
    expect(strokeCandidates([[3, 0, 3], [3, 0, 3]], BRUSH)).toEqual(single);
    const long = strokeCandidates([[0, 0, 3], [3, 0, 3], [6, 0, 3]], BRUSH)!;
    const inLong = new Set(long.map((c) => `${c.x},${c.z}`));
    for (const c of single) expect(inLong.has(`${c.x},${c.z}`)).toBe(true);
  });

  it('a dab gives about its area times the density', () => {
    for (const density of [0.25, 1, 4]) {
      let total = 0;
      for (let k = 0; k < 20; k++) total += strokeCandidates([[k * 50, 0, 0]], { ...BRUSH, radius: 3, density })!.length;
      const want = Math.PI * 9 * density;
      expect(total / 20).toBeGreaterThan(want * 0.85);
      expect(total / 20).toBeLessThan(want * 1.15);
    }
  });

  it('adding dabs one by one gives the list the whole stroke gives, and a dab past the bound is refused', () => {
    const s = new StrokeCandidates(BRUSH);
    const dabs: [number, number, number][] = [[0, 0, 0], [1.5, 0.2, 0], [3, 0.4, 0.5]];
    for (const d of dabs) expect(s.add(d)).toBe(true);
    expect(s.list()).toEqual(strokeCandidates(dabs, BRUSH));
    const dense = new StrokeCandidates({ radius: 10, density: 10, seed: 1 });
    expect(dense.add([0, 0, 0])).toBe(false);
    expect(dense.count).toBe(0);
    expect(strokeCandidates([[0, 0, 0]], { radius: 10, density: 10, seed: 1 })).toBeNull();
  });
});

describe('painting', () => {
  it('copies land on the surface within the dabs, scaled and turned within range, appended after the set', () => {
    const f = paint([[0, 0, 0], [2, 0, 0]]);
    const all = copies(f);
    expect(all[0]).toEqual(Array.from(one));
    for (const c of all.slice(1)) {
      expect(Math.min(Math.hypot(c[0]!, c[2]!), Math.hypot(c[0]! - 2, c[2]!))).toBeLessThanOrEqual(2 + 1e-6);
      expect(c[1]).toBe(0);
      // Upright: a turn about Y only.
      expect(Math.abs(c[3]!) + Math.abs(c[5]!)).toBeLessThan(1e-6);
      expect(c[7]).toBeGreaterThanOrEqual(0.5 - 1e-6);
      expect(c[7]).toBeLessThanOrEqual(1.5 + 1e-6);
      expect(c[7]).toBe(c[8]);
    }
    const scales = new Set(all.slice(1).map((c) => c[7]));
    expect(scales.size).toBeGreaterThan(3);
  });

  it('the same stroke on the same set gives the same bytes; painting it again adds nothing', () => {
    const dabs: [number, number, number][] = [[0, 0, 0], [1, 0, 1]];
    const a = paint(dabs);
    expect(paint(dabs)).toEqual(a);
    const again = applyInstanceStroke(a, { mode: 'paint', dabs, brush: BRUSH }, AT_ORIGIN, flat());
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe('no_change');
  });

  it('spacing keeps copies apart, from each other and from the set\'s copies', () => {
    const f = paint([[0, 0, 0]], { density: 8, spacing: 1 });
    const pts = copies(f).slice(1).map((c) => [c[0]!, c[2]!]);
    expect(pts.length).toBeGreaterThan(3);
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) expect(Math.hypot(pts[i]![0]! - pts[j]![0]!, pts[i]![1]! - pts[j]![1]!)).toBeGreaterThanOrEqual(1 - 1e-6);
    // A copy already there keeps new ones a spacing away.
    const holder = new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    const g = paint([[0, 0, 0]], { density: 8, spacing: 1 }, holder);
    for (const c of copies(g).slice(1)) expect(Math.hypot(c[0]!, c[2]!)).toBeGreaterThanOrEqual(1 - 1e-6);
  });

  it('align leans copies to the normal: 1 along it, 0 upright', () => {
    const n = [Math.sin(0.5), Math.cos(0.5)];
    const slope = (): [number, number, number] => [0, n[0]!, 0];
    for (const align of [0, 1]) {
      const r = applyInstanceStroke(one, { mode: 'paint', dabs: [[0, 0, 0]], brush: { ...BRUSH, yaw: 0, align } }, AT_ORIGIN, slope);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const c = copies(r.floats)[1]!;
      const [x, y, z, w] = [c[3]!, c[4]!, c[5]!, c[6]!];
      // The copy's up axis (rotation applied to [0, 1, 0]).
      const up = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
      if (align === 0) expect(up[1]).toBeCloseTo(1, 6);
      else {
        expect(up[0]).toBeCloseTo(n[0]!, 5);
        expect(up[1]).toBeCloseTo(n[1]!, 5);
      }
    }
  });

  it('no surface, a wall or a surface out of reach: no copy there', () => {
    const none = applyInstanceStroke(one, { mode: 'paint', dabs: [[0, 0, 0]], brush: BRUSH }, AT_ORIGIN, () => null);
    expect(none.ok).toBe(false);
    const wall = applyInstanceStroke(one, { mode: 'paint', dabs: [[0, 0, 0]], brush: BRUSH }, AT_ORIGIN, () => [0, 1, 0]);
    expect(wall.ok).toBe(false);
    const far = applyInstanceStroke(one, { mode: 'paint', dabs: [[0, 0, 0]], brush: BRUSH }, AT_ORIGIN, () => [BRUSH.radius * 2 + 0.1, 0, 0]);
    expect(far.ok).toBe(false);
  });

  it('the stroke\'s own surface is used per candidate (and must match the candidates)', () => {
    const dabs: [number, number, number][] = [[0, 0, 0]];
    const cand = strokeCandidates(dabs, BRUSH)!;
    const surface = cand.map((_, i) => (i % 2 === 0 ? ([0.5, 0, 0] as [number, number, number]) : null));
    const r = applyInstanceStroke(one, { mode: 'paint', dabs, brush: BRUSH, surface }, AT_ORIGIN);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.added).toBe(Math.ceil(cand.length / 2));
      for (const c of copies(r.floats).slice(1)) expect(c[1]).toBe(0.5);
    }
    const bad = applyInstanceStroke(one, { mode: 'paint', dabs, brush: BRUSH, surface: surface.slice(1) }, AT_ORIGIN);
    expect(bad.ok === false && bad.code).toBe('surface_mismatch');
  });

  it('copies are stored in the set\'s own space (moved, turned and scaled set)', () => {
    // A set at (10, 1, 0), turned 90° about Y, scale 2.
    const s = Math.SQRT1_2;
    const toWorld = [0, 0, -2, 0, 0, 2, 0, 0, 2, 0, 0, 0, 10, 1, 0, 1];
    const toLocal = [0, 0, 0.5, 0, 0, 0.5, 0, 0, -0.5, 0, 0, 0, 0, -0.5, -5, 1];
    const space: InstanceSetSpace = { toWorld, toLocal, rotation: [0, s, 0, s], scale: 2 };
    const f = paint([[10, 1, 0]], { yaw: 0, scale: [1, 1] }, one, space);
    for (const c of copies(f).slice(1)) {
      // Back to the world through the set's matrix: on the ground at y = 0, within the dab.
      const wx = toWorld[0]! * c[0]! + toWorld[4]! * c[1]! + toWorld[8]! * c[2]! + toWorld[12]!;
      const wy = toWorld[1]! * c[0]! + toWorld[5]! * c[1]! + toWorld[9]! * c[2]! + toWorld[13]!;
      const wz = toWorld[2]! * c[0]! + toWorld[6]! * c[1]! + toWorld[10]! * c[2]! + toWorld[14]!;
      expect(wy).toBeCloseTo(0, 5);
      expect(Math.hypot(wx - 10, wz)).toBeLessThanOrEqual(2 + 1e-5);
      // Upright in the world: the local rotation undoes the set's turn; scale 1 in the world.
      expect(c[4]).toBeCloseTo(-s, 5);
      expect(c[6]).toBeCloseTo(s, 5);
      expect(c[7]).toBeCloseTo(0.5, 6);
    }
  });

  it('a set past an instance set\'s copies is refused', () => {
    const full = new Float32Array(MAX_INSTANCES * INSTANCE_FLOATS);
    for (let i = 0; i < MAX_INSTANCES; i++) full[i * INSTANCE_FLOATS] = 1000 + i;
    const r = applyInstanceStroke(full, { mode: 'paint', dabs: [[0, 0, 0]], brush: BRUSH }, AT_ORIGIN, flat());
    expect(r.ok === false && r.code).toBe('set_full');
  });
});

describe('dropping onto block layers', () => {
  const TYPES: BlockType[] = [{ blockId: 'soil', name: 'Soil', variants: [{ color: '#886644' }], shape: 'full' }];
  const types = new Map(TYPES.map((t) => [t.blockId, t]));
  const comp: BlockLayerComponent = { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [8, 8, 8] } };

  it('copies sit on the tops (the colliders\' shape), the higher column where it is higher', () => {
    const g = BlockGrid.from(comp, null);
    const r = applyBlockEdits(g, [{ kind: 'fill', box: [0, 0, 0, 8, 2, 8], cell: { block: 'soil' } }, { kind: 'fill', box: [4, 2, 0, 8, 4, 8], cell: { block: 'soil' } }], { types, stamps: new Map() });
    expect(r.ok).toBe(true);
    const drop = dropOntoBlockLayers([{ grid: g, types, origin: [-4, 10, -4] }]);
    const f = applyInstanceStroke(one, { mode: 'paint', dabs: [[0, 11.5, 0]], brush: { ...BRUSH, radius: 1.8 } }, AT_ORIGIN, drop);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    for (const c of copies(f.floats).slice(1)) expect(c[1]).toBeCloseTo(c[0]! >= 0 ? 12 : 11, 6);
    // Outside the layer: nothing.
    expect(drop(-10, 20, 0, -10)).toBeNull();
  });
});

describe('erasing', () => {
  it('removes the copies inside the dabs\' cylinders only; nothing there is no change; the last copy stays', () => {
    const f = new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 5, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 9, 0, 0, 0, 0, 1, 1, 1, 1]);
    const r = applyInstanceStroke(f, { mode: 'erase', dabs: [[0, 0, 0]], brush: { ...BRUSH, radius: 1.5 } }, AT_ORIGIN);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.removed).toBe(2);
      expect(copies(r.floats).map((c) => c[0])).toEqual([5, 0]);
    }
    const none = applyInstanceStroke(f, { mode: 'erase', dabs: [[50, 0, 0]], brush: BRUSH }, AT_ORIGIN);
    expect(none.ok === false && none.code).toBe('no_change');
    const last = applyInstanceStroke(one, { mode: 'erase', dabs: [[100, 0, 100]], brush: BRUSH }, AT_ORIGIN);
    expect(last.ok === false && last.code).toBe('set_empty');
  });
});

describe('stroke validation', () => {
  const good: InstanceStroke = { mode: 'paint', dabs: [[0, 0, 0]], brush: BRUSH };
  it('accepts a stroke and names the field of a bad one', () => {
    expect(instanceStrokeError(good)).toBeNull();
    expect(instanceStrokeError({ ...good, mode: 'smear' })?.path).toBe('/mode');
    expect(instanceStrokeError({ ...good, dabs: [] })?.path).toBe('/dabs');
    expect(instanceStrokeError({ ...good, dabs: Array.from({ length: INSTANCE_BRUSH_LIMITS.dabs + 1 }, () => [0, 0, 0]) })?.path).toBe('/dabs');
    expect(instanceStrokeError({ ...good, brush: { ...BRUSH, radius: 0 } })?.path).toBe('/brush/radius');
    expect(instanceStrokeError({ ...good, brush: { ...BRUSH, scale: [2, 1] } })?.path).toBe('/brush/scale');
    expect(instanceStrokeError({ ...good, brush: { ...BRUSH, seed: 1.5 } })?.path).toBe('/brush/seed');
    expect(instanceStrokeError({ ...good, surface: [[0, 2, 0]] })?.path).toBe('/surface/0');
    expect(instanceStrokeError({ ...good, mode: 'erase', surface: [] })?.path).toBe('/surface');
    expect(instanceStrokeError({ ...good, colour: 1 })?.path).toBe('/colour');
  });
});
