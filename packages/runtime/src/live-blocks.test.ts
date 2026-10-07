/**
 * The live blocks' bookkeeping on the runtime grid: which objects go and come
 * for a written cell (only the cells written, only when their prefab or
 * rotation changed), ids taken by other objects, layers leaving, a new run.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, applyBlockEdits, type BlockLayerComponent, type BlockType, type EntityV3, type PrefabDefinition } from '@thirdlight/project-model';

import { RuntimeGrid } from './grid';

const COMP: BlockLayerComponent = { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [32, 8, 32] } };
const TYPES: BlockType[] = [
  { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' },
  { blockId: 'lamp', name: 'Lamp', variants: [{ prefab: 'lamp' }, { prefab: 'torch' }, { color: '#ffff00' }], shape: 'none', live: true },
];
const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const prefab = (prefabId: string, n: number): PrefabDefinition =>
  ({ prefabId, displayName: prefabId, createdRevision: 1, entityCount: n, depth: 2, entities: Array.from({ length: n }, (_, i) => ({ localId: `box-000${i + 1}`, ...(i > 0 ? { parentLocalId: 'box-0001' } : {}), components: { transform: T, ...(i === 0 ? { model: { asset: { assetId: 'm' } }, materials: { '*': 'mat' } } : { light: { type: 'point' } }) } })) }) as never;
const PREFABS = new Map([['lamp', prefab('lamp', 2)], ['torch', prefab('torch', 1)]]);

function layer(id: string, build: (g: BlockGrid) => void): EntityV3 {
  const g = new BlockGrid(COMP);
  build(g);
  const data = g.toData(id, null, g.takeDirty().chunks);
  return { id, components: { transform: T, blockLayer: { ...COMP, ...(data !== null ? { data } : {}) } } } as unknown as EntityV3;
}
const edits = (g: BlockGrid, list: unknown[]): void => void applyBlockEdits(g, list as never, { types: new Map(TYPES.map((t) => [t.blockId, t])), stamps: new Map() });
const ids = (add: readonly EntityV3[]): string[] => add.map((e) => e.id);

describe('live blocks on the runtime grid', () => {
  it('spawns the loaded cells once, then only what a write changes; the root leaves its model to the chunk', () => {
    const grid = new RuntimeGrid(TYPES, [], false, 45, undefined, PREFABS);
    grid.addLayers([layer('g', (g) => edits(g, [{ kind: 'fill', box: [0, 0, 0, 4, 1, 4], cell: { block: 'stone' } }, { kind: 'fill', box: [1, 1, 1, 2, 2, 2], cell: { block: 'lamp', variant: 0 } }]))]);
    const first = grid.takeLive(() => false)!;
    expect(ids(first.add)).toEqual(['g-1_1_1', 'g-1_1_1-1']);
    const root = first.add[0]!.components as unknown as Record<string, unknown>;
    expect(root['model']).toBeUndefined();
    expect(root['materials']).toBeUndefined();
    expect((first.add[1]!.components as unknown as Record<string, unknown>)['light']).toBeDefined();
    expect(first.add[1]!.parentId).toBe('g-1_1_1');
    expect(grid.takeLive(() => true)).toBeNull();
    // Metadata and a stone write: nothing to do; a new variant swaps the objects; a colour look has none.
    grid.api.set('g', 0, 0, 0, { block: 'stone', rot: 90 });
    expect(grid.takeLive(() => true)).toBeNull();
    grid.api.set('g', 1, 1, 1, { block: 'lamp', variant: 1 });
    const swapped = grid.takeLive((id) => id.startsWith('g-1_1_1'))!;
    expect([swapped.remove, ids(swapped.add), swapped.refused]).toEqual([['g-1_1_1', 'g-1_1_1-1'], ['g-1_1_1'], []]);
    expect(grid.api.entity('g', 1, 1, 1)).toBe('g-1_1_1');
    expect(grid.api.cellOf('g-1_1_1')).toEqual({ layer: 'g', x: 1, y: 1, z: 1 });
    expect(grid.isLive('g-1_1_1') && !grid.isLive('g-1_1_1-1')).toBe(true);
    grid.api.set('g', 1, 1, 1, { block: 'lamp', variant: 2 });
    expect(grid.api.entity('g', 1, 1, 1)).toBeNull();
    expect(grid.takeLive(() => true)).toEqual({ remove: ['g-1_1_1'], add: [], refused: [] });
    expect(grid.liveCount).toBe(0);
  });

  it('a cell whose ids another object holds spawns nothing; a layer leaving and a new run return its objects', () => {
    const grid = new RuntimeGrid(TYPES, [], false, 45, undefined, PREFABS);
    grid.addLayers([layer('g', (g) => edits(g, [{ kind: 'fill', box: [0, 0, 0, 2, 1, 1], cell: { block: 'lamp', variant: 1 } }]))]);
    const d = grid.takeLive((id) => id === 'g-0_0_0')!;
    expect([ids(d.add), d.refused]).toEqual([['g-1_0_0'], ['g-0_0_0']]);
    expect(grid.mayBeLive('g-0_0_0') && grid.mayBeLive('g-7_1_2-3') && !grid.mayBeLive('g-x') && !grid.mayBeLive('other-1_1_1')).toBe(true);
    expect(grid.reset()).toEqual(['g-1_0_0']);
    expect(ids(grid.takeLive(() => false)!.add)).toEqual(['g-0_0_0', 'g-1_0_0']);
    grid.removeLayers(new Set(['g']));
    expect(grid.takeGoneLive()).toEqual(['g-0_0_0', 'g-1_0_0']);
    expect(grid.takeLive(() => false)).toBeNull();
  });

  it('a connected live block re-resolves its neighbours in the same step: a run grown by one turns its old end into a straight piece', () => {
    const pipe: BlockType = { blockId: 'pipe', name: 'Pipe', variants: [{ prefab: 'lamp' }, { prefab: 'torch' }], shape: 'none', live: true, connect: { pieces: { end: { variant: 1 }, straight: { variant: 0 } } } };
    const grid = new RuntimeGrid([...TYPES, pipe], [], false, 45, undefined, PREFABS);
    grid.addLayers([layer('g', (g) => void applyBlockEdits(g, [{ kind: 'fill', box: [1, 0, 1, 3, 1, 2], cell: { block: 'pipe' } }], { types: new Map([[pipe.blockId, pipe]]), stamps: new Map() }))]);
    // Two ends facing each other: torches turned toward +x and −x.
    const first = grid.takeLive(() => false)!;
    expect(ids(first.add)).toEqual(['g-1_0_1', 'g-2_0_1']);
    expect(grid.api.get('g', 2, 0, 1)).toMatchObject({ variant: 1, rot: 270, piece: 'end' });
    grid.api.set('g', 3, 0, 1, { block: 'pipe' });
    // Read in the same step: the old end is a straight piece now.
    expect(grid.api.get('g', 2, 0, 1)).toMatchObject({ variant: 0, rot: 90, piece: 'straight' });
    const next = grid.takeLive((id) => id === 'g-1_0_1' || id === 'g-2_0_1')!;
    expect(next.remove).toEqual(['g-2_0_1']);
    expect(ids(next.add)).toEqual(['g-2_0_1', 'g-2_0_1-1', 'g-3_0_1']);
    // The far end did not change: its torch stays.
    expect(next.remove).not.toContain('g-1_0_1');
  });

  it('a kit swap respawns the live blocks whose prefab it changes, keeps those it does not, and takes them away where it swaps in a plain block', () => {
    const lamp: BlockType = { ...TYPES[1]!, kits: { dim: { block: 'lamp', variants: [1, 1, 2] }, same: { block: 'lamp' }, off: { block: 'stone' } } };
    const grid = new RuntimeGrid([TYPES[0]!, lamp], [], false, 45, undefined, PREFABS);
    grid.addLayers([layer('g', (g) => edits(g, [{ kind: 'fill', box: [0, 0, 0, 2, 1, 1], cell: { block: 'lamp', variant: 0 } }, { kind: 'region', regionId: 'left', op: 'set', boxes: [[0, 0, 0, 1, 1, 1]] }]))]);
    expect(ids(grid.takeLive(() => false)!.add)).toEqual(['g-0_0_0', 'g-0_0_0-1', 'g-1_0_0', 'g-1_0_0-1']);
    const taken = (id: string): boolean => grid.isLive(id);
    // The same prefab: nothing goes or comes.
    expect(grid.api.setKit('g', 'same')).toBe(true);
    expect(grid.takeLive(taken)).toEqual({ remove: [], add: [], refused: [] });
    // Torches in the left region only: its lamp is replaced, the other kept; reads show the swap, the cell stays a lamp.
    expect(grid.api.setKit('g', 'dim', 'left')).toBe(true);
    const dim = grid.takeLive(taken)!;
    expect([dim.remove, ids(dim.add)]).toEqual([['g-0_0_0', 'g-0_0_0-1'], ['g-0_0_0']]);
    expect(grid.api.get('g', 0, 0, 0)).toMatchObject({ block: 'lamp', variant: 1 });
    expect(grid.api.get('g', 0, 0, 0)?.kitBlock).toBeUndefined();
    expect(grid.api.kit('g', 'left')).toBe('dim');
    // Off over the whole layer: the right lamp's objects go (the left region keeps its own kit).
    grid.api.setKit('g', 'off');
    const off = grid.takeLive(taken)!;
    expect([off.remove, ids(off.add)]).toEqual([['g-1_0_0', 'g-1_0_0-1'], []]);
    expect(grid.api.get('g', 1, 0, 0)).toMatchObject({ block: 'lamp', kitBlock: 'stone' });
    expect(grid.api.entity('g', 1, 0, 0)).toBeNull();
    // A write under the kit spawns as the kit shows it.
    grid.api.set('g', 0, 0, 0, { block: 'lamp', variant: 0 });
    expect(grid.takeLive(taken)).toBeNull();
    // Taken off: back to the authored lamps.
    grid.api.setKit('g', null, 'left');
    grid.api.setKit('g', null);
    const back = grid.takeLive(taken)!;
    expect([back.remove, ids(back.add)]).toEqual([['g-0_0_0'], ['g-0_0_0', 'g-0_0_0-1', 'g-1_0_0', 'g-1_0_0-1']]);
  });

  it('a game without live block types keeps no bookkeeping', () => {
    const grid = new RuntimeGrid([TYPES[0]!], [], false, 45, undefined, PREFABS);
    grid.addLayers([layer('g', (g) => edits(g, [{ kind: 'fill', box: [0, 0, 0, 2, 1, 1], cell: { block: 'stone' } }]))]);
    expect(grid.takeLive(() => false)).toBeNull();
    expect(grid.api.entity('g', 0, 0, 0)).toBeNull();
  });
});
