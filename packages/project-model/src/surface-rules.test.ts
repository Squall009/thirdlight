/**
 * Material rules: the conditions and their fades, the layer stack, and the
 * two bakes — terrain tiles (a bake over part of the terrain gives the bytes
 * a full one gives; hand paint stays over the rules; edge samples two tiles
 * share agree) and block chunks (walls and steep tops by their own slope,
 * hand paint over the rules, the unpainted share filled).
 */
import { describe, expect, it } from 'vitest';

import { SurfaceRuleSet, canonicalSurfaceRules, ruleNoise, ruleRangeAt, validateSurfaceRules, type SurfacePoint, type SurfaceRule } from './surface-rules';
import { bakeTerrainRules, terrainBakeMargin, terrainBakeRect } from './terrain-rules';
import { TerrainSamples, paintTerrain, sculptTerrain } from './terrain-edit';
import { cloneTerrainTile, flatTerrainTile, terrainBakedLayers, terrainLayersAt, TERRAIN_WEIGHT_BYTES, type TerrainTile } from './terrain-tile';
import { terrainFlatStep, terrainStepOf, terrainTileKey, type TerrainComponent } from './terrain';
import { applyBlockEdits, BlockGrid, type BlockEdit } from './block-grid';
import { blockTopOptions, meshBlockChunk, shapeSource, type BlockLookResolver } from './block-mesh';
import { chunkMeshPaint } from './block-paint-mesh';
import type { BlockLayerComponent, BlockType } from './block-layers';
import type { ModelErrorV2 } from './errors';

const at = (o: Partial<SurfacePoint>): SurfacePoint => ({ x: 0, y: 0, z: 0, slope: 0, wall: false, cavity: () => 0, ...o });
function layersOf(set: SurfaceRuleSet, p: SurfacePoint): Record<number, number> {
  const layers: number[] = [];
  const weights: number[] = [];
  const n = set.evaluate(p, layers, weights);
  const out: Record<number, number> = {};
  for (let i = 0; i < n; i++) out[layers[i]!] = weights[i]!;
  return out;
}

describe('surface rules', () => {
  it('ranges fade smoothly outside their ends', () => {
    expect(ruleRangeAt({ min: 30 }, 29)).toBe(0);
    expect(ruleRangeAt({ min: 30, fade: 10 }, 30)).toBe(1);
    expect(ruleRangeAt({ min: 30, fade: 10 }, 25)).toBe(0.5);
    expect(ruleRangeAt({ min: 30, fade: 10 }, 20)).toBe(0);
    expect(ruleRangeAt({ max: 5, fade: 2 }, 6)).toBe(0.5);
    expect(ruleRangeAt({ min: 0, max: 1 }, 0.5)).toBe(1);
  });

  it('stacks in order: a slope rule over the base, a later rule over both, weights summing to 255', () => {
    const set = new SurfaceRuleSet([{ layer: 3, slope: { min: 40 } }, { layer: 2, height: { min: 100 }, strength: 0.5 }]);
    expect(layersOf(set, at({ slope: 10 }))).toEqual({ 0: 255 });
    expect(layersOf(set, at({ slope: 60 }))).toEqual({ 3: 255 });
    expect(layersOf(set, at({ slope: 60, y: 120 }))).toEqual({ 3: 128, 2: 127 });
    expect(layersOf(set, at({ slope: 10, y: 120 }))).toEqual({ 0: 127, 2: 128 });
  });

  it('reads faces, block types, metadata, cavity and the layers so far', () => {
    const set = new SurfaceRuleSet([
      { layer: 1, face: 'wall' },
      { layer: 2, blocks: ['brick'] },
      { layer: 3, meta: { wet: true } },
    ]);
    expect(layersOf(set, at({ wall: true }))).toEqual({ 1: 255 });
    expect(layersOf(set, at({ block: 'brick' }))).toEqual({ 2: 255 });
    expect(layersOf(set, at({ block: 'stone' }))).toEqual({ 0: 255 });
    expect(layersOf(set, at({ meta: (k) => (k === 'wet' ? true : undefined) }))).toEqual({ 3: 255 });
    const hollow = new SurfaceRuleSet([{ layer: 1, cavity: { min: 0.5, radius: 4 } }, { layer: 2, weight: { layer: 1, max: 0.2 } }]);
    let asked = 0;
    // Measured once per point however many rules read it.
    expect(layersOf(hollow, at({ cavity: (r) => (asked++, r === 4 ? 1 : 0) }))).toEqual({ 1: 255 });
    expect(asked).toBe(1);
    expect(layersOf(hollow, at({ cavity: () => 0 }))).toEqual({ 2: 255 });
  });

  it('noise is a mask in world space, the same at the same point', () => {
    const a = ruleNoise(3.3, 1.2, -7.9, 5);
    expect(a).toBe(ruleNoise(3.3, 1.2, -7.9, 5));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    expect(ruleNoise(3.3, 1.2, -7.9, 6)).not.toBe(a);
    const set = new SurfaceRuleSet([{ layer: 1, noise: { scale: 4, min: 0.5 } }]);
    let hits = 0;
    for (let x = 0; x < 64; x++) if ((layersOf(set, at({ x, z: x * 0.7 }))[1] ?? 0) > 0) hits += 1;
    expect(hits).toBeGreaterThan(8);
    expect(hits).toBeLessThan(56);
  });

  it('validates: block conditions on block layers only, their layers 0-3', () => {
    const check = (v: unknown, blocks: boolean): string[] => {
      const errors: ModelErrorV2[] = [];
      validateSurfaceRules(v, '/rules', errors, blocks);
      return errors.map((e) => e.path);
    };
    expect(check([{ layer: 5, slope: { min: 30, fade: 5 } }, { layer: 1, noise: { scale: 3, seed: 2, max: 0.4 } }], false)).toEqual([]);
    expect(check([{ layer: 5 }], true)).toEqual(['/rules/0/layer']);
    expect(check([{ layer: 1, blocks: ['a'] }], false)).toEqual(['/rules/0/blocks']);
    expect(check([{ layer: 1, slope: { min: 50, max: 40 } }, { layer: 1, noise: { min: 0 } }, { layer: 1, what: 1 }], false)).toEqual(['/rules/0/slope', '/rules/1/noise/scale', '/rules/2/what']);
    expect(canonicalSurfaceRules([{ layer: 1, strength: 1, slope: { fade: 0, min: 3 } }])).toEqual([{ layer: 1, slope: { min: 3 } }]);
  });
});

