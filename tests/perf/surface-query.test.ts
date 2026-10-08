/**
 * Opt-in (TL_PERF=1): what `ctx.surface` costs the simulation, without a browser.
 *
 *   TL_PERF=1 npx vitest run tests/perf/surface-query.test.ts
 *
 * - The tiles' hand-over: a decoded tile copied to the simulation's worker (structured clone, as `postMessage`
 *   copies it), heights and holes only (collision) against heights, holes, baked weights and hand paint (the surface
 *   query's layers), for 257² and 1,025² tiles; the bytes the worker then holds per tile.
 * - A query: `ctx.surface.at` over a 2 × 2 terrain of 257² tiles with a 100 × 100 block area on it (sloped painted
 *   tops, four material rules incl. a cavity), at random points across the area and the ground round it; and the
 *   first query after a tile arrived (the terrain's field made again).
 *
 * The numbers go to ~/.cache/thirdlight-perf/surface-query.jsonl and the phase plan's progress table.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { BlockGrid, TERRAIN_PAINT_BYTES, TERRAIN_WEIGHT_BYTES, applyBlockEdits, type BlockLayerComponent, type BlockType, type EntityV3, type SurfaceRule, type TerrainComponent } from '@thirdlight/project-model';

import { RuntimeGrid } from '../../packages/runtime/src/grid';

const ON = process.env['TL_PERF'] === '1';
function record(line: string): void {
  console.log(line);
  const dir = join(process.env['TL_PERF_ROOT'] ?? join(homedir(), '.cache', 'thirdlight-perf'));
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'surface-query.jsonl'), `${new Date().toISOString()} ${line}\n`);
}
const round = (v: number): number => Math.round(v * 1000) / 1000;
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

function tileData(digest: string, samples: number, painted: boolean): { digest: string; samples: number; heights: Uint16Array; holes: Uint8Array | null; weights: Uint8Array; paint: Uint8Array | null } {
  const n = samples * samples;
  const heights = new Uint16Array(n);
  const weights = new Uint8Array(n * TERRAIN_WEIGHT_BYTES);
  for (let i = 0; i < n; i++) {
    const x = i % samples;
    const z = Math.floor(i / samples);
    heights[i] = 30000 + Math.round(2000 * Math.sin(x / 17) * Math.cos(z / 23));
    weights[i * TERRAIN_WEIGHT_BYTES] = (x >> 5) % 4;
    weights[i * TERRAIN_WEIGHT_BYTES + 1] = 1;
    weights[i * TERRAIN_WEIGHT_BYTES + 4] = 200;
    weights[i * TERRAIN_WEIGHT_BYTES + 5] = 55;
  }
  return { digest, samples, heights, holes: null, weights, paint: painted ? new Uint8Array(n * TERRAIN_PAINT_BYTES) : null };
}

describe.runIf(ON)('surface query cost', () => {
  it('the tiles handed to the simulation: clone time and bytes with and without the layers', () => {
    for (const samples of [257, 1025]) {
      const t = tileData('t', samples, true);
      const runs = (fn: () => unknown): number => {
        const out: number[] = [];
        for (let k = 0; k < 9; k++) {
          const t0 = performance.now();
          fn();
          out.push(performance.now() - t0);
        }
        return round(median(out));
      };
      const collision = runs(() => structuredClone({ heights: t.heights, holes: t.holes }));
      const weights = runs(() => structuredClone({ heights: t.heights, holes: t.holes, weights: t.weights, paint: null }));
      const all = runs(() => structuredClone({ heights: t.heights, holes: t.holes, weights: t.weights, paint: t.paint }));
      record(JSON.stringify({ case: 'hand-over', samples, cloneMs: { heightsHoles: collision, withWeights: weights, withWeightsAndPaint: all }, bytes: { heights: t.heights.byteLength, weights: t.weights.byteLength, paint: t.paint!.byteLength } }));
    }
  });

  it('ctx.surface.at over a block area on terrain', () => {
    const types: BlockType[] = [{ blockId: 'rock', name: 'Rock', variants: [{ color: '#808080' }], shape: 'full' }];
    const rules: SurfaceRule[] = [
      { layer: 1, slope: { min: 25, fade: 8 } },
      { layer: 2, height: { min: 60, fade: 10 } },
      { layer: 3, cavity: { min: 0.5, fade: 0.5, radius: 4 } },
      { layer: 2, noise: { scale: 40, seed: 2, min: 0.4, fade: 0.2 }, strength: 0.6 },
    ];
    const comp: BlockLayerComponent = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [100, 8, 100] }, rules };
    const g = new BlockGrid(comp);
    const edits: Parameters<typeof applyBlockEdits>[1] = [{ kind: 'fill', box: [0, 0, 0, 100, 2, 100], cell: { block: 'rock' } }];
    for (let x = 0; x < 100; x += 4) edits.push({ kind: 'cells', at: [x, 1, 50], cell: { block: 'rock', corners: [1, 0.5, 0.5, 1] } });
    for (let k = 0; k < 20; k++) edits.push({ kind: 'paint', at: [5 + k * 5, 30], radius: 4, strength: 1, channel: 2 });
    const r = applyBlockEdits(g, edits, { types: new Map(types.map((t) => [t.blockId, t])), stamps: new Map() });
    expect(r.ok).toBe(true);
    const data = g.toData('area', null, g.takeDirty().chunks);
    const terrain: TerrainComponent = { tileSamples: 257, spacing: 1, heightRange: [-32, 96], tiles: [{ x: 0, z: 0, data: 'a' }, { x: 1, z: 0, data: 'b' }, { x: 0, z: 1, data: 'c' }, { x: 1, z: 1, data: 'd' }] };
    const entities = [
      { id: 'ground', components: { transform: { position: [0, 0, 0] }, terrain } },
      { id: 'area', components: { transform: { position: [200, 30, 200] }, blockLayer: { ...comp, data } } },
    ] as unknown as EntityV3[];
    const grid = new RuntimeGrid(types, [], false);
    grid.addLayers(entities);
    grid.addTerrainData(['a', 'b', 'c', 'd'].map((d) => tileData(d, 257, false)));
    const s = grid.surface.api;
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const timeQueries = (n: number, pick: () => [number, number]): { usMedian: number; usMean: number; sources: Record<string, number> } => {
      const times: number[] = [];
      const sources: Record<string, number> = {};
      for (let i = 0; i < n; i++) {
        const [x, z] = pick();
        const t0 = performance.now();
        const a = s.at([x, 200, z]);
        times.push(performance.now() - t0);
        const k = a?.source ?? 'none';
        sources[k] = (sources[k] ?? 0) + 1;
      }
      return { usMedian: round(median(times) * 1000), usMean: round((times.reduce((p, q) => p + q, 0) / n) * 1000), sources };
    };
    timeQueries(500, () => [rnd() * 512, rnd() * 512]);
    const onArea = timeQueries(5000, () => [200 + rnd() * 100, 200 + rnd() * 100]);
    const round_ = timeQueries(5000, () => [rnd() * 512, rnd() * 512]);
    grid.addTerrainData([tileData('a', 257, false)]);
    const t0 = performance.now();
    s.at([10, 200, 10]);
    const afterArrival = round(performance.now() - t0);
    record(JSON.stringify({ case: 'query', onArea, anywhere: round_, firstAfterTileMs: afterArrival, simTerrainBytes: grid.terrain.memory() }));
  });
});
