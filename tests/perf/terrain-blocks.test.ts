/**
 * Opt-in (TL_PERF=1): what a terrain meeting a block area costs the backend when the blocks change, without a
 * browser.
 *
 *   TL_PERF=1 npx vitest run tests/perf/terrain-blocks.test.ts
 *
 * A 2 × 2 terrain of 257² tiles at 1 m (512 m square, rolling hills) with the landscape class's four material rules
 * and three scatter rules, and on it a block area of 100 × 100 columns (two rows of rock, sloped tops rising across
 * it, painted): the re-bake when the blocks layer is added (cut, blend 8 m), then for single block edits — a border
 * column raised a row, a 4 × 4 patch of border columns repainted, a column deep inside raised — as the host plans
 * them (`splineRebakeRects` → `planTerrainSplineRebake`: heights and holes, rules and paint, scatter) and stores them
 * (the changed tiles encoded and gzipped). The numbers go to ~/.cache/thirdlight-perf/terrain-blocks.jsonl and the
 * phase plan's progress table.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { BlockGrid, applyBlockEdits, flatTerrainTile, terrainFlatStep, type BlockLayerComponent, type BlockLayerData, type BlockType, type ScatterCell, type ScatterRule, type SceneV4, type SurfaceRule, type TerrainComponent, type TerrainLayer, type TerrainTile } from '@thirdlight/project-model';
import { planTerrainEdit, planTerrainSplineRebake, splineRebakeRects, type TerrainLayerReads } from '@thirdlight/commands';

import { terrainBlobOf } from '../../packages/workspace/src/terrain-edits';

const ON = process.env['TL_PERF'] === '1';
function record(line: string): void {
  console.log(line);
  const dir = join(process.env['TL_PERF_ROOT'] ?? join(homedir(), '.cache', 'thirdlight-perf'));
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'terrain-blocks.jsonl'), `${new Date().toISOString()} ${line}\n`);
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
const N = 2;
const GROUND = 'ground-1';
const AREA = 'area-1';
/** The block area: 100 × 100 columns of 1 m from (156, 0, 156), across the four tiles' corner. */
const AREA_AT: [number, number, number] = [156, 0, 156];
const SIDE = 100;
const TYPES = new Map<string, BlockType>([['rock', { blockId: 'rock', name: 'Rock', shape: 'full', variants: [{ color: '#808080' }] } as unknown as BlockType]]);
const AREA_COMP: BlockLayerComponent = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [SIDE, 8, SIDE] } };

let serial = 1;
const name = (): string => (serial++).toString(16).padStart(64, '0');

function hills(tx: number, tz: number): TerrainTile {
  const t = flatTerrainTile(257, terrainFlatStep(RANGE));
  const step = 65535 / 256;
  for (let z = 0; z < 257; z++)
    for (let x = 0; x < 257; x++) {
      const gx = tx * 256 + x;
      const gz = tz * 256 + z;
      t.heights[z * 257 + x] = Math.round((66 + 3 * Math.sin(gx / 13) * Math.cos(gz / 17) + 1 * Math.sin(gx / 3.1 + gz / 4.3)) * step);
    }
  return t;
}

/** The area's cells: a rock row under a sloped row whose tops rise 1/16 a cell a column along x (2 m to about 8 m). */
function areaData(): BlockLayerData {
  const g = BlockGrid.from(AREA_COMP, null);
  const edits = [{ kind: 'fill' as const, box: [0, 0, 0, SIDE, 1, SIDE], cell: { block: 'rock' } }];
  const r = applyBlockEdits(g, edits, { types: TYPES, fields: [] } as never);
  if (!r.ok) throw new Error(r.message);
  for (let x = 0; x < SIDE; x++) {
    const c = (k: number): number => Math.min(4, Math.round((1 + k / 16) * 64) / 64);
    applyBlockEdits(g, [{ kind: 'fill', box: [x, 1, 0, x + 1, 2, SIDE], cell: { block: 'rock', corners: [c(x % 48), c((x % 48) + 1), c((x % 48) + 1), c(x % 48)] } }], { types: TYPES, fields: [] } as never);
  }
  applyBlockEdits(g, [{ kind: 'paint', at: [SIDE / 2, SIDE / 2], radius: SIDE, strength: 1, falloff: 'constant', channel: 2 }], { types: TYPES, fields: [] } as never);
  return g.toData(AREA, null, g.takeDirty().chunks)!;
}

function scene(comp: TerrainComponent, data: BlockLayerData): SceneV4 {
  const entities: unknown[] = [
    { id: GROUND, name: 'Ground', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, terrain: comp } },
    { id: AREA, name: 'Area', components: { transform: { position: AREA_AT, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, blockLayer: AREA_COMP } },
  ];
  return { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities, blocks: [data] } as unknown as SceneV4;
}

