/**
 * Opt-in (TL_PERF=1): rule scatter's costs, without a browser.
 *
 *   TL_PERF=1 npx vitest run tests/perf/scatter.test.ts
 *
 * - Baking (the backend's side): a 257² tile at 2 m (512 m square) of rolling hills with the landscape class's
 *   three tree and rock rules, whole, and the part a 16 m raise bakes again (as dense as the class, and 16 times).
 * - Drawing (the page's main thread): a 2,048 m group's instance sets built from its stored copies (what an
 *   edit's re-bake costs a frame), a ground cover square made (the worker's share) and built.
 * The numbers go to ~/.cache/thirdlight-perf/scatter.jsonl and the phase plan's progress table.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { TerrainField, bakeTerrainScatter, flatTerrainTile, scatterCellCopies, scatterReach, terrainFlatStep, terrainScatterSurface, terrainTileKey, type ScatterCell, type ScatterRule, type TerrainComponent, type TerrainTile } from '@thirdlight/project-model';

import { buildInstanceSet } from '../../packages/three-adapter/src/instancing';
import { CoverGenerator } from '../../packages/three-adapter/src/cover-worker';
import type { ModelInstance } from '../../packages/three-adapter/src/visual';

const ON = process.env['TL_PERF'] === '1';
function record(line: string): void {
  console.log(line);
  const dir = join(process.env['TL_PERF_ROOT'] ?? join(homedir(), '.cache', 'thirdlight-perf'));
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'scatter.jsonl'), `${new Date().toISOString()} ${line}\n`);
}
const ms = (t0: number): number => Math.round((performance.now() - t0) * 100) / 100;

/** Three rules as the landscape class's (trees in clumps on gentle ground, pines up high, rocks on steep parts), `dense` times as dense. */
const rules = (dense: number): ScatterRule[] => [
  { id: 'trees', asset: { assetId: 'kit' }, density: 0.0012 * dense, spacing: 10 / Math.sqrt(dense), slope: { max: 22, fade: 6 }, noise: { scale: 75, seed: 3, min: 0.35, fade: 0.15 } },
  { id: 'pines', asset: { assetId: 'kit' }, density: 0.0008 * dense, spacing: 10 / Math.sqrt(dense), height: { min: 10, fade: 5 }, slope: { max: 30, fade: 5 } },
  { id: 'rocks', asset: { assetId: 'kit' }, density: 0.0005 * dense, spacing: 6 / Math.sqrt(dense), align: 0.5, slope: { min: 15, fade: 5 } },
];
const COMP: TerrainComponent = { tileSamples: 257, spacing: 2, heightRange: [-64, 192], tiles: [{ x: 0, z: 0 }] };

function hills(): TerrainTile {
  const t = flatTerrainTile(257, terrainFlatStep(COMP.heightRange));
  const step = 65535 / 256;
  for (let z = 0; z < 257; z++) for (let x = 0; x < 257; x++) t.heights[z * 257 + x] = Math.round((64 + 20 * Math.sin(x / 13) * Math.cos(z / 17) + 6 * Math.sin(x / 3.1 + z / 4.3)) * step);
  return t;
}

/** A model of three LOD levels (a lathe-like box each). */
function kit(): ModelInstance {
  const root = new THREE.Group();
  const lod = new THREE.LOD();
  for (const [i, d] of [[0, 0], [1, 60], [2, 200]] as const) lod.addLevel(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.4, 1, 12 >> i), new THREE.MeshBasicMaterial()), d);
  root.add(lod);
  return { glbRoot: root } as unknown as ModelInstance;
}

