/**
 * A project's voxel worlds on disk: region files kept current under edit
 * commands (dirty chunks only, re-packing only those chunks, atomic
 * replace through the workspace's durable write, damaged chunks repaired
 * or carried over verbatim), undo records spilled to files, and game saves
 * made against the shipped world's region files.
 *
 * Region files are zstd-compressed per chunk at level 3 (the at-rest pick;
 * exports may recompress harder); the voxel package is pure and takes the
 * compressor as a function, so Node's own zstd is plugged in here.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import {
  applyEdit,
  applyUndo,
  baseChunkHash,
  chunkKey,
  chunkOfKey,
  chunksPerRegionSide,
  createDenseChunk,
  createWorldStore,
  DirtyTracker,
  exportOrAir,
  packRegionChunk,
  parseRegionFileName,
  regionChunkCodecBytes,
  regionFileName,
  RegionIndex,
  repairChunks,
  saveChunkOf,
  writeRegion,
  type ChunkCoord,
  type ChunkGrid,
  type ChunkUndo,
  type EditOutcome,
  type PaletteStore,
  type RegionChunkRead,
  type RegionEntry,
  type RegionExpect,
  type RegionFootprint,
  type RegionLayout,
  type RegionTile,
  type RepairOutcome,
  type RepairSource,
  type SaveChunk,
  type SaveFile,
  type SaveJob,
  type StampResolver,
  type UndoSpill,
  type VoxelEditCommand,
} from '@thirdlight/voxel';
import { sha256HexNative } from './digest';
import { defaultOps, errnoOf, writeAtomic, type WriteOps } from './write';

/** zstd level of chunk frames at rest (the storage pick: level 3; level 19 only pays at export). */
export const REGION_ZSTD_LEVEL = 3;

export const zstdCompress = (b: Uint8Array): Uint8Array => zstdCompressSync(b, { params: { [constants.ZSTD_c_compressionLevel]: REGION_ZSTD_LEVEL } });
export const zstdDecompress = (b: Uint8Array): Uint8Array => zstdDecompressSync(b);

/** The world store of the storage pick: a record palette per chunk, sparse 4³ bricks in memory, the bit-packed body at rest. */
export function pickStore(grid: ChunkGrid): PaletteStore {
  return createWorldStore(grid, 'pick');
}

/** A region file's name as the region writer makes it. */
export const REGION_FILE_NAME_RE = /^[a-z0-9_.-]{1,64}\.vxr$/;

/**
 * The region file names found in a folder, sorted: what a world without a
 * list of its own (an old manifest being lifted, a bench folder) says it has.
 */
export function listRegionFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((n) => REGION_FILE_NAME_RE.test(n)).sort() : [];
}

/** Region index of a chunk on one axis. */
export function regionOf(grid: ChunkGrid, footprint: RegionFootprint, chunk: number): number {
  return Math.floor(chunk / chunksPerRegionSide(grid, footprint));
}

/** A region file's address: layout, footprint and indices (ry 0 in a column). */
export interface RegionAddress {
  layout: RegionLayout;
  footprint: RegionFootprint;
  rx: number;
  ry: number;
  rz: number;
}

export function addressOf(grid: ChunkGrid, layout: RegionLayout, footprint: RegionFootprint, c: ChunkCoord): RegionAddress {
  return { layout, footprint, rx: regionOf(grid, footprint, c.cx), ry: layout === 'stacked' ? regionOf(grid, footprint, c.cy) : 0, rz: regionOf(grid, footprint, c.cz) };
}

export function addressName(a: RegionAddress): string {
  return regionFileName(a.layout, a.rx, a.ry, a.rz);
}

/** A chunk's region entry from the store (null when it is air). */
export function storeEntry(store: PaletteStore, c: ChunkCoord): RegionEntry | null {
  const bytes = store.encodeChunk(c.cx, c.cy, c.cz);
  return bytes === null ? null : packRegionChunk(store.grid, c.cx, c.cy, c.cz, bytes, 'zstd', zstdCompress);
}

/** Imports what a region read returned into a store (air reads drop the chunk). */
export function importRead(store: PaletteStore, r: RegionChunkRead): void {
  const bytes = regionChunkCodecBytes(store.grid, r, zstdDecompress);
  if (bytes === null) store.dropChunk(r.cx, r.cy, r.cz);
  else store.decodeChunk(r.cx, r.cy, r.cz, bytes);
}