/** The area's data after more edits (a grid of it, edited, written back). */
function edited(data: BlockLayerData, edits: Parameters<typeof applyBlockEdits>[1]): BlockLayerData {
  const g = BlockGrid.from(AREA_COMP, data);
  const r = applyBlockEdits(g, edits, { types: TYPES, fields: [] } as never);
  if (!r.ok) throw new Error(r.message);
  return g.toData(AREA, data, g.takeDirty().chunks)!;
}

describe.skipIf(!ON)('terrain meeting a block area: re-bake costs', () => {
  it('the blocks layer added, then a block edit at the border, a repaint there, an edit deep inside', () => {
    const tiles: Map<string, TerrainTile> = new Map();
    const cells: Map<string, ScatterCell> = new Map();
    const refs = [];
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      const d = name();
      tiles.set(d, hills(x, z));
      refs.push({ x, z, data: d });
    }
    let comp: TerrainComponent = { tileSamples: 257, spacing: 1, heightRange: RANGE, tiles: refs, rules: RULES, scatter: SCATTER };
    const read = (d: string) => ({ ok: true as const, tile: tiles.get(d)! });
    const readCell = (d: string) => ({ ok: true as const, cell: cells.get(d)! });
    const reads: TerrainLayerReads = { heightmap: () => null, delta: () => ({ ok: false, error: { code: 'blob_missing' } as never }), blockTypes: () => TYPES };
    let data = areaData();
    // The rules and scatter baked first (as the class's terrain is).
    const bake = planTerrainEdit(scene(comp, data), undefined, { entityId: GROUND, kind: 'bake', rules: RULES, scatter: SCATTER }, read, undefined, readCell);
    if (!bake.ok) throw new Error(JSON.stringify(bake.error));
    const apply = (plan: { tiles: Map<string, TerrainTile>; bases: Map<string, TerrainTile | null>; scatter: Map<string, ScatterCell | null> }): number => {
      const t0 = performance.now();
      comp = {
        ...comp,
        tiles: comp.tiles.map((t) => {
          const key = `${t.x},${t.z}`;
          const out = { ...t };
          const tile = plan.tiles.get(key);
          if (tile !== undefined) tiles.set((out.data = terrainBlobOf(tile).digest), tile);
          if (plan.bases.has(key)) {
            const b = plan.bases.get(key)!;
            if (b === null) delete out.base;
            else tiles.set((out.base = terrainBlobOf(b).digest), b);
          }
          if (plan.scatter.has(key)) {
            const c = plan.scatter.get(key)!;
            if (c === null) delete out.scatter;
            else cells.set((out.scatter = name()), c);
          }
          return out;
        }),
      };
      return ms(t0);
    };
    apply({ tiles: bake.plan.tiles, bases: new Map(), scatter: bake.plan.scatter });
    const step = (label: string, before: SceneV4, after: SceneV4): void => {
      const t0 = performance.now();
      const rects = splineRebakeRects(before, after).get(GROUND) ?? [];
      const rectMs = ms(t0);
      const planned = planTerrainSplineRebake(after, GROUND, rects, read, readCell, reads);
      if (!planned.ok) throw new Error(`${label}: ${planned.error.message}`);
      const planMs = ms(t0) - rectMs;
      if (planned.plan === null) {
        // The ground the blocks give the terrain did not move (a column inside raised over corners its neighbours keep).
        record(`terrain blocks re-bake: ${label}: boxes ${rects.length} found in ${rectMs} ms, plan ${Math.round(planMs * 100) / 100} ms, nothing changed`);
        return;
      }
      const encodeMs = apply(planned.plan);
      const area = rects.reduce((a, r) => a + (r[2] - r[0]) * (r[3] - r[1]), 0);
      record(`terrain blocks re-bake: ${label}: boxes ${rects.length} (${Math.round(area)} m²) found in ${rectMs} ms, plan ${Math.round(planMs * 100) / 100} ms (heights + holes, rules + paint, scatter), encode + gzip ${encodeMs} ms, ${planned.plan.tiles.size} tiles, ${planned.plan.bases.size} hand-made forms, ${planned.plan.scatter.size} scatter tiles; total ${Math.round((planMs + rectMs + encodeMs) * 100) / 100} ms`);
      expect(planned.plan.tiles.size).toBeGreaterThan(0);
    };
    const layer: TerrainLayer = { id: 'blocks', kind: 'blocks' };
    step('blocks layer added (100 × 100 m area)', scene(comp, data), scene({ ...comp, layers: [layer] }, data));
    comp = { ...comp, layers: [layer] };
    let next = edited(data, [{ kind: 'cells', at: [40, 2, 0], cell: { block: 'rock' } }]);
    step('a border column raised a row', scene(comp, data), scene(comp, next));
    data = next;
    next = edited(data, [{ kind: 'paint', at: [60, 1], radius: 2, strength: 1, falloff: 'constant', channel: 1 }]);
    step('the border repainted (a 2 m dab)', scene(comp, data), scene(comp, next));
    data = next;
    next = edited(data, [{ kind: 'cells', at: [50, 2, 50], cell: { block: 'rock' } }]);
    step('a column deep inside raised a row', scene(comp, data), scene(comp, next));
  }, 300_000);
});
