/**
 * The surface fields on real ground (the cached town and hills): a chunk
 * column's block form through a real worker against the same job run in
 * this thread, byte for byte, at level 0 and on the far cache's 2 m nodes;
 * the 2 m result against the 0.5 m result of the same ground within the
 * tolerances stated here, field by field, with what cannot agree named;
 * and what the block form costs a chunk column (reported, never asserted).
 */
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import {
  chunkGrid,
  chunkOfKey,
  createWorldStore,
  encodeDenseChunk,
  farGroundFields,
  MipTree,
  isBodyRole,
  SHAPE_FULL,
  SURFACE_DISTANCE_CAP_M,
  SURFACE_FIELD_NAMES,
  SURFACE_NO_ROW,
  surfaceFieldsInputOf,
  surfaceFieldsNow,
  VOXEL_ROLE,
  WorkerPool,
  type FarGroundFieldsInput,
  type PaletteStore,
  type SurfaceFieldColumns,
} from '@thirdlight/voxel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundleWorker, nodePoolWorker, REPO } from './stream-node';
import { townWorld } from './town';
import { loadAreaCached } from './world-cache';
import { hillyWorld } from './worlds';

const grid = chunkGrid(32);
const E = grid.edge;
const CAP = SURFACE_DISTANCE_CAP_M;
const MIST = 40;

interface World {
  readonly name: string;
  readonly store: PaletteStore;
  /** The chunk columns loaded (inclusive) and the rows that hold anything. */
  readonly c0: number;
  readonly c1: number;
  readonly cy0: number;
  readonly cy1: number;
}

function rowsOf(store: PaletteStore): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  const c = { cx: 0, cy: 0, cz: 0 };
  for (const k of store.chunkKeys()) {
    chunkOfKey(grid, k, c);
    lo = Math.min(lo, c.cy);
    hi = Math.max(hi, c.cy);
  }
  return [lo, hi];
}

/** Where the hills are made wet (cells; a square of 16 m inside the compared ground), and the side of the square mist is laid on. */
const WET = { x: 800, z: 880, side: 32 };
const FOG_SIDE = 32;

/** Wet ground over one square (the surface cell and the two under it) and two cells of mist lying on another. */
function paint(store: PaletteStore): void {
  const v = { material: 0, role: 0, shape: 0, wetness: 0 };
  const top = (x: number, z: number): number => {
    for (let y = 300; y > -200; y--) if (isBodyRole(store.voxelAt(x, y, z, v).role) && v.material !== 0) return y;
    throw new Error(`no ground at ${x},${z}`);
  };
  for (let x = WET.x; x < WET.x + WET.side; x++) for (let z = WET.z; z < WET.z + WET.side; z++) {
    const y = top(x, z);
    for (let k = 0; k < 3; k++) {
      store.voxelAt(x, y - k, z, v);
      store.setVoxel(x, y - k, z, { ...v, wetness: 5 });
    }
  }
  // The first square of dry ground (no water over any of its columns) of the compared chunks, on the 2 m columns' lines.
  const dry = (x0: number, z0: number): boolean => {
    for (let x = x0; x < x0 + FOG_SIDE; x++) for (let z = z0; z < z0 + FOG_SIDE; z++) if (store.voxelAt(x, top(x, z) + 1, z, v).material !== 0) return false;
    return true;
  };
  for (let x0 = 736; x0 <= 896; x0 += 32) for (let z0 = 736; z0 <= 896; z0 += 32) {
    if ((x0 === WET.x && z0 === WET.z) || !dry(x0, z0)) continue;
    for (let x = x0; x < x0 + FOG_SIDE; x++) for (let z = z0; z < z0 + FOG_SIDE; z++) {
      const y = top(x, z);
      for (let k = 1; k <= 2; k++) store.setVoxel(x, y + k, z, { material: MIST, role: VOXEL_ROLE.gas, shape: SHAPE_FULL, wetness: 0 });
    }
    return;
  }
  throw new Error('no dry square for the mist');
}

let worlds: World[] = [];
let workerFile = '';
let pool: WorkerPool;
let jobId = 0;

