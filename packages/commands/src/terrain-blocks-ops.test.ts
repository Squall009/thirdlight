/**
 * A terrain meeting a block layer (a `blocks` edit layer): its edge follows
 * the layer's border corner heights and fades back to its own ground over
 * the blend; under the footprint it is cut away (the cells the footprint
 * covers whole are holes, the ground there the blocks') or flattened just
 * under the blocks; the blocks' paint carries across the border; scatter
 * keeps off the footprint. A block edit at the border re-bakes only round
 * the columns it changed, and that re-bake equals combining everything.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, PAINT_BYTES, PAINT_CHANNELS, TERRAIN_BLOCKS_SINK, encodeChunkPaint, flatTerrainTile, terrainHeightOf, terrainHoleAt, terrainLayersAt, type BlockCell, type BlockLayerComponent, type BlockLayerData, type BlockType, type ScatterCell, type SceneV4, type TerrainBlocksLayer, type TerrainComponent, type TerrainTile } from '@thirdlight/project-model';

import { blockSeamRebakeRects, planTerrainSplineRebake, splineRebakeRects, type TerrainLayerReads, type TerrainSplinePlan } from './index';
import { terrainSplineContext } from './terrain-spline-ops';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
const RANGE: [number, number] = [-20, 100];
const GROUND = 'group-0902';
const LAYER = 'group-0903';
const N = 65;
/** The block area: 8 × 8 cells of 1 m from (20, 0, 20), its ground two rows high (2 m). */
const AT: [number, number, number] = [20, 0, 20];
const SIDE = 8;
const TYPES = new Map<string, BlockType>([['rock', { blockId: 'rock', name: 'Rock', shape: 'full', variants: [{ color: '#808080' }] } as unknown as BlockType]]);

type Blobs = Map<string, TerrainTile>;

/** The block layer's data: rows 0–1 of `side` × `side` columns, `top` cells (by column) as given. */
function blockData(cells: (x: number, z: number) => BlockCell[] | null, paint?: number): BlockLayerData {
  const comp: BlockLayerComponent = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [32, 8, 32] } };
  const g = new BlockGrid(comp);
  for (let z = 0; z < SIDE; z++) for (let x = 0; x < SIDE; x++) (cells(x, z) ?? []).forEach((c, y) => c !== null && g.set(x, y, z, c));
  const data = g.toData(LAYER, null, g.takeDirty().chunks)!;
  if (paint !== undefined) {
    // Every lattice vertex painted wholly layer `paint`.
    const lattice = new Uint8Array(PAINT_BYTES);
    for (let i = 0; i < PAINT_BYTES / PAINT_CHANNELS; i++) lattice[i * PAINT_CHANNELS + paint] = 255;
    data.chunks = data.chunks!.map((c) => (c.cx === 0 && c.cz === 0 ? { ...c, paint: encodeChunkPaint(lattice) } : c));
  }
  return data;
}
const flat = (): BlockLayerData => blockData(() => [{ block: 'rock' }, { block: 'rock' }]);

/** A 2 × 1 terrain of 65-sample tiles at 1 m, flat at 0.5 m, with a block layer at AT and the blocks layer given. */
function world(blobs: Blobs, data: BlockLayerData, layer: TerrainBlocksLayer | null, spacing = 1, terrainAt: [number, number, number] = [0, 0, 0]): SceneV4 {
  const tiles = [0, 1].map((x) => {
    const t = flatTerrainTile(N, Math.round(((0.5 - RANGE[0]) / (RANGE[1] - RANGE[0])) * 65535));
    const d = `${x + 1}`.repeat(64);
    blobs.set(d, t);
    return { x, z: 0, data: d };
  });
  const comp: TerrainComponent = { tileSamples: N, spacing, heightRange: RANGE, tiles, ...(layer !== null ? { layers: [layer] } : {}) };
  const ground = { id: GROUND, name: 'Ground', components: { transform: { position: terrainAt, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, terrain: comp } };
  const blocks = { id: LAYER, name: 'Blocks', components: { transform: { position: AT, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, blockLayer: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [32, 8, 32] } } } };
  return { ...BEFORE.scene, entities: [...BEFORE.scene.entities, ground, blocks], blocks: [data] } as unknown as SceneV4;
}