/**
 * Replaces `dir/name` with `bytes` through the workspace's durable write
 * (temp file in the same folder, fsync, rename, folder fsync, read back),
 * only if the file still holds what this process last saw there
 * (`expect`: its hash, or null when it did not exist). Null bytes delete
 * the file (a region that became all air). Returns the new hash, or why not.
 */
export function replaceFile(dir: string, name: string, bytes: Uint8Array | null, expect: string | null, ops?: WriteOps): { ok: true; hash: string | null } | { ok: false; why: string } {
  if (bytes === null) {
    rmSync(join(dir, name), { force: true });
    return { ok: true, hash: null };
  }
  const out = writeAtomic({ dir, target: name, bytes, allowedPreHashes: expect === null ? null : [expect], previousHash: expect, ...(ops !== undefined ? { ops } : {}) });
  if (out.ok) return { ok: true, hash: sha256HexNative(bytes) };
  return { ok: false, why: out.external !== undefined ? 'changed on disk by someone else' : out.unreadable !== undefined ? 'unreadable' : `write failed (${out.failed?.onDiskState ?? '?'}${out.failed?.errno !== undefined ? `, ${out.failed.errno}` : ''})` };
}

/** One file of a staged write: replaced only if it still holds `expect` (its hash; null: it must be absent). */
export interface StagedFile {
  readonly dir: string;
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly expect: string | null;
}

/**
 * What a staged write did. `external` and `failed`: nothing was replaced.
 * `partial`: the files in `written` hold their new bytes, those in
 * `notWritten` their old ones (a rename or the folder flush failed after
 * the first rename).
 */
export type StagedOutcome =
  | { readonly ok: true; readonly hashes: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly kind: 'external'; readonly changed: readonly string[] }
  | { readonly ok: false; readonly kind: 'failed'; readonly why: string }
  | { readonly ok: false; readonly kind: 'partial'; readonly why: string; readonly written: readonly string[]; readonly notWritten: readonly string[]; readonly hashes: ReadonlyMap<string, string> };

let stagedNonce = 0;

/**
 * Replaces several files as one change, as far as a file system allows:
 * every file's new bytes are written and flushed to a temp file beside it
 * first (same folder, so same disk), then every target is checked to still
 * hold what this process last saw there, and only then are the temp files
 * renamed over their targets, in the given order (put the file that says
 * which others are current, a manifest, last). A failed write or a changed
 * target replaces nothing; a rename failing midway is reported with exactly
 * which files hold the new bytes. Keys of `hashes`: `dir/name`.
 */
export function writeFilesStaged(files: readonly StagedFile[], ops: WriteOps = defaultOps): StagedOutcome {
  const path = (f: StagedFile): string => join(f.dir, f.name);
  const temps: string[] = [];
  const dropTemps = (from = 0): void => {
    for (let k = from; k < temps.length; k++) ops.removeFile(temps[k]!);
  };
  for (const f of files) {
    const tmp = join(f.dir, `.${f.name}.tmp-${process.pid}-s${++stagedNonce}`);
    let fd: number | null = null;
    try {
      fd = ops.openTempFile(tmp);
      temps.push(tmp);
      ops.writeAll(fd, f.bytes);
      ops.fsyncFile(fd);
      const closing = fd;
      fd = null;
      ops.closeFile(closing);
    } catch (e) {
      if (fd !== null) {
        try {
          ops.closeFile(fd);
        } catch {
          // the write already failed; that error is the one reported
        }
      }
      dropTemps();
      return { ok: false, kind: 'failed', why: `${f.name}: staging failed (${errnoOf(e) ?? (e instanceof Error ? e.message : String(e))}); no file was replaced` };
    }
  }
  const changed: string[] = [];
  for (const f of files) {
    let now: string | null;
    try {
      now = sha256HexNative(ops.readFile(path(f)));
    } catch (e) {
      const en = errnoOf(e);
      if (en !== 'ENOENT') {
        dropTemps();
        return { ok: false, kind: 'failed', why: `${f.name}: unreadable (${en ?? '?'}); no file was replaced` };
      }
      now = null;
    }
    if (now !== f.expect) changed.push(f.name);
  }
  if (changed.length > 0) {
    dropTemps();
    return { ok: false, kind: 'external', changed };
  }
  const hashes = new Map<string, string>();
  for (let k = 0; k < files.length; k++) {
    const f = files[k]!;
    try {
      ops.renameFile(temps[k]!, path(f));
      hashes.set(path(f), sha256HexNative(f.bytes));
    } catch (e) {
      dropTemps(k);
      if (k === 0) return { ok: false, kind: 'failed', why: `${f.name}: rename failed (${errnoOf(e) ?? '?'}); no file was replaced` };
      return { ok: false, kind: 'partial', why: `${f.name}: rename failed (${errnoOf(e) ?? '?'})`, written: files.slice(0, k).map((g) => g.name), notWritten: files.slice(k).map((g) => g.name), hashes };
    }
  }
  for (const dir of new Set(files.map((f) => f.dir))) {
    try {
      ops.fsyncDir(dir);
    } catch (e) {
      // Every file holds its new bytes, but whether they survive a crash is not known.
      return { ok: false, kind: 'partial', why: `${dir}: folder flush failed (${errnoOf(e) ?? '?'})`, written: files.map((g) => g.name), notWritten: [], hashes };
    }
  }
  return { ok: true, hashes };
}

