import { describe, expect, it } from 'vitest';
import { BUILDING_GENERATOR } from './building';
import { followOpening, OPENING_SIZES, openingCells, openingFrame, propFitsOpening, yawQuaternion } from './openings';
import type { StructureDefinition, StructureOpening } from './definition';

const MAT = { wall: 3, floor: 4, roof: 5, foundation: 6, stair: 7 };

function house(points: [number, number][], openings: StructureOpening[]): StructureDefinition {
  return BUILDING_GENERATOR.canonical({ footprint: [{ id: 'main', points }], storeys: 1, storeyHeight: 6, foundationDepth: 2, roof: { shape: 'flat', overhang: 0, axis: 'x' }, materials: MAT, openings, stairs: [], generator: 1 });
}

const door = (edge: number, at = 2): StructureOpening => ({ id: `d${edge}`, polygon: 'main', edge, storey: 0, at, width: 2, height: 4, sill: 0 });

describe('openings: cells, frame, sizes, the fit rule', () => {
  for (const [name, pts] of [
    ['anticlockwise', [[0, 0], [12, 0], [12, 10], [0, 10]]],
    ['clockwise', [[0, 0], [0, 10], [12, 10], [12, 0]]],
  ] as const) {
    it(`each edge's opening is its wall's cells, facing out (${name} points)`, () => {
      const def = house(pts.map((p) => [...p] as [number, number]), [0, 1, 2, 3].map((e) => door(e)));
      for (const o of def.openings) {
        const c = openingCells(def, o)!;
        const f = openingFrame(def, o)!;
        // The cells are wall cells the generator writes as openings, and one step out is outside the plan.
        const plan = { x0: 0, z0: 0, x1: 12, z1: 10 };
        for (const [x, z] of c.columns) expect(x === 0 || x === plan.x1 - 1 || z === 0 || z === plan.z1 - 1).toBe(true);
        for (const [x, z] of c.columns) {
          const ox = x + c.out[0];
          const oz = z + c.out[1];
          expect(ox < plan.x0 || ox >= plan.x1 || oz < plan.z0 || oz >= plan.z1).toBe(true);
        }
        expect([c.y0, c.y1]).toEqual([1, 4]);
        // The frame: the opening's middle, its prop's +z out of the building.
        expect(f.position[1]).toBe(0.5);
        const out = [Math.sin(f.yawRad), Math.cos(f.yawRad)];
        expect(out[0]).toBeCloseTo(c.out[0], 9);
        expect(out[1]).toBeCloseTo(c.out[1], 9);
        expect(f.size).toEqual([1, 2, 0.5]);
      }
    });
  }

  it('a prop following its opening keeps its place relative to it (moved, turned with another wall, resized)', () => {
    const def = house([[0, 0], [12, 0], [12, 10], [0, 10]], [door(0)]);
    const f0 = openingFrame(def, def.openings[0]!)!;
    const nudged = { position: [f0.position[0] + 0.1, f0.position[1], f0.position[2] - 0.05] as [number, number, number], rotation: yawQuaternion(f0.yawRad) };
    const same = followOpening(nudged, f0, f0);
    same.position.forEach((v, i) => expect(v).toBeCloseTo(nudged.position[i]!, 9));
    // Moved along its wall by 2 cells: the prop by 1 m.
    const f1 = openingFrame(def, { ...def.openings[0]!, at: 4 })!;
    const moved = followOpening(nudged, f0, f1);
    expect(Math.hypot(moved.position[0] - nudged.position[0], moved.position[2] - nudged.position[2])).toBeCloseTo(1, 9);
    // Onto another wall: turned with it, its nudge turned too (the same offset in the opening's own frame).
    const f2 = openingFrame(def, { ...def.openings[0]!, edge: 1, at: 2 })!;
    const turned = followOpening(nudged, f0, f2);
    const q = yawQuaternion(f2.yawRad);
    turned.rotation.forEach((v, i) => expect(Math.abs(v)).toBeCloseTo(Math.abs(q[i]!), 9));
    expect(Math.hypot(turned.position[0] - f2.position[0], turned.position[2] - f2.position[2])).toBeCloseTo(Math.hypot(0.1, 0.05), 9);
  });

  it('standard sizes fit a default storey; a prop fits by its bounds within the opening and one cell deep', () => {
    for (const s of OPENING_SIZES) expect(s.sill + s.height).toBeLessThanOrEqual(5);
    const o = { width: 2, height: 4 };
    expect(propFitsOpening([1, 2, 0.1], o)).toBe(true);
    expect(propFitsOpening([1.04, 2.04, 0.54], o)).toBe(true);
    expect(propFitsOpening([1.1, 2, 0.1], o)).toBe(false);
    expect(propFitsOpening([1, 2.1, 0.1], o)).toBe(false);
    expect(propFitsOpening([1, 2, 0.6], o)).toBe(false);
  });
});
