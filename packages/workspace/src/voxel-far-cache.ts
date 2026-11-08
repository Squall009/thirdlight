/**
 * A voxel world's far cache on disk: the far tree's kept nodes
 * (@thirdlight/voxel far-tree.ts) built from the world's region files.
 *
 * Layout: a folder per world (by default `cache/voxel-far/<world>/` in the
 * project, which the project's `.gitignore` keeps out of git) holding
 * `far.json` (format, the world's id, edge and footprint, the levels kept,
 * the world revision it was built from, and per level its region files,
 * nodes and bytes) and a folder `L<level>/` per kept level. A level's nodes
 * are stored exactly as chunks are, in region files of the same format
 * (stacked, the world's footprint, the world's id), at the level's node
 * coordinates: node (nx, ny, nz) of level L is "chunk" (nx, ny, nz) of that
 * level's files. So the cache is read by range, checked and decoded with the
 * code that reads the world, and an export ships its files beside the
 * world's.
 *
 * The cache is derived: the same world gives the same bytes, whichever
 * order or process builds it. A full build works one region column at a
 * time (the levels up to a region's size), then the levels above from those
 * nodes; a rebuild after an edit builds exactly the changed chunks'
 * ancestors at the kept levels, reading their untouched children from the
 * cache, and rewrites only the files holding them.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildFarNode,
  chunkGrid,
  createDenseChunk,
  chunksPerRegionSide,
  FAR_CACHE_FORMAT,
  FAR_MIN_LEVEL,
  farAncestors,
  FarNodeIndex,
  farTopLevel,
  mipNodeKey,
  packRegionChunk,
  parseRegionFileName,
  regionChunkCodecBytes,
  regionFileName,
  RegionIndex,
  REGION_ENTRY_BYTES,
  WORLD_GRID_ID,
  writeRegion,
  type ChunkGrid,
  type FarCells,
  type FarSource,
  type MipNode,
  type PaletteStore,
  type RegionChunkRead,
  type RegionEntry,
  type RegionFootprint,
  type RegionLayout,
} from '@thirdlight/voxel';
import { hexToBytes } from '@thirdlight/shared';
import { gridFolder, readVoxelWorldManifest, type VoxelWorldManifest } from './voxel-worlds';
import { pickStore, zstdCompress, zstdDecompress } from './voxel-world-files';
import { writeAtomic } from './write';

/** The far cache's manifest file in its folder. */
export const FAR_CACHE_MANIFEST = 'far.json';

/** Where a project keeps its worlds' far caches (project-relative; under `cache/`, never committed). */
export const FAR_CACHE_SEGMENTS = ['cache', 'voxel-far'] as const;

/** A project's far cache folder for one world. */
export function farCacheDir(projectDir: string, world: string): string {
  return join(projectDir, ...FAR_CACHE_SEGMENTS, world);
}

/** The folder of a kept level's region files inside a far cache. */
export function farLevelFolder(level: number): string {
  return `L${level}`;
}

/** The far cache layout's region layout: nodes stack like chunks. */
const FAR_LAYOUT: RegionLayout = 'stacked';

export interface FarCacheLevel {
  readonly level: number;
  /** Its region files (sorted). */
  readonly regions: readonly string[];
  /** Nodes that hold anything. */
  readonly nodes: number;
  /** Bytes of its region files. */
  readonly bytes: number;
}

export interface FarCacheManifest {
  readonly format: number;
  readonly worldId: string;
  readonly edge: number;
  readonly footprint: RegionFootprint;
  readonly minLevel: number;
  readonly maxLevel: number;
  /** The world revision the cache was built from (a cache of another revision is stale). */
  readonly revision: number;
  readonly levels: readonly FarCacheLevel[];
}

function manifestBytes(m: FarCacheManifest): Uint8Array {
  const ordered = {
    format: m.format,
    worldId: m.worldId,
    edge: m.edge,
    footprint: m.footprint,
    minLevel: m.minLevel,
    maxLevel: m.maxLevel,
    revision: m.revision,
    levels: m.levels.map((l) => ({ level: l.level, regions: l.regions, nodes: l.nodes, bytes: l.bytes })),
  };
  return new TextEncoder().encode(`${JSON.stringify(ordered, null, 2)}\n`);
}

