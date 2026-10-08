import { describe, expect, it } from 'vitest';

import type { ModelErrorV2 } from './errors';
import {
  bakeScatterCell,
  canonicalScatterRules,
  decodeScatterCell,
  encodeScatterCell,
  sameScatterCell,
  scatterCellCopies,
  scatterReach,
  scatterStrokeRect,
  strokeScatterEdits,
  validateScatterRules,
  withScatterEdits,
  type ScatterCell,
  type ScatterGround,
  type ScatterRect,
  type ScatterRule,
  type ScatterSurface,
} from './scatter';

/** Rolling ground: flat west of x = 0, a 45° slope rising east of it; layer 1 north of z = 20. */
function rolling(): ScatterSurface {
  const g: ScatterGround = { x: 0, y: 0, z: 0, slope: 0, wall: false, nx: 0, ny: 1, nz: 0, cavity: () => 0, layer: (l) => (l === 1 ? (g.z > 20 ? 1 : 0) : g.z > 20 ? 0 : 1) };
  return {
    at(x, z) {
      if (x > 60) return null;
      g.x = x;
      g.z = z;
      const steep = x > 0;
      g.y = steep ? x : 0;
      g.slope = steep ? 45 : 0;
      const s = Math.SQRT1_2;
      [g.nx, g.ny, g.nz] = steep ? [-s, s, 0] : [0, 1, 0];
      return g;
    },
  };
}

const TREES: ScatterRule = { id: 'trees', asset: { assetId: 'tree' }, density: 0.05, spacing: 3, slope: { max: 30 }, scale: [0.8, 1.2] };
const ROCKS: ScatterRule = { id: 'rocks', asset: { assetId: 'rock' }, density: 0.02, layers: [{ layer: 1, min: 0.5 }] };
const BOUNDS: ScatterRect = [-64, -64, 64, 64];

function positions(cell: ScatterCell, rule: string): [number, number][] {
  const c = cell.get(rule);
  if (c === undefined) return [];
  const out: [number, number][] = [];
  for (let i = 0; i < c.copies.length; i += 10) out.push([c.copies[i]!, c.copies[i + 2]!]);
  return out;
}

