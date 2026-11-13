/**
 * A far cache's fine levels baked (levels 1 and 0: 1 m and 0.5 m cells,
 * under the kept levels the far cache always holds), when the world's bake
 * level asks for them (@thirdlight/voxel far-fine-bake.ts).
 *
 * Layout (far cache format 3): `far.json`'s `fine` names the level the bake
 * goes down to, the build and encoding, and per fine level its region files
 * and the region columns baked so far. A fine level's nodes are stored as the
 * coarse levels' baked bricks are, in `B<level>/` region files at the level's
 * node coordinates: a level-0 node is a chunk, so level 0's files tile the
 * world exactly as its own region files do, and level 1's span twice as far.
 * A node is stored only where it draws something; a node missing from a baked
 * column draws nothing.
 *
 * The bake works a level's region column at a time, level 1 first (a 1 m bake
 * is a 0.5 m bake's first half): a column's nodes are built from the world's
 * files (in a bake thread), then its files and the column's place in the
 * manifest are written. So a bake stopped part way keeps every column it
 * wrote and goes on from the next, and a column is never half written.
 *
 * After an edit the fine nodes whose blocks read a changed chunk are built
 * again in baked columns (columns not baked yet are baked from the edited
 * files when their turn comes), looked up first by the content of the chunks
 * they read in the cache's rebuilt store.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hexToBytes, sha256Hex } from '@thirdlight/shared';
import {
  bakeFarFineNode,
  chunkGrid,
  chunksPerRegionSide,
  encodeFarBricks,
  FAR_BRICKS_BLOB_VERSION,
  FAR_FINE_BAKE_BUILD,
  farFineBakedLevels,
  farFineChunks,
  farFineDirty,
  mipNodeKey,
  parseRegionFileName,
  regionFileName,
  RegionIndex,
  valueMaterial,
  valueRole,
  valueShape,
  valueWetness,
  WORLD_GRID_ID,
  writeRegion,
  type ChunkCells,
  type ChunkGrid,
  type FarCells,
  type MipNode,
  type RegionEntry,
  type RegionFootprint,
} from '@thirdlight/voxel';
import { bakedEntry, farBricksFolder, FarRebuiltStore, type FarBricksRebuild } from './voxel-far-bake';
import { FAR_LAYOUT, FarWorldSource, readFarCacheManifest, writeFarCacheFile, writeFarCacheManifest, type FarCacheFine, type FarCacheFineLevel, type FarCacheManifest } from './voxel-far-cache';

/** One fine bake job: a fine level's region column (the level's node coordinates), built from the world's files. */
export interface FarFineTask {
  readonly worldDir: string;
  readonly level: number;
  readonly rx: number;
  readonly rz: number;
}

/** A fine bake job's nodes, as region entries (zstd-packed where smaller), and what it took. */
export interface FarFineResult {
  readonly level: number;
  readonly rx: number;
  readonly rz: number;
  readonly entries: RegionEntry[];
  readonly ms: number;
}

/** Runs fine bake jobs (in threads, or here one after another), answers in any order. */
export type FarFineRunner = (tasks: readonly FarFineTask[]) => AsyncIterable<FarFineResult>;

/** A level's region column as the manifest lists it. */
export function farFineColumnKey(rx: number, rz: number): string {
  return `${rx},${rz}`;
}