const terrainOf = (scene: SceneV4): TerrainComponent => scene.entities.find((e) => e.id === GROUND)!.components.terrain as TerrainComponent;
const withLayer = (scene: SceneV4, layer: TerrainBlocksLayer | null): SceneV4 =>
  ({ ...scene, entities: scene.entities.map((e) => (e.id === GROUND ? { ...e, components: { ...e.components, terrain: { ...terrainOf(scene), ...(layer !== null ? { layers: [layer] } : { layers: undefined }) } } } : e)) }) as SceneV4;
const withBlocks = (scene: SceneV4, data: BlockLayerData): SceneV4 => ({ ...scene, blocks: [data] }) as unknown as SceneV4;

let serial = 100;
function store(scene: SceneV4, plan: Pick<TerrainSplinePlan, 'tiles' | 'bases'>, blobs: Blobs): SceneV4 {
  const comp = terrainOf(scene);
  const name = (): string => (serial++).toString(16).padStart(64, 'c');
  const tiles = comp.tiles.map((t) => {
    const key = `${t.x},${t.z}`;
    const out = { ...t };
    const tile = plan.tiles.get(key);
    if (tile !== undefined) blobs.set((out.data = name()), tile);
    if (plan.bases.has(key)) {
      const b = plan.bases.get(key)!;
      if (b === null) delete out.base;
      else blobs.set((out.base = name()), b);
    }
    return out;
  });
  return { ...scene, entities: scene.entities.map((e) => (e.id === GROUND ? { ...e, components: { ...e.components, terrain: { ...comp, tiles } } } : e)) } as SceneV4;
}

const reads: TerrainLayerReads = { heightmap: () => null, delta: () => ({ ok: false, error: { code: 'blob_missing', cls: 'not_found', message: 'none' } as never }), blockTypes: () => TYPES };
const readTile = (blobs: Blobs) => (d: string) => (blobs.has(d) ? { ok: true as const, tile: blobs.get(d)! } : { ok: false as const, error: { code: 'blob_missing', cls: 'not_found', message: d } as never });
const readCell = (_d: string) => ({ ok: true as const, cell: new Map() as ScatterCell });

function plan(after: SceneV4, rects: [number, number, number, number][], blobs: Blobs): TerrainSplinePlan | null {
  const planned = planTerrainSplineRebake(after, GROUND, rects, readTile(blobs), readCell, reads);
  if (!planned.ok) throw new Error(planned.error.message);
  return planned.plan;
}
function follow(before: SceneV4, after: SceneV4, blobs: Blobs): SceneV4 {
  const p = plan(after, splineRebakeRects(before, after).get(GROUND) ?? [], blobs);
  return p === null ? after : store(after, p, blobs);
}

/** The drawn tile holding global sample (gx, gz) and the sample's index in it. */
function sampleOf(scene: SceneV4, blobs: Blobs, gx: number, gz: number): { t: TerrainTile; i: number; lx: number } {
  const comp = terrainOf(scene);
  const tx = Math.min(1, Math.floor(gx / (N - 1)));
  const t = blobs.get(comp.tiles.find((r) => r.x === tx && r.z === 0)!.data!)!;
  const lx = gx - tx * (N - 1);
  return { t, i: gz * N + lx, lx };
}
const heightAt = (scene: SceneV4, blobs: Blobs, gx: number, gz: number): number => {
  const s = sampleOf(scene, blobs, gx, gz);
  return terrainHeightOf(RANGE, s.t.heights[s.i]!);
};
const holeAt = (scene: SceneV4, blobs: Blobs, gx: number, gz: number): boolean => {
  const s = sampleOf(scene, blobs, gx, gz);
  return terrainHoleAt(s.t, s.lx, gz);
};
const smooth = (t: number): number => t * t * (3 - 2 * t);
const STEP = (RANGE[1] - RANGE[0]) / 65535;

