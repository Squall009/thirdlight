/**
 * The multi-km mountain test world for the far field: a square of 8 km by
 * default with the bench's dense town (town.ts) at its centre on flat ground,
 * in one of two styles:
 *
 * - `realistic` (the default; far-landscape.ts): eroded massifs to ~1.5 km
 *   with ridgelines, branching valleys and river channels from a drainage
 *   simulation, floodplains, escarpments, crags, outcrops with overhangs,
 *   boulders and scree, a few arches, snow on the high peaks, half-metre
 *   detail at the surface;
 * - `terraced`: the first far world, kept for measurements against it:
 *   ridged noise mountains with regular terraced cliffs, overhangs where the
 *   cliffs are, material by slope and height.
 *
 * Engine-owned test data for measuring the far field, not a product feature
 * and not world generation for games. Every cell is a pure function of the
 * seed, the size and the cell's position, and the world is written one region
 * column (256 m × the world's height) at a time straight to region files,
 * each column holding only its own chunks, so a world of any size is never
 * held in memory; columns are independent, so workers write them side by
 * side. Chunks wholly under the ground are uniform rock entries (12 bytes
 * each), so the cost on disk follows the surface.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fractalNoise01, valueNoise01 } from '@thirdlight/shared';
import {
  chunkGrid,
  chunksPerRegionSide,
  createDenseChunk,
  localIndex,
  packRegionChunk,
  recordValue,
  regionFileName,
  SHAPE_FULL,
  VOXEL_ROLE,
  WORLD_GRID_ID,
  writeRegion,
  type ChunkGrid,
  type DenseChunk,
  type RegionEntry,
  type RegionFootprint,
} from '@thirdlight/voxel';
import { gridFolder, pickStore, VOXEL_WORLDS_FOLDER, writeVoxelWorldManifest, zstdCompress } from '@thirdlight/workspace';
import { TEST_WORLD_ID } from './test-world-id';
import { townWorld } from './town';
import { CoarseField, MAT, fillGroundColumn, shapeByte, smoothstep, type GroundColumn } from './world-kit';
import { FLAT_RADIUS, RISEN_RADIUS } from './far-drainage';
import { FarLandscape, LANDSCAPE_BASE } from './far-landscape';

/** The far world's folder name in a project. */
export const FAR_WORLD_NAME = 'far';
/** Its default side in km (the world is the next whole number of 512 m region pairs, so the town sits at the centre). */
export const FAR_WORLD_KM = 8;
/** The region footprint (cells a side: 256 m) and the chunk edge, as every bench world. */
export const FAR_WORLD_FOOTPRINT: RegionFootprint = 512;
const grid = chunkGrid(32);
/** The world's base (cells): 64 m under the valley floor. */
const BASE = LANDSCAPE_BASE;
/** Town footprint (cells) and the chunks it is moved by so its middle is the world's origin. */
const TOWN_CELLS = 512;
const TOWN_SHIFT_CHUNKS = TOWN_CELLS / 2 / grid.edge;
/** Height (cells) of the mountains' tallest peaks: ~1.5 km. */
const PEAK = 3000;
/** Terraced cliffs: the step (cells) and the share of each step its riser takes. */
const TERRACE_STEP = 56;
const TERRACE_RISER = 0.12;
/** Overhangs: how far (cells) the ground is pushed in and out near its surface where the cliffs are. */
const OVERHANG = 10;
const OVERHANG_DEPTH = 16;
/** Slope (cells up a cell across) past which the ground is bare rock. */
const ROCK_SLOPE = 1.1;
/** Above this height (cells, ~1.1 km) the ground is rock, then scree (gravel) on gentle slopes. */
const BARE_HEIGHT = 2200;
const SOIL = 4;

/** The world's styles; the first is the default. */
export const FAR_WORLD_STYLES = ['realistic', 'terraced'] as const;
export type FarWorldStyle = (typeof FAR_WORLD_STYLES)[number];

export interface FarWorldOptions {
  readonly seed?: number;
  /** Side in km (default {@link FAR_WORLD_KM}). */
  readonly sizeKm?: number;
  /** Default `realistic`. */
  readonly style?: FarWorldStyle;
}

