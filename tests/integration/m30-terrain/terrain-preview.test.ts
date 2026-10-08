/**
 * The terrain tools' stroke maths (browser-free): the `editTerrain` args a
 * stroke stores are accepted by the command, its preview dab says the same
 * thing in the terrain's frame, and the rectangles the GPU preview writes
 * hold every sample (in every tile holding it) the command's brush cores
 * change — so a preview never leaves a change of the stored stroke undrawn.
 * The preview's texels against the stored tiles are compared in the
 * browser (terrain-cdlod e2e, `?terrainCheck=1`).
 */
import { describe, expect, it } from 'vitest';
import { validateEditTerrainArgs } from '../../../packages/commands/src/index';
import { TERRAIN_HEIGHT_STEPS, TerrainSamples, validateTerrainLayers, type ModelErrorV2, flatTerrainTile, holeTerrain, paintTerrain, rampTerrain, sculptTerrain, terrainHoleAt, terrainTileKey, type TerrainTile } from '../../../packages/project-model/src/index';
import { DEFAULT_ERODE_TOOL, DEFAULT_STAMP_TOOL, PLACED_TERRAIN_TOOLS, TERRAIN_TOOLS, erodeArgs, layersWithStamp, previewDab, strokeArgs, strokeDabLimit, dabsAlong, DEFAULT_TERRAIN_BRUSH, type TerrainToolId } from '../../../packages/editor/src/session/terrain-brush';
import { boxTiles, brushDabOf, brushSampleBox, compareRect, emptyDiff, tileRect } from '../../../packages/three-adapter/src/terrain-preview';

const S = 33;
const N = S - 1;
const SPACING = 0.5;
const RANGE: [number, number] = [-32, 96];
const ORIGIN = [10, 2, -20];

/** 3 × 3 tiles of rolling ground, painted nowhere. */
function tiles(): Map<string, TerrainTile> {
  const out = new Map<string, TerrainTile>();
  for (let tz = 0; tz < 3; tz++)
    for (let tx = 0; tx < 3; tx++) {
      const t = flatTerrainTile(S, 0);
      for (let z = 0; z < S; z++)
        for (let x = 0; x < S; x++) {
          const gx = tx * N + x;
          const gz = tz * N + z;
          const h = 4 + 2 * Math.sin(gx / 7) * Math.cos(gz / 5);
          t.heights[z * S + x] = Math.round(((h - RANGE[0]) / (RANGE[1] - RANGE[0])) * TERRAIN_HEIGHT_STEPS);
        }
      out.set(terrainTileKey(tx, tz), t);
    }
  return out;
}

/** Every [tile, local x, local z] whose heights, paint or holes differ. */
function changed(before: Map<string, TerrainTile>, after: ReadonlyMap<string, TerrainTile>): [string, number, number][] {
  const out: [string, number, number][] = [];
  for (const [key, a] of after) {
    const b = before.get(key)!;
    for (let z = 0; z < S; z++)
      for (let x = 0; x < S; x++) {
        const i = z * S + x;
        // A tile's paint map is made whole when first painted: none reads as unpainted.
        const paint = (t: TerrainTile): string => (t.paint === null ? '0,0,0,0,0,0,0,0,0' : Array.from(t.paint.subarray(i * 9, i * 9 + 9)).join(','));
        const hole = (t: TerrainTile): boolean => x < N && z < N && terrainHoleAt(t, x, z);
        if (a.heights[i] !== b.heights[i] || paint(a) !== paint(b) || hole(a) !== hole(b)) out.push([key, x, z]);
      }
  }
  return out;
}

const shape = { origin: ORIGIN, heightRange: RANGE, spacing: SPACING };