// ---- terrain ----------------------------------------------------------------------------------------

const TERRAIN: Pick<TerrainComponent, 'tileSamples' | 'spacing' | 'heightRange'> = { tileSamples: 33, spacing: 1, heightRange: [-50, 150] };
const N = 32;
/** 2 × 2 tiles of rolling ground with a steep wall along x = 40 (rising 12 m over 4 m). */
function rolling(): Map<string, TerrainTile> {
  const tiles = new Map<string, TerrainTile>();
  for (let tz = 0; tz < 2; tz++) {
    for (let tx = 0; tx < 2; tx++) {
      const t = flatTerrainTile(33, terrainFlatStep(TERRAIN.heightRange));
      for (let j = 0; j <= N; j++) {
        for (let i = 0; i <= N; i++) {
          const x = tx * N + i;
          const z = tz * N + j;
          const h = 2 * Math.sin(x / 7) * Math.cos(z / 9) + Math.max(0, Math.min(12, (x - 38) * 3));
          t.heights[j * 33 + i] = terrainStepOf(TERRAIN.heightRange, h);
        }
      }
      tiles.set(terrainTileKey(tx, tz), t);
    }
  }
  return tiles;
}
const RULES: SurfaceRule[] = [
  { layer: 5, slope: { min: 50, fade: 8 } },
  { layer: 2, cavity: { min: 0.3, fade: 0.3, radius: 3 } },
  { layer: 7, noise: { scale: 6, seed: 3, min: 0.7, fade: 0.1 }, weight: { layer: 5, max: 0.2 } },
];
const ORIGIN = [100, 5, -40];
const bytes = (tiles: ReadonlyMap<string, TerrainTile>): string[] => [...tiles.entries()].sort().map(([k, t]) => `${k}:${(t.weights ?? new Uint8Array(0)).join(',')}`);