describe('scatter rules', () => {
  it('validates and canonicalises', () => {
    const errors: ModelErrorV2[] = [];
    validateScatterRules([TREES, ROCKS], '/scatter', errors, false);
    expect(errors).toEqual([]);
    validateScatterRules([{ ...TREES, blocks: ['grass'] }, { id: 'trees', asset: { assetId: 'x' }, density: 0 }, { ...ROCKS, layers: [{ layer: 7, min: 2, max: 1 }] }], '/scatter', errors, true);
    expect(errors.map((e) => e.path)).toEqual(['/scatter/1/id', '/scatter/1/density', '/scatter/2/layers/0', '/scatter/2/layers/0/layer']);
    expect(canonicalScatterRules([{ ...TREES, yaw: 360, align: 0, seed: 0 }])).toEqual([{ id: 'trees', asset: { assetId: 'tree' }, density: 0.05, spacing: 3, scale: [0.8, 1.2], slope: { max: 30 } }]);
    expect(scatterReach([TREES, { ...ROCKS, cavity: { min: 0, radius: 4 } }])).toBe(4);
    // Far copies as impostors below a screen size; never for ground cover (it never draws that far).
    const far: ModelErrorV2[] = [];
    validateScatterRules([{ ...TREES, impostorSize: 0.03 }, { ...ROCKS, impostorSize: 2 }, { id: 'grass', asset: { assetId: 'tuft' }, density: 2, cover: true, impostorSize: 0.03 }], '/scatter', far, false);
    expect(far.map((e) => e.path)).toEqual(['/scatter/1/impostorSize', '/scatter/2/impostorSize']);
    expect(canonicalScatterRules([{ ...TREES, impostorSize: 0.03, collide: true }])[0]).toMatchObject({ impostorSize: 0.03, collide: true });
  });

  it('places copies only where the conditions hold, never closer than the spacing', () => {
    const { cell } = bakeScatterCell([TREES, ROCKS], rolling(), null, BOUNDS, null, [0, 0, 0]);
    const trees = positions(cell, 'trees');
    expect(trees.length).toBeGreaterThan(50);
    // The slope is 45° east of x = 0, past the rule's 30°: no tree there.
    expect(trees.every(([x]) => x <= 0)).toBe(true);
    for (let i = 0; i < trees.length; i++) for (let j = i + 1; j < trees.length; j++) expect(Math.hypot(trees[i]![0] - trees[j]![0], trees[i]![1] - trees[j]![1])).toBeGreaterThanOrEqual(3);
    // Rocks grow only where layer 1 shows (north of z = 20), and the ground's height is theirs.
    const rocks = cell.get('rocks')!;
    expect(rocks.cells.length).toBeGreaterThan(0);
    for (let i = 0; i < rocks.copies.length; i += 10) {
      expect(rocks.copies[i + 2]).toBeGreaterThan(20);
      expect(rocks.copies[i + 1]).toBeCloseTo(Math.max(0, rocks.copies[i]!), 4);
    }
    // Deterministic, and the bytes round-trip.
    const again = bakeScatterCell([TREES, ROCKS], rolling(), null, BOUNDS, null, [0, 0, 0]).cell;
    expect(sameScatterCell(cell, again)).toBe(true);
    expect(sameScatterCell(decodeScatterCell(encodeScatterCell(cell)!), cell)).toBe(true);
  });

  it('a rectangle baked again gives the bytes of a whole bake', () => {
    const before = bakeScatterCell([TREES, ROCKS], rolling(), null, BOUNDS, null, [0, 0, 0]).cell;
    // The ground east of x = -20 changes (it becomes flat everywhere): bake the change grown by the reach.
    const flat: ScatterSurface = {
      at(x, z) {
        const g = rolling().at(Math.min(x, 0), z);
        if (g === null || x > 60) return null;
        return { ...g, x, z, layer: (l: number) => (l === 1 ? (z > 20 ? 1 : 0) : z > 20 ? 0 : 1) };
      },
    };
    const reach = scatterReach([TREES, ROCKS]);
    const part = bakeScatterCell([TREES, ROCKS], flat, before, BOUNDS, [-20 - reach, -64, 64, 64], [0, 0, 0]).cell;
    const whole = bakeScatterCell([TREES, ROCKS], flat, null, BOUNDS, null, [0, 0, 0]).cell;
    expect(sameScatterCell(part, whole)).toBe(true);
    expect(scatterCellCopies(whole)).toBeGreaterThan(scatterCellCopies(before));
  });

  it('hand edits survive a bake and follow the ground', () => {
    const base = bakeScatterCell([TREES], rolling(), null, BOUNDS, null, [0, 0, 0]).cell;
    // Paint trees on the steep slope (the rule says none) and erase them around the origin.
    const paint = { rule: 'trees', mode: 'paint' as const, dabs: [[30, 0]] as [number, number][], radius: 10 };
    const erase = { rule: 'trees', mode: 'erase' as const, dabs: [[-20, -20]] as [number, number][], radius: 12 };
    let cell = base;
    for (const stroke of [paint, erase]) {
      const edits = strokeScatterEdits(cell.get('trees'), TREES, stroke, BOUNDS)!;
      expect(edits).not.toBeNull();
      cell = withScatterEdits(cell, 'trees', edits);
      cell = bakeScatterCell([TREES], rolling(), cell, BOUNDS, scatterStrokeRect(stroke, scatterReach([TREES])), [0, 0, 0]).cell;
    }
    const trees = positions(cell, 'trees');
    expect(trees.some(([x, z]) => Math.hypot(x - 30, z) <= 10)).toBe(true);
    expect(trees.some(([x, z]) => Math.hypot(x + 20, z + 20) <= 12)).toBe(false);
    // A whole bake keeps both edits.
    const whole = bakeScatterCell([TREES], rolling(), cell, BOUNDS, null, [0, 0, 0]).cell;
    expect(sameScatterCell(whole, cell)).toBe(true);
    // Painting the same place twice changes nothing.
    expect(strokeScatterEdits(cell.get('trees'), TREES, paint, BOUNDS)).toBeNull();
    // The painted copies sit on the slope's height.
    const c = whole.get('trees')!;
    for (let i = 0; i < c.copies.length; i += 10) if (c.copies[i]! > 0) expect(c.copies[i + 1]).toBeCloseTo(c.copies[i]!, 4);
  });

  it('copies are in the source frame and a rule dropped loses its entry', () => {
    const at = bakeScatterCell([TREES, ROCKS], rolling(), null, BOUNDS, null, [5, 2, -3]).cell;
    const zero = bakeScatterCell([TREES, ROCKS], rolling(), null, BOUNDS, null, [0, 0, 0]).cell;
    const a = at.get('trees')!.copies;
    const b = zero.get('trees')!.copies;
    expect(a[0]).toBeCloseTo(b[0]! - 5, 4);
    expect(a[1]).toBeCloseTo(b[1]! - 2, 4);
    expect(a[2]).toBeCloseTo(b[2]! + 3, 4);
    const without = bakeScatterCell([ROCKS], rolling(), zero, BOUNDS, null, [0, 0, 0]).cell;
    expect([...without.keys()]).toEqual(['rocks']);
  });
});