/** Undo records past the memory budget, one file each in a scratch folder. */
export class DiskUndoSpill implements UndoSpill {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  private path(id: number): string {
    return join(this.dir, `u${id}.tlvu`);
  }
  async write(id: number, bytes: Uint8Array): Promise<void> {
    writeFileSync(this.path(id), bytes);
  }
  async read(id: number): Promise<Uint8Array> {
    return new Uint8Array(readFileSync(this.path(id)));
  }
  async remove(id: number): Promise<void> {
    rmSync(this.path(id), { force: true });
  }
}

export interface WorldDirOptions {
  readonly grid: ChunkGrid;
  readonly worldId: Uint8Array;
  readonly layout: RegionLayout;
  readonly footprint: RegionFootprint;
  readonly gridId?: number;
}

interface RegionFileState {
  readonly address: RegionAddress;
  entries: Map<number, RegionEntry>;
  /** Hash of the bytes on disk as this process last wrote or read them (null: no file). */
  hash: string | null;
  /** Whether its chunks are in the store (a world opened on demand loads a file when an edit reaches it). */
  loaded: boolean;
  /** The store bytes its chunks took when loaded (what dropping it frees). */
  residentBytes: number;
}

/** A save job with its file's bytes, prepared off the live state. */
export interface PreparedSave {
  readonly job: SaveJob;
  readonly name: string;
  readonly entries: Map<number, RegionEntry>;
  readonly bytes: Uint8Array | null;
  readonly repacked: number;
}

/** A chunk no source could repair: unloaded, edits refused, its bytes carried over verbatim. */
export interface DamagedChunk {
  readonly file: string;
  readonly reasons: readonly string[];
}

/**
 * Store bytes a world opened on demand keeps of its clean region files
 * (least recently used dropped first), per open world: files with chunks
 * not saved yet are kept whatever this says, so an edit never loses cells.
 */
export const REGION_WORLD_RESIDENT_BYTES = 256 * 1024 * 1024;

/**
 * One grid's region files in a folder, edited through edit commands and
 * saved by rewriting only files with dirty chunks, re-packing only those
 * chunks. Opened whole ({@link RegionWorld.open}: every chunk in the store,
 * what tools and tests read) or on demand ({@link RegionWorld.scan}: every
 * listed file checked and hashed, its chunks loaded only when an edit
 * reaches them and dropped again once saved, within a byte budget), which
 * is how the backend serves worlds of any size in bounded memory.
 */
export class RegionWorld {
  readonly store: PaletteStore;
  readonly tracker = new DirtyTracker();
  readonly gridId: number;
  readonly files = new Map<string, RegionFileState>();
  readonly damaged = new Map<number, DamagedChunk>();
  /**
   * Region files the world lists that are missing, unreadable or of another
   * tile: why, by name. Their chunks are not loaded and cannot be edited, and
   * the files stay listed, so a reader reports them damaged instead of air.
   */
  readonly damagedRegions = new Map<string, string>();
  /** Files of regions that became all air: removed once the world no longer lists them ({@link flushRemovals}). */
  private readonly removals = new Set<string>();
  /** Opened on demand: the store bytes of clean files kept (null: opened whole, every file loaded). */
  private budget: number | null = null;
  /** Loaded files, least recently used first (opened on demand only). */
  private readonly order = new Set<string>();
  private sources: readonly RepairSource[] = [];
  /** Files loaded and dropped since opening (opened on demand). */
  readonly counters = { loads: 0, drops: 0 };