/** Reads a far cache's manifest; throws when it is missing or of another format (build it again). */
export function readFarCacheManifest(cacheDir: string): FarCacheManifest {
  const o = JSON.parse(readFileSync(join(cacheDir, FAR_CACHE_MANIFEST), 'utf8')) as FarCacheManifest;
  if (o.format !== FAR_CACHE_FORMAT) throw new Error(`far cache format ${String(o.format)}, expected ${FAR_CACHE_FORMAT}`);
  return o;
}

/** A parsed region file and its bytes. */
interface OpenFile {
  readonly index: RegionIndex;
  readonly bytes: Uint8Array;
}

/** Region files read whole, a few kept (a build reads one column's files, then the next column's). */
class FileCache {
  private readonly files = new Map<string, OpenFile | null>();
  constructor(private readonly keep: number) {}
  get(path: string, read: () => OpenFile | null): OpenFile | null {
    const had = this.files.get(path);
    if (had !== undefined) {
      this.files.delete(path);
      this.files.set(path, had);
      return had;
    }
    const f = read();
    this.files.set(path, f);
    while (this.files.size > this.keep) this.files.delete(this.files.keys().next().value!);
    return f;
  }
}

/** Decodes a region read into cells (null: air; a uniform chunk stays its value). */
function readCells(grid: ChunkGrid, store: PaletteStore, r: RegionChunkRead): FarCells {
  if (r.kind === 'air') return null;
  if (r.kind === 'uniform') return r.value;
  const bytes = regionChunkCodecBytes(grid, r, zstdDecompress);
  if (bytes === null) return null;
  store.decodeChunk(r.cx, r.cy, r.cz, bytes);
  const out = createDenseChunk(grid);
  const any = store.exportChunk(r.cx, r.cy, r.cz, out);
  store.dropChunk(r.cx, r.cy, r.cz);
  return any ? out : null;
}

/** A node's (or chunk's) region entry from its cells (null: air, no entry). */
function cellsEntry(grid: ChunkGrid, store: PaletteStore, n: { nx: number; ny: number; nz: number }, cells: FarCells): RegionEntry | null {
  if (cells === null) return null;
  if (typeof cells === 'number') return { cx: n.nx, cy: n.ny, cz: n.nz, uniform: cells };
  store.importChunk(n.nx, n.ny, n.nz, cells);
  const bytes = store.encodeChunk(n.nx, n.ny, n.nz);
  store.dropChunk(n.nx, n.ny, n.nz);
  return bytes === null ? null : packRegionChunk(grid, n.nx, n.ny, n.nz, bytes, 'zstd', zstdCompress);
}

/**
 * Replaces (or, for null bytes, removes) a cache file through the durable
 * write, whatever it held: the cache is derived, rebuilt rather than merged.
 */
function writeCacheFile(dir: string, name: string, bytes: Uint8Array | null): void {
  if (bytes === null) {
    rmSync(join(dir, name), { force: true });
    return;
  }
  const out = writeAtomic({ dir, target: name, bytes, allowedPreHashes: [], previousHash: null });
  if (!out.ok) throw new Error(`${join(dir, name)}: not written`);
}

/**
 * Region files of chunks or nodes at one level, read whole by name from a
 * folder (the world's grid folder, or a far cache's level folder).
 */
class RegionFolder {
  private readonly files: FileCache;
  constructor(
    readonly dir: string,
    readonly grid: ChunkGrid,
    readonly worldId: Uint8Array,
    readonly footprint: RegionFootprint,
    readonly layout: RegionLayout,
    readonly listed: ReadonlySet<string>,
    keep = 16,
  ) {
    this.files = new FileCache(keep);
  }

