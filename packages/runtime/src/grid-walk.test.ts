/**
 * `ctx.grid`'s walk queries on the running grid: a path through a door that
 * a script opens (closed: none), the step limit from the layer's walk and
 * from the query, occupied cells avoided, a cost field, the walk field, a
 * kit's broken door, reach within a cost, and refusals of options that do
 * not fit.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, applyBlockEdits, type BlockLayerComponent, type BlockType, type CellField, type EntityV3 } from '@thirdlight/project-model';

import { RuntimeGrid } from './grid';

const COMP: BlockLayerComponent = { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [16, 8, 16] } };
const T = { position: [10, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const TYPES: BlockType[] = [
  { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' },
  { blockId: 'mud', name: 'Mud', variants: [{ color: '#664422' }], shape: 'full', metadata: { cost: 4 } },
  { blockId: 'wall', name: 'Wall', variants: [{ color: '#aaaaaa' }], shape: 'full', placement: 'edge' },
  { blockId: 'door', name: 'Door', variants: [{ color: '#884422' }], shape: 'full', placement: 'edge', kits: { ruined: { block: 'gap' } } },
  { blockId: 'gap', name: 'Gap', variants: [{ color: '#442211' }], shape: 'none', placement: 'edge', blocking: false },
];
const FIELDS: CellField[] = [
  { key: 'cost', type: 'float', default: 1 },
  { key: 'walkable', type: 'bool', default: true },
];

/** A 12 × 12 floor (row 0, tops at 0.5 m); a wall on the line x = 6 with a closed door at z = 9; a step a row up at x 10. */
function layer(comp: BlockLayerComponent = COMP): EntityV3 {
  const g = new BlockGrid(comp);
  const wall: number[] = [];
  for (let z = 0; z < 12; z++) if (z !== 9) wall.push(6, 1, z, 0, 6, 2, z, 0);
  applyBlockEdits(g, [
    { kind: 'fill', box: [0, 0, 0, 12, 1, 12], cell: { block: 'stone' } },
    { kind: 'fill', box: [10, 1, 0, 12, 2, 12], cell: { block: 'stone' } },
    { kind: 'edges', at: wall, edge: { block: 'wall' } },
    { kind: 'edges', at: [6, 1, 9, 0, 6, 2, 9, 0], edge: { block: 'door' } },
  ] as never, { types: new Map(TYPES.map((t) => [t.blockId, t])), stamps: new Map() });
  const data = g.toData('g', null, g.takeDirty().chunks);
  return { id: 'g', components: { transform: T, blockLayer: { ...comp, ...(data !== null ? { data } : {}) } } } as unknown as EntityV3;
}
const cells = (r: readonly { x: number; y: number; z: number }[] | null): string | null => (r === null ? null : r.map((p) => `${p.x},${p.y},${p.z}`).join(' '));