  private constructor(
    readonly dir: string,
    readonly opts: WorldDirOptions,
  ) {
    this.store = pickStore(opts.grid);
    this.gridId = opts.gridId ?? 0;
  }

  /** A new world folder written from a store's chunks (every file, atomically). */
  static create(dir: string, opts: WorldDirOptions, from: PaletteStore): RegionWorld {
    mkdirSync(dir, { recursive: true });
    const w = new RegionWorld(dir, opts);
    const c: ChunkCoord = { cx: 0, cy: 0, cz: 0 };
    for (const key of from.chunkKeys()) {
      chunkOfKey(opts.grid, key, c);
      const e = storeEntry(from, c);
      if (e === null) continue;
      w.fileOf(c).entries.set(key, e);
      importRead(w.store, 'uniform' in e ? { ...c, kind: 'uniform', value: e.uniform } : { ...c, kind: 'stored', bytes: e.stored, raw: e.raw });
    }
    for (const [name, f] of w.files) {
      const r = replaceFile(dir, name, w.bytesOf(f.address, f.entries), null);
      if (!r.ok) throw new Error(`${name}: ${r.why}`);
      f.hash = r.hash;
    }
    return w;
  }

  /**
   * Opens a world folder: the chunks of every region file the world lists
   * (`listed`, its manifest's list; a file it does not list is never read)
   * into the store. A listed file that is missing, unreadable or of another
   * tile is a damaged region, never air. A damaged chunk is repaired from
   * the first source that has it (and is then dirty, so the next save
   * writes it sound) or kept damaged.
   */
  static async open(dir: string, opts: WorldDirOptions, listed: readonly string[], sources: readonly RepairSource[] = []): Promise<{ world: RegionWorld; repairs: RepairOutcome[] }> {
    const w = new RegionWorld(dir, opts);
    const broken: { c: ChunkCoord; file: string; entry: RegionEntry | null }[] = [];
    for (const name of [...listed].sort()) {
      let bytes: Uint8Array;
      let index: RegionIndex;
      try {
        ({ index, bytes } = w.readFile(name));
      } catch (e) {
        // A listed file that cannot be read is reported, never read as air.
        w.damagedRegions.set(name, e instanceof Error ? e.message : String(e));
        continue;
      }
      const h = index.header;
      const f: RegionFileState = { address: { layout: h.layout, footprint: opts.footprint, rx: h.rx, ry: h.ry, rz: h.rz }, entries: new Map(), hash: sha256HexNative(bytes), loaded: true, residentBytes: 0 };
      w.files.set(name, f);
      w.importFile(name, f, index, bytes, broken);
    }
    const repairs = await w.repair(broken, sources);
    return { world: w, repairs };
  }

  /**
   * Opens a world folder on demand: every file the world lists is read once
   * to check it holds its tile and to take its hash (one file at a time, so
   * opening holds no more than one file), and its chunks are loaded only
   * when an edit reaches them ({@link ensure}). Clean files are dropped
   * again past `budgetBytes` of store memory ({@link trim}). A listed file
   * that is missing, unreadable or of another tile is a damaged region, as
   * when opened whole; a damaged chunk is found when its file loads.
   */
  static scan(dir: string, opts: WorldDirOptions, listed: readonly string[], budgetBytes = REGION_WORLD_RESIDENT_BYTES, sources: readonly RepairSource[] = []): RegionWorld {
    const w = new RegionWorld(dir, opts);
    w.budget = budgetBytes;
    w.sources = sources;
    for (const name of [...listed].sort()) {
      try {
        const { index, bytes } = w.readFile(name);
        const h = index.header;
        w.files.set(name, { address: { layout: h.layout, footprint: opts.footprint, rx: h.rx, ry: h.ry, rz: h.rz }, entries: new Map(), hash: sha256HexNative(bytes), loaded: false, residentBytes: 0 });
      } catch (e) {
        w.damagedRegions.set(name, e instanceof Error ? e.message : String(e));
      }
    }
    return w;
  }