  file(rx: number, ry: number, rz: number): OpenFile | null {
    const name = regionFileName(this.layout, rx, this.layout === 'stacked' ? ry : 0, rz);
    if (!this.listed.has(name)) return null;
    return this.files.get(join(this.dir, name), () => {
      const bytes = new Uint8Array(readFileSync(join(this.dir, name)));
      const expect = { worldId: this.worldId, gridId: WORLD_GRID_ID, layout: this.layout, grid: this.grid, footprint: this.footprint, rx, ry: this.layout === 'stacked' ? ry : 0, rz };
      return { index: RegionIndex.parse(bytes, { expect }), bytes };
    });
  }

  /** The read of chunk (cx, cy, cz) at this folder's level. Throws on a damaged chunk or file. */
  read(cx: number, cy: number, cz: number): RegionChunkRead {
    const side = chunksPerRegionSide(this.grid, this.footprint);
    const f = this.file(Math.floor(cx / side), Math.floor(cy / side), Math.floor(cz / side));
    if (f === null) return { cx, cy, cz, kind: 'air' };
    const i = f.index.find(cx, cy, cz);
    return i < 0 ? { cx, cy, cz, kind: 'air' } : f.index.read(i, f.bytes);
  }
}

/** A world folder's level-0 chunks as a far tree's source. */
export class FarWorldSource implements FarSource {
  readonly manifest: VoxelWorldManifest;
  readonly grid: ChunkGrid;
  private readonly folder: RegionFolder;
  private readonly store: PaletteStore;

  constructor(readonly worldDir: string) {
    this.manifest = readVoxelWorldManifest(worldDir);
    this.grid = chunkGrid(this.manifest.edge);
    this.folder = new RegionFolder(join(worldDir, gridFolder(WORLD_GRID_ID)), this.grid, hexToBytes(this.manifest.worldId), this.manifest.footprint, this.manifest.layout, new Set(this.manifest.regions));
    this.store = pickStore(this.grid);
  }

  chunk(cx: number, cy: number, cz: number): FarCells {
    const r = this.folder.read(cx, cy, cz);
    if (r.kind === 'damaged') throw new Error(`chunk (${cx}, ${cy}, ${cz}): ${r.reason}`);
    return readCells(this.grid, this.store, r);
  }

  /** The level at which one node spans one region (chunks a region side = 2^level). */
  get columnLevel(): number {
    return Math.log2(chunksPerRegionSide(this.grid, this.manifest.footprint));
  }

