/**
 * Opt-in (TL_PERF=1): a terrain's edit layers, without a browser.
 *
 *   TL_PERF=1 npx vitest run tests/perf/terrain-layers.test.ts
 *
 * - Combining a tile's heights from its hand-made ones through the stack: four 300 m stamps (128² shapes), an erosion
 *   layer's stored difference, both; 257² and 1,025² tiles at 1 m.
 * - Erosion of a whole 1,025² tile of rolling hills (the rectangle and its margin): hydraulic (0.5 droplets a sample),
 *   thermal (40 passes), both — the backend's worker does this off its event loop.
 * - What the stack keeps per tile beside the drawn one: the hand-made tile's and the erosion difference's blobs
 *   (gzip) and their decoded size.
 * The numbers go to ~/.cache/thirdlight-perf/terrain.jsonl and the phase plan's progress table.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { EROSION_MARGIN_SAMPLES, TerrainLayerStack, TerrainSamples, TerrainSplineLayer, erodeGrid, flatTerrainTile, terrainFlatStep, terrainHeightOf, terrainNoise, terrainTileBytes, terrainTileKey, type ErosionSettings, type Heightmap, type TerrainComponent, type TerrainLayer, type TerrainTile } from '@thirdlight/project-model';

import { terrainBlobOf } from '../../packages/workspace/src/terrain-edits';
import { deltaBlobOf } from '../../packages/workspace/src/terrain-layer-reads';

const ON = process.env['TL_PERF'] === '1';
function record(line: string): void {
  console.log(line);
  const dir = join(process.env['TL_PERF_ROOT'] ?? join(homedir(), '.cache', 'thirdlight-perf'));
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'terrain.jsonl'), `${new Date().toISOString()} ${line}\n`);
}
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const r2 = (v: number): number => Math.round(v * 100) / 100;

const hills = (x: number, z: number): number => 60 * terrainNoise(x / 180, z / 180, 1) + 18 * terrainNoise(x / 45, z / 45, 2) + 4 * terrainNoise(x / 11, z / 11, 3) + 1 * terrainNoise(x / 3, z / 3, 4);
function comp(n: number, layers?: TerrainLayer[]): TerrainComponent {
  return { tileSamples: n, spacing: 1, heightRange: [-200, 600], tiles: [{ x: 0, z: 0 }], ...(layers !== undefined ? { layers } : {}) };
}
function hillTile(n: number): TerrainTile {
  const c = comp(n);
  const s = new TerrainSamples(c, new Map([[terrainTileKey(0, 0), flatTerrainTile(n, terrainFlatStep(c.heightRange))]]));
  const t = s.writable(0, 0)!;
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) t.heights[z * n + x] = s.stepOf(hills(x, z));
  return t;
}
const CONE: Heightmap = (() => {
  const w = 128;
  const samples = new Uint16Array(w * w);
  for (let z = 0; z < w; z++) for (let x = 0; x < w; x++) samples[z * w + x] = Math.round(Math.max(0, 1 - Math.hypot(x - 63.5, z - 63.5) / 63.5) * 65535);
  return { width: w, height: w, samples };
})();

describe.runIf(ON)('terrain edit layers perf', () => {
  it('combining a tile through the stack, eroding a 1,025² tile, the stack\'s bytes per tile', () => {
    const out: Record<string, unknown> = {};
    for (const n of [257, 1025]) {
      const tile = hillTile(n);
      const size = n - 1;
      const stamps: TerrainLayer = { id: 'peaks', kind: 'stamps', stamps: [0.25, 0.75].flatMap((u) => [0.25, 0.75].map((v) => ({ asset: 'cone', at: [u * size, v * size] as [number, number], size: 300, height: 40, rotation: 30 }))) };
      // An erosion difference over the whole tile (what a run over it stores): small steps everywhere.
      const delta = new Int16Array(n * n);
      for (let i = 0; i < delta.length; i++) delta[i] = Math.round(40 * terrainNoise((i % n) / 7, Math.floor(i / n) / 7, 9));
      const erosion: TerrainLayer = { id: 'erosion', kind: 'erosion', tiles: [{ x: 0, z: 0, data: 'd'.repeat(64) }] };
      const sources = { heightmap: () => CONE, delta: () => delta };
      const time = (layers: TerrainLayer[]): number => {
        const c = comp(n, layers);
        const stack = new TerrainLayerStack(c, [0, 0, 0], new TerrainSplineLayer([], c, [0, 0, 0]), sources);
        const xs: number[] = [];
        for (let k = 0; k < 5; k++) {
          const t0 = performance.now();
          const h = stack.heights(0, 0, tile.heights);
          xs.push(performance.now() - t0);
          expect(h).not.toBe(tile.heights);
        }
        return r2(median(xs));
      };
      out[`combine${n}`] = { stamps4: time([stamps]), erosion: time([erosion]), both: time([stamps, erosion]) };
      // The stack's bytes beside the drawn tile.
      const base = terrainBlobOf(tile);
      const d = deltaBlobOf(n, delta);
      out[`bytes${n}`] = { baseBlob: base.bytes.length, baseDecoded: terrainTileBytes(tile), erosionBlob: d.bytes.length, erosionDecoded: delta.byteLength };
    }
    // Erosion of a whole 1,025² tile and its margin.
    const n = 1025 + 2 * EROSION_MARGIN_SAMPLES;
    const grid = (): { cols: number; rows: number; spacing: number; heights: Float64Array; region: [number, number, number, number] } => {
      const heights = new Float64Array(n * n);
      for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) heights[z * n + x] = terrainHeightOf([-200, 600], 0) + hills(x, z);
      return { cols: n, rows: n, spacing: 1, heights, region: [EROSION_MARGIN_SAMPLES, EROSION_MARGIN_SAMPLES, n - 1 - EROSION_MARGIN_SAMPLES, n - 1 - EROSION_MARGIN_SAMPLES] };
    };
    const run = (s: ErosionSettings): number => {
      const g = grid();
      const t0 = performance.now();
      erodeGrid(g, s);
      return Math.round(performance.now() - t0);
    };
    out['erode1025'] = { hydraulic: run({ hydraulic: {} }), thermal: run({ thermal: {} }), both: run({ hydraulic: {}, thermal: {} }) };
    record(`terrain-layers ${JSON.stringify(out)}`);
  }, 600_000);
});