describe('a terrain meeting a block layer', () => {
  it('cut: the edge follows the border, fades back over the blend, and the footprint is cut away', () => {
    const blobs: Blobs = new Map();
    const s0 = world(blobs, flat(), null);
    const s1 = follow(s0, withLayer(s0, { id: 'blocks', kind: 'blocks', blend: 4 }), blobs);
    // On the border (every side, corners included): the blocks' top, 2 m.
    for (const [x, z] of [[20, 20], [24, 20], [28, 20], [28, 24], [28, 28], [24, 28], [20, 24]]) expect(heightAt(s1, blobs, x!, z!), `border (${x}, ${z})`).toBeCloseTo(2, 2);
    // Outside, d metres from the border: the ground pulled toward it by smoothstep(1 − d / 4).
    for (const d of [1, 2, 3]) expect(heightAt(s1, blobs, 24, 20 - d), `${d} m out`).toBeCloseTo(0.5 + 1.5 * smooth(1 - d / 4), 2);
    // Past the blend, and diagonally past a corner: its own ground.
    expect(heightAt(s1, blobs, 24, 15)).toBeCloseTo(0.5, 2);
    expect(heightAt(s1, blobs, 17, 17)).toBeCloseTo(0.5, 2);
    // Diagonally out from a corner, 2·√2 m: by its distance to the corner.
    expect(heightAt(s1, blobs, 30, 30)).toBeCloseTo(0.5 + 1.5 * smooth(1 - Math.SQRT2 * 2 / 4), 2);
    // Under it: the cells the footprint covers a cell in from its border are holes (the ground there the blocks'); the
    // ring of cells along the border stays, just under the blocks; those round it are not cut.
    for (let z = 20; z < 28; z++) for (let x = 20; x < 28; x++) expect(holeAt(s1, blobs, x, z), `cell (${x}, ${z})`).toBe(x > 20 && x < 27 && z > 20 && z < 27);
    for (const [x, z] of [[19, 24], [28, 24], [24, 19], [24, 28]]) expect(holeAt(s1, blobs, x!, z!), `cell (${x}, ${z})`).toBe(false);
    expect(heightAt(s1, blobs, 24, 24)).toBeCloseTo(2, 2);
    // A sample a cell in, beside the kept ring: below the blocks.
    expect(heightAt(s1, blobs, 21, 24)).toBeCloseTo(2 - TERRAIN_BLOCKS_SINK, 2);
    // The hand-made ground stays beside, and comes back when the layer goes.
    expect(terrainOf(s1).tiles[0]!.base).toBeDefined();
    const s2 = follow(s1, withLayer(s1, null), blobs);
    expect(heightAt(s2, blobs, 24, 20)).toBeCloseTo(0.5, 2);
    expect(holeAt(s2, blobs, 24, 24)).toBe(false);
  });

  it('the edge follows sloped tops\' corner heights; a wall stacked on the ground leaves the ground the border', () => {
    const blobs: Blobs = new Map();
    // Row 0 with corners rising along x (1 + x/8 rows at the −x edge of column x); column (3, 0) carries a wall two cells high.
    const data = blockData((x, z) => {
      const ground: BlockCell = { block: 'rock', corners: [1 + x / 8, 1 + (x + 1) / 8, 1 + (x + 1) / 8, 1 + x / 8] };
      return x === 3 && z === 0 ? [{ block: 'rock' }, { block: 'rock' }, { block: 'rock' }] : [ground];
    });
    const s0 = world(blobs, data, null);
    const s1 = follow(s0, withLayer(s0, { id: 'blocks', kind: 'blocks', blend: 4 }), blobs);
    // Along the −z border: each corner's height (the lowest of the columns sharing it).
    for (const x of [0, 1, 2, 5, 6, 7, 8]) expect(heightAt(s1, blobs, 20 + x, 20), `corner x ${x}`).toBeCloseTo(1 + x / 8, 2);
    // The column stacked three cells high: the run is the column, its top 3 m, but the corners it shares take the lower neighbours'.
    expect(heightAt(s1, blobs, 23, 20)).toBeCloseTo(1 + 3 / 8, 2);
    expect(heightAt(s1, blobs, 24, 20)).toBeCloseTo(1 + 4 / 8, 2);
    // Along the +x border: the last column's +x corners.
    expect(heightAt(s1, blobs, 28, 24)).toBeCloseTo(2, 2);
  });

  it('flatten: no holes, the ground under the blocks just below them, the border exact', () => {
    const blobs: Blobs = new Map();
    const s0 = world(blobs, flat(), null);
    const s1 = follow(s0, withLayer(s0, { id: 'blocks', kind: 'blocks', mode: 'flatten', blend: 4 }), blobs);
    expect(heightAt(s1, blobs, 24, 20)).toBeCloseTo(2, 2);
    expect(heightAt(s1, blobs, 24, 24)).toBeCloseTo(2 - TERRAIN_BLOCKS_SINK, 2);
    for (let z = 20; z < 28; z++) for (let x = 20; x < 28; x++) expect(holeAt(s1, blobs, x, z)).toBe(false);
  });

  it('a terrain grid not on the cells: whole cells cut, the cells half on the blocks kept and under them', () => {
    const blobs: Blobs = new Map();
    const s0 = world(blobs, flat(), null, 1, [0.5, 0, 0]);
    const s1 = follow(s0, withLayer(s0, { id: 'blocks', kind: 'blocks', blend: 4 }), blobs);
    // Terrain samples at x = 0.5 + i: samples 20–27 (x 20.5–27.5) lie under the blocks; cell 19 (x 19.5–20.5) is half on
    // them, cell 20 wholly but beside it (kept), cell 21 the first cut.
    expect(holeAt(s1, blobs, 19, 24)).toBe(false);
    expect(holeAt(s1, blobs, 20, 24)).toBe(false);
    expect(holeAt(s1, blobs, 21, 24)).toBe(true);
    expect(holeAt(s1, blobs, 26, 24)).toBe(false);
    // The samples of the kept cells under the blocks: below them; those of cut cells only: at them.
    expect(heightAt(s1, blobs, 20, 24)).toBeCloseTo(2 - TERRAIN_BLOCKS_SINK, 2);
    expect(heightAt(s1, blobs, 23, 24)).toBeCloseTo(2, 2);
    // Half a metre out: almost the border's height.
    expect(heightAt(s1, blobs, 19, 24)).toBeCloseTo(0.5 + 1.5 * smooth(1 - 0.5 / 4), 2);
  });

  it('the blocks\' paint carries across the border, fading over the blend', () => {
    const blobs: Blobs = new Map();
    const s0 = world(blobs, blockData(() => [{ block: 'rock' }, { block: 'rock' }], 2), null);
    const s1 = follow(s0, withLayer(s0, { id: 'blocks', kind: 'blocks', blend: 4 }), blobs);
    const layers = (gx: number, gz: number): { layers: number[]; weights: number[] } => {
      const s = sampleOf(s1, blobs, gx, gz);
      return terrainLayersAt(s.t, s.i);
    };
    // On the border: wholly the blocks' layer 2.
    expect(layers(24, 20)).toEqual({ layers: [2], weights: [255] });
    // 2 m out: half (smoothstep 0.5) layer 2 over the ground's layer 0.
    const half = layers(24, 18);
    expect(half.layers.slice(0, 2).sort()).toEqual([0, 2]);
    expect(half.weights[half.layers.indexOf(2)]! / 255).toBeCloseTo(smooth(0.5), 1);
    // Past the blend: the ground's own.
    expect(layers(24, 15)).toEqual({ layers: [0], weights: [255] });
    // Without paint carried: layer 0 at the border too.
    const s2 = follow(s1, withLayer(s1, { id: 'blocks', kind: 'blocks', blend: 4, paint: false }), blobs);
    const s = sampleOf(s2, blobs, 24, 20);
    expect(terrainLayersAt(s.t, s.i)).toEqual({ layers: [0], weights: [255] });
  });

  it('scatter keeps off the footprint', () => {
    const blobs: Blobs = new Map();
    const s0 = world(blobs, flat(), { id: 'blocks', kind: 'blocks' });
    const comp = terrainOf(s0);
    const ctx = terrainSplineContext(s0 as never, comp, [0, 0, 0], reads);
    expect(ctx.covered).not.toBeNull();
    expect(ctx.covered!(24, 24)).toBe(true);
    expect(ctx.covered!(20, 24)).toBe(true);
    expect(ctx.covered!(19.9, 24)).toBe(false);
    expect(ctx.covered!(10, 10)).toBe(false);
  });

  it('a block edit at the border re-bakes only round the columns it changed, the same as combining everything', () => {
    const blobs: Blobs = new Map();
    const s0 = world(blobs, flat(), null);
    const s1 = follow(s0, withLayer(s0, { id: 'blocks', kind: 'blocks', blend: 4 }), blobs);
    // A third row on four border columns (x 22–25, z 20): their top 3 m.
    const raised = blockData((x, z) => (x >= 2 && x <= 5 && z === 0 ? [{ block: 'rock' }, { block: 'rock' }, { block: 'rock' }] : [{ block: 'rock' }, { block: 'rock' }]));
    const s2 = withBlocks(s1, raised);
    const rects = blockSeamRebakeRects(s1, s2).get(GROUND)!;
    expect(rects.length).toBe(1);
    // The changed columns (x 22–25, z 20) grown by a larger block's reach (9 cells) and the blend (4 m).
    expect(rects[0]).toEqual([22 - 13, 20 - 13, 26 + 13, 21 + 13]);
    expect(splineRebakeRects(s1, s2).get(GROUND)).toEqual(rects);
    const part = plan(s2, rects, blobs)!;
    const whole = plan(s2, [[-10, -10, 200, 200]], blobs)!;
    for (const [key, t] of whole.tiles) {
      const p = part.tiles.get(key) ?? sampleOf(s1, blobs, Number(key.split(',')[0]) * (N - 1), 0).t;
      expect([...p.heights], `tile ${key} heights`).toEqual([...t.heights]);
      expect(p.holes === null ? null : [...p.holes], `tile ${key} holes`).toEqual(t.holes === null ? null : [...t.holes]);
    }
    const s3 = store(s2, part, blobs);
    // The border follows the raised columns (3 m) where they alone meet it; the corners they share with the low ones stay 2 m.
    expect(heightAt(s3, blobs, 24, 20)).toBeCloseTo(3, 2);
    expect(heightAt(s3, blobs, 22, 20)).toBeCloseTo(2, 2);
    expect(heightAt(s3, blobs, 24, 18)).toBeCloseTo(0.5 + 2.5 * smooth(0.5), 2);
    // Untouched far away (and in the other tile).
    expect(heightAt(s3, blobs, 70, 30)).toBeCloseTo(0.5, 2);
    // The re-bake shows in the edit's box only: the changed columns and the samples round them.
    const moved: number[] = [];
    for (let z = 0; z < N; z++) for (let x = 0; x < 2 * (N - 1); x++) if (Math.abs(heightAt(s3, blobs, x, z) - heightAt(s1, blobs, x, z)) > STEP) moved.push(x * 1000 + z);
    for (const k of moved) {
      const [x, z] = [Math.floor(k / 1000), k % 1000];
      expect(x >= rects[0]![0] && x <= rects[0]![2] && z >= rects[0]![1] && z <= rects[0]![3], `sample (${x}, ${z}) moved outside the box`).toBe(true);
    }
  });
});