beforeAll(async () => {
  const town = createWorldStore(grid);
  loadAreaCached(townWorld().grids[0]!, town, 0, 0, 256, 256);
  const hills = createWorldStore(grid);
  // A lake's shore and the slopes over it.
  loadAreaCached(hillyWorld().grids[0]!, hills, 704, 704, 960, 960);
  paint(hills);
  const [t0, t1] = rowsOf(town);
  const [h0, h1] = rowsOf(hills);
  worlds = [
    { name: 'town', store: town, c0: 0, c1: 7, cy0: t0, cy1: t1 },
    { name: 'hills', store: hills, c0: 22, c1: 29, cy0: h0, cy1: h1 },
  ];
  workerFile = await bundleWorker('stream-worker-node', join(REPO, 'dist', 'voxel-bench', `surface-fields-worker-${process.pid}.mjs`));
  pool = new WorkerPool({ size: 1, create: () => nodePoolWorker(workerFile), timeoutMs: 20_000, maxQueued: 64 });
}, 240_000);

afterAll(() => {
  pool?.close();
  if (workerFile !== '') rmSync(workerFile, { force: true });
});

/** A level-0 chunk column's fields, in this thread. */
const fine = (w: World, cx: number, cz: number): SurfaceFieldColumns => surfaceFieldsNow(surfaceFieldsInputOf(w.store, cx, cz, w.cy0, w.cy1).input);

/** A level-2 node column's job input: the node column and the eight round it, as the far cache stores them (raw codec bytes). */
function farInput(store: PaletteStore, nx: number, nz: number, cy0: number, cy1: number): FarGroundFieldsInput {
  const tree = new MipTree(store);
  const nodes: Array<FarGroundFieldsInput['nodes'][number]> = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let ny = cy0 >> 2; ny <= cy1 >> 2; ny++) {
    const cells = tree.node({ level: 2, nx: nx + dx, ny, nz: nz + dz });
    const bytes = cells === null ? null : encodeDenseChunk(grid, cells);
    if (bytes !== null) nodes.push({ dx, dz, ny, bytes: { stored: bytes, raw: true } });
  }
  return { edge: E, level: 2, nx, nz, nodes };
}

const WORKER_MS: number[] = [];
const round = (v: number): number => Math.round(v * 1000) / 1000;

function sameBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

describe('surface fields: page and worker alike', () => {
  it('gives the same bytes from a real worker as from the same job in this thread, a chunk column of each world at level 0 and its 2 m nodes', { timeout: 120_000 }, async () => {
    for (const w of worlds) {
      // Each column twice: the worker's first jobs are its code's first run.
      for (const [cx, cz] of [[w.c0 + 1, w.c0 + 1], [w.c0 + 2, w.c0 + 1], [w.c0 + 1, w.c0 + 1], [w.c0 + 2, w.c0 + 1]] as const) {
        const here = fine(w, cx, cz);
        const { input, transfer } = surfaceFieldsInputOf(w.store, cx, cz, w.cy0, w.cy1);
        const o = await pool.submit<SurfaceFieldColumns>({ id: ++jobId, kind: 'surface-fields', lane: 'edit', distance: 0, input, transfer });
        expect(o.status, `${w.name} ${cx},${cz}`).toBe('done');
        if (o.status !== 'done') continue;
        WORKER_MS.push(o.workerUs / 1000);
        expect([o.output.x, o.output.z, o.output.w, o.output.d, o.output.cellM]).toEqual([cx * E, cz * E, E, E, 0.5]);
        for (const name of SURFACE_FIELD_NAMES) expect(sameBytes(o.output[name], here[name]), `${w.name} ${cx},${cz} ${name}`).toBe(true);
        // The column holds ground: the comparison is not of empty arrays.
        expect(here.row.filter((r) => r !== SURFACE_NO_ROW).length).toBe(E * E);
      }
      // With a structure's stamp over part of the column (every cell of a 4 × 4 square of columns of its chunks): no
      // surface there, construction beside it, and the same bytes from the worker.
      const [sx, sz] = [w.c0 + 1, w.c0 + 1];
      const stamp = new Uint8Array(grid.cellsPerChunk);
      for (let x = 8; x < 12; x++) for (let z = 8; z < 12; z++) stamp.fill(1, (x * E + z) * E, (x * E + z + 1) * E);
      const builtOf = (cx: number, _cy: number, cz: number): Uint8Array | null => (cx === sx && cz === sz ? stamp : null);
      const stamped = surfaceFieldsNow(surfaceFieldsInputOf(w.store, sx, sz, w.cy0, w.cy1, builtOf).input);
      const sent = surfaceFieldsInputOf(w.store, sx, sz, w.cy0, w.cy1, builtOf);
      const so = await pool.submit<SurfaceFieldColumns>({ id: ++jobId, kind: 'surface-fields', lane: 'edit', distance: 0, input: sent.input, transfer: sent.transfer });
      expect(so.status, `${w.name} stamped`).toBe('done');
      if (so.status === 'done') for (const name of SURFACE_FIELD_NAMES) expect(sameBytes(so.output[name], stamped[name]), `${w.name} stamped ${name}`).toBe(true);
      expect(stamped.row[9 * E + 9]).toBe(SURFACE_NO_ROW);
      expect(stamped.construction[9 * E + 7]).toBe(0.5);
      // Six columns from the stamp: 3 m, unless something of the town's own stands nearer.
      if (w.name === 'hills') expect(stamped.construction[9 * E + 2]).toBe(3);
      else expect(stamped.construction[9 * E + 2]).toBeLessThanOrEqual(3);
      expect(stamp.every((v, i) => v === (((i / E / E) | 0) >= 8 && ((i / E / E) | 0) < 12 && ((i / E) | 0) % E >= 8 && ((i / E) | 0) % E < 12 ? 1 : 0)), 'the stamp sent is a copy').toBe(true);
      const nx = w.c0 >> 2;
      const input = farInput(w.store, nx, nx, w.cy0, w.cy1);
      const here = farGroundFields(input, (b) => b);
      const o = await pool.submit<SurfaceFieldColumns>({ id: ++jobId, kind: 'far-ground-fields', lane: 'edit', distance: 0, input, transfer: [] });
      expect(o.status, `${w.name} far`).toBe('done');
      if (o.status !== 'done') continue;
      expect(o.output.cellM).toBe(2);
      for (const name of SURFACE_FIELD_NAMES) expect(sameBytes(o.output[name], here[name]), `${w.name} far ${name}`).toBe(true);
      expect(here.row.filter((r) => r !== SURFACE_NO_ROW).length).toBeGreaterThan(200);
    }
    process.stderr.write(`surface fields bench: in a worker, two chunk columns twice over (the town's, then the hills'), ms a column ${WORKER_MS.map(round).join(', ')}\n`);
  });
});