describe('terrain tools: strokes', () => {
  it('store args the command accepts, for every tool, inverted or not', () => {
    for (const t of TERRAIN_TOOLS) {
      // The placed tools store no stroke (checked below).
      if (PLACED_TERRAIN_TOOLS.includes(t.id)) continue;
      for (const invert of [false, true]) {
        const args = strokeArgs('ground', t.id, DEFAULT_TERRAIN_BRUSH, [[12, -14], [13, -14]], invert, { height: 5, from: [11, 4, -15], to: [20, 7, -10] });
        const v = validateEditTerrainArgs(args);
        expect(v.ok, `${t.id}${invert ? ' inverted' : ''}: ${JSON.stringify(v)}`).toBe(true);
      }
    }
    expect(strokeArgs('g', 'raise', DEFAULT_TERRAIN_BRUSH, [[0, 0]], true, {})['kind']).toBe('lower');
    expect(strokeArgs('g', 'paint', DEFAULT_TERRAIN_BRUSH, [[0, 0]], true, {})['erase']).toBe(true);
    expect(strokeArgs('g', 'holes', DEFAULT_TERRAIN_BRUSH, [[0, 0]], true, {})['erase']).toBe(true);
    // The placed tools: an erode's args and the layers after a stamp are what the command and the model take.
    const erode = validateEditTerrainArgs(erodeArgs('ground', DEFAULT_ERODE_TOOL, [12, -14], 8));
    expect(erode.ok, JSON.stringify(erode)).toBe(true);
    const layers = layersWithStamp(layersWithStamp([{ id: 'splines', kind: 'splines' }], { ...DEFAULT_STAMP_TOOL, asset: 'cone' }, [12, -14], 8), { ...DEFAULT_STAMP_TOOL, asset: 'cone', rotation: 30 }, [20, -14], 8);
    const errors: ModelErrorV2[] = [];
    validateTerrainLayers(layers, '/layers', errors);
    expect(errors).toEqual([]);
    // A new stamps layer goes under the splines; the second stamp joins it.
    expect(layers.map((l) => l.id)).toEqual(['stamps', 'splines']);
    expect((layers[0] as { stamps: unknown[] }).stamps).toHaveLength(2);
  });

  it('hold at most the dabs the command takes at their radius, dropped along the drag', () => {
    // 64 m at 1 m: the samples bound (16,777,216 over 16,900 a dab) binds before the 1,024 dabs.
    expect(strokeDabLimit(64, 1)).toBe(992);
    expect(strokeDabLimit(2, 1)).toBe(1024);
    const along = dabsAlong([0, 0], [10, 0], 2.5);
    expect(along.points).toEqual([[2.5, 0], [5, 0], [7.5, 0], [10, 0]]);
    expect(along.last).toEqual([10, 0]);
    expect(dabsAlong([0, 0], [1, 0], 2.5).points).toEqual([]);
  });

  it('preview in the terrain frame what they store (centre, steps, flatten level, ramp ends)', () => {
    const mps = (RANGE[1] - RANGE[0]) / TERRAIN_HEIGHT_STEPS;
    const b = { ...DEFAULT_TERRAIN_BRUSH, height: 1.5, blend: 0.4 };
    const raise = brushDabOf(previewDab('raise', b, [12, -14], false, {}), shape);
    expect([raise.cx, raise.cz]).toEqual([2, 6]);
    expect(raise.strength).toBeCloseTo(1.5 / mps, 6);
    const flat = brushDabOf(previewDab('flatten', b, [12, -14], false, { height: 7 }), shape);
    expect(flat.strength).toBe(0.4);
    expect(flat.target).toBeCloseTo((7 - ORIGIN[1]! - RANGE[0]) / mps, 6);
    const ramp = brushDabOf(previewDab('ramp', b, [0, 0], false, { from: [11, 4, -15], to: [20, 7, -10] }), shape);
    expect(ramp.from[0]).toBe(1);
    expect(ramp.from[1]).toBe(5);
    expect(ramp.from[2]).toBeCloseTo((4 - 2 - RANGE[0]) / mps, 6);
    expect(ramp.to.slice(0, 2)).toEqual([10, 10]);
  });

  it('write every sample the cores change, in every tile holding it', () => {
    const cases: { tool: TerrainToolId; invert?: boolean; at: [number, number]; radius: number }[] = [
      { tool: 'raise', at: [10 + 16, -20 + 16], radius: 3.3 },
      { tool: 'lower', at: [10 + 7.9, -20 + 31.7], radius: 5 },
      { tool: 'smooth', at: [10 + 16.2, -20 + 15.8], radius: 4 },
      { tool: 'flatten', at: [10 + 31.9, -20 + 0.4], radius: 2.6 },
      { tool: 'noise', at: [10 + 20, -20 + 24], radius: 6 },
      { tool: 'paint', at: [10 + 16, -20 + 16.1], radius: 3 },
      { tool: 'holes', at: [10 + 16.1, -20 + 15.9], radius: 2.2 },
      { tool: 'holes', invert: true, at: [10 + 16.1, -20 + 15.9], radius: 1.1 },
      { tool: 'ramp', at: [0, 0], radius: 1.5 },
    ];
    let start = tiles();
    for (const c of cases) {
      const brush = { ...DEFAULT_TERRAIN_BRUSH, radius: c.radius, height: 0.7, blend: 0.6, falloff: 'linear' as const, scale: 3 };
      const extra = { height: 9, from: [10 + 4, 6, -20 + 30] as [number, number, number], to: [10 + 40, 1, -20 + 2] as [number, number, number] };
      const dab = brushDabOf(previewDab(c.tool, brush, c.at, c.invert === true, extra), shape);
      const s = new TerrainSamples({ tileSamples: S, spacing: SPACING, heightRange: RANGE }, start);
      const local = [c.at[0] - ORIGIN[0]!, c.at[1] - ORIGIN[2]!] as const;
      if (c.tool === 'paint') paintTerrain(s, { at: local, radius: c.radius, strength: 0.6, falloff: 'linear', layer: 2 });
      else if (c.tool === 'holes') holeTerrain(s, { at: local, radius: c.radius, ...(c.invert === true ? { erase: true } : {}) });
      else if (c.tool === 'ramp') rampTerrain(s, { from: [4, 4, 30], to: [40, -1, 2], radius: c.radius, strength: 0.6, falloff: 'linear' });
      else sculptTerrain(s, { kind: c.tool as 'raise', at: local, radius: c.radius, strength: c.tool === 'raise' || c.tool === 'lower' || c.tool === 'noise' ? 0.7 : 0.6, falloff: 'linear', height: 9 - ORIGIN[1]!, scale: 3, seed: brush.seed });
      const diff = changed(start, s.all());
      expect(diff.length, `${c.tool}: the core changed something`).toBeGreaterThan(0);
      const box = brushSampleBox(dab, SPACING);
      const [tx0, tz0, tx1, tz1] = boxTiles(box, N);
      for (const [key, x, z] of diff) {
        const [tx, tz] = key.split(',').map(Number) as [number, number];
        expect(tx >= tx0 && tx <= tx1 && tz >= tz0 && tz <= tz1, `${c.tool}: tile ${key} is reached`).toBe(true);
        const r = tileRect(box, tx, tz, N);
        expect(r !== null && x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3], `${c.tool}: [${key}] ${x},${z} is written`).toBe(true);
      }
      start = new Map(s.all());
    }
  });

  it('compare a previewed rectangle with the stored tile byte by byte', () => {
    const stored = new Uint8Array(4 * 4 * 4);
    const preview = new Uint8Array(2 * 2 * 4);
    // Sample (1, 1) of a 4-sample tile: step 0x0102, normal (128, 128); the preview one step up and a normal byte off.
    stored.set([1, 2, 128, 128], (1 * 4 + 1) * 4);
    preview.set([1, 3, 129, 128], 0);
    const d = emptyDiff();
    compareRect(d, 'heights', preview, stored, [1, 1, 2, 2], 4);
    expect(d.samples).toBe(4);
    expect(d.stepsMax).toBe(1);
    expect(d.stepsDiffering).toBe(1);
    expect(d.normalMax).toBe(1);
  });
});
