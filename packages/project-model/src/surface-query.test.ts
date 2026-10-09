/**
 * One surface query over block layers and terrain: which one answers at a
 * point (a block area on terrain, a bridge over it, a hole cut under the
 * blocks), the heights, normals and slopes each reports, and the material
 * layer weights (block paint over the layer's rules, terrain's baked layers).
 * Neutral fixtures only.
 */
import { describe, expect, it } from 'vitest';

import type { BlockLayerComponent, BlockType } from './block-layers';
import { applyBlockEdits, BlockGrid, type BlockEdit } from './block-grid';
import { SurfaceRuleSet } from './surface-rules';
import { surfaceAt, type SurfaceSource } from './surface-query';
import { TerrainField } from './terrain-field';
import { flatTerrainTile, setTerrainHole, writeSampleLayers, TERRAIN_WEIGHT_BYTES, type TerrainTile } from './terrain-tile';
import { terrainFlatStep, type TerrainComponent } from './terrain';

const TYPES: BlockType[] = [{ blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' }];
const types = new Map(TYPES.map((t) => [t.blockId, t]));
const edit = (g: BlockGrid, ...edits: BlockEdit[]): void => {
  const r = applyBlockEdits(g, edits, { types, stamps: new Map() });
  if (!r.ok) throw new Error(`${r.path}: ${r.message}`);
};

/** A 16 × 16 m terrain (one tile of 17 samples, 1 m apart) at the origin, flat at 1 m, layer 1 on its +x half. */
function terrain(hole?: [number, number]): SurfaceSource {
  const comp: TerrainComponent = { tileSamples: 17, spacing: 1, heightRange: [0, 2], tiles: [{ x: 0, z: 0, data: 'd' }] };
  const t: TerrainTile = flatTerrainTile(17, terrainFlatStep(comp.heightRange));
  t.heights.fill(Math.round(65535 / 2));
  t.weights = new Uint8Array(17 * 17 * TERRAIN_WEIGHT_BYTES);
  for (let z = 0; z < 17; z++) for (let x = 0; x < 17; x++) writeSampleLayers(t.weights, (z * 17 + x) * TERRAIN_WEIGHT_BYTES, x >= 8 ? [1, 0] : [0], x >= 8 ? [200, 55] : [255]);
  if (hole !== undefined) setTerrainHole(t, hole[0], hole[1], true);
  return { kind: 'terrain', id: 'ground', field: new TerrainField(comp, [0, 0, 0], new Map([['0,0', t]])) };
}

/** A block layer of 1 m cells at `origin`: a 4 × 4 floor of stone one cell thick, its tops painted layer 2 at its −x half. */
function blocks(origin: [number, number, number], rules?: SurfaceRuleSet): SurfaceSource {
  const comp: BlockLayerComponent = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [16, 8, 16] } };
  const g = new BlockGrid(comp);
  edit(g, { kind: 'fill', box: [0, 0, 0, 4, 1, 4], cell: { block: 'stone' } }, { kind: 'paint', at: [0, 2], radius: 1.5, strength: 1, channel: 2, falloff: 'constant' });
  return { kind: 'blocks', id: 'plaza', grid: g, types, origin, topSubdivision: 1, wallPaint: false, ...(rules !== undefined ? { rules } : {}) };
}

