/**
 * Edge pieces on the runtime grid: `ctx.grid` reads an edge's piece and
 * whether it blocks passage, writes and opens them (refused where they do not
 * fit), the chunk collider follows a door's state in the same flush, a save's
 * diff carries them, and a live door spawns its prefab on its edge.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, applyBlockEdits, type BlockLayerComponent, type BlockType, type EntityV3, type PrefabDefinition } from '@thirdlight/project-model';

import { RuntimeGrid } from './grid';
import type { PhysicsPort3D, StaticColliderSpec3D } from './ports';

const COMP: BlockLayerComponent = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [16, 4, 16] } };
const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const TYPES: BlockType[] = [
  { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' },
  { blockId: 'wall', name: 'Wall', variants: [{ color: '#aaaaaa' }], shape: 'full', placement: 'edge' },
  { blockId: 'rail', name: 'Rail', variants: [{ color: '#444444' }], shape: 'half', placement: 'edge', blocking: false },
  { blockId: 'door', name: 'Door', variants: [{ prefab: 'door' }], shape: 'full', placement: 'edge', live: true },
];
const DOOR: PrefabDefinition = {
  prefabId: 'door',
  displayName: 'Door',
  createdRevision: 1,
  entityCount: 2,
  depth: 2,
  entities: [
    { localId: 'box-0001', components: { transform: T, model: { asset: { assetId: 'frame' } } } },
    { localId: 'box-0002', parentLocalId: 'box-0001', components: { transform: T, box: { size: [1, 1, 0.1] } } },
  ],
} as never;

function layer(build: (g: BlockGrid) => void): EntityV3 {
  const g = new BlockGrid(COMP);
  build(g);
  const data = g.toData('g', null, g.takeDirty().chunks);
  return { id: 'g', components: { transform: T, blockLayer: { ...COMP, ...(data !== null ? { data } : {}) } } } as unknown as EntityV3;
}
const edits = (g: BlockGrid, list: unknown[]): void => void applyBlockEdits(g, list as never, { types: new Map(TYPES.map((t) => [t.blockId, t])), stamps: new Map() });

function fakePort(): PhysicsPort3D & { added: StaticColliderSpec3D[]; removed: string[] } {
  const added: StaticColliderSpec3D[] = [];
  const removed: string[] = [];
  return {
    dimension: 3,
    added,
    removed,
    stageCharacterMove: () => undefined,
    step: () => ({ requested: { x: 0, y: 0, z: 0 }, applied: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 }, grounded: false, supportNormal: { x: 0, y: 1, z: 0 }, contacts: { ground: false, wall: false, head: false, steepSlope: false }, snapped: false }),
    addStaticColliders: (specs) => added.push(...specs),
    removeStaticColliders: (ids) => removed.push(...ids),
    dispose: () => undefined,
  };
}
const triangles = (specs: readonly StaticColliderSpec3D[]): number => specs.reduce((n, s) => n + ((s.shape as { indices?: number[] }).indices?.length ?? 0) / 3, 0);

/** A floor, a wall between (2, 1, 2) and (3, 1, 2), a rail on (2, 1, 2)'s −z side and a door on its +z side. */
const room = (g: BlockGrid): void =>
  edits(g, [
    { kind: 'fill', box: [0, 0, 0, 8, 1, 8], cell: { block: 'stone' } },
    { kind: 'edges', at: [3, 1, 2, 0], edge: { block: 'wall' } },
    { kind: 'edges', at: [2, 1, 2, 1], edge: { block: 'rail' } },
    { kind: 'edges', at: [2, 1, 3, 1], edge: { block: 'door' } },
  ]);