  /** A listed file's bytes and table, checked against the tile its name gives. Throws when it cannot be read. */
  private readFile(name: string): { index: RegionIndex; bytes: Uint8Array } {
    const at = parseRegionFileName(this.opts.layout, name);
    if (at === null) throw new Error(`not a ${this.opts.layout} region file name`);
    const expect: RegionExpect = { worldId: this.opts.worldId, gridId: this.gridId, layout: this.opts.layout, grid: this.opts.grid, footprint: this.opts.footprint, ...at };
    const bytes = new Uint8Array(readFileSync(join(this.dir, name)));
    return { index: RegionIndex.parse(bytes, { expect }), bytes };
  }

  /** A file's chunks into the store and its entries; chunks that do not read or decode go to `broken`. */
  private importFile(name: string, f: RegionFileState, index: RegionIndex, bytes: Uint8Array, broken: { c: ChunkCoord; file: string; entry: RegionEntry | null }[]): void {
    const grid = this.opts.grid;
    let resident = 0;
    for (let i = 0; i < index.size; i++) {
      const read = index.read(i, bytes);
      const key = chunkKey(grid, read.cx, read.cy, read.cz);
      const entry = index.entry(i, bytes);
      if (read.kind !== 'damaged') {
        try {
          importRead(this.store, read);
          f.entries.set(key, entry!);
          resident += this.store.chunkBytes(read.cx, read.cy, read.cz);
          continue;
        } catch {
          // Bytes that pass their checksum but do not decode are damage too.
        }
      }
      broken.push({ c: { cx: read.cx, cy: read.cy, cz: read.cz }, file: name, entry });
    }
    f.residentBytes = resident;
  }

  /** Repairs broken chunks from the sources, or keeps them damaged (unloaded, edits refused). */
  private async repair(broken: { c: ChunkCoord; file: string; entry: RegionEntry | null }[], sources: readonly RepairSource[]): Promise<RepairOutcome[]> {
    const grid = this.opts.grid;
    const repairs = await repairChunks(grid, this.gridId, broken.map((b) => b.c), sources);
    repairs.forEach((r, k) => {
      const b = broken[k]!;
      const key = chunkKey(grid, b.c.cx, b.c.cy, b.c.cz);
      const f = this.files.get(b.file)!;
      if (r.repaired) {
        if (r.bytes === null) this.store.dropChunk(b.c.cx, b.c.cy, b.c.cz);
        else this.store.decodeChunk(b.c.cx, b.c.cy, b.c.cz, r.bytes);
        // The file still holds the damaged bytes: dirty, so the next save writes the repaired chunk.
        f.entries.delete(key);
        this.tracker.edited({ grid: this.gridId, key });
      } else {
        if (b.entry !== null) f.entries.set(key, b.entry);
        this.damaged.set(key, { file: b.file, reasons: r.reasons });
      }
    });
    return repairs;
  }

  /**
   * Loads the region files holding these chunks that are not loaded yet
   * (opened on demand; opened whole, everything already is) and marks the
   * files used most recently. A file that cannot be read now is a damaged
   * region: its chunks are refused, never edited as air.
   */
  async ensure(chunks: Iterable<Readonly<ChunkCoord>>): Promise<void> {
    if (this.budget === null) return;
    const names = new Set<string>();
    for (const c of chunks) names.add(addressName(addressOf(this.opts.grid, this.opts.layout, this.opts.footprint, c)));
    const broken: { c: ChunkCoord; file: string; entry: RegionEntry | null }[] = [];
    for (const name of names) {
      const f = this.files.get(name);
      if (f === undefined || this.damagedRegions.has(name)) continue;
      this.order.delete(name);
      this.order.add(name);
      if (f.loaded) continue;
      try {
        const { index, bytes } = this.readFile(name);
        if (sha256HexNative(bytes) !== f.hash) throw new Error('changed on disk since the world was opened');
        f.entries = new Map();
        f.loaded = true;
        this.counters.loads++;
        this.importFile(name, f, index, bytes, broken);
      } catch (e) {
        this.damagedRegions.set(name, e instanceof Error ? e.message : String(e));
      }
    }
    if (broken.length > 0) await this.repair(broken, this.sources);
  }

  /** Store bytes of the files loaded now (opened on demand; 0 when opened whole). */
  get residentBytes(): number {
    let n = 0;
    for (const name of this.order) n += this.files.get(name)?.residentBytes ?? 0;
    return n;
  }