describe.skipIf(!ON)('rule scatter costs', () => {
  for (const dense of [1, 16]) it(`bakes a tile whole and the part a raise moves; builds a group (density ×${dense})`, () => {
    const RULES = rules(dense);
    const tile = hills();
    const tiles = new Map([[terrainTileKey(0, 0), tile]]);
    const field = new TerrainField(COMP, [0, 0, 0], tiles);
    const surface = terrainScatterSurface(field);
    let t0 = performance.now();
    const whole = bakeTerrainScatter(RULES, surface, [0, 0, 0], 512, [[0, 0]], new Map(), null);
    const wholeMs = ms(t0);
    const cell = whole.cells.get('0,0')! as ScatterCell;
    const copies = scatterCellCopies(cell);
    expect(copies).toBeGreaterThan(100);
    // A 16 m raise at the middle: the rectangle it bakes again (its reach grown by the rules').
    const reach = scatterReach(RULES) + 4;
    t0 = performance.now();
    bakeTerrainScatter(RULES, surface, [0, 0, 0], 512, [[0, 0]], new Map([['0,0', cell]]), [256 - 16 - reach, 256 - 16 - reach, 256 + 16 + reach, 256 + 16 + reach]);
    const partMs = ms(t0);
    record(`scatter bake (density ×${dense}) 257² tile at 2 m (512 m), 3 rules: whole ${wholeMs} ms (${copies} copies, ${whole.looked} candidates), a 16 m raise's rectangle ${partMs} ms`);

    // A 2,048 m group of the landscape class holds about 16 such tiles' copies per rule: built as one instance set each.
    const template = kit();
    const perRule = (id: string): Float32Array => cell.get(id)!.copies;
    const times: number[] = [];
    let n = 0;
    for (const r of RULES) {
      const one = perRule(r.id);
      const k = one.length / 10;
      const big = new Float32Array(k * 16 * 10);
      for (let i = 0; i < 16; i++) {
        big.set(one, i * one.length);
        for (let c = 0; c < k; c++) {
          big[(i * k + c) * 10] = big[(i * k + c) * 10]! + (i % 4) * 512;
          big[(i * k + c) * 10 + 2] = big[(i * k + c) * 10 + 2]! + Math.floor(i / 4) * 512;
        }
      }
      // Warm (the page has built sets before: its code is compiled by then).
      buildInstanceSet(template, big, k * 16, 'perf', { chunkSize: 2048, copiesPerChunk: 1 << 20, density: { start: 0.02, end: 0.005, min: 0.25 }, lodPerCopy: true }).dispose();
      t0 = performance.now();
      const set = buildInstanceSet(template, big, k * 16, 'perf', { chunkSize: 2048, copiesPerChunk: 1 << 20, density: { start: 0.02, end: 0.005, min: 0.25 }, lodPerCopy: true });
      times.push(ms(t0));
      n += k * 16;
      set.dispose();
    }
    record(`scatter group build (density ×${dense}; 2,048 m, 3 rules, ${n} copies): ${times.join(' + ')} ms`);
  });

  it('makes and builds a ground cover square', () => {
    const tile = hills();
    const template = kit();
    // Ground cover: a 32 m square of grass at 2 per m² made by the generator (the worker's share), then built on the page.
    const gen = new CoverGenerator();
    const grass: ScatterRule = { id: 'grass', asset: { assetId: 'kit' }, density: 2, align: 0.7, slope: { max: 30, fade: 5 }, cover: true };
    gen.apply({ t: 'coverTile', digest: 'd', tile });
    gen.apply({ t: 'coverSource', id: 't', source: { kind: 'terrain', component: { ...COMP, tiles: [{ x: 0, z: 0, data: 'd' }] }, origin: [0, 0, 0], rules: [grass] } });
    gen.make('t', [0, 0, 32, 32]);
    buildInstanceSet(template, gen.make('t', [32, 32, 64, 64])[0]!.copies, 100, 'warm', { chunkSize: 32 }).dispose();
    let t0 = performance.now();
    const made = gen.make('t', [64, 64, 96, 96]);
    const makeMs = ms(t0);
    const m = made[0]!;
    t0 = performance.now();
    const coverSet = buildInstanceSet(template, m.copies, m.copies.length / 10, 'cover', { chunkSize: 32, densityDistance: { start: 24, end: 40, min: 0 }, lodPerCopy: true });
    const buildMs = ms(t0);
    coverSet.dispose();
    record(`ground cover 32 m square at 2/m²: ${m.copies.length / 10} copies, made in ${makeMs} ms (worker), built in ${buildMs} ms (page)`);
  });
});