/** The world's cell span on x and z: [−half, half), half a whole number of regions. */
export function farWorldHalf(sizeKm = FAR_WORLD_KM): number {
  const cells = Math.ceil((sizeKm * 2000) / (2 * FAR_WORLD_FOOTPRINT)) * 2 * FAR_WORLD_FOOTPRINT;
  return cells / 2;
}

/** How much a column is cliff country (0 … 1): terraces and overhangs there. */
function cliffMask(x: number, z: number, seed: number): number {
  return smoothstep(0.52, 0.62, valueNoise01(x / 1400, z / 1400, seed + 7)) * smoothstep(FLAT_RADIUS * 2, RISEN_RADIUS, Math.hypot(x, z));
}

/** Surface height (cells) of column (x, z) in the terraced style. */
export function farHeight(x: number, z: number, seed: number): number {
  const r = Math.hypot(x, z);
  const risen = smoothstep(FLAT_RADIUS, RISEN_RADIUS, r);
  if (risen === 0) return 0;
  const mass = smoothstep(0.32, 0.72, fractalNoise01(x / 7000, z / 7000, 3, seed));
  const n = fractalNoise01(x / 2200, z / 2200, 5, seed + 1);
  const ridge = 1 - Math.abs(2 * n - 1);
  const rolling = 36 * fractalNoise01(x / 600, z / 600, 3, seed + 2);
  let h = rolling + PEAK * mass * mass * (0.15 + 0.85 * ridge * ridge * ridge);
  const cliff = cliffMask(x, z, seed);
  if (cliff > 0) {
    const t = h / TERRACE_STEP;
    const f = t - Math.floor(t);
    const terraced = (Math.floor(t) + smoothstep(0.5 - TERRACE_RISER / 2, 0.5 + TERRACE_RISER / 2, f)) * TERRACE_STEP;
    h += (terraced - h) * cliff;
  }
  return risen * h;
}

/** A column's ground (surface from its height, top material from its slope and height). */
function groundOf(h: number, slope: number): GroundColumn {
  const bare = slope > ROCK_SLOPE || h > BARE_HEIGHT;
  const top = slope > ROCK_SLOPE ? MAT.rock : h > BARE_HEIGHT ? MAT.gravel : MAT.grass;
  return { surface: h, base: BASE, top, soilDepth: bare ? 0 : SOIL, liquidLevel: -Infinity };
}

/** Writes one cell of ground from a signed density (> 0 inside, cells) and its depth under the surface. */
function writeGroundCell(out: DenseChunk, i: number, density: number, depth: number, col: GroundColumn): boolean {
  const fill = Math.min(1, Math.max(0, density + 0.5));
  if (fill <= 0) {
    out.material[i] = 0;
    out.role[i] = 0;
    out.shape[i] = 0;
    out.wetness[i] = 0;
    return false;
  }
  out.material[i] = depth < 1 ? col.top : depth < 1 + col.soilDepth ? MAT.soil : MAT.rock;
  out.role[i] = VOXEL_ROLE.terrain;
  out.shape[i] = shapeByte(fill);
  out.wetness[i] = 0;
  return true;
}

/** Counts of what a column (or a world) wrote. */
export interface FarColumnWrite {
  readonly files: string[];
  readonly uniform: number;
  readonly stored: number;
  readonly bytes: number;
  readonly ms: number;
}

const ROCK_VALUE = recordValue(MAT.rock, VOXEL_ROLE.terrain, SHAPE_FULL, 0);

const landscapes = new Map<string, FarLandscape>();

/** The realistic landscape of a world (made once a thread: its drainage takes a few seconds). */
export function farLandscape(sizeKm = FAR_WORLD_KM, seed = 97): FarLandscape {
  const key = `${sizeKm}:${seed}`;
  let l = landscapes.get(key);
  if (l === undefined) landscapes.set(key, (l = new FarLandscape(farWorldHalf(sizeKm), seed)));
  return l;
}

/** The ground's surface height (cells) at column (x, z) before its half-metre roughness, in a style. */
export function farSurfaceHeight(x: number, z: number, opts: FarWorldOptions = {}): number {
  const seed = opts.seed ?? 97;
  return (opts.style ?? 'realistic') === 'terraced' ? farHeight(x, z, seed) : farLandscape(opts.sizeKm, seed).heightAt(x, z, null, null);
}