  /**
   * Drops clean loaded files, least recently used first, until their store
   * bytes fit the budget (opened on demand). A file with a dirty chunk or a
   * save running stays: its cells exist only here until written.
   */
  trim(): void {
    if (this.budget === null) return;
    let total = this.residentBytes;
    if (total <= this.budget) return;
    const grid = this.opts.grid;
    const dirtyFiles = new Set<string>();
    const c: ChunkCoord = { cx: 0, cy: 0, cz: 0 };
    for (const d of this.tracker.dirty()) {
      if (d.grid !== this.gridId) continue;
      chunkOfKey(grid, d.key, c);
      dirtyFiles.add(addressName(addressOf(grid, this.opts.layout, this.opts.footprint, c)));
    }
    for (const name of [...this.order]) {
      if (total <= this.budget) break;
      const f = this.files.get(name);
      if (f === undefined || dirtyFiles.has(name) || f.hash === null) continue;
      for (const key of f.entries.keys()) {
        chunkOfKey(grid, key, c);
        this.store.dropChunk(c.cx, c.cy, c.cz);
        this.damaged.delete(key);
      }
      f.entries = new Map();
      f.loaded = false;
      total -= f.residentBytes;
      f.residentBytes = 0;
      this.order.delete(name);
      this.counters.drops++;
    }
  }

  private fileOf(c: ChunkCoord): RegionFileState {
    const address = addressOf(this.opts.grid, this.opts.layout, this.opts.footprint, c);
    const name = addressName(address);
    let f = this.files.get(name);
    if (f === undefined) this.files.set(name, (f = { address, entries: new Map(), hash: null, loaded: true, residentBytes: 0 }));
    return f;
  }

  private bytesOf(a: RegionAddress, entries: Map<number, RegionEntry>): Uint8Array | null {
    if (entries.size === 0) return null;
    const tile: RegionTile = { worldId: this.opts.worldId, gridId: this.gridId, layout: a.layout, grid: this.opts.grid, footprint: a.footprint, rx: a.rx, ry: a.ry, rz: a.rz, compressor: 'zstd' };
    return writeRegion(tile, entries.values());
  }

  /** The region files the world lists: every file written, and every listed file that could not be read. */
  listedRegions(): string[] {
    const names = [...this.files].filter(([, f]) => f.hash !== null).map(([n]) => n);
    for (const n of this.damagedRegions.keys()) names.push(n);
    return [...new Set(names)].sort();
  }

  /** Whether a chunk can be edited (its data is sound and loaded). */
  readonly loaded = (gridId: number, cx: number, cy: number, cz: number): boolean => {
    if (gridId !== this.gridId || this.damaged.has(chunkKey(this.opts.grid, cx, cy, cz))) return false;
    const name = addressName(addressOf(this.opts.grid, this.opts.layout, this.opts.footprint, { cx, cy, cz }));
    // A file the world lists but has not loaded is not air: its chunks wait for {@link ensure}.
    return !this.damagedRegions.has(name) && this.files.get(name)?.loaded !== false;
  };

  /** Applies an edit command (refused before any write when it reaches a damaged chunk). */
  edit(cmd: VoxelEditCommand, stamps?: StampResolver): EditOutcome {
    const out = applyEdit({ store: (id) => (id === this.gridId ? this.store : undefined) }, cmd, { loaded: this.loaded, ...(stamps !== undefined ? { stamps } : {}) });
    for (const u of out.chunks) this.tracker.edited({ grid: u.grid, key: chunkKey(this.opts.grid, u.cx, u.cy, u.cz) });
    return out;
  }

  /** Writes an undo record back (an undo transaction): its chunks are edited again. */
  undo(record: readonly ChunkUndo[]): void {
    applyUndo({ store: (id) => (id === this.gridId ? this.store : undefined) }, record);
    for (const u of record) this.tracker.edited({ grid: u.grid, key: chunkKey(this.opts.grid, u.cx, u.cy, u.cz) });
  }

