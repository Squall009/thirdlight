import { BUILDING_GENERATOR_VERSION, openingFrame, type StructureDefinition, type StructureOpening } from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';

import { movedOpening, nextOpeningId, openingAtCell, openingBox, openingOnWall, openingProblem, openingWords, propChoices, propOutgrown, propPlacement, snapAlong, wallUnderCell, withOpening, withoutOpening } from './structure-openings';

/** A 6 × 5 m house (12 × 10 cells), one storey of 7 rows (its slab, 6 rows of wall), its points anticlockwise from (0, 0). */
const HOUSE: StructureDefinition = {
  footprint: [{ id: 'room', points: [[0, 0], [12, 0], [12, 10], [0, 10]] }],
  storeys: 1,
  storeyHeight: 7,
  foundationDepth: 0,
  roof: { shape: 'flat', overhang: 0, axis: 'x' },
  materials: { wall: 9, floor: 9, roof: 9, foundation: 9, stair: 9 },
  openings: [],
  stairs: [],
  generator: BUILDING_GENERATOR_VERSION,
};
const DOOR = { kind: 'door', width: 3, height: 4, sill: 0 } as const;
const WINDOW = { kind: 'window', width: 2, height: 2, sill: 2 } as const;

describe('the wall under the pointer', () => {
  it('names the polygon edge, storey, place along it and row of a wall cell; a corner by the face picked; none for a slab or the roof', () => {
    // The front wall (edge 0, z 0), its cells x 0 … 11 from the edge's start; row 1 over the slab.
    expect(wallUnderCell(HOUSE, [5, 2, 0], [0, 0, -1])).toEqual({ polygon: 'room', edge: 0, storey: 0, length: 12, along: 5, row: 1 });
    // The side wall at x 0 runs from (0, 10) to (0, 0): its cells counted from z 9 down.
    expect(wallUnderCell(HOUSE, [0, 3, 6], [-1, 0, 0])).toEqual({ polygon: 'room', edge: 3, storey: 0, length: 10, along: 3, row: 2 });
    // The corner cell (0, 0) is both walls': the face looking −z is the front wall's, the face looking −x the side's.
    expect(wallUnderCell(HOUSE, [0, 2, 0], [0, 0, -1])?.edge).toBe(0);
    expect(wallUnderCell(HOUSE, [0, 2, 0], [-1, 0, 0])?.edge).toBe(3);
    // The slab (row 0) and the roof (row 7) are no wall; a cell inside the room is none.
    expect(wallUnderCell(HOUSE, [5, 0, 0], [0, 0, -1])).toBeNull();
    expect(wallUnderCell(HOUSE, [5, 7, 0], [0, 1, 0])).toBeNull();
    expect(wallUnderCell(HOUSE, [5, 2, 5], [0, 0, -1])).toBeNull();
  });

  it('snaps an opening centred on the cell under the pointer, kept off the wall’s end cells', () => {
    expect(snapAlong({ length: 12, along: 5 }, 3)).toBe(4);
    expect(snapAlong({ length: 12, along: 6 }, 2)).toBe(6);
    expect(snapAlong({ length: 12, along: 0 }, 2)).toBe(1);
    expect(snapAlong({ length: 12, along: 11 }, 4)).toBe(7);
    const wall = wallUnderCell(HOUSE, [5, 2, 0], [0, 0, -1])!;
    expect(openingOnWall(HOUSE, wall, DOOR)).toEqual({ id: 'door-1', polygon: 'room', edge: 0, storey: 0, at: 4, width: 3, height: 4, sill: 0 });
  });
});