/**
 * Writes region column (rx, rz) of the far world into `gridDir` (the world
 * grid's folder): every stacked region file of the column that holds
 * anything. Returns the file names and what they hold.
 */
export function writeFarWorldColumn(gridDir: string, rx: number, rz: number, opts: FarWorldOptions = {}): FarColumnWrite {
  const t0 = performance.now();
  const seed = opts.seed ?? 97;
  const half = farWorldHalf(opts.sizeKm);
  const side = chunksPerRegionSide(grid, FAR_WORLD_FOOTPRINT);
  const e = grid.edge;
  const store = pickStore(grid);
  const town = townWorld({ footprint: TOWN_CELLS }).grids[0]!;
  const cells = createDenseChunk(grid);
  const byStack = new Map<number, RegionEntry[]>();
  const add = (entry: RegionEntry): void => {
    const ry = Math.floor(entry.cy / side);
    let l = byStack.get(ry);
    if (l === undefined) byStack.set(ry, (l = []));
    l.push(entry);
  };
  const encode = (cx: number, cy: number, cz: number): void => {
    store.importChunk(cx, cy, cz, cells);
    const bytes = store.encodeChunk(cx, cy, cz);
    store.dropChunk(cx, cy, cz);
    if (bytes !== null) add(packRegionChunk(grid, cx, cy, cz, bytes, 'zstd', zstdCompress));
  };
  const heights = new Float32Array((e + 2) * (e + 2));
  const cols: GroundColumn[] = [];
  const warp = new CoarseField(grid, 4);
  const land = (opts.style ?? 'realistic') === 'realistic' ? farLandscape(opts.sizeKm, seed) : null;
  let uniform = 0;
  for (let lcx = 0; lcx < side; lcx++) for (let lcz = 0; lcz < side; lcz++) {
    const cx = rx * side + lcx;
    const cz = rz * side + lcz;
    const x0 = cx * e;
    const z0 = cz * e;
    if (x0 < -half || x0 >= half || z0 < -half || z0 >= half) continue;
    // The town's chunks come whole from the town (its ground is the flat ground round it).
    if (x0 >= -TOWN_CELLS / 2 && x0 < TOWN_CELLS / 2 && z0 >= -TOWN_CELLS / 2 && z0 < TOWN_CELLS / 2) {
      for (let cy = town.bounds.min[1] >> grid.shift; cy <= (town.bounds.max[1] - 1) >> grid.shift; cy++) {
        if (town.fill(grid, cx + TOWN_SHIFT_CHUNKS, cy, cz + TOWN_SHIFT_CHUNKS, cells)) encode(cx, cy, cz);
      }
      continue;
    }
    if (land !== null) {
      // The realistic ground: its column plans the span, then each chunk in it.
      const col = land.plan(grid, x0, z0);
      for (let cy = LANDSCAPE_BASE >> grid.shift; cy <= Math.floor(col.high) >> grid.shift; cy++) {
        const y0 = cy * e;
        // Under every cell's layers (top, soil, the outcrops' reach): whole rock.
        if (y0 + e + 8 <= col.low) {
          add({ cx, cy, cz, uniform: ROCK_VALUE });
          uniform++;
          continue;
        }
        if (col.fill(cells, y0)) encode(cx, cy, cz);
      }
      continue;
    }
    for (let a = 0; a < e + 2; a++) for (let b = 0; b < e + 2; b++) heights[a * (e + 2) + b] = farHeight(x0 + a - 1, z0 + b - 1, seed);
    let minS = Infinity;
    let maxS = -Infinity;
    cols.length = 0;
    for (let lx = 0; lx < e; lx++) for (let lz = 0; lz < e; lz++) {
      const at = (dx: number, dz: number): number => heights[(lx + 1 + dx) * (e + 2) + (lz + 1 + dz)]!;
      const h = at(0, 0);
      const slope = Math.max(Math.abs(at(1, 0) - at(-1, 0)), Math.abs(at(0, 1) - at(0, -1))) / 2;
      cols.push(groundOf(h, slope));
      minS = Math.min(minS, h);
      maxS = Math.max(maxS, h);
    }
    const overhang = cliffMask(x0 + e / 2, z0 + e / 2, seed) > 0.3;
    const margin = overhang ? OVERHANG + 1 : 0;
    const top = (Math.ceil(maxS + margin) >> grid.shift) + 1;
    for (let cy = BASE >> grid.shift; cy < top; cy++) {
      const y0 = cy * e;
      if (y0 + e + 2 + SOIL + margin <= minS) {
        add({ cx, cy, cz, uniform: ROCK_VALUE });
        uniform++;
        continue;
      }
      if (y0 >= maxS + margin) continue;
      let any = false;
      if (!overhang) {
        let k = 0;
        for (let lx = 0; lx < e; lx++) for (let lz = 0; lz < e; lz++) any = fillGroundColumn(grid, cells, lx, lz, y0, cols[k++]!) || any;
      } else {
        // The ground pushed in and out near its surface: overhangs under the cliffs' lips.
        warp.sample(x0, y0, z0, (x, y, z) => (valueNoise01(x / 18, z / 18, seed + 9, y / 12) - 0.5) * 2 * OVERHANG);
        let k = 0;
        for (let lx = 0; lx < e; lx++) for (let lz = 0; lz < e; lz++) {
          const col = cols[k++]!;
          for (let ly = 0; ly < e; ly++) {
            const y = y0 + ly;
            const i = localIndex(grid, lx, ly, lz);
            const depth = col.surface - (y + 0.5);
            const density = y < BASE ? -1 : depth < OVERHANG_DEPTH ? depth + warp.at(lx, ly, lz) : depth;
            any = writeGroundCell(cells, i, density, depth, col) || any;
          }
        }
      }
      if (any) encode(cx, cy, cz);
    }
  }
  mkdirSync(gridDir, { recursive: true });
  const files: string[] = [];
  let bytes = 0;
  let stored = 0;
  for (const [ry, entries] of [...byStack.entries()].sort((a, b) => a[0] - b[0])) {
    const b = writeRegion({ worldId: TEST_WORLD_ID, gridId: WORLD_GRID_ID, layout: 'stacked', grid, footprint: FAR_WORLD_FOOTPRINT, rx, ry, rz, compressor: 'zstd' }, entries);
    const name = regionFileName('stacked', rx, ry, rz);
    writeFileSync(join(gridDir, name), b);
    files.push(name);
    bytes += b.length;
    stored += entries.length;
  }
  return { files, uniform, stored: stored - uniform, bytes, ms: performance.now() - t0 };
}