/** The region columns of fine level `level` the world holds anything in (a level's region column spans 2^level world columns), sorted. */
export function farFineColumns(world: FarWorldSource, level: number): Array<readonly [number, number]> {
  const seen = new Map<string, readonly [number, number]>();
  for (const [rx, rz] of world.columns()) {
    const at = [Math.floor(rx / 2 ** level), Math.floor(rz / 2 ** level)] as const;
    seen.set(farFineColumnKey(at[0], at[1]), at);
  }
  return [...seen.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * The world's chunks as a fine block reads them (far-bricks-faces.ts `ChunkCells`), each decoded once and kept until
 * `forgetBelow` drops the ones a walk along x has passed.
 */
class WorldCells {
  private readonly kept = new Map<string, FarCells>();
  constructor(private readonly world: FarWorldSource) {}

  at(cx: number, cy: number, cz: number): FarCells {
    const k = `${cx},${cy},${cz}`;
    let c = this.kept.get(k);
    if (c === undefined) {
      c = this.world.chunk(cx, cy, cz);
      this.kept.set(k, c);
    }
    return c;
  }

  /** Drops the chunks below `cx` along x. */
  forgetBelow(cx: number): void {
    for (const [k] of this.kept) if (Number(k.slice(0, k.indexOf(','))) < cx) this.kept.delete(k);
  }

  readonly cells: ChunkCells = (cx, cy, cz, out) => {
    const c = this.at(cx, cy, cz);
    if (c === null || c === 0) return false;
    if (typeof c === 'number') {
      out.material.fill(valueMaterial(c));
      out.role.fill(valueRole(c));
      out.shape.fill(valueShape(c));
      out.wetness.fill(valueWetness(c));
      return true;
    }
    out.material.set(c.material);
    out.role.set(c.role);
    out.shape.set(c.shape);
    out.wetness.set(c.wetness);
    return true;
  };
}

/** Whether a fine node holds anything: one of its chunks is more than air. */
function holds(cells: WorldCells, n: MipNode): boolean {
  const s = 1 << n.level;
  for (let cx = n.nx * s; cx < (n.nx + 1) * s; cx++) for (let cy = n.ny * s; cy < (n.ny + 1) * s; cy++) for (let cz = n.nz * s; cz < (n.nz + 1) * s; cz++) {
    const c = cells.at(cx, cy, cz);
    if (c !== null && c !== 0) return true;
  }
  return false;
}

/** A fine node's bricks, baked and encoded (null: it draws nothing). */
function bakedFine(grid: ChunkGrid, cells: ChunkCells, n: MipNode): Uint8Array | null {
  const b = bakeFarFineNode(grid, cells, n);
  return b === null ? null : encodeFarBricks(b);
}

/** A fine bake job run here: every node of the column that draws something, built from the world's files. */
export function bakeFarFineColumn(world: FarWorldSource, t: Pick<FarFineTask, 'level' | 'rx' | 'rz'>): FarFineResult {
  const t0 = performance.now();
  const g = world.grid;
  const side = chunksPerRegionSide(g, world.manifest.footprint);
  const S = 1 << t.level;
  // The node rows the world's region rows under the column hold.
  let lo = Infinity;
  let hi = -Infinity;
  for (const name of world.manifest.regions) {
    const at = parseRegionFileName(world.manifest.layout, name);
    if (at === null || Math.floor(at.rx / S) !== t.rx || Math.floor(at.rz / S) !== t.rz) continue;
    const rows = world.manifest.layout === 'stacked' ? [at.ry] : world.columnRows(at.rx, at.rz);
    for (const ry of rows) {
      lo = Math.min(lo, Math.floor((ry * side) / S));
      hi = Math.max(hi, Math.floor(((ry + 1) * side - 1) / S));
    }
  }
  const cells = new WorldCells(world);
  const entries: RegionEntry[] = [];
  for (let nx = t.rx * side; nx < (t.rx + 1) * side; nx++) {
    // A node reads its chunks and one round them: what lies behind the previous column of nodes is not read again.
    cells.forgetBelow(nx * S - 1);
    for (let nz = t.rz * side; nz < (t.rz + 1) * side; nz++) for (let ny = lo; ny <= hi; ny++) {
      const n = { level: t.level, nx, ny, nz };
      if (!holds(cells, n)) continue;
      const bytes = bakedFine(g, cells.cells, n);
      if (bytes !== null) entries.push(bakedEntry(n, bytes));
    }
  }
  return { level: t.level, rx: t.rx, rz: t.rz, entries, ms: performance.now() - t0 };
}

/** The fine bake jobs' default runner: here, one after another, the event loop given back between columns. */
export function inThreadFarFine(): FarFineRunner {
  return async function* run(tasks) {
    const worlds = new Map<string, FarWorldSource>();
    for (const t of tasks) {
      let w = worlds.get(t.worldDir);
      if (w === undefined) worlds.set(t.worldDir, (w = new FarWorldSource(t.worldDir)));
      yield bakeFarFineColumn(w, t);
      await new Promise<void>((ok) => setImmediate(ok));
    }
  };
}

/** The fine record of a cache baked toward `bakeLevel` now (levels coarsest first, none baked yet). */
function freshFine(bakeLevel: number): FarCacheFine {
  return { bakeLevel, build: FAR_FINE_BAKE_BUILD, blob: FAR_BRICKS_BLOB_VERSION, levels: farFineBakedLevels(bakeLevel).map((level) => ({ level, regions: [], nodes: 0, bytes: 0, columns: [] })) };
}

/**
 * Makes a cache's fine record bake toward `bakeLevel` (0 or 1), as format 3: a record of another build or encoding is
 * dropped with its files; one baked coarser gains the finer levels, its baked columns kept; one baked finer already is
 * left as it is (a coarser level asks for less of what it holds). Returns the manifest written.
 */
export function startFarFine(cacheDir: string, bakeLevel: number): FarCacheManifest {
  const m = readFarCacheManifest(cacheDir);
  let fine = m.fine;
  if (fine !== undefined && (fine.build !== FAR_FINE_BAKE_BUILD || fine.blob !== FAR_BRICKS_BLOB_VERSION)) {
    for (const l of fine.levels) for (const name of l.regions) rmSync(join(cacheDir, farBricksFolder(l.level), name), { force: true });
    fine = undefined;
  }
  if (fine !== undefined && fine.bakeLevel <= bakeLevel) return m;
  const want = freshFine(fine === undefined ? bakeLevel : Math.min(bakeLevel, fine.bakeLevel));
  const had = new Map((fine?.levels ?? []).map((l) => [l.level, l]));
  const next: FarCacheManifest = { ...m, format: 3, fine: { ...want, levels: want.levels.map((l) => had.get(l.level) ?? l) } };
  writeFarCacheManifest(cacheDir, next);
  return next;
}

/** The fine bake jobs a cache still lacks for `bakeLevel` (coarsest level first): the world's columns not baked yet. */
export function farFinePending(m: FarCacheManifest, world: FarWorldSource, bakeLevel: number): Array<Omit<FarFineTask, 'worldDir'>> {
  const out: Array<Omit<FarFineTask, 'worldDir'>> = [];
  for (const level of farFineBakedLevels(bakeLevel)) {
    const done = new Set(m.fine?.levels.find((l) => l.level === level)?.columns ?? []);
    for (const [rx, rz] of farFineColumns(world, level)) if (!done.has(farFineColumnKey(rx, rz))) out.push({ level, rx, rz });
  }
  return out;
}

/** How far a cache's fine bake toward `bakeLevel` is: per level, the world's columns baked and in all. */
export function farFineProgress(m: FarCacheManifest, world: FarWorldSource, bakeLevel: number): Array<{ readonly level: number; readonly done: number; readonly total: number }> {
  return farFineBakedLevels(bakeLevel).map((level) => {
    const done = new Set(m.fine?.levels.find((l) => l.level === level)?.columns ?? []);
    const all = farFineColumns(world, level);
    return { level, done: all.filter(([rx, rz]) => done.has(farFineColumnKey(rx, rz))).length, total: all.length };
  });
}

/** The fine levels a cache holds whole for `bakeLevel` (every world column of each baked; empty: not baked that far yet). */
export function farFineComplete(m: FarCacheManifest, world: FarWorldSource, bakeLevel: number): number[] {
  const p = farFineProgress(m, world, bakeLevel);
  return p.every((l) => l.done === l.total) ? p.map((l) => l.level) : [];
}

/** Region tile of a fine level's file. */
function tile(m: FarCacheManifest, grid: ChunkGrid, rx: number, ry: number, rz: number): Parameters<typeof writeRegion>[0] {
  return { worldId: hexToBytes(m.worldId), gridId: WORLD_GRID_ID, layout: FAR_LAYOUT, grid, footprint: m.footprint as RegionFootprint, rx, ry, rz, compressor: 'zstd' };
}

/** A fine level file's entries (empty: none). */
function readEntries(cacheDir: string, m: FarCacheManifest, grid: ChunkGrid, level: number, name: string): RegionEntry[] {
  const path = join(cacheDir, farBricksFolder(level), name);
  if (!existsSync(path)) return [];
  const at = parseRegionFileName(FAR_LAYOUT, name)!;
  const bytes = new Uint8Array(readFileSync(path));
  const t = tile(m, grid, at.rx, at.ry, at.rz);
  const index = RegionIndex.parse(bytes, { expect: { worldId: t.worldId, gridId: t.gridId, layout: t.layout, grid, footprint: t.footprint, rx: at.rx, ry: at.ry, rz: at.rz } });
  const out: RegionEntry[] = [];
  for (let i = 0; i < index.size; i++) out.push(index.entry(i, bytes)!);
  return out;
}

/**
 * Writes fine level files: for each file name, its entries (none: the file goes), the level's record counted again
 * for those files. Returns the level record.
 */
function writeFineFiles(cacheDir: string, m: FarCacheManifest, grid: ChunkGrid, l: FarCacheFineLevel, files: ReadonlyMap<string, RegionEntry[]>): FarCacheFineLevel {
  const dir = join(cacheDir, farBricksFolder(l.level));
  mkdirSync(dir, { recursive: true });
  const regions = new Set(l.regions);
  let nodes = l.nodes;
  let bytes = l.bytes;
  for (const [name, entries] of files) {
    if (regions.has(name)) {
      nodes -= readEntries(cacheDir, m, grid, l.level, name).length;
      bytes -= existsSync(join(dir, name)) ? readFileSync(join(dir, name)).length : 0;
    }
    const at = parseRegionFileName(FAR_LAYOUT, name)!;
    const b = entries.length === 0 ? null : writeRegion(tile(m, grid, at.rx, at.ry, at.rz), entries);
    writeFarCacheFile(dir, name, b);
    if (b === null) regions.delete(name);
    else {
      regions.add(name);
      nodes += entries.length;
      bytes += b.length;
    }
  }
  return { ...l, regions: [...regions].sort(), nodes, bytes };
}

/**
 * Writes a baked column into the cache: its files (the column's old files replaced) and the column marked baked in
 * the manifest. A column of a level the cache no longer bakes is left out. Returns the manifest written.
 */
export function writeFarFineColumn(cacheDir: string, grid: ChunkGrid, r: FarFineResult): FarCacheManifest {
  const m = readFarCacheManifest(cacheDir);
  const l = m.fine?.levels.find((x) => x.level === r.level);
  if (m.fine === undefined || l === undefined) return m;
  const side = chunksPerRegionSide(grid, m.footprint as RegionFootprint);
  const files = new Map<string, RegionEntry[]>();
  // The column's files written before (a column baked again) are replaced whole.
  for (const name of l.regions) {
    const at = parseRegionFileName(FAR_LAYOUT, name)!;
    if (at.rx === r.rx && at.rz === r.rz) files.set(name, []);
  }
  for (const e of r.entries) {
    const name = regionFileName(FAR_LAYOUT, r.rx, Math.floor(e.cy / side), r.rz);
    let list = files.get(name);
    if (list === undefined) files.set(name, (list = []));
    list.push(e);
  }
  const written = writeFineFiles(cacheDir, m, grid, l, files);
  const columns = [...new Set([...l.columns, farFineColumnKey(r.rx, r.rz)])].sort();
  const next: FarCacheManifest = { ...m, fine: { ...m.fine, levels: m.fine.levels.map((x) => (x.level === r.level ? { ...written, columns } : x)) } };
  writeFarCacheManifest(cacheDir, next);
  return next;
}

/**
 * The content key of fine node `n`: the fine build, the encoding and every chunk entry its block reads as the world
 * stores it (in order), so two nodes reading the same chunks the same way share a key.
 */
export function farFineContentKey(world: FarWorldSource, n: MipNode): string {
  const parts: Uint8Array[] = [new TextEncoder().encode(JSON.stringify({ fine: FAR_FINE_BAKE_BUILD, v: FAR_BRICKS_BLOB_VERSION, level: n.level }))];
  const { min, max } = farFineChunks(n);
  for (let cx = min[0]; cx <= max[0]; cx++) for (let cy = min[1]; cy <= max[1]; cy++) for (let cz = min[2]; cz <= max[2]; cz++) {
    const r = world.read(cx, cy, cz);
    if (r.kind === 'air') parts.push(Uint8Array.of(0));
    else if (r.kind === 'uniform') parts.push(Uint8Array.of(1, r.value & 0xff, (r.value >>> 8) & 0xff, (r.value >>> 16) & 0xff, r.value >>> 24));
    else if (r.kind === 'stored') {
      const head = new Uint8Array(6);
      head[0] = 2;
      head[1] = r.raw ? 1 : 0;
      new DataView(head.buffer).setUint32(2, r.bytes.length, true);
      parts.push(head, r.bytes);
    } else throw new Error(`chunk (${cx}, ${cy}, ${cz}): ${r.reason}`);
  }
  const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return sha256Hex(all);
}

/** A rebuilt store's entry for a fine node that draws nothing (a stored entry is never empty). */
const DRAWS_NOTHING = Uint8Array.of(0);

/**
 * Builds again the fine nodes an edit of `chunks` made stale (`farFineDirty`) in the cache's baked columns, each
 * looked up first by its content key in the rebuilt store, and rewrites only the files holding them, then the
 * manifest. Absent: the cache bakes no fine levels.
 */
export function rebakeFarFine(worldDir: string, cacheDir: string, chunks: ReadonlyArray<{ readonly cx: number; readonly cy: number; readonly cz: number }>, only?: { readonly level: number; readonly rx: number; readonly rz: number }): FarBricksRebuild | undefined {
  const t0 = performance.now();
  const m = readFarCacheManifest(cacheDir);
  if (m.fine === undefined) return undefined;
  const world = new FarWorldSource(worldDir);
  const g = world.grid;
  const side = chunksPerRegionSide(g, m.footprint as RegionFootprint);
  const baked = new Map(m.fine.levels.map((l) => [l.level, new Set(l.columns)]));
  const inOnly = (n: { level: number; nx: number; nz: number }): boolean => only === undefined || (n.level === only.level && Math.floor(n.nx / side) === only.rx && Math.floor(n.nz / side) === only.rz);
  const dirty = farFineDirty(chunks).filter((n) => inOnly(n) && baked.get(n.level)?.has(farFineColumnKey(Math.floor(n.nx / side), Math.floor(n.nz / side))) === true);
  dirty.sort((a, b) => a.level - b.level || a.nx - b.nx || a.ny - b.ny || a.nz - b.nz);
  const store = new FarRebuiltStore(cacheDir);
  const cells = new WorldCells(world);
  const byFile = new Map<number, Map<string, Map<string, RegionEntry | null>>>();
  let built = 0;
  let reused = 0;
  for (const n of dirty) {
    const key = farFineContentKey(world, n);
    let bytes = store.get(key);
    if (bytes === null) {
      bytes = holds(cells, n) ? bakedFine(g, cells.cells, n) : null;
      store.put(key, bytes ?? DRAWS_NOTHING);
      built++;
    } else {
      reused++;
      if (bytes.length === DRAWS_NOTHING.length && bytes[0] === 0) bytes = null;
    }
    const name = regionFileName(FAR_LAYOUT, Math.floor(n.nx / side), Math.floor(n.ny / side), Math.floor(n.nz / side));
    let level = byFile.get(n.level);
    if (level === undefined) byFile.set(n.level, (level = new Map()));
    let put = level.get(name);
    if (put === undefined) level.set(name, (put = new Map()));
    put.set(mipNodeKey(n), bytes === null ? null : bakedEntry(n, bytes));
  }
  let fine = m.fine;
  for (const [level, files] of byFile) {
    const l = fine.levels.find((x) => x.level === level)!;
    const merged = new Map<string, RegionEntry[]>();
    for (const [name, put] of files) {
      const entries = new Map(readEntries(cacheDir, m, g, level, name).map((e) => [mipNodeKey({ level, nx: e.cx, ny: e.cy, nz: e.cz }), e]));
      for (const [k, e] of put) {
        if (e === null) entries.delete(k);
        else entries.set(k, e);
      }
      merged.set(name, [...entries.values()]);
    }
    const written = writeFineFiles(cacheDir, m, g, l, merged);
    fine = { ...fine, levels: fine.levels.map((x) => (x.level === level ? { ...written, columns: x.columns } : x)) };
  }
  if (byFile.size > 0) writeFarCacheManifest(cacheDir, { ...readFarCacheManifest(cacheDir), fine });
  return { dirty: dirty.length, built, reused, ms: performance.now() - t0 };
}

/** A fine level's stored entries by node key (tests and benches compare them). */
export function farFineStored(cacheDir: string, level: number): Map<string, RegionEntry> {
  const m = readFarCacheManifest(cacheDir);
  const l = m.fine?.levels.find((x) => x.level === level);
  const out = new Map<string, RegionEntry>();
  if (l === undefined) return out;
  const g = chunkGrid(m.edge as 16 | 32);
  for (const name of l.regions) for (const e of readEntries(cacheDir, m, g, level, name)) out.set(mipNodeKey({ level, nx: e.cx, ny: e.cy, nz: e.cz }), e);
  return out;
}