describe('ctx.grid walk queries', () => {
  it('finds a path through a door a script opens, with world points and costs; none while it is closed', () => {
    const grid = new RuntimeGrid(TYPES, FIELDS, false);
    grid.addLayers([layer()]);
    const api = grid.api;
    expect(api.path('g', [2, 1, 2], [8, 1, 2])).toBeNull();
    // The lower leaf open: a walker a row high (the default headroom) passes, one two rows high does not.
    expect(api.setEdgeOpen('g', 5, 1, 9, '+x', true)).toBe(true);
    expect(api.path('g', [2, 1, 2], [8, 1, 2])).not.toBeNull();
    expect(api.path('g', [2, 1, 2], [8, 1, 2], { headroom: 1 })).toBeNull();
    expect(api.setEdgeOpen('g', 5, 2, 9, '+x', true)).toBe(true);
    const p = api.path('g', [2, 1, 2], [8, 1, 2], { headroom: 1 })!;
    expect(p[0]).toMatchObject({ x: 2, y: 0, z: 2, cost: 0 });
    // The point is on the top at the cell's centre, in the world (the layer's origin is at x 10).
    expect(p[0]!.point).toEqual({ x: 12.5, y: 0.5, z: 2.5 });
    expect(p.at(-1)).toMatchObject({ x: 8, y: 0, z: 2 });
    expect(cells(p)).toContain('5,0,9 6,0,9');
    expect(p.at(-1)!.cost).toBeCloseTo(p.length - 1, 9);
    // Neighbours of the doorway's west cell include the east one now.
    expect(api.walkNeighbours('g', [5, 0, 9]).map((n) => `${n.x},${n.z}`)).toContain('6,9');
  });

  it("takes the step limit from the layer's walk or the query; a kit's broken door lets through", () => {
    const grid = new RuntimeGrid(TYPES, FIELDS, false);
    grid.addLayers([layer({ ...COMP, walk: { maxStep: 0.5 } })]);
    const api = grid.api;
    // The row-high step at x 10 (0.5 m) is within the layer's step; a query can make it too high.
    expect(cells(api.path('g', [8, 1, 0], [11, 2, 0]))).toBe('8,0,0 9,0,0 10,1,0 11,1,0');
    expect(api.path('g', [8, 1, 0], [11, 2, 0], { maxStep: 0.25 })).toBeNull();
    // Down a row: the default drop is half a cell (0.25 m), so not back down; with a drop it is.
    expect(api.path('g', [11, 2, 0], [8, 1, 0])).toBeNull();
    expect(api.path('g', [11, 2, 0], [8, 1, 0], { maxDrop: 0.5 })).not.toBeNull();
    // The ruined kit shows the doors as gaps: the way is open.
    expect(api.path('g', [2, 1, 2], [8, 1, 2])).toBeNull();
    expect(api.setKit('g', 'ruined')).toBe(true);
    expect(api.path('g', [2, 1, 2], [8, 1, 2])).not.toBeNull();
  });

  it('avoids occupied cells, prices cells by a cost field, keeps to the walk field, and reaches within a cost', () => {
    const grid = new RuntimeGrid(TYPES, FIELDS, false);
    grid.addLayers([layer()]);
    const api = grid.api;
    const straight = cells(api.path('g', [0, 0, 4], [4, 0, 4]));
    expect(straight).toBe('0,0,4 1,0,4 2,0,4 3,0,4 4,0,4');
    // A unit stands on (2, 0, 4): the path goes round it.
    const round = api.path('g', [0, 0, 4], [4, 0, 4], { avoid: [[2, 0, 4]] })!;
    expect(cells(round)).not.toContain('2,0,4');
    expect(round).toHaveLength(7);
    // Mud costs 4 a metre: a mud line across z 4 at x 2 is walked round when cost counts, through when it doesn't.
    expect(api.set('g', 2, 0, 4, { block: 'mud' })).toBe(true);
    expect(cells(api.path('g', [0, 0, 4], [4, 0, 4]))).toBe(straight);
    expect(cells(api.path('g', [0, 0, 4], [4, 0, 4], { costField: 'cost' }))).not.toContain('2,0,4');
    // Not walkable: a cell marked so is no place.
    expect(api.setMeta('g', 1, 0, 4, 'walkable', false)).toBe(true);
    expect(cells(api.path('g', [0, 0, 4], [4, 0, 4], { field: 'walkable' }))).not.toContain('1,0,4');
    // Reach: within 1 m of (3, 0, 3), a cross of 5.
    expect(api.reachable('g', [3, 0, 3], 1).map((p) => `${p.x},${p.z}`).sort()).toEqual(['2,3', '3,2', '3,3', '3,4', '4,3']);
    expect(api.reachable('g', [3, 0, 3], 1)[0]).toMatchObject({ x: 3, z: 3, cost: 0 });
  });

  it('refuses options that do not fit and cells that name no place', () => {
    const grid = new RuntimeGrid(TYPES, FIELDS, false);
    grid.addLayers([layer()]);
    const api = grid.api;
    expect(api.path('g', [0, 0, 4], [4, 0, 4], { costField: 'walkable' })).toBeNull();
    expect(api.path('g', [0, 0, 4], [4, 0, 4], { field: 'nope' })).toBeNull();
    expect(api.path('g', [0, 0, 4], [4, 0, 4], { maxStep: -1 })).toBeNull();
    expect(api.path('g', [0, 0, 4], [4, 0, 4], { avoid: [[1, 2]] })).toBeNull();
    expect(api.path('g', [0, 0], [4, 0, 4])).toBeNull();
    expect(api.path('nope', [0, 0, 4], [4, 0, 4])).toBeNull();
    // Outside the layer's columns: no place.
    expect(api.path('g', [14, 3, 14], [4, 0, 4])).toBeNull();
    expect(api.walkNeighbours('g', [14, 3, 14])).toEqual([]);
    expect(api.reachable('g', [3, 0, 3], -1)).toEqual([]);
  });
});