  /**
   * Starts a save job per file that holds dirty chunks and prepares its
   * bytes from the state now (re-packing only the dirty chunks). Files with
   * a save job still running are skipped (their chunks stay dirty).
   */
  prepareSaves(): PreparedSave[] {
    const grid = this.opts.grid;
    const byFile = new Map<string, number[]>();
    const c: ChunkCoord = { cx: 0, cy: 0, cz: 0 };
    for (const d of this.tracker.dirty()) {
      if (d.grid !== this.gridId || this.damaged.has(d.key)) continue;
      chunkOfKey(grid, d.key, c);
      const name = addressName(addressOf(grid, this.opts.layout, this.opts.footprint, c));
      let list = byFile.get(name);
      if (list === undefined) byFile.set(name, (list = []));
      list.push(d.key);
    }
    const out: PreparedSave[] = [];
    for (const [name, keys] of byFile) {
      const job = this.tracker.beginSave(name, keys.map((key) => ({ grid: this.gridId, key })));
      if (job === null) continue;
      chunkOfKey(grid, keys[0]!, c);
      const f = this.fileOf(c);
      const entries = new Map(f.entries);
      for (const key of keys) {
        const e = storeEntry(this.store, chunkOfKey(grid, key));
        if (e === null) entries.delete(key);
        else entries.set(key, e);
      }
      out.push({ job, name, entries, bytes: this.bytesOf(f.address, entries), repacked: keys.length });
    }
    return out;
  }

  /** Commits a prepared save (atomic replace); refused when its job expired, failed when the write did. */
  commit(p: PreparedSave, ops?: WriteOps): { ok: boolean; why?: string } {
    const f = this.files.get(p.name) ?? this.fileOf(chunkOfKey(this.opts.grid, p.job.chunks[0]!.key));
    let why: string | undefined;
    const r = this.tracker.commitSave(p.job.id, () => {
      if (p.bytes === null) {
        // Removed only once the world stops listing it: a file listed but gone would read as damaged.
        f.hash = null;
        f.entries = p.entries;
        this.removals.add(p.name);
        return true;
      }
      this.removals.delete(p.name);
      const w = replaceFile(this.dir, p.name, p.bytes, f.hash, ops);
      if (!w.ok) {
        why = w.why;
        return false;
      }
      f.hash = w.hash;
      f.entries = p.entries;
      return true;
    });
    return r.ok ? { ok: true } : { ok: false, why: why ?? r.reason };
  }

  /**
   * Commits prepared saves as one staged write ({@link writeFilesStaged}),
   * with `after` (e.g. the world's manifest) renamed last. A save whose job
   * expired is left out. Files written take their new state; the chunks of
   * any file not written stay dirty, so a later save writes them. A region
   * that became all air counts as saved only when everything was written
   * (its file goes once the manifest no longer lists it).
   */
  commitAll(prepared: readonly PreparedSave[], after: readonly StagedFile[] = [], ops?: WriteOps): StagedOutcome {
    const live = prepared.filter((p) => this.tracker.isLive(p.job.id));
    const writes = live.filter((p) => p.bytes !== null);
    const files: StagedFile[] = [...writes.map((p) => ({ dir: this.dir, name: p.name, bytes: p.bytes!, expect: this.files.get(p.name)?.hash ?? null })), ...after];
    const out = writeFilesStaged(files, ops);
    const written = new Set(out.ok ? files.map((f) => join(f.dir, f.name)) : out.kind === 'partial' ? [...out.hashes.keys()] : []);
    for (const p of live) {
      const f = this.files.get(p.name) ?? this.fileOf(chunkOfKey(this.opts.grid, p.job.chunks[0]!.key));
      this.tracker.commitSave(p.job.id, () => {
        if (p.bytes === null) {
          if (!out.ok) return false;
          f.hash = null;
          f.entries = p.entries;
          this.removals.add(p.name);
          return true;
        }
        if (!written.has(join(this.dir, p.name))) return false;
        this.removals.delete(p.name);
        f.hash = sha256HexNative(p.bytes);
        f.entries = p.entries;
        return true;
      });
    }
    return out;
  }

  /** Deletes the files of regions that became all air (call once the world's list no longer names them). */
  flushRemovals(): void {
    for (const name of this.removals) if (this.files.get(name)?.hash === null) replaceFile(this.dir, name, null, null);
    this.removals.clear();
  }

  /** Saves every dirty file now; returns files and bytes written and chunks re-packed. */
  save(): { files: number; bytes: number; repacked: number } {
    let bytes = 0;
    let repacked = 0;
    const prepared = this.prepareSaves();
    const out = this.commitAll(prepared);
    if (!out.ok) throw new Error(`save: ${out.kind === 'external' ? `changed on disk by someone else: ${out.changed.join(', ')}` : out.why}`);
    for (const p of prepared) {
      bytes += p.bytes?.length ?? 0;
      repacked += p.repacked;
    }
    this.flushRemovals();
    return { files: prepared.length, bytes, repacked };
  }
}