describe('edge pieces on the runtime grid', () => {
  it('reads an edge from either cell beside it, with its blocked state; writes are checked', () => {
    const grid = new RuntimeGrid(TYPES, [], true);
    grid.addLayers([layer(room)]);
    const api = grid.api;
    expect(api.edge('g', 2, 1, 2, '+x')).toEqual({ block: 'wall', rot: 0, variant: 0, open: false, blocked: true });
    expect(api.edge('g', 3, 1, 2, '-x')).toEqual(api.edge('g', 2, 1, 2, '+x'));
    expect(api.blocked('g', 3, 1, 2, '-x')).toBe(true);
    // A rail stands there but does not block; no piece blocks nothing.
    expect(api.edge('g', 2, 1, 2, '-z')?.block).toBe('rail');
    expect(api.blocked('g', 2, 1, 2, '-z')).toBe(false);
    expect(api.blocked('g', 2, 1, 2, '-x')).toBe(false);
    expect(api.blocked('g', 2, 1, 2, '+z')).toBe(true);
    // Open the door: passage, and the change is seen by scripts one step later.
    grid.beginStep(1);
    expect(api.setEdgeOpen('g', 2, 1, 3, '-z', true)).toBe(true);
    expect(api.setEdgeOpen('g', 2, 1, 3, '-z', true)).toBe(false);
    expect(api.blocked('g', 2, 1, 2, '+z')).toBe(false);
    expect(api.edge('g', 2, 1, 2, '+z')).toMatchObject({ open: true, blocked: false });
    grid.beginStep(2);
    expect(api.changes()).toEqual([{ layer: 'g', x: 2, y: 1, z: 3, before: 'door', after: 'door', stepIndex: 1, side: '-z' }]);
    // Refused: a cell block on an edge, a quarter turn, out of bounds, an unknown side.
    expect(api.setEdge('g', 5, 1, 5, '+x', { block: 'stone' })).toBe(false);
    expect(api.setEdge('g', 5, 1, 5, '+x', { block: 'wall', rot: 90 })).toBe(false);
    expect(api.setEdge('g', 15, 1, 5, '+x', { block: 'wall' })).toBe(true);
    expect(api.setEdge('g', 16, 1, 5, '+x', { block: 'wall' })).toBe(false);
    expect(api.setEdge('g', 5, 1, 5, 'up' as never, { block: 'wall' })).toBe(false);
    expect(api.clearEdge('g', 15, 1, 5, '+x')).toBe(true);
    expect(api.clearEdge('g', 15, 1, 5, '+x')).toBe(false);
    // Edges are no cells: the cell beside a wall is still empty.
    expect(api.get('g', 2, 1, 2)).toBeNull();
    expect(api.set('g', 2, 1, 2, { block: 'wall' })).toBe(false);
  });

  it("the chunk's collider loses an opened door and gets it back closed, in the next flush", () => {
    const port = fakePort();
    const grid = new RuntimeGrid(TYPES, [], true);
    grid.addLayers([layer(room)]);
    grid.flushCollision(port);
    const closed = triangles(port.added);
    port.added.length = 0;
    grid.api.setEdgeOpen('g', 2, 1, 2, '+z', true);
    grid.flushCollision(port);
    // The door's slab (12 triangles) is gone; the wall, rail and floor stay.
    expect(triangles(port.added)).toBe(closed - 12);
    port.added.length = 0;
    grid.api.setEdgeOpen('g', 2, 1, 2, '+z', false);
    grid.flushCollision(port);
    expect(triangles(port.added)).toBe(closed);
  });

  it("a save's diff carries the edges changed, and restoring it puts them back", () => {
    const grid = new RuntimeGrid(TYPES, [], false);
    grid.addLayers([layer(room)]);
    grid.api.setEdgeOpen('g', 2, 1, 2, '+z', true);
    grid.api.clearEdge('g', 3, 1, 2, '-x');
    grid.api.setEdge('g', 6, 1, 6, '-z', { block: 'rail', rot: 180 });
    const diff = grid.api.diff();
    expect(diff.layers).toEqual([{ layer: 'g', cells: [], edges: [[2, 1, 3, 1, { block: 'door', open: true }], [3, 1, 2, 0, null], [6, 1, 6, 1, { block: 'rail', rot: 180 }]] }]);
    const saved = JSON.parse(JSON.stringify(diff));
    grid.reset();
    expect(grid.api.blocked('g', 2, 1, 2, '+x')).toBe(true);
    expect(grid.restoreDiff(saved)).toBeNull();
    expect(grid.api.blocked('g', 2, 1, 2, '+x')).toBe(false);
    expect(grid.api.edge('g', 2, 1, 2, '+z')?.open).toBe(true);
    expect(grid.api.edge('g', 6, 1, 6, '-z')).toMatchObject({ block: 'rail', rot: 180 });
    expect(grid.restoreDiff({ version: 1, layers: [{ layer: 'g', cells: [], edges: [[1, 1, 1, 0, { block: 'stone' }]] }] })).toContain('fills cells');
  });

  it('a live door spawns its prefab standing on its edge, named by it; it stays through open and close, and goes with the edge', () => {
    const grid = new RuntimeGrid(TYPES, [], false, 45, undefined, new Map([['door', DOOR]]));
    grid.addLayers([layer(room)]);
    const first = grid.takeLive(() => false)!;
    expect(first.add.map((e) => e.id)).toEqual(['g-2_1_3z', 'g-2_1_3z-1']);
    // A z-line edge at z = 3 over cell x = 2: its root at the edge's bottom centre (2.5, 1, 3), not turned.
    const root = first.add[0]!.components as unknown as { transform: { position: number[]; rotation: number[] }; model?: unknown };
    expect(root.transform.position).toEqual([2.5, 1, 3]);
    expect(root.model).toBeUndefined();
    expect(grid.api.edgeEntity('g', 2, 1, 2, '+z')).toBe('g-2_1_3z');
    expect(grid.api.cellOf('g-2_1_3z-1')).toEqual({ layer: 'g', x: 2, y: 1, z: 3, side: '-z' });
    expect(grid.mayBeLive('g-2_1_3z-1')).toBe(true);
    // Opening keeps the objects (and their scripts' state).
    grid.api.setEdgeOpen('g', 2, 1, 2, '+z', true);
    expect(grid.takeLive(() => true)).toEqual({ remove: [], add: [], refused: [] });
    // Turned end for end, it spawns again facing the other way; cleared, it goes.
    expect(grid.api.setEdge('g', 2, 1, 2, '+z', { block: 'door', rot: 180 })).toBe(true);
    const turned = grid.takeLive((id) => id.startsWith('g-2_1_3z'))!;
    expect(turned.remove).toEqual(['g-2_1_3z', 'g-2_1_3z-1']);
    const r = (turned.add[0]!.components as unknown as { transform: { rotation: number[] } }).transform.rotation;
    expect(r[1]).toBeCloseTo(1, 12);
    grid.api.clearEdge('g', 2, 1, 3, '-z');
    expect(grid.takeLive(() => true)).toEqual({ remove: ['g-2_1_3z', 'g-2_1_3z-1'], add: [], refused: [] });
  });
});
