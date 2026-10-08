/**
 * `ctx.surface` in the simulation: the ground of a block layer standing on
 * a terrain, read across their seam from the tiles the page handed over
 * (heights, holes and layer weights, those maybe later; nothing where a
 * tile has not arrived or was let go), scenery terrain without collision included, the block
 * layer's painted cells and a larger block's covered cells, and the answers
 * following scripts' cell writes and the layers' unloading.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, TERRAIN_WEIGHT_BYTES, applyBlockEdits, flatTerrainTile, type BlockLayerComponent, type BlockType, type EntityV3, type TerrainComponent } from '@thirdlight/project-model';

import { RuntimeGrid } from './grid';

const TYPES: BlockType[] = [
  { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' },
  { blockId: 'well', name: 'Well', variants: [{ color: '#333333' }], shape: 'full', footprint: [2, 1, 2] },
];
const COMP: BlockLayerComponent = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [16, 4, 16] } };
const types = new Map(TYPES.map((t) => [t.blockId, t]));

/** A 4 × 4 m plaza one cell thick at (4, 1, 4), its −x columns painted layer 2, a well (2 × 2 footprint) on its +x+z corner. */
function plaza(): EntityV3 {
  const g = new BlockGrid(COMP);
  const r = applyBlockEdits(g, [{ kind: 'fill', box: [0, 0, 0, 4, 1, 4], cell: { block: 'stone' } }, { kind: 'cells', at: [2, 1, 2], cell: { block: 'well' } }, { kind: 'paint', at: [0, 2], radius: 1.5, strength: 1, channel: 2, falloff: 'constant' }], { types, stamps: new Map() });
  if (!r.ok) throw new Error(r.message);
  const data = g.toData('plaza', null, g.takeDirty().chunks);
  return { id: 'plaza', components: { transform: { position: [4, 1, 4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, blockLayer: { ...COMP, ...(data !== null ? { data } : {}) } } } as unknown as EntityV3;
}

/** A 16 m terrain tile (17 samples, 1 m apart) flat at 1 m, layer 1 east of x = 8, with or without collision. */
const TERRAIN: TerrainComponent = { tileSamples: 17, spacing: 1, heightRange: [0, 2], tiles: [{ x: 0, z: 0, data: 'tile-a' }] };
const ground = (collision: boolean): EntityV3 => ({ id: 'ground', components: { transform: { position: [0, 0, 0] }, terrain: { ...TERRAIN, ...(collision ? {} : { collision: false }) } } }) as unknown as EntityV3;
function tileData(): { digest: string; samples: number; heights: Uint16Array; holes: null; weights: Uint8Array; paint: null } {
  const t = flatTerrainTile(17, 0);
  t.heights.fill(32767);
  const weights = new Uint8Array(17 * 17 * TERRAIN_WEIGHT_BYTES);
  // Per sample: four layer indices, then their weights (one layer, all of it).
  for (let z = 0; z < 17; z++) {
    for (let x = 0; x < 17; x++) {
      weights[(z * 17 + x) * TERRAIN_WEIGHT_BYTES] = x >= 8 ? 1 : 0;
      weights[(z * 17 + x) * TERRAIN_WEIGHT_BYTES + 4] = 255;
    }
  }
  return { digest: 'tile-a', samples: 17, heights: t.heights, holes: null, weights, paint: null };
}

describe('ctx.surface', () => {
  it('reads the plaza on its tops and the terrain round it, across the seam', () => {
    for (const collision of [true, false]) {
      const grid = new RuntimeGrid(TYPES, [], collision);
      grid.addLayers([ground(collision), plaza()]);
      const s = grid.surface.api;
      // No tile yet: only the plaza has ground.
      expect(s.at([2, 5, 6])).toBeNull();
      expect(s.at([5, 5, 5])).toMatchObject({ source: 'blocks', object: 'plaza', height: 2 });
      grid.addTerrainData([tileData()]);
      // Walking east along z = 5.5 across the plaza's −x border (x = 4) and its +x one (x = 8).
      const line = [2, 3.9, 4.1, 5, 7.9, 8.1, 12].map((x) => s.at([x, 3, 5.5]));
      expect(line.map((p) => p?.source)).toEqual(['terrain', 'terrain', 'blocks', 'blocks', 'blocks', 'terrain', 'terrain']);
      expect(line[0]!.height).toBeCloseTo(1, 3);
      expect(line[2]!.height).toBe(2);
      expect(line[2]).toMatchObject({ layers: [2], cell: [0, 0, 1], block: 'stone' });
      expect(line[4]).toMatchObject({ layers: [0], weights: [1] });
      expect(line[6]).toMatchObject({ layers: [1], weights: [1], wetness: 0 });
      expect(Object.isFrozen(line[2])).toBe(true);
      // The well's covered cell answers with the well (its anchor), a cell above the plaza.
      expect(s.top(7.5, 7.5)).toMatchObject({ source: 'blocks', height: 3, cell: [2, 1, 2], block: 'well' });
      // Not a point: null.
      expect(s.at([Number.NaN, 0, 0] as unknown as [number, number, number])).toBeNull();
      expect(s.top(1, Number.POSITIVE_INFINITY)).toBeNull();
    }
  });

  it('follows script writes, the tile let go, and unloading', () => {
    const grid = new RuntimeGrid(TYPES, [], true);
    grid.addLayers([ground(true), plaza()]);
    grid.addTerrainData([tileData()]);
    const s = grid.surface.api;
    expect(grid.api.clear('plaza', 1, 0, 1)).toBe(true);
    expect(s.at([5.5, 3, 5.5])).toMatchObject({ source: 'terrain' });
    expect(grid.terrain.memory()!.layerBytes).toBe(17 * 17 * TERRAIN_WEIGHT_BYTES);
    // Heights first, the layer weights handed over later (a worker's page spreads them over frames): layer 0 until then.
    const { weights, ...heights } = tileData();
    grid.addTerrainData([{ ...heights, digest: 'tile-a' }]);
    expect(s.at([12, 3, 5.5])).toMatchObject({ layers: [0] });
    grid.addTerrainData([{ digest: 'tile-a', layer: 'weights', bytes: weights.slice(0, 10) }, { digest: 'other', layer: 'weights', bytes: weights }]);
    expect(s.at([12, 3, 5.5])).toMatchObject({ layers: [0] });
    grid.addTerrainData([{ digest: 'tile-a', layer: 'weights', bytes: weights }]);
    expect(s.at([12, 3, 5.5])).toMatchObject({ layers: [1] });
    grid.addTerrainData([{ digest: 'tile-a', dropped: true }]);
    expect(s.at([2, 3, 5.5])).toBeNull();
    grid.removeLayers(new Set(['plaza', 'ground']));
    expect(s.at([5, 5, 5])).toBeNull();
  });
});
