/**
 * The runtime grid — `ctx.grid` reads and writes, the
 * validation of writes, footprints, the ray pick, regions, change events,
 * the diff for saves, and the chunk colliders rebuilt on the 3D port.
 */
import { describe, expect, it } from 'vitest';
import { BLOCK_COLUMN_BYTES, BlockGrid, applyBlockEdits, type BlockLayerComponent, type BlockType, type CellField, type EntityV3 } from '@thirdlight/project-model';

import { RuntimeGrid } from './grid';
import type { PhysicsPort3D, StaticColliderSpec3D } from './ports';

const COMP: BlockLayerComponent = { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [32, 8, 32] } };
const TYPES: BlockType[] = [
  { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' },
  { blockId: 'grass', name: 'Grass', variants: [{ color: '#55aa55' }], shape: 'full', metadata: { walkable: true } },
  { blockId: 'slab', name: 'Slab', variants: [{ color: '#aaaaaa' }], shape: 'half', rotations: [0] },
  { blockId: 'well', name: 'Well', variants: [{ color: '#333333' }], shape: 'full', footprint: [2, 1, 2] },
  { blockId: 'ghost', name: 'Ghost', variants: [{ color: '#ffffff' }], shape: 'none' },
];
const FIELDS: CellField[] = [
  { key: 'walkable', type: 'bool' },
  { key: 'wet', type: 'bool' },
  { key: 'cost', type: 'int', default: 1, min: 0, max: 9 },
];

function layerEntity(id: string, position: [number, number, number], build?: (g: BlockGrid) => void): EntityV3 {
  const g = new BlockGrid(COMP);
  build?.(g);
  const data = g.toData(id, null, g.takeDirty().chunks);
  return { id, components: { transform: { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, blockLayer: { ...COMP, ...(data !== null ? { data } : {}) } } } as unknown as EntityV3;
}

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

const floor = (g: BlockGrid): void => {
  applyBlockEdits(g, [{ kind: 'fill', box: [0, 0, 0, 16, 1, 16], cell: { block: 'stone' } }, { kind: 'region', regionId: 'deploy.a', op: 'set', boxes: [[0, 1, 0, 2, 2, 2]] }], { types: new Map(TYPES.map((t) => [t.blockId, t])), stamps: new Map() });
};

describe('runtime grid', () => {
  it('reports each loaded layer\'s memory (what bounds a layer), largest first, and follows writes', () => {
    const grid = new RuntimeGrid(TYPES, FIELDS, true);
    expect(grid.memory()).toBeNull();
    grid.addLayers([layerEntity('ground', [0, 0, 0], floor), layerEntity('small', [40, 0, 0], (g) => g.set(0, 0, 0, { block: 'stone' }))]);
    const m = grid.memory()!;
    expect(m.layers.map((l) => l.entityId)).toEqual(['ground', 'small']);
    const ground = m.layers[0]!;
    // A 16 × 16 floor one cell deep: one chunk of 256 columns, each one 4-byte cell and its bookkeeping.
    expect(ground).toMatchObject({ chunks: 1, columns: 256, cells: 256 });
    expect(ground.bytes).toBe(256 * (4 + BLOCK_COLUMN_BYTES));
    expect(m.bytes).toBe(ground.bytes + m.layers[1]!.bytes);
    grid.api.set('ground', 20, 0, 20, { block: 'stone' });
    expect(grid.memory()!.layers[0]).toMatchObject({ chunks: 2, columns: 257, cells: 257 });
  });

  it('reads cells with effective metadata, writes and clears them, and validates writes', () => {
    const grid = new RuntimeGrid(TYPES, FIELDS, true);
    grid.addLayers([layerEntity('ground', [10, 0, -4], floor)]);
    const api = grid.api;
    expect(api.layers()).toEqual(['ground']);
    expect(api.get('ground', 3, 0, 3)).toEqual({ block: 'stone', rot: 0, variant: 0, meta: { walkable: false, wet: false, cost: 1 } });
    expect(api.get('ground', 3, 1, 3)).toBeNull();
    expect(api.columnTop('ground', 3, 3)).toBe(0);
    grid.beginStep(1);
    expect(api.set('ground', 3, 1, 3, { block: 'grass', meta: { wet: true } })).toBe(true);
    expect(api.meta('ground', 3, 1, 3, 'walkable')).toBe(true);
    expect(api.meta('ground', 3, 1, 3, 'wet')).toBe(true);
    expect(api.columnTop('ground', 3, 3)).toBe(1);
    // refused: unknown block, disallowed rotation, bad metadata, outside the bounds
    expect(api.set('ground', 4, 1, 4, { block: 'nope' })).toBe(false);
    expect(api.set('ground', 4, 1, 4, { block: 'slab', rot: 90 })).toBe(false);
    expect(api.set('ground', 4, 1, 4, { meta: { cost: 42 } })).toBe(false);
    expect(api.set('ground', 99, 0, 0, { block: 'stone' })).toBe(false);
    expect(api.setMeta('ground', 5, 1, 5, 'cost', 4)).toBe(true);
    expect(api.get('ground', 5, 1, 5)?.block).toBeNull();
    expect(api.clear('ground', 3, 0, 3)).toBe(true);
    expect(api.get('ground', 3, 0, 3)).toBeNull();
    expect(api.clear('ground', 3, 0, 3)).toBe(false);
    // the change events are seen one step later
    expect(api.changes()).toEqual([]);
    grid.beginStep(2);
    expect(api.changes().map((c) => [c.x, c.y, c.z, c.before, c.after])).toEqual([
      [3, 1, 3, null, 'grass'],
      [5, 1, 5, null, null],
      [3, 0, 3, 'stone', null],
    ]);
  });

  it('world ↔ cell, neighbours, regions', () => {
    const grid = new RuntimeGrid(TYPES, FIELDS, true);
    grid.addLayers([layerEntity('ground', [10, 0, -4], floor)]);
    const api = grid.api;
    expect(api.worldToCell('ground', [13.5, 0.75, -3.2])).toEqual({ x: 3, y: 1, z: 0 });
    expect(api.cellToWorld('ground', 3, 1, 0)).toEqual({ x: 13.5, y: 0.75, z: -3.5 });
    expect(api.neighbours('ground', 0, 0, 0).length).toBe(3);
    expect(api.neighbours('ground', 5, 3, 5, true).length).toBe(26);
    expect(api.regions('ground')).toEqual(['deploy.a']);
    expect(api.region('ground', 'deploy.a')?.length).toBe(4);
    expect(api.inRegion('ground', 'deploy.a', 1, 1, 1)).toBe(true);
    expect(api.inRegion('ground', 'deploy.a', 2, 1, 1)).toBe(false);
    expect(api.region('ground', 'nope')).toBeNull();
  });

  it('picks the first block a ray enters, with its face; a cleared cell lets the ray through', () => {
    const grid = new RuntimeGrid(TYPES, FIELDS, true);
    grid.addLayers([layerEntity('ground', [10, 0, -4], floor)]);
    const api = grid.api;
    const hit = api.pick([13.5, 5, -1.5], [0, -1, 0])!;
    expect([hit.layer, hit.x, hit.y, hit.z]).toEqual(['ground', 3, 0, 2]);
    expect(hit.normal).toEqual({ x: 0, y: 1, z: 0 });
    expect(hit.distance).toBeCloseTo(4.5, 9);
    grid.beginStep(1);
    api.clear('ground', 3, 0, 2);
    expect(api.pick([13.5, 5, -1.5], [0, -1, 0])).toBeNull();
  });

  it('footprints: the covered cells report the anchor and refuse other blocks', () => {
    const grid = new RuntimeGrid(TYPES, FIELDS, true);
    grid.addLayers([layerEntity('ground', [0, 0, 0])]);
    const api = grid.api;
    grid.beginStep(1);
    expect(api.set('ground', 4, 0, 4, { block: 'well' })).toBe(true);
    expect(api.get('ground', 5, 0, 5)?.anchor).toEqual({ x: 4, y: 0, z: 4 });
    expect(api.set('ground', 5, 0, 5, { block: 'stone' })).toBe(false);
    expect(api.set('ground', 3, 0, 4, { block: 'well' })).toBe(false);
    expect(api.clear('ground', 4, 0, 4)).toBe(true);
    expect(api.set('ground', 5, 0, 5, { block: 'stone' })).toBe(true);
  });

  it('rebuilds the colliders of written chunks on the port (batched), none for shape none', () => {
    const port = fakePort();
    const grid = new RuntimeGrid(TYPES, FIELDS, true);
    grid.addLayers([layerEntity('ground', [0, 0, 0], floor)]);
    grid.flushCollision(port);
    expect(port.added.map((s) => s.entityId)).toEqual(['ground#blocks:0,0:0']);
    expect((port.added[0]!.shape as { type: string }).type).toBe('mesh');
    port.added.length = 0;
    grid.beginStep(1);
    grid.api.clear('ground', 3, 0, 3);
    grid.api.set('ground', 20, 0, 20, { block: 'ghost' });
    grid.flushCollision(port);
    expect(port.removed).toEqual(['ground#blocks:0,0:0']);
    expect(port.added.map((s) => s.entityId)).toEqual(['ground#blocks:0,0:0']);
    // nothing to rebuild: no port calls
    port.added.length = 0;
    port.removed.length = 0;
    grid.flushCollision(port);
    expect([port.added.length, port.removed.length]).toEqual([0, 0]);
    // a 2D plane draws layers only
    const flat = new RuntimeGrid(TYPES, FIELDS, false);
    flat.addLayers([layerEntity('ground', [0, 0, 0], floor)]);
    const p2 = fakePort();
    flat.flushCollision(p2);
    expect(p2.added).toEqual([]);
  });

  it('render changes name the written chunks and their neighbours; the diff round-trips; reset restores', () => {
    const grid = new RuntimeGrid(TYPES, FIELDS, true);
    grid.addLayers([layerEntity('ground', [0, 0, 0], floor)]);
    expect(grid.takeRenderChanges().map((c) => `${c.cx},${c.cz}`)).toEqual(['0,0']);
    grid.beginStep(1);
    grid.api.clear('ground', 15, 0, 3);
    const ch = grid.takeRenderChanges();
    expect(ch.map((c) => `${c.cx},${c.cz}`).sort()).toEqual(['0,0', '1,0']);
    expect(ch.find((c) => c.cx === 1)!.chunk).toBeNull();
    grid.api.set('ground', 1, 1, 1, { block: 'grass' });
    const diff = grid.api.diff();
    expect(diff.layers[0]!.cells).toEqual([[1, 1, 1, { block: 'grass' }], [15, 0, 3, null]].sort((a, b) => (a[0] as number) - (b[0] as number)));
    grid.reset();
    expect(grid.api.get('ground', 15, 0, 3)?.block).toBe('stone');
    expect(grid.api.diff().layers).toEqual([]);
    grid.beginStep(1);
    expect(grid.api.applyDiff(diff)).toBe(true);
    expect(grid.api.get('ground', 15, 0, 3)).toBeNull();
    expect(grid.api.get('ground', 1, 1, 1)?.block).toBe('grass');
    // unloading a layer returns its collider ids
    grid.flushCollision(fakePort());
    expect(grid.removeLayers(new Set(['ground'])).length).toBeGreaterThan(0);
    expect(grid.api.layers()).toEqual([]);
  });
});

describe('sloped terrain in ctx.grid', () => {
  const ramped = (g: BlockGrid): void => {
    floor(g);
    // A 1-cell rise over 2 cells along +x (cells are 0.5 m tall: 0.25 m per metre, 14.04°).
    applyBlockEdits(g, [{ kind: 'cells', at: [4, 1, 4], cell: { block: 'grass', corners: [0, 0.5, 0.5, 0] } }, { kind: 'cells', at: [5, 1, 4], cell: { block: 'grass', corners: [0.5, 1, 1, 0.5] } }], { types: new Map(TYPES.map((t) => [t.blockId, t])), stamps: new Map() });
  };

  it('get shows the corners; set writes them on a full block and refuses them on others', () => {
    const grid = new RuntimeGrid(TYPES, FIELDS, false);
    grid.addLayers([layerEntity('ground', [0, 0, 0], ramped)]);
    expect(grid.api.get('ground', 4, 1, 4)!.corners).toEqual([0, 0.5, 0.5, 0]);
    expect(grid.api.get('ground', 4, 0, 4)!.corners).toBeUndefined();
    expect(grid.api.set('ground', 6, 1, 4, { block: 'stone', corners: [1, 1, 0.5, 0.5] })).toBe(true);
    expect(grid.api.get('ground', 6, 1, 4)!.corners).toEqual([1, 1, 0.5, 0.5]);
    expect(grid.api.set('ground', 7, 1, 4, { block: 'slab', corners: [1, 1, 0.5, 0.5] })).toBe(false);
    expect(grid.api.set('ground', 7, 1, 4, { block: 'stone', corners: [1, 1, 0.3, 0.5] })).toBe(false);
    // The diff keeps the corners (saves restore sloped cells).
    expect(JSON.stringify(grid.api.diff())).toContain('"corners":[1,1,0.5,0.5]');
  });

  it('surface and columnSurface: height, normal, slope and walkable against maxSlope', () => {
    const grid = new RuntimeGrid(TYPES, FIELDS, false, 10);
    grid.addLayers([layerEntity('ground', [10, 2, 10], ramped)]);
    // Halfway up the first sloped cell: 0.5 (floor) + 0.25 × 0.5 of a 0.5 m cell, plus the origin's 2 m.
    const s = grid.api.surface('ground', [10 + 4.5, 20, 10 + 4.5])!;
    expect(s.height).toBeCloseTo(2 + 0.5 + 0.125, 12);
    expect([s.x, s.y, s.z]).toEqual([4, 1, 4]);
    expect(s.slope).toBeCloseTo((Math.atan(0.25) * 180) / Math.PI, 9);
    expect(s.normal.x).toBeLessThan(0);
    // The project default here is 10°: a 14° slope is not walkable; a flat floor is.
    expect(s.walkable).toBe(false);
    expect(grid.api.columnSurface('ground', 1, 1)).toEqual(expect.objectContaining({ height: 2.5, slope: 0, walkable: true, y: 0 }));
    expect(grid.api.columnSurface('ground', 20, 20)).toBeNull();
    // A position below the floor finds nothing; one inside the floor reads its top.
    expect(grid.api.surface('ground', [11, 0, 11])).toBeNull();
    expect(grid.api.surface('ground', [11, 2.1, 11])!.height).toBeCloseTo(2.5, 12);
  });

  it('a layer maxSlope decides walkable and reaches the port as the colliders\' limit', () => {
    const grid = new RuntimeGrid(TYPES, FIELDS, true, 10);
    const e = layerEntity('ground', [0, 0, 0], ramped);
    (e.components as unknown as { blockLayer: BlockLayerComponent }).blockLayer.maxSlope = 20;
    grid.addLayers([e]);
    expect(grid.api.surface('ground', [4.5, 9, 4.5])!.walkable).toBe(true);
    const port = fakePort();
    grid.flushCollision(port);
    expect(port.added.length).toBeGreaterThan(0);
    expect(port.added.every((c) => Math.abs(c.maxSlope! - (20 * Math.PI) / 180) < 1e-12)).toBe(true);
    // Without the field the colliders carry no limit (the character's own applies, as before).
    const plain = new RuntimeGrid(TYPES, FIELDS, true);
    plain.addLayers([layerEntity('ground', [0, 0, 0], ramped)]);
    const p2 = fakePort();
    plain.flushCollision(p2);
    expect(p2.added.every((c) => c.maxSlope === undefined)).toBe(true);
  });

  it('block type material swaps: checked, part of the diff a save keeps, restored, cleared by a new run', () => {
    const grid = new RuntimeGrid(TYPES, FIELDS, true, 45, ['mat-ash', 'mat-moss']);
    const api = grid.api;
    expect(api.typeMaterials('stone')).toBeNull();
    expect(api.setTypeMaterials('stone', { '*': 'mat-ash' })).toBe(true);
    expect(api.typeMaterials('stone')).toEqual({ '*': 'mat-ash' });
    expect(grid.typeMaterialSwaps().get('stone')).toEqual({ '*': 'mat-ash' });
    // Unknown types and materials, empty patches.
    expect(api.setTypeMaterials('nope', { '*': 'mat-ash' })).toBe(false);
    expect(api.setTypeMaterials('grass', { '*': 'mat-missing' })).toBe(false);
    expect(api.setTypeMaterials('grass', {})).toBe(false);
    const diff = api.diff();
    expect(diff.types).toEqual({ stone: { '*': 'mat-ash' } });
    // null: the type's own again.
    expect(api.setTypeMaterials('stone', { '*': null })).toBe(true);
    expect(grid.typeMaterialSwaps().size).toBe(0);
    expect(grid.restoreDiff(diff)).toBeNull();
    expect(grid.typeMaterialSwaps().get('stone')).toEqual({ '*': 'mat-ash' });
    expect(grid.restoreDiff({ version: 1, layers: [], types: { stone: { '*': 'mat-missing' } } })).toContain('not a material this game ships');
    // A diff without types (an older save) clears them.
    expect(grid.restoreDiff({ version: 1, layers: [] })).toBeNull();
    expect(grid.typeMaterialSwaps().size).toBe(0);
    api.setTypeMaterials('grass', { '*': 'mat-moss' });
    grid.reset();
    expect(grid.typeMaterialSwaps().size).toBe(0);
    // Without the game's material list, nothing can be swapped.
    expect(new RuntimeGrid(TYPES, FIELDS, true).api.setTypeMaterials('stone', { '*': 'mat-ash' })).toBe(false);
  });
});


describe('ctx.grid cut-aways', () => {
  const withCutaway = (id: string): EntityV3 => {
    const e = layerEntity(id, [0, 0, 0]) as unknown as { components: { blockLayer: BlockLayerComponent } };
    e.components.blockLayer = { ...e.components.blockLayer, cutaway: { regions: [{ region: 'roof' }], planes: [6] } };
    return e as unknown as EntityV3;
  };

  it('scripts force a zone, name a subject, and the state is a new object only after a change', () => {
    const grid = new RuntimeGrid(TYPES, FIELDS, true);
    grid.addLayers([withCutaway('house')]);
    const before = grid.cutawayState();
    expect(before).toEqual({ subject: null, forced: [] });
    expect(grid.api.setCutaway('house', 'roof', true)).toBe(true);
    expect(grid.api.setCutaway('house', '#6', false)).toBe(true);
    const forced = grid.cutawayState();
    expect(forced).not.toBe(before);
    expect(forced.forced).toEqual([['house', 'roof', true], ['house', '#6', false]]);
    // The same write again changes nothing (the renderer is not told again).
    expect(grid.api.setCutaway('house', 'roof', true)).toBe(true);
    expect(grid.cutawayState()).toBe(forced);
    expect(grid.api.setCutaway('house', 'roof', null)).toBe(true);
    expect(grid.cutawayState().forced).toEqual([['house', '#6', false]]);
    expect(grid.api.setCutawaySubject('player')).toBe(true);
    expect(grid.cutawayState().subject).toBe('player');
    expect(grid.api.setCutawayPoint([1, 2, 3])).toBe(true);
    expect(grid.cutawayState().subject).toEqual([1, 2, 3]);
    expect(grid.api.setCutawaySubject(null)).toBe(true);
    expect(grid.cutawayState().subject).toBeNull();
  });

  it('refuses unknown layers and zones, and a new run forgets what scripts set', () => {
    const grid = new RuntimeGrid(TYPES, FIELDS, true);
    grid.addLayers([withCutaway('house'), layerEntity('plain', [0, 0, 0])]);
    expect(grid.api.setCutaway('nowhere', 'roof', true)).toBe(false);
    expect(grid.api.setCutaway('house', 'cellar', true)).toBe(false);
    expect(grid.api.setCutaway('house', '#5', true)).toBe(false);
    expect(grid.api.setCutaway('plain', 'roof', true)).toBe(false);
    expect(grid.api.setCutawayPoint([1, Number.NaN, 3])).toBe(false);
    grid.api.setCutaway('house', 'roof', true);
    grid.api.setCutawaySubject('player');
    grid.reset();
    expect(grid.cutawayState()).toEqual({ subject: null, forced: [] });
    // An unloaded layer's forced zones go with it.
    grid.api.setCutaway('house', 'roof', true);
    grid.removeLayers(new Set(['house']));
    expect(grid.cutawayState().forced).toEqual([]);
  });
});
