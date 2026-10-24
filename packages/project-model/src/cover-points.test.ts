/**
 * Cover point sets: on one floor the points are the stored bake's copies
 * (place, normal, spacing); under a ceiling every floor gets its own; the
 * format reads back what was baked, sorted so a share is a prefix.
 */
import { describe, expect, it } from 'vitest';

import { BlockGrid } from './block-grid';
import type { BlockChunk, BlockLayerComponent, BlockType } from './block-layers';
import { blockChunkRect } from './block-scatter';
import { COVER_POINT_STEPS, bakeCoverPoints, coverPointAt, coverPointNormal, coverPointsBelow } from './cover-points';
import { bakeScatterCell, type ScatterRule } from './scatter';
import { blockScatterSurface } from './scatter-surfaces';

const TYPES = new Map<string, BlockType>([
  ['stone', { blockId: 'stone', name: 'Stone', variants: [{ color: '#777777' }], shape: 'full' } as BlockType],
  ['floor', { blockId: 'floor', name: 'Floor', variants: [{ color: '#886644' }], shape: 'full' } as BlockType],
]);

/** One 16 × 16 m chunk of 1 m cells: a floor at row 0 and, when `roof`, a stone roof over x < 8 at row 4 (no walls). */
function layer(roof: boolean): { grid: BlockGrid; component: BlockLayerComponent } {
  const columns: number[][] = [];
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) columns.push(roof && x < 8 ? [x, z, 0, 1, 1, 4, 1, 0] : [x, z, 0, 1, 1]);
  const chunk: BlockChunk = { cx: 0, cz: 0, palette: [{ block: 'stone' }, { block: 'floor' }], columns };
  const component = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [16, 8, 16] } } as BlockLayerComponent;
  return { grid: BlockGrid.from(component, { entityId: 'l', chunks: [chunk] }), component };
}

const ORIGIN = [10, 2, -5];
const MOSS: ScatterRule = { id: 'moss', asset: { assetId: 'moss' }, density: 6, cover: true, blocks: ['floor'], scale: [0.5, 1.5], align: 1 };