describe('an opening’s ghost, ids and edits', () => {
  it('gives its cells as a box in the grid (metres) and finds the opening a cell is in', () => {
    const door: StructureOpening = { id: 'door-1', polygon: 'room', edge: 0, storey: 0, at: 4, width: 3, height: 4, sill: 0 };
    expect(openingBox(HOUSE, door)).toEqual({ min: [2, 0.5, 0], max: [3.5, 2.5, 0.5] });
    const def = withOpening(HOUSE, door);
    expect(openingAtCell(def, [5, 3, 0])?.id).toBe('door-1');
    expect(openingAtCell(def, [5, 5, 0])).toBeNull();
    expect(openingAtCell(def, [7, 1, 0])).toBeNull();
    expect(nextOpeningId(def, 'door')).toBe('door-2');
    expect(nextOpeningId(def, 'window')).toBe('window-1');
    expect(movedOpening(def, 'door-1', 2)?.at).toBe(6);
    expect(withoutOpening(def, 'door-1').openings).toEqual([]);
    expect(withOpening(def, { ...door, width: 2 }).openings).toEqual([{ ...door, width: 2 }]);
    expect(openingWords(door)).toBe('Door 1.5 × 2 m');
    expect(openingWords({ width: 2, height: 2, sill: 2 })).toBe('Window 1 × 1 m, sill 1 m');
  });

  it('refuses in words: a corner, touching or overlapping another on its wall, and what the generator refuses (too tall for the storey, inside where wings meet)', () => {
    const door: StructureOpening = { id: 'door-1', polygon: 'room', edge: 0, storey: 0, at: 4, width: 3, height: 4, sill: 0 };
    expect(openingProblem(HOUSE, door)).toBeNull();
    expect(openingProblem(HOUSE, { ...door, at: 0 })).toMatch(/corner of its wall: keep it within cells 1 to 10/);
    expect(openingProblem(HOUSE, { ...door, at: 9 })).toMatch(/corner/);
    const def = withOpening(HOUSE, door);
    const win: StructureOpening = { id: 'window-1', polygon: 'room', edge: 0, storey: 0, at: 7, width: 2, height: 2, sill: 2 };
    expect(openingProblem(def, win)).toMatch(/touches "door-1": leave at least one cell of wall/);
    expect(openingProblem(def, { ...win, at: 6 })).toMatch(/overlaps "door-1"/);
    expect(openingProblem(def, { ...win, at: 8 })).toBeNull();
    // Over the door's top on the same columns: not touching (a cell of wall between rows 4 and 6).
    expect(openingProblem(def, { ...win, at: 4, sill: 5, height: 1 })).toBeNull();
    // Too tall: the generator's own check, as it says it.
    expect(openingProblem(HOUSE, { ...win, sill: 2, height: 5 })).toMatch(/sill 2 \+ height 5 is more than the 6 rows/);
    // An L: the main room's edge 1 (x 12) meets a wing there; an opening where they join is inside the building.
    const L: StructureDefinition = { ...HOUSE, footprint: [...HOUSE.footprint, { id: 'wing', points: [[12, 0], [20, 0], [20, 6], [12, 6]] }] };
    expect(openingProblem(L, { ...door, edge: 1, at: 2, width: 2 })).toMatch(/inside the building/);
  });
});

describe('props for an opening', () => {
  const door: StructureOpening = { id: 'door-1', polygon: 'room', edge: 0, storey: 0, at: 4, width: 3, height: 5, sill: 0 };
  const leaf = { assetId: 'leaf', displayName: 'Leaf', bounds: { min: [-0.75, 0, -0.05], max: [0.75, 2.5, 0.05] } };
  const thick = { assetId: 'thick', displayName: 'Thick', bounds: { min: [-0.75, 0, -0.4], max: [0.75, 2.5, 0.4] } };
  const wide = { assetId: 'wide', displayName: 'Wide', bounds: { min: [0, 0, 0], max: [2, 2.5, 0.1] } };
  const old = { assetId: 'old', displayName: 'Old crate', bounds: null };

  it('offers the models that fit (bounds within the opening, a cell deep, 5 cm over), then those of unknown size; not the rest', () => {
    expect(propChoices([wide, old, thick, leaf], door)).toEqual([{ asset: leaf, fits: true }, { asset: old, fits: null }]);
    // 1.55 m wide passes a 1.5 m opening by the tolerance; 1.6 m does not.
    expect(propChoices([{ ...wide, bounds: { min: [0, 0, 0], max: [1.55, 2, 0.1] } }], door)).toHaveLength(1);
    expect(propChoices([{ ...wide, bounds: { min: [0, 0, 0], max: [1.6, 2, 0.1] } }], door)).toHaveLength(0);
    expect(propOutgrown(leaf.bounds, { width: 2, height: 4 })).toBe(true);
    expect(propOutgrown(leaf.bounds, door)).toBe(false);
    expect(propOutgrown(null, { width: 1, height: 1 })).toBe(false);
  });

  it('places a prop by its bounds: centred on the opening’s width and the wall, on its sill, turned with it', () => {
    const f = openingFrame(HOUSE, door)!;
    // A model centred on its origin stands at the opening's frame.
    expect(propPlacement(HOUSE, door, leaf.bounds)!.position.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([...f.position]);
    // A model whose origin is its bottom-left corner (x 0 … 1.5) is moved half its width along the wall (turned 180°).
    const p = propPlacement(HOUSE, door, { min: [0, 0, 0], max: [1.5, 2.5, 0.1] })!;
    expect(p.position[0]).toBeCloseTo(f.position[0] + 0.75, 9);
    expect(p.position[1]).toBeCloseTo(f.position[1], 9);
    expect(p.position[2]).toBeCloseTo(f.position[2] + 0.05, 9);
    expect(p.rotation[1]).toBeCloseTo(Math.sin(f.yawRad / 2), 9);
    // Of unknown size: its origin at the frame.
    expect(propPlacement(HOUSE, door, null)!.position).toEqual([...f.position]);
  });
});