describe('surfaceAt', () => {
  it('answers from the block area on its tops and from the terrain round it', () => {
    const sources = [terrain(), blocks([4, 0.5, 4])];
    // On the blocks: their top (1.5 m) over the terrain's 1 m.
    const on = surfaceAt(sources, 6, 5, 6)!;
    expect(on).toMatchObject({ source: 'blocks', object: 'plaza', height: 1.5, cell: [2, 0, 2], block: 'stone', slope: 0 });
    expect(on.normal).toEqual([0, 1, 0]);
    // Beside them: the terrain, flat, its layers there.
    const off = surfaceAt(sources, 2.2, 5, 6)!;
    expect(off).toMatchObject({ source: 'terrain', object: 'ground', layers: [0], weights: [1], wetness: 0 });
    expect(off.height).toBeCloseTo(1, 4);
    expect(surfaceAt(sources, 12, 5, 6)!.layers).toEqual([1, 0]);
    expect(surfaceAt(sources, 12, 5, 6)!.weights[0]).toBeCloseTo(200 / 255, 6);
    // Off everything: none.
    expect(surfaceAt(sources, -5, 5, 6)).toBeNull();
  });

  it('weights on blocks are the paint the mesh shows (hand paint over the rules), strongest first', () => {
    const painted = surfaceAt([blocks([0, 0, 0])], 0.2, 5, 2)!;
    expect(painted.layers[0]).toBe(2);
    expect(painted.weights[0]).toBeCloseTo(1, 6);
    const plain = surfaceAt([blocks([0, 0, 0])], 3.5, 5, 2)!;
    expect(plain).toMatchObject({ layers: [0], weights: [1] });
    // A rule giving flat tops layer 3: the unpainted share goes to it, the painted corner keeps its paint.
    const rules = new SurfaceRuleSet([{ layer: 3, slope: { max: 10 } }]);
    expect(surfaceAt([blocks([0, 0, 0], rules)], 3.5, 5, 2)!).toMatchObject({ layers: [3], weights: [1] });
    expect(surfaceAt([blocks([0, 0, 0], rules)], 0.2, 5, 2)!.layers[0]).toBe(2);
  });

  it('a bridge answers only from above it; [x, z] asks for the top', () => {
    const sources = [terrain(), blocks([4, 5, 4])];
    expect(surfaceAt(sources, 6, 9, 6)).toMatchObject({ source: 'blocks', height: 6 });
    expect(surfaceAt(sources, 6, 3, 6)).toMatchObject({ source: 'terrain' });
    expect(surfaceAt(sources, 6, Infinity, 6)).toMatchObject({ source: 'blocks', height: 6 });
  });

  it('the blocks answer over a hole the terrain has under them, and a tie goes to the blocks', () => {
    const holed = [terrain([5, 5]), blocks([4, 0, 4])];
    expect(surfaceAt(holed, 5.5, 5, 5.5)).toMatchObject({ source: 'blocks', height: 1 });
    expect(surfaceAt([terrain([5, 5])], 5.5, 5, 5.5)).toBeNull();
    // The blocks' top at the terrain's height (1 m): the blocks, whichever source is listed first.
    expect(surfaceAt([terrain(), blocks([4, 0, 4])], 6, 5, 6)!.source).toBe('blocks');
    expect(surfaceAt([blocks([4, 0, 4]), terrain()], 6, 5, 6)!.source).toBe('blocks');
  });

  it('a cellar under the ground answers on its own floor; a point sunk into the ground climbs to it', () => {
    // The terrain at 1 m over a block floor whose top is at -2 m (a cellar under it).
    const sources = [terrain(), blocks([4, -3, 4])];
    expect(surfaceAt(sources, 6, -1, 6)).toMatchObject({ source: 'blocks', height: -2 });
    expect(surfaceAt(sources, 6, 5, 6)).toMatchObject({ source: 'terrain' });
    expect(surfaceAt(sources, 6, Infinity, 6)).toMatchObject({ source: 'terrain' });
    // A foot a little in the ground still stands on it; a point deep in the ground with nothing under it climbs out.
    expect(surfaceAt(sources, 6, 0.9, 6)).toMatchObject({ source: 'terrain' });
    expect(surfaceAt([terrain()], 2, -4, 2)!.height).toBeCloseTo(1, 4);
    // Under the ground with the cellar below: the cellar's floor, not the surface 3 m above.
    expect(surfaceAt(sources, 6, -1.9, 6)).toMatchObject({ source: 'blocks', height: -2 });
  });

  it('refuses a point that is not one', () => {
    expect(surfaceAt([terrain()], Number.NaN, 0, 0)).toBeNull();
    expect(surfaceAt([terrain()], 0, Number.NaN, 0)).toBeNull();
  });
});