/** The 0.5 m fields over the middle chunk columns of a world, as one square of columns (index `x · side + z` from the square's corner). */
function fineSquare(w: World): { x0: number; side: number; f: Record<string, Float64Array> } {
  const cols = Array.from({ length: w.c1 - w.c0 - 1 }, (_, i) => w.c0 + 1 + i);
  const side = cols.length * E;
  const f: Record<string, Float64Array> = {};
  for (const name of SURFACE_FIELD_NAMES) f[name] = new Float64Array(side * side);
  cols.forEach((cx, i) => cols.forEach((cz, k) => {
    const t = performance.now();
    const c = fine(w, cx, cz);
    BENCH.push(performance.now() - t);
    for (const name of SURFACE_FIELD_NAMES) for (let x = 0; x < E; x++) for (let z = 0; z < E; z++) f[name]![(i * E + x) * side + k * E + z] = c[name][x * E + z]!;
  }));
  return { x0: cols[0]! * E, side, f };
}

const BENCH: number[] = [];
const quantile = (a: number[], q: number): number => (a.length === 0 ? Number.NaN : [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))]!);
const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;

/**
 * The tolerances the 2 m result is held to against the 0.5 m result of the
 * same ground, a field. A 2 m column stands over 4 × 4 columns of 0.5 m.
 * Compared on **ground** (all sixteen surfaces terrain, and the 2 m one):
 * where anything built stands the two scales name different surfaces (a
 * roof against the ground beside it), and thin construction (a fence, a
 * post) is not in a 2 m cell at all.
 */
const TOLERANCE = {
  /** Height (m) against the mean of the sixteen: a quarter of a metre. */
  height: 0.25,
  /** Slope (degrees) against the mean of the sixteen: in 95 of 100 columns, and in every one (a 2 m cell beside a pit or a bank reads it filled or cut). */
  slope: 5,
  slopeWorst: 10,
  /** Wetness (levels of 7) against the mean of the sixteen. */
  wetness: 1,
  /** The share of columns whose material is one of the sixteen's (a 2 m cell takes the material most of its 64 cells hold, which may be what lies under a thin top layer). */
  material: 0.95,
  /** Water depth and top (m) against the means, where all sixteen columns hold water and the 2 m column kept it. */
  water: 0.25,
  /**
   * Distance to another material (m) against the mean of the sixteen, and to construction against the nearest of the
   * sixteen: the 2 m result is never nearer by more than a 2 m cell's diagonal. It may be farther by any amount where
   * what is near is narrower than a 2 m cell (a kerb, a fence, a post: not in the 2 m data); where materials lie in
   * wide areas (the hills) the material distance is within the diagonal both ways.
   */
  distance: 2 * Math.SQRT2,
};