/** The far world's region columns (rx, rz), centre first (so a partial run still holds the middle). */
export function farWorldColumns(sizeKm = FAR_WORLD_KM): Array<readonly [number, number]> {
  const half = farWorldHalf(sizeKm);
  const n = half / FAR_WORLD_FOOTPRINT;
  const out: Array<readonly [number, number]> = [];
  for (let rx = -n; rx < n; rx++) for (let rz = -n; rz < n; rz++) out.push([rx, rz]);
  return out.sort((a, b) => Math.hypot(a[0] + 0.5, a[1] + 0.5) - Math.hypot(b[0] + 0.5, b[1] + 0.5) || a[0] - b[0] || a[1] - b[1]);
}

/** The world folder of the far world in a project, and its grid folder. */
export function farWorldDirs(projectDir: string, name = FAR_WORLD_NAME): { dir: string; gridDir: string } {
  const dir = join(projectDir, VOXEL_WORLDS_FOLDER, name);
  return { dir, gridDir: join(dir, gridFolder(WORLD_GRID_ID)) };
}

/** Writes the world's manifest once every column is on disk. */
export function finishFarWorld(dir: string, files: readonly string[]): void {
  const hex = [...TEST_WORLD_ID].map((b) => b.toString(16).padStart(2, '0')).join('');
  writeVoxelWorldManifest(dir, { worldId: hex, edge: 32, layout: 'stacked', footprint: FAR_WORLD_FOOTPRINT }, files);
}

/** The world grid's chunk layout (for readers of the far world). */
export const FAR_WORLD_GRID: ChunkGrid = grid;
