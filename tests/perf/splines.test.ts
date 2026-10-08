/**
 * Opt-in (TL_PERF=1): what a spline change costs the backend, without a browser.
 *
 *   TL_PERF=1 npx vitest run tests/perf/splines.test.ts
 *
 * A 1 km road (a winding 8 m road with 6 m falloff, painted, scatter kept clear) over a 4 × 4 terrain of 257² tiles
 * at 2 m (2 km square, rolling hills) with the landscape class's four material rules (one reads cavity) and its three
 * scatter rules: the re-bake when the road is added, when one of its points moves 5 m, and when it goes — planned
 * (heights, rules and paint, scatter) and the changed tiles encoded and gzipped as the host stores them.
 * And what the host makes along a 1 km road (a surface swept 1 m apart) and a 1 km river (water, nine points
 * across): the mesh made, its levels simplified (meshoptimizer), the blob encoded — and the triangles per level.
 * The numbers go to ~/.cache/thirdlight-perf/splines.jsonl and the phase plan's progress table.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { SplineCurve, decodeSplineMade, flatTerrainTile, terrainFlatStep, type ScatterCell, type ScatterRule, type SceneV4, type SplineComponent, type SurfaceRule, type TerrainComponent, type TerrainTile } from '@thirdlight/project-model';
import { planTerrainEdit, planTerrainSplineRebake, splineRebakeRects } from '@thirdlight/commands';

import { loadMeshSimplifier } from '@thirdlight/asset-pipeline';

import { terrainBlobOf } from '../../packages/workspace/src/terrain-edits';
import { splineMadeBlob } from '../../packages/workspace/src/spline-follows';

const ON = process.env['TL_PERF'] === '1';
function record(line: string): void {
  console.log(line);
  const dir = join(process.env['TL_PERF_ROOT'] ?? join(homedir(), '.cache', 'thirdlight-perf'));
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'splines.jsonl'), `${new Date().toISOString()} ${line}\n`);
}
const ms = (t0: number): number => Math.round((performance.now() - t0) * 100) / 100;

const RULES: SurfaceRule[] = [
  { layer: 1, slope: { min: 25, fade: 8 } },
  { layer: 2, height: { min: 60, fade: 10 } },
  { layer: 3, cavity: { min: 0.5, fade: 0.5, radius: 4 } },
  { layer: 2, noise: { scale: 40, seed: 2, min: 0.4, fade: 0.2 }, strength: 0.6 },
];
const SCATTER: ScatterRule[] = [
  { id: 'trees', asset: { assetId: 'kit' }, density: 0.0012, spacing: 10, slope: { max: 22, fade: 6 }, noise: { scale: 75, seed: 3, min: 0.35, fade: 0.15 } },
  { id: 'pines', asset: { assetId: 'kit' }, density: 0.0008, spacing: 10, height: { min: 10, fade: 5 }, slope: { max: 30, fade: 5 } },
  { id: 'rocks', asset: { assetId: 'kit' }, density: 0.0005, spacing: 6, align: 0.5, slope: { min: 15, fade: 5 } },
];
const RANGE: [number, number] = [-64, 192];
const N = 4;
const GROUND = 'ground-1';

type Blobs = { tiles: Map<string, TerrainTile>; cells: Map<string, ScatterCell> };
let serial = 1;
const name = (): string => (serial++).toString(16).padStart(64, '0');

function hills(tx: number, tz: number): TerrainTile {
  const t = flatTerrainTile(257, terrainFlatStep(RANGE));
  const step = 65535 / 256;
  for (let z = 0; z < 257; z++)
    for (let x = 0; x < 257; x++) {
      const gx = tx * 256 + x;
      const gz = tz * 256 + z;
      t.heights[z * 257 + x] = Math.round((64 + 20 * Math.sin(gx / 13) * Math.cos(gz / 17) + 6 * Math.sin(gx / 3.1 + gz / 4.3)) * step);
    }
  return t;
}

function scene(comp: TerrainComponent, road: SplineComponent | null): SceneV4 {
  const entities: unknown[] = [{ id: GROUND, name: 'Ground', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, terrain: comp } }];
  if (road !== null) entities.push({ id: 'road-1', name: 'Road', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, spline: road } });
  return { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities } as unknown as SceneV4;
}

describe.skipIf(!ON)('spline re-bake costs', () => {
  it('a 1 km road added, a point moved 5 m, the road removed', () => {
    const blobs: Blobs = { tiles: new Map(), cells: new Map() };
    const tiles = [];
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      const d = name();
      blobs.tiles.set(d, hills(x, z));
      tiles.push({ x, z, data: d });
    }
    let comp: TerrainComponent = { tileSamples: 257, spacing: 2, heightRange: RANGE, tiles, rules: RULES, scatter: SCATTER };
    const read = (d: string) => ({ ok: true as const, tile: blobs.tiles.get(d)! });
    const readCell = (d: string) => ({ ok: true as const, cell: blobs.cells.get(d)! });
    // The rules and scatter baked first (as the class's terrain is).
    const bake = planTerrainEdit(scene(comp, null), undefined, { entityId: GROUND, kind: 'bake', rules: RULES, scatter: SCATTER }, read, undefined, readCell);
    if (!bake.ok) throw new Error(JSON.stringify(bake.error));
    const apply = (plan: { tiles: Map<string, TerrainTile>; bases: Map<string, TerrainTile | null>; scatter: Map<string, ScatterCell | null> }): number => {
      const t0 = performance.now();
      comp = {
        ...comp,
        tiles: comp.tiles.map((t) => {
          const key = `${t.x},${t.z}`;
          const out = { ...t };
          const tile = plan.tiles.get(key);
          if (tile !== undefined) {
            const blob = terrainBlobOf(tile);
            blobs.tiles.set((out.data = blob.digest), tile);
          }
          if (plan.bases.has(key)) {
            const b = plan.bases.get(key)!;
            if (b === null) delete out.base;
            else {
              const blob = terrainBlobOf(b);
              blobs.tiles.set((out.base = blob.digest), b);
            }
          }
          if (plan.scatter.has(key)) {
            const c = plan.scatter.get(key)!;
            if (c === null) delete out.scatter;
            else blobs.cells.set((out.scatter = name()), c);
          }
          return out;
        }),
      };
      return ms(t0);
    };
    apply({ tiles: bake.plan.tiles, bases: new Map(), scatter: bake.plan.scatter });

    // A winding road about 1 km long across the terrain.
    const points: SplineComponent['points'] = [];
    for (let k = 0; k <= 10; k++) points.push({ at: [300 + k * 90, 140, 900 + 120 * Math.sin(k / 1.7)] });
    const road: SplineComponent = { points, width: 8, terrain: { falloff: 6, offset: 0.1, paint: { layer: 1, falloff: 2 } }, scatter: { margin: 1 } };
    const length = SplineCurve.of(road, [0, 0, 0]).length;
    const step = (label: string, before: SceneV4, after: SceneV4): void => {
      const t0 = performance.now();
      const rects = splineRebakeRects(before, after).get(GROUND) ?? [];
      const planned = planTerrainSplineRebake(after, GROUND, rects, read, readCell);
      if (!planned.ok || planned.plan === null) throw new Error(`${label}: nothing planned`);
      const planMs = ms(t0);
      const encodeMs = apply(planned.plan);
      record(`spline re-bake: ${label} (${Math.round(length)} m road, ${rects.length} boxes): plan ${planMs} ms (heights, rules + paint, scatter), encode + gzip ${encodeMs} ms, ${planned.plan.tiles.size} tiles, ${planned.plan.bases.size} hand-made forms, ${planned.plan.scatter.size} scatter tiles; total ${Math.round((planMs + encodeMs) * 100) / 100} ms`);
      expect(planned.plan.tiles.size).toBeGreaterThan(0);
    };
    const s0 = scene(comp, null);
    const s1 = scene(comp, road);
    step('added', s0, s1);
    const moved = { ...road, points: road.points.map((p, i) => (i === 5 ? { at: [p.at[0], p.at[1], p.at[2] + 5] as [number, number, number] } : p)) };
    step('a point moved 5 m', scene(comp, road), scene(comp, moved));
    step('removed', scene(comp, moved), scene(comp, null));
  }, 300_000);

  it('the meshes made along a 1 km road and a 1 km river, with their levels', async () => {
    const simplifier = await loadMeshSimplifier();
    const core = { content: { meshSimplifier: { current: simplifier } } } as unknown as Parameters<typeof splineMadeBlob>[0];
    const points: SplineComponent['points'] = [];
    for (let k = 0; k <= 10; k++) points.push({ at: [k * 90, 3 * Math.sin(k / 2), 120 * Math.sin(k / 1.7)] });
    for (const [label, c] of [
      ['road', { points, width: 8, mesh: { tiling: 8 } }],
      ['river', { points, width: 14, mesh: { kind: 'water' as const, offset: -0.4, tiling: 14 } }],
    ] as const) {
      const t0 = performance.now();
      const blob = splineMadeBlob(core, c as SplineComponent);
      const totalMs = ms(t0);
      const made = decodeSplineMade(blob.bytes);
      const tris = [0, 1, 2, 3].map((l) => made.pieces.reduce((a, p) => a + (p.levels[l]?.indices.length ?? 0) / 3, 0));
      record(`spline mesh: ${label} ${Math.round(SplineCurve.of(c as SplineComponent, [0, 0, 0]).length)} m: made, simplified and encoded in ${totalMs} ms; ${made.pieces.length} pieces; triangles per level ${tris.join(' / ')}; blob ${Math.round(blob.bytes.length / 1024)} KB`);
      expect(tris[1]).toBeLessThan(tris[0]!);
    }
  }, 120_000);
});