  /** The world's region columns (rx, rz), sorted. */
  columns(): Array<readonly [number, number]> {
    const seen = new Map<string, readonly [number, number]>();
    for (const name of this.manifest.regions) {
      const at = parseRegionFileName(this.manifest.layout, name);
      if (at !== null) seen.set(`${at.rx},${at.rz}`, [at.rx, at.rz]);
    }
    return [...seen.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  /** The node rows (ny at {@link columnLevel}) a region column holds anything in. */
  columnRows(rx: number, rz: number): number[] {
    const rows = new Set<number>();
    const shift = this.columnLevel;
    for (const name of this.manifest.regions) {
      const at = parseRegionFileName(this.manifest.layout, name);
      if (at === null || at.rx !== rx || at.rz !== rz) continue;
      if (this.manifest.layout === 'stacked') {
        rows.add(at.ry);
        continue;
      }
      const f = this.folder.file(rx, 0, rz)!;
      const c = { cx: 0, cy: 0, cz: 0 };
      for (let i = 0; i < f.index.size; i++) rows.add(f.index.coordOf(i, c).cy >> shift);
    }
    return [...rows].sort((a, b) => a - b);
  }
}

/** A far cache's kept nodes read from its level folders. */
export class FarCacheReader {
  readonly manifest: FarCacheManifest;
  readonly grid: ChunkGrid;
  private readonly folders = new Map<number, RegionFolder>();
  private readonly store: PaletteStore;

  constructor(readonly cacheDir: string) {
    this.manifest = readFarCacheManifest(cacheDir);
    this.grid = chunkGrid(this.manifest.edge as 16 | 32);
    const id = hexToBytes(this.manifest.worldId);
    for (const l of this.manifest.levels) this.folders.set(l.level, new RegionFolder(join(cacheDir, farLevelFolder(l.level)), this.grid, id, this.manifest.footprint, FAR_LAYOUT, new Set(l.regions)));
    this.store = pickStore(this.grid);
  }

  /** A kept node's cells (null: air). */
  node(n: MipNode): FarCells {
    const f = this.folders.get(n.level);
    if (f === undefined) throw new RangeError(`level ${n.level} is not kept (${this.manifest.minLevel} … ${this.manifest.maxLevel})`);
    const r = f.read(n.nx, n.ny, n.nz);
    if (r.kind === 'damaged') throw new Error(`far node ${mipNodeKey(n)}: ${r.reason}`);
    return readCells(this.grid, this.store, r);
  }

  /** A kept node's entry as stored (null: air): what a rebuild carries over unchanged. */
  entry(n: MipNode): RegionEntry | null {
    const f = this.folders.get(n.level);
    if (f === undefined) return null;
    const side = chunksPerRegionSide(this.grid, this.manifest.footprint);
    const file = f.file(Math.floor(n.nx / side), Math.floor(n.ny / side), Math.floor(n.nz / side));
    if (file === null) return null;
    const i = file.index.find(n.nx, n.ny, n.nz);
    return i < 0 ? null : file.index.entry(i, file.bytes);
  }

  /** Every kept node that holds anything, with its stored bytes: what the far selection reads. */
  index(): FarNodeIndex {
    const idx = new FarNodeIndex(this.grid, this.manifest.minLevel, this.manifest.maxLevel);
    const c = { cx: 0, cy: 0, cz: 0 };
    for (const l of this.manifest.levels) {
      const f = this.folders.get(l.level)!;
      for (const name of l.regions) {
        const at = parseRegionFileName(FAR_LAYOUT, name)!;
        const file = f.file(at.rx, at.ry, at.rz)!;
        for (let i = 0; i < file.index.size; i++) {
          file.index.coordOf(i, c);
          idx.add({ level: l.level, nx: c.cx, ny: c.cy, nz: c.cz }, file.index.storedBytes(i) + REGION_ENTRY_BYTES);
        }
      }
    }
    return idx;
  }
}

/** One region column's kept nodes: per kept level up to the column level, their entries. */
export interface FarColumnResult {
  readonly rx: number;
  readonly rz: number;
  /** [level, entries] for levels minLevel … columnLevel. */
  readonly levels: ReadonlyArray<readonly [number, RegionEntry[]]>;
}

/**
 * Builds a region column's kept nodes (levels `minLevel` … the column
 * level, where one node spans the region) from the world's chunks: what a
 * worker does for one column of a full build.
 */
export function farColumnNodes(world: FarWorldSource, rx: number, rz: number, minLevel = FAR_MIN_LEVEL): FarColumnResult {
  const top = world.columnLevel;
  if (minLevel > top) throw new RangeError(`lowest far level ${minLevel} is above the column level ${top}`);
  const store = pickStore(world.grid);
  const out = new Map<number, RegionEntry[]>();
  for (let l = minLevel; l <= top; l++) out.set(l, []);
  for (const ny of world.columnRows(rx, rz)) {
    buildFarNode(world, { level: top, nx: rx, ny, nz: rz }, (n, cells) => {
      if (n.level < minLevel) return;
      const e = cellsEntry(world.grid, store, n, cells);
      if (e !== null) out.get(n.level)!.push(e);
    });
  }
  return { rx, rz, levels: [...out.entries()] };
}

/** What a far cache build did. */
export interface FarBuildReport {
  readonly manifest: FarCacheManifest;
  /** Nodes kept per level (index: level). */
  readonly nodes: number[];
  readonly bytes: number;
  readonly ms: number;
}

/** Runs a full build's region columns (in workers, or here one after another). */
export type FarColumnRunner = (columns: ReadonlyArray<readonly [number, number]>, minLevel: number) => AsyncIterable<FarColumnResult> | Iterable<FarColumnResult>;

/**
 * Builds a world's far cache from its region files into `cacheDir`
 * (replacing what is there): the region columns through `run` (default: in
 * this thread, one after another), then the levels above the column level
 * from their nodes. Written into a fresh folder beside `cacheDir` and moved
 * into place last, so a cache folder is always whole.
 */
export async function buildFarCache(worldDir: string, cacheDir: string, opts: { minLevel?: number; run?: FarColumnRunner } = {}): Promise<FarBuildReport> {
  const t0 = performance.now();
  const world = new FarWorldSource(worldDir);
  const minLevel = opts.minLevel ?? FAR_MIN_LEVEL;
  const columns = world.columns();
  const columnLevel = world.columnLevel;
  const side = chunksPerRegionSide(world.grid, world.manifest.footprint);
  const xs = columns.map((c) => c[0]);
  const zs = columns.map((c) => c[1]);
  const span = columns.length === 0 ? 1 : Math.max(Math.max(...xs) - Math.min(...xs) + 1, Math.max(...zs) - Math.min(...zs) + 1) * side;
  const maxLevel = Math.max(columnLevel, farTopLevel(span, minLevel));
  const byLevel = new Map<number, Map<string, RegionEntry>>();
  for (let l = minLevel; l <= maxLevel; l++) byLevel.set(l, new Map());
  const run = opts.run ?? ((cols, min) => cols.map(([rx, rz]) => farColumnNodes(world, rx, rz, min)));
  for await (const r of run(columns, minLevel)) {
    for (const [level, entries] of r.levels) for (const e of entries) byLevel.get(level)!.set(mipNodeKey({ level, nx: e.cx, ny: e.cy, nz: e.cz }), e);
  }
  // The levels above a region's size, from the column level's nodes.
  const store = pickStore(world.grid);
  const memo = new Map<string, FarCells>();
  const decode = (n: MipNode): FarCells => {
    const e = byLevel.get(n.level)?.get(mipNodeKey(n));
    if (e === undefined) return null;
    return readCells(world.grid, store, 'uniform' in e ? { cx: n.nx, cy: n.ny, cz: n.nz, kind: 'uniform', value: e.uniform } : { cx: n.nx, cy: n.ny, cz: n.nz, kind: 'stored', bytes: e.stored, raw: e.raw });
  };
  const upper: FarSource = {
    grid: world.grid,
    chunk: () => {
      throw new Error('the far levels above a region are built from its nodes, never from chunks');
    },
    cached: (n) => (n.level === columnLevel ? decode(n) : n.level > columnLevel ? (memo.get(mipNodeKey(n)) ?? null) : undefined),
  };
  for (let l = columnLevel + 1; l <= maxLevel; l++) {
    const parents = new Map<string, MipNode>();
    for (const e of byLevel.get(l - 1)!.values()) {
      const p = { level: l, nx: e.cx >> 1, ny: e.cy >> 1, nz: e.cz >> 1 };
      parents.set(mipNodeKey(p), p);
    }
    const list = [...parents.values()].sort((a, b) => a.nx - b.nx || a.ny - b.ny || a.nz - b.nz);
    for (const p of list) {
      const cells = buildFarNode({ ...upper, cached: (n) => (n.level === l ? undefined : upper.cached!(n)) }, p);
      memo.set(mipNodeKey(p), cells);
      const e = cellsEntry(world.grid, store, p, cells);
      if (e !== null) byLevel.get(l)!.set(mipNodeKey(p), e);
    }
    // Only the level just built is read by the next one.
    for (const k of [...memo.keys()]) if (!k.startsWith(`${l}:`)) memo.delete(k);
  }
  const fresh = `${cacheDir}.building`;
  rmSync(fresh, { recursive: true, force: true });
  mkdirSync(fresh, { recursive: true });
  const levels: FarCacheLevel[] = [];
  const id = hexToBytes(world.manifest.worldId);
  for (let l = minLevel; l <= maxLevel; l++) levels.push(writeLevel(join(fresh, farLevelFolder(l)), world.grid, id, world.manifest.footprint, l, byLevel.get(l)!.values()));
  const manifest: FarCacheManifest = { format: FAR_CACHE_FORMAT, worldId: world.manifest.worldId, edge: world.manifest.edge, footprint: world.manifest.footprint, minLevel, maxLevel, revision: world.manifest.revision, levels };
  writeFileSync(join(fresh, FAR_CACHE_MANIFEST), manifestBytes(manifest));
  rmSync(cacheDir, { recursive: true, force: true });
  renameSync(fresh, cacheDir);
  const nodes: number[] = [];
  for (let l = 0; l <= maxLevel; l++) nodes.push(levels.find((x) => x.level === l)?.nodes ?? 0);
  return { manifest, nodes, bytes: levels.reduce((s, l) => s + l.bytes, 0), ms: performance.now() - t0 };
}

/** Groups entries into the level's region files and writes them; returns the level's record. */
function writeLevel(dir: string, grid: ChunkGrid, worldId: Uint8Array, footprint: RegionFootprint, level: number, entries: Iterable<RegionEntry>): FarCacheLevel {
  mkdirSync(dir, { recursive: true });
  const side = chunksPerRegionSide(grid, footprint);
  const files = new Map<string, { rx: number; ry: number; rz: number; entries: RegionEntry[] }>();
  let nodes = 0;
  for (const e of entries) {
    const rx = Math.floor(e.cx / side), ry = Math.floor(e.cy / side), rz = Math.floor(e.cz / side);
    const name = regionFileName(FAR_LAYOUT, rx, ry, rz);
    let f = files.get(name);
    if (f === undefined) files.set(name, (f = { rx, ry, rz, entries: [] }));
    f.entries.push(e);
    nodes++;
  }
  let bytes = 0;
  for (const [name, f] of files) {
    const b = writeRegion({ worldId, gridId: WORLD_GRID_ID, layout: FAR_LAYOUT, grid, footprint, rx: f.rx, ry: f.ry, rz: f.rz, compressor: 'zstd' }, f.entries);
    writeFileSync(join(dir, name), b);
    bytes += b.length;
  }
  return { level, regions: [...files.keys()].sort(), nodes, bytes };
}

/** What a rebuild after an edit did. */
export interface FarRebuildReport {
  /** The nodes built again: every ancestor of the changed chunks at the kept levels, lowest level first. */
  readonly rebuilt: readonly MipNode[];
  /** The level files written (`L<level>/<name>`), sorted. */
  readonly files: readonly string[];
  readonly ms: number;
}

/**
 * Builds again exactly the kept ancestors of `chunks` (changed in the world
 * folder since the cache was built) and rewrites only the level files
 * holding them, then the manifest (at the world's revision now). Untouched
 * children are read from the cache, so the result equals a full build.
 */
export function rebuildFarCache(worldDir: string, cacheDir: string, chunks: Iterable<{ readonly cx: number; readonly cy: number; readonly cz: number }>): FarRebuildReport {
  const t0 = performance.now();
  const world = new FarWorldSource(worldDir);
  const cache = new FarCacheReader(cacheDir);
  const m = cache.manifest;
  if (m.worldId !== world.manifest.worldId || m.edge !== world.manifest.edge || m.footprint !== world.manifest.footprint) throw new Error('the far cache is of another world: build it again');
  const ancestors = farAncestors(chunks, m.minLevel, m.maxLevel);
  const stale = new Set(ancestors.map(mipNodeKey));
  const built = new Map<string, FarCells>();
  const src: FarSource = {
    grid: world.grid,
    chunk: (cx, cy, cz) => world.chunk(cx, cy, cz),
    cached: (n) => {
      if (n.level < m.minLevel) return undefined;
      const key = mipNodeKey(n);
      return stale.has(key) ? built.get(key) : cache.node(n);
    },
  };
  for (const n of ancestors) built.set(mipNodeKey(n), buildFarNode(src, n));
  // Rewrite the files holding a rebuilt node: their other entries carried over as stored.
  const store = pickStore(world.grid);
  const side = chunksPerRegionSide(world.grid, m.footprint);
  const id = hexToBytes(m.worldId);
  const touched = new Map<string, { level: number; rx: number; ry: number; rz: number }>();
  for (const n of ancestors) {
    const rx = Math.floor(n.nx / side), ry = Math.floor(n.ny / side), rz = Math.floor(n.nz / side);
    touched.set(`${farLevelFolder(n.level)}/${regionFileName(FAR_LAYOUT, rx, ry, rz)}`, { level: n.level, rx, ry, rz });
  }
  const levels = new Map(m.levels.map((l) => [l.level, { ...l, regions: new Set(l.regions) }]));
  const written: string[] = [];
  for (const [path, t] of [...touched.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const dir = join(cacheDir, farLevelFolder(t.level));
    const name = regionFileName(FAR_LAYOUT, t.rx, t.ry, t.rz);
    const entries = new Map<string, RegionEntry>();
    const lv = levels.get(t.level)!;
    if (lv.regions.has(name)) {
      const bytes = new Uint8Array(readFileSync(join(dir, name)));
      const index = RegionIndex.parse(bytes, { expect: { worldId: id, gridId: WORLD_GRID_ID, layout: FAR_LAYOUT, grid: world.grid, footprint: m.footprint, rx: t.rx, ry: t.ry, rz: t.rz } });
      for (let i = 0; i < index.size; i++) {
        const e = index.entry(i, bytes)!;
        entries.set(mipNodeKey({ level: t.level, nx: e.cx, ny: e.cy, nz: e.cz }), e);
      }
    }
    for (const n of ancestors) {
      if (n.level !== t.level || Math.floor(n.nx / side) !== t.rx || Math.floor(n.ny / side) !== t.ry || Math.floor(n.nz / side) !== t.rz) continue;
      const key = mipNodeKey(n);
      const e = cellsEntry(world.grid, store, n, built.get(key)!);
      if (e === null) entries.delete(key);
      else entries.set(key, e);
    }
    mkdirSync(dir, { recursive: true });
    const bytes = entries.size === 0 ? null : writeRegion({ worldId: id, gridId: WORLD_GRID_ID, layout: FAR_LAYOUT, grid: world.grid, footprint: m.footprint, rx: t.rx, ry: t.ry, rz: t.rz, compressor: 'zstd' }, entries.values());
    writeCacheFile(dir, name, bytes);
    if (bytes === null) lv.regions.delete(name);
    else lv.regions.add(name);
    written.push(path);
  }
  const counted: FarCacheLevel[] = [...levels.values()].sort((a, b) => a.level - b.level).map((l) => countLevel(join(cacheDir, farLevelFolder(l.level)), world.grid, id, m.footprint, l.level, [...l.regions].sort()));
  const manifest: FarCacheManifest = { ...m, revision: world.manifest.revision, levels: counted };
  writeCacheFile(cacheDir, FAR_CACHE_MANIFEST, manifestBytes(manifest));
  return { rebuilt: ancestors, files: written, ms: performance.now() - t0 };
}

function countLevel(dir: string, grid: ChunkGrid, worldId: Uint8Array, footprint: RegionFootprint, level: number, regions: string[]): FarCacheLevel {
  let nodes = 0;
  let bytes = 0;
  for (const name of regions) {
    const b = new Uint8Array(readFileSync(join(dir, name)));
    const at = parseRegionFileName(FAR_LAYOUT, name)!;
    nodes += RegionIndex.parse(b, { expect: { worldId, gridId: WORLD_GRID_ID, layout: FAR_LAYOUT, grid, footprint, ...at } }).size;
    bytes += b.length;
  }
  return { level, regions, nodes, bytes };
}

/** Every file of a far cache (manifest first, then level files), relative to its folder: what an export ships. */
export function farCacheFiles(cacheDir: string): string[] {
  if (!existsSync(join(cacheDir, FAR_CACHE_MANIFEST))) return [];
  const m = readFarCacheManifest(cacheDir);
  const out = [FAR_CACHE_MANIFEST];
  // Only the files the manifest lists: anything else in a level folder is debris, never shipped.
  for (const l of m.levels) for (const name of l.regions) out.push(`${farLevelFolder(l.level)}/${name}`);
  return out;
}