describe('terrain rule bake', () => {
  it('paints steep ground by slope; edge samples two tiles share agree', () => {
    const s = new TerrainSamples(TERRAIN, rolling());
    expect(bakeTerrainRules(s, new SurfaceRuleSet(RULES), ORIGIN, null)).toBeGreaterThan(100);
    const t10 = s.tile(1, 0)!;
    // Sample (x 40, z 10) is on the wall: layer 5; (x 20, z 10) is gentle ground.
    expect(terrainBakedLayers(t10, 10 * 33 + 8).layers[0]).toBe(5);
    const gentle = terrainBakedLayers(s.tile(0, 0)!, 10 * 33 + 20);
    expect(gentle.layers).not.toContain(5);
    for (let j = 0; j <= N; j++) {
      const a = s.tile(0, 0)!.weights!.subarray((j * 33 + N) * TERRAIN_WEIGHT_BYTES, (j * 33 + N + 1) * TERRAIN_WEIGHT_BYTES);
      const b = s.tile(1, 0)!.weights!.subarray(j * 33 * TERRAIN_WEIGHT_BYTES, (j * 33 + 1) * TERRAIN_WEIGHT_BYTES);
      expect([...a]).toEqual([...b]);
    }
  });

  it('an edit baked over the samples it moved gives the bytes of a full bake', () => {
    const set = new SurfaceRuleSet(RULES);
    const base = new TerrainSamples(TERRAIN, rolling());
    bakeTerrainRules(base, set, ORIGIN, null);
    const before = new Map([...base.all()].map(([k, t]) => [k, cloneTerrainTile(t)]));
    // A sculpt near the tiles' corner, then a bake of only what it changed.
    const s = new TerrainSamples(TERRAIN, before);
    sculptTerrain(s, { kind: 'raise', at: [31, 30], radius: 5, strength: 6, falloff: 'smooth' });
    const written = new Map([...s.touched].map((k) => [k, s.all().get(k)!]));
    const rect = terrainBakeRect(before, written, N, terrainBakeMargin(set, 1));
    expect(rect).not.toBeNull();
    bakeTerrainRules(s, set, ORIGIN, rect);
    const full = new TerrainSamples(TERRAIN, new Map([...s.all()].map(([k, t]) => [k, cloneTerrainTile(t)])));
    bakeTerrainRules(full, set, ORIGIN, null);
    expect(bytes(s.all())).toEqual(bytes(full.all()));
    // And the edit changed something there.
    expect(bytes(s.all())).not.toEqual(bytes(before));
  });

  it('hand paint stays over the rules through a bake', () => {
    const s = new TerrainSamples(TERRAIN, rolling());
    paintTerrain(s, { at: [40, 10], radius: 2, strength: 1, falloff: 'constant', layer: 9 });
    bakeTerrainRules(s, new SurfaceRuleSet(RULES), ORIGIN, null);
    const t = s.tile(1, 0)!;
    expect(terrainLayersAt(t, 10 * 33 + 8)).toEqual({ layers: [9], weights: [255] });
    // Next to the paint the rules show.
    expect(terrainLayersAt(t, 20 * 33 + 8).layers[0]).toBe(5);
    // No rules: every sample back to layer 0 (the weights hold their default).
    bakeTerrainRules(s, new SurfaceRuleSet([]), ORIGIN, null);
    expect(terrainBakedLayers(s.tile(1, 0)!, 20 * 33 + 8)).toEqual({ layers: [0], weights: [255] });
    expect(terrainLayersAt(s.tile(1, 0)!, 10 * 33 + 8)).toEqual({ layers: [9], weights: [255] });
  });
});

// ---- block layers -----------------------------------------------------------------------------------