describe('surface fields: the 2 m result against the 0.5 m result of the same ground', () => {
  it('agrees within the stated tolerance a field on the town and the hills, and loses what a 2 m cell cannot hold', { timeout: 240_000 }, () => {
    const report: Record<string, unknown> = {};
    for (const w of worlds) {
      const sq = fineSquare(w);
      const far = new Map<string, SurfaceFieldColumns>();
      const farOf = (nx: number, nz: number): SurfaceFieldColumns => {
        const key = `${nx},${nz}`;
        let c = far.get(key);
        if (c === undefined) far.set(key, (c = farGroundFields(farInput(w.store, nx, nz, w.cy0, w.cy1), (b) => b)));
        return c;
      };
      const n = sq.side / 4;
      const d: Record<string, number[]> = { height: [], slope: [], wetness: [], waterDepth: [], waterTop: [], gasBottom: [], gasTop: [], gasDensity: [], materialEdge: [], construction: [] };
      const count = { columns: 0, ground: 0, material: 0, sky: 0, skyAgreed: 0, wet: 0, waterDeep: 0, waterDeepKept: 0, waterShallow: 0, waterShallowKept: 0, waterPart: 0, waterPartKept: 0, gasOnGround: 0, gasOnGroundKept: 0, builtNear: 0, builtNearBoth: 0 };
      for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) {
        const gx = (sq.x0 >> 2) + i;
        const gz = (sq.x0 >> 2) + k;
        const c = farOf(gx >> 5, gz >> 5);
        const j = (gx & 31) * E + (gz & 31);
        const at = (name: string): number[] => {
          const out: number[] = [];
          for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) out.push(sq.f[name]![(i * 4 + x) * sq.side + k * 4 + z]!);
          return out;
        };
        const where = `${w.name} 2 m column ${gx},${gz}`;
        expect(c.row[j], where).not.toBe(SURFACE_NO_ROW);
        count.columns++;
        const roles = at('role');
        const skies = at('sky');
        if (skies.every((v) => v === skies[0])) {
          count.skyAgreed++;
          if (c.sky[j] === skies[0]) count.sky++;
        }
        // Construction: never nearer at 2 m than the nearest of the sixteen by more than the tolerance.
        const builtNear = Math.min(...at('construction'));
        d.construction!.push(builtNear - c.construction[j]!);
        if (builtNear < CAP) {
          count.builtNear++;
          if (c.construction[j]! < CAP) count.builtNearBoth++;
        }
        // Water: kept where every column under the 2 m one holds a 2 m cell of it; lost or kept elsewhere.
        const depths = at('waterDepth');
        const wet = depths.filter((v) => v > 0).length;
        const kept = c.waterDepth[j]! > 0;
        if (wet === 16 && Math.min(...depths) >= 2) {
          count.waterDeep++;
          if (kept) {
            count.waterDeepKept++;
            d.waterDepth!.push(c.waterDepth[j]! - mean(depths));
            d.waterTop!.push(c.waterTop[j]! - mean(at('waterTop')));
            expect(at('waterMaterial').includes(c.waterMaterial[j]!), `${where} water material`).toBe(true);
          }
        } else if (wet === 16) {
          count.waterShallow++;
          if (kept) {
            count.waterShallowKept++;
            d.waterDepth!.push(c.waterDepth[j]! - mean(depths));
            d.waterTop!.push(c.waterTop[j]! - mean(at('waterTop')));
          }
        } else if (wet > 0) {
          count.waterPart++;
          if (kept) count.waterPartKept++;
        } else expect(kept, `${where}: water at 2 m over dry ground`).toBe(false);
        // Gas lying on the ground.
        const gases = at('gasMaterial');
        if (gases.every((g) => g === MIST) && at('gasBottom').every((b, q) => Math.abs(b - at('height')[q]!) < 0.5)) {
          count.gasOnGround++;
          if (c.gasMaterial[j] !== 0) {
            count.gasOnGroundKept++;
            d.gasBottom!.push(c.gasBottom[j]! - mean(at('gasBottom')));
            d.gasTop!.push(c.gasTop[j]! - mean(at('gasTop')));
            d.gasDensity!.push(c.gasDensity[j]! - mean(at('gasDensity')));
          }
        }
        if (!roles.every((r) => r === VOXEL_ROLE.terrain) || c.role[j] !== VOXEL_ROLE.terrain) continue;
        count.ground++;
        if (at('wetness').some((v) => v > 0)) count.wet++;
        d.height!.push(c.height[j]! - mean(at('height')));
        d.slope!.push(c.slope[j]! - mean(at('slope')));
        d.wetness!.push(c.wetness[j]! - mean(at('wetness')));
        d.materialEdge!.push(c.materialEdge[j]! - mean(at('materialEdge')));
        if (at('material').includes(c.material[j]!)) count.material++;
      }
      const stat = (a: number[]): Record<string, number> => ({ n: a.length, min: round(Math.min(...a)), p05: round(quantile(a, 0.05)), p50: round(quantile(a, 0.5)), p95: round(quantile(a, 0.95)), max: round(Math.max(...a)) });
      report[w.name] = { ...count, ...Object.fromEntries(Object.entries(d).map(([k2, a]) => [k2, stat(a)])) };
      const worst = (a: number[]): number => Math.max(0, ...a.map(Math.abs));
      expect(count.ground, `${w.name}: ground columns compared`).toBeGreaterThan(1000);
      expect(worst(d.height!), `${w.name} height`).toBeLessThanOrEqual(TOLERANCE.height);
      expect(quantile(d.slope!.map(Math.abs), 0.95), `${w.name} slope, 95 of 100`).toBeLessThanOrEqual(TOLERANCE.slope);
      expect(worst(d.slope!), `${w.name} slope`).toBeLessThanOrEqual(TOLERANCE.slopeWorst);
      expect(worst(d.wetness!), `${w.name} wetness`).toBeLessThanOrEqual(TOLERANCE.wetness);
      expect(count.material / count.ground, `${w.name} material`).toBeGreaterThanOrEqual(TOLERANCE.material);
      expect(count.sky, `${w.name} sky`).toBe(count.skyAgreed);
      expect(count.skyAgreed).toBeGreaterThan(2000);
      expect(worst(d.waterDepth!), `${w.name} water depth`).toBeLessThanOrEqual(TOLERANCE.water);
      expect(worst(d.waterTop!), `${w.name} water top`).toBeLessThanOrEqual(TOLERANCE.water);
      expect(Math.min(0, ...d.materialEdge!), `${w.name} material edge, nearer at 2 m`).toBeGreaterThanOrEqual(-TOLERANCE.distance);
      expect(Math.max(0, ...d.construction!), `${w.name} construction, nearer at 2 m`).toBeLessThanOrEqual(TOLERANCE.distance);
      if (w.name === 'hills') {
        // Wide areas of each material: within the diagonal both ways. Wet ground and a lake compared; mist on the ground is not in the 2 m data.
        expect(worst(d.materialEdge!), 'hills material edge').toBeLessThanOrEqual(TOLERANCE.distance);
        expect(d.materialEdge!.filter((v) => v !== 0).length).toBeGreaterThan(100);
        expect(count.wet).toBe((WET.side / 4) ** 2);
        expect(count.waterDeepKept + count.waterShallowKept).toBeGreaterThan(500);
        expect(count.gasOnGround).toBe((FOG_SIDE / 4) ** 2);
        // Mist two cells thick on the ground: in the 2 m data only where its cells fall in a 2 m cell the ground does not
        // hold, thinner there than it is, its bottom and top within a 2 m cell of the 0.5 m ones.
        expect(count.gasOnGroundKept).toBeLessThan(count.gasOnGround);
        expect(worst(d.gasBottom!), 'hills gas bottom').toBeLessThanOrEqual(2);
        expect(worst(d.gasTop!), 'hills gas top').toBeLessThanOrEqual(2);
        expect(Math.max(...d.gasDensity!), 'hills gas density').toBeLessThan(0);
      } else {
        // The town's ponds are three cells deep inside a 2 m cell that holds their bed: every one is ground at 2 m. Its
        // fences and posts are not in the 2 m data: construction near at 0.5 m is missing at 2 m in some columns, never the reverse.
        expect(count.waterShallow).toBeGreaterThan(8);
        expect(count.waterShallowKept + count.waterPartKept).toBe(0);
        expect(count.builtNear).toBeGreaterThan(2000);
        expect(count.builtNearBoth).toBeLessThan(count.builtNear);
        expect(count.builtNearBoth).toBeGreaterThan(count.builtNear * 0.9);
      }
    }
    process.stderr.write(`surface fields bench: ${BENCH.length} chunk columns in this thread, ms a column p50 ${round(quantile(BENCH, 0.5))} p95 ${round(quantile(BENCH, 0.95))} max ${round(Math.max(...BENCH))}\n`);
    process.stderr.write(`surface fields 2 m against 0.5 m: ${JSON.stringify(report)}\n`);
  });
});