describe('cover point sets', () => {
  it('stand where the stored bake puts copies on one floor, spacing included', () => {
    const { grid } = layer(false);
    const surface = blockScatterSurface({ grid, types: TYPES, origin: ORIGIN, topSubdivision: 1 });
    const rect = blockChunkRect(ORIGIN, [1, 1, 1], 0, 0);
    for (const rule of [MOSS, { ...MOSS, id: 'spaced', spacing: 0.6 }]) {
      const set = bakeCoverPoints(rule, surface, rect, ORIGIN);
      const stored = bakeScatterCell([{ ...rule, cover: false }], surface, null, rect, null, ORIGIN).cell.get(rule.id)!;
      expect(set.count).toBe(stored.copies.length / 10);
      expect(set.count).toBeGreaterThan(rule.spacing === undefined ? 1200 : 200);
      const step = 16 / (COVER_POINT_STEPS - 1);
      const key = (x: number, z: number): string => `${Math.round(x / step)},${Math.round(z / step)}`;
      const want = new Set<string>();
      for (let i = 0; i < stored.copies.length; i += 10) want.add(key(stored.copies[i]!, stored.copies[i + 2]!));
      for (let i = 0; i < set.count; i++) {
        const p = coverPointAt(set, i);
        expect(want.has(key(p.x, p.z))).toBe(true);
        expect(p.y).toBeCloseTo(1, 5);
        expect(p.normal[1]).toBeCloseTo(1, 2);
      }
    }
  });

  it('gives every floor under a ceiling its own points, the roof too, and the stored bake only the highest', () => {
    const { grid } = layer(true);
    const surface = blockScatterSurface({ grid, types: TYPES, origin: ORIGIN, topSubdivision: 1 });
    const rect = blockChunkRect(ORIGIN, [1, 1, 1], 0, 0);
    const any: ScatterRule = { ...MOSS, id: 'any', blocks: undefined };
    const all = bakeCoverPoints(any, surface, rect, ORIGIN);
    const ys = new Map<number, number>();
    for (let i = 0; i < all.count; i++) {
      const p = coverPointAt(all, i);
      ys.set(Math.round(p.y), (ys.get(Math.round(p.y)) ?? 0) + 1);
    }
    expect([...ys.keys()].sort()).toEqual([1, 5]);
    // About half the floor is roofed: the floor and the roof each take about half the column's points under it.
    expect(ys.get(5)! / all.count).toBeGreaterThan(0.25);
    expect(ys.get(1)! / all.count).toBeGreaterThan(0.6);
    expect(all.low).toBeCloseTo(1, 5);
    expect(all.high).toBeCloseTo(5, 5);
    const stored = bakeScatterCell([{ ...any, cover: false }], surface, null, rect, null, ORIGIN).cell.get('any')!;
    let roofed = 0;
    for (let i = 0; i < stored.copies.length; i += 10) if (stored.copies[i]! < 8 && Math.round(stored.copies[i + 1]!) === 1) roofed += 1;
    expect(roofed).toBe(0);
    // Moss names the floor blocks: under the roof as in the open, never on the roof.
    const moss = bakeCoverPoints(MOSS, surface, rect, ORIGIN);
    let under = 0;
    for (let i = 0; i < moss.count; i++) {
      const p = coverPointAt(moss, i);
      expect(Math.round(p.y)).toBe(1);
      if (p.x < 8) under += 1;
    }
    expect(under / moss.count).toBeGreaterThan(0.4);
    expect(under / moss.count).toBeLessThan(0.6);
  });

  it('reads back sorted by threshold, a share being a prefix, the thresholds spread evenly', () => {
    const { grid } = layer(false);
    const surface = blockScatterSurface({ grid, types: TYPES, origin: ORIGIN, topSubdivision: 1 });
    const set = bakeCoverPoints(MOSS, surface, blockChunkRect(ORIGIN, [1, 1, 1], 0, 0), ORIGIN);
    let last = 0;
    for (let i = 0; i < set.count; i++) {
      const p = coverPointAt(set, i);
      expect(p.threshold).toBeGreaterThanOrEqual(last);
      last = p.threshold;
      expect(p.yaw).toBeGreaterThan(0);
      expect(p.yaw).toBeLessThan(1);
    }
    for (const k of [0, 0.1, 0.25, 0.5, 0.9, 1]) {
      const n = coverPointsBelow(set, k);
      for (let i = 0; i < set.count; i++) expect(coverPointAt(set, i).threshold < k).toBe(i < n);
      expect(Math.abs(n / set.count - k)).toBeLessThan(0.05);
    }
    // The data is whole numbers below 2^24 or a height: the texture as it is.
    for (let i = 0; i < set.count; i++) for (const k of [0, 2, 3]) expect(Number.isInteger(set.data[i * 4 + k]!) && set.data[i * 4 + k]! < 2 ** 24).toBe(true);
  });

  it('ends a column whose surface answers the same ground again (a block taller than its cell)', () => {
    const g = { x: 0, y: 3, z: 0, slope: 0, wall: false, nx: 0, ny: 1, nz: 0, cavity: () => 0, layer: () => 0 };
    const same = { at: (x: number, z: number) => Object.assign(g, { x, z }), under: (x: number, z: number) => Object.assign(g, { x, z }) };
    const set = bakeCoverPoints({ ...MOSS, blocks: undefined }, same, [0, 0, 4, 4], [0, 0, 0]);
    // One point per candidate, about 6 a m² over the 16 m²: the column ended after its first ground.
    expect(set.count).toBeGreaterThan(80);
    expect(set.count).toBeLessThan(110);
  });

  it('keeps a normal to within a degree or so', () => {
    for (const n of [[0, 1, 0], [0.3, 0.9, 0.1], [-0.6, 0.5, 0.62], [0.9, 0.2, -0.38]]) {
      const len = Math.hypot(n[0]!, n[1]!, n[2]!);
      const u = [n[0]! / len, n[1]! / len, n[2]! / len];
      const s = Math.abs(u[0]!) + Math.abs(u[1]!) + Math.abs(u[2]!);
      const back = coverPointNormal(Math.round(((u[0]! / s) * 0.5 + 0.5) * 255), Math.round(((u[2]! / s) * 0.5 + 0.5) * 255));
      expect(Math.acos(Math.min(1, back[0] * u[0]! + back[1] * u[1]! + back[2] * u[2]!))).toBeLessThan(0.025);
    }
  });
});