/**
 * The shipped world, read only: a folder of region files, each read whole
 * once (an exported game reads ranges; the save logic only needs a chunk's
 * canonical codec bytes and their hash). Only the files the world lists
 * are read, each checked against the world id and the tile its name gives:
 * a region it does not list is air, and a listed file that is missing,
 * unreadable or of another tile is damaged (its chunks throw), so a save is
 * never made or checked against air standing in for a lost tile.
 */
export class ShippedWorld {
  private readonly cache = new Map<string, { index: RegionIndex; bytes: Uint8Array } | { error: string }>();
  private readonly listed: ReadonlySet<string>;
  constructor(
    readonly dir: string,
    readonly opts: WorldDirOptions,
    regions: readonly string[],
  ) {
    this.listed = new Set(regions);
  }

  /** A chunk's canonical codec bytes (null: air). Throws on a damaged chunk or a listed region that cannot be read. */
  chunkBytes(c: Readonly<ChunkCoord>): Uint8Array | null {
    const f = this.file(c);
    if (f === null) return null;
    if ('error' in f) throw new Error(f.error);
    return this.read(f, c);
  }

  /** The region file holding a chunk (null: the world does not list it, so the chunk is air). */
  private file(c: Readonly<ChunkCoord>): { index: RegionIndex; bytes: Uint8Array } | { error: string } | null {
    const at = addressOf(this.opts.grid, this.opts.layout, this.opts.footprint, c);
    const name = addressName(at);
    if (!this.listed.has(name)) return null;
    let f = this.cache.get(name);
    if (f === undefined) {
      try {
        const bytes = new Uint8Array(readFileSync(join(this.dir, name)));
        const expect: RegionExpect = { worldId: this.opts.worldId, gridId: this.opts.gridId ?? 0, layout: at.layout, grid: this.opts.grid, footprint: at.footprint, rx: at.rx, ry: at.ry, rz: at.rz };
        f = { index: RegionIndex.parse(bytes, { expect }), bytes };
      } catch (e) {
        f = { error: `shipped region ${name} is listed but damaged: ${e instanceof Error ? e.message : String(e)}` };
      }
      this.cache.set(name, f);
    }
    return f;
  }

  private read(f: { index: RegionIndex; bytes: Uint8Array }, c: Readonly<ChunkCoord>): Uint8Array | null {
    const i = f.index.find(c.cx, c.cy, c.cz);
    if (i < 0) return null;
    return regionChunkCodecBytes(this.opts.grid, f.index.read(i, f.bytes), zstdDecompress);
  }

  hash(c: Readonly<ChunkCoord>): Uint8Array {
    return baseChunkHash(this.opts.grid, this.chunkBytes(c));
  }

  /**
   * A repair source: the shipped chunk. A region the shipped world does not
   * list, or cannot read, means the source does not have the chunk, never
   * that it is air: claiming air for a chunk the damaged file stored would
   * drop it silently.
   */
  source(name = 'shipped world'): RepairSource {
    return {
      name,
      chunk: async (_g, c) => {
        const f = this.file(c);
        return f === null || 'error' in f ? undefined : this.read(f, c);
      },
    };
  }
}

/**
 * A game save's entries rebuilt for the chunks touched since the last save
 * (others kept as they were): each touched chunk against its shipped base,
 * dropped when it equals it again.
 */
export function updateSave(prev: SaveFile, shipped: ShippedWorld, store: PaletteStore, gridId: number, touched: Iterable<Readonly<ChunkCoord>>): SaveFile {
  const grid = store.grid;
  const entries = new Map<string, SaveChunk>();
  const id = (g: number, c: Readonly<ChunkCoord>): string => `${g}:${chunkKey(grid, c.cx, c.cy, c.cz)}`;
  for (const c of prev.chunks) entries.set(id(c.grid, c), c);
  const now = createDenseChunk(grid);
  for (const c of touched) {
    exportOrAir(store, c.cx, c.cy, c.cz, now);
    const e = saveChunkOf(grid, gridId, c.cx, c.cy, c.cz, shipped.chunkBytes(c), now);
    if (e === null) entries.delete(id(gridId, c));
    else entries.set(id(gridId, c), e);
  }
  return { worldId: prev.worldId, grid, chunks: [...entries.values()] };
}