const TYPES: BlockType[] = [
  { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' },
  { blockId: 'brick', name: 'Brick', variants: [{ color: '#aa4444' }], shape: 'full' },
];
const types = new Map(TYPES.map((t) => [t.blockId, t]));
const resolver: BlockLookResolver = { source: (t, v, fm) => ({ key: `c:${t.blockId}`, source: shapeSource(t.shape, fm[0], fm[1], fm[2]), uv: 'world' }) };
const edit = (g: BlockGrid, ...edits: BlockEdit[]): void => {
  const r = applyBlockEdits(g, edits, { types, stamps: new Map() });
  if (!r.ok) throw new Error(`${r.path}: ${r.message}`);
};

describe('block rules', () => {
  const layer = (wallPaint: boolean, rules: SurfaceRule[]): BlockLayerComponent => ({ cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [16, 8, 16] }, ...(wallPaint ? { wallPaint: true } : {}), rules });
  /** Ground 1 row deep, a brick block 3 rows tall on x 4-7, z 4-7 (walls 3 m high), a cell with a steep top. */
  const grid = (l: BlockLayerComponent): BlockGrid => {
    const g = new BlockGrid(l);
    edit(g, { kind: 'fill', box: [0, 0, 0, 16, 1, 16], cell: { block: 'stone' } }, { kind: 'fill', box: [4, 1, 4, 8, 4, 8], cell: { block: 'brick' } }, { kind: 'cells', at: [12, 1, 12], cell: { block: 'stone', corners: [0, 0, 3, 3] } });
    g.takeDirty();
    return g;
  };
  /** Each vertex's weights with its normal and position (world: the layer at y 10). */
  function colours(g: BlockGrid, l: BlockLayerComponent): { p: number[]; n: number[]; w: number[] }[] {
    const out: { p: number[]; n: number[]; w: number[] }[] = [];
    for (const part of meshBlockChunk(g, 0, 0, types, resolver, blockTopOptions(l))) {
      const c = chunkMeshPaint(g, types, 0, 0, { wallPaint: l.wallPaint === true, topSubdivision: 1, rules: new SurfaceRuleSet(l.rules!), origin: [0, 10, 0] }, part);
      for (let i = 0; i < part.positions.length / 3; i++) out.push({ p: [...part.positions.subarray(i * 3, i * 3 + 3)], n: [...part.normals.subarray(i * 3, i * 3 + 3)], w: [...c.weights.subarray(i * 4, i * 4 + 4)] });
    }
    return out;
  }
  for (const wallPaint of [false, true]) {
    it(`a slope rule paints walls and steep tops, flat tops keep the base (wall paint ${wallPaint ? 'on' : 'off'})`, () => {
      const l = layer(wallPaint, [{ layer: 3, slope: { min: 45 } }, { layer: 2, blocks: ['brick'], face: 'top' }, { layer: 1, height: { max: 11.5 }, face: 'top' }]);
      const vs = colours(grid(l), l);
      const walls = vs.filter((v) => Math.abs(v.n[1]!) < 0.1);
      expect(walls.length).toBeGreaterThan(20);
      for (const v of walls) expect(v.w, JSON.stringify(v)).toEqual([0, 0, 0, 255]);
      // The brick block's top (y 4): layer 2; the ground's top (y 1, world 11): layer 1 by height.
      const brickTop = vs.filter((v) => v.n[1]! > 0.99 && Math.abs(v.p[1]! - 4) < 1e-4);
      expect(brickTop.length).toBeGreaterThan(3);
      for (const v of brickTop) expect(v.w).toEqual([0, 0, 255, 0]);
      const groundTop = vs.filter((v) => v.n[1]! > 0.99 && Math.abs(v.p[1]! - 1) < 1e-4);
      for (const v of groundTop) expect(v.w).toEqual([0, 255, 0, 0]);
      // The steep top (rising 3 m over 1 m: 72°) by its own slope.
      const steep = vs.filter((v) => v.n[1]! > 0.2 && v.n[1]! < 0.5);
      expect(steep.length).toBeGreaterThan(2);
      for (const v of steep) expect(v.w).toEqual([0, 0, 0, 255]);
    });
  }

  it('hand paint stays over the rules; the paint\'s unpainted share shows them', () => {
    const l = layer(false, [{ layer: 3, slope: { min: 45 } }]);
    const g = grid(l);
    // Layer 2 painted by hand at full strength around (1, 1), half strength around (12, 3).
    edit(g, { kind: 'paint', at: [1, 1], radius: 1.2, strength: 1, channel: 2, falloff: 'constant' }, { kind: 'paint', at: [13, 3], radius: 1.2, strength: 0.5, channel: 1, falloff: 'constant' });
    const vs = colours(g, l);
    const top = (x: number, z: number) => vs.find((v) => v.n[1]! > 0.99 && Math.abs(v.p[0]! - x) < 1e-4 && Math.abs(v.p[2]! - z) < 1e-4 && Math.abs(v.p[1]! - 1) < 1e-4)!;
    expect(top(1, 1).w).toEqual([0, 0, 255, 0]);
    expect(top(13, 3).w).toEqual([128, 127, 0, 0]);
    expect(top(9, 9).w).toEqual([255, 0, 0, 0]);
  });
});
