/**
 * The voxel formats on disk, Node side: a world's region files kept under
 * edit commands (dirty chunks only, atomic replace, damaged chunks repaired
 * or carried), undo records spilled to files, and game saves made against
 * the shipped world's region files. What the backend (editor) and an
 * exported game's save code will do, as a reference the tests and the edit
 * bench drive with real files and real zstd.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyEdit,
  applyUndo,
  baseChunkHash,
  chunkKey,
  chunkOfKey,
  createDenseChunk,
  DirtyTracker,
  exportOrAir,
  regionChunkCodecBytes,
  RegionIndex,
  repairChunks,
  saveChunkOf,
  writeRegion,
  type ChunkCoord,
  type ChunkGrid,
  type ChunkUndo,
  type EditOutcome,
  type PaletteStore,
  type RegionEntry,
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
import { writeAtomic, type WriteOps } from '@thirdlight/workspace';
import { addressName, addressOf, importRead, pickStore, storeEntry, zstdDecompress, type RegionAddress } from './regions';

export const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

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
  if (out.ok) return { ok: true, hash: sha256(bytes) };
  return { ok: false, why: out.external !== undefined ? 'changed on disk by someone else' : out.unreadable !== undefined ? 'unreadable' : `write failed (${out.failed?.onDiskState ?? '?'}${out.failed?.errno !== undefined ? `, ${out.failed.errno}` : ''})` };
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
 * One grid's region files in a folder, loaded whole into the picked store
 * (tests and the bench load small worlds; the streaming version is 45.5's),
 * edited through edit commands and saved by rewriting only files with dirty
 * chunks, re-packing only those chunks.
 */
export class RegionWorld {
  readonly store: PaletteStore;
  readonly tracker = new DirtyTracker();
  readonly gridId: number;
  readonly files = new Map<string, RegionFileState>();
  readonly damaged = new Map<number, DamagedChunk>();

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
   * Opens a world folder: every region file's chunks into the store. A
   * damaged chunk is repaired from the first source that has it (and is
   * then dirty, so the next save writes it sound) or kept damaged.
   */
  static async open(dir: string, opts: WorldDirOptions, sources: readonly RepairSource[] = []): Promise<{ world: RegionWorld; repairs: RepairOutcome[] }> {
    const w = new RegionWorld(dir, opts);
    const grid = opts.grid;
    const broken: { c: ChunkCoord; file: string; entry: RegionEntry | null }[] = [];
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.vxr')).sort()) {
      const bytes = new Uint8Array(readFileSync(join(dir, name)));
      const index = RegionIndex.parse(bytes);
      const h = index.header;
      const f: RegionFileState = { address: { layout: h.layout, footprint: opts.footprint, rx: h.rx, ry: h.ry, rz: h.rz }, entries: new Map(), hash: sha256(bytes) };
      w.files.set(name, f);
      for (let i = 0; i < index.size; i++) {
        const read = index.read(i, bytes);
        const key = chunkKey(grid, read.cx, read.cy, read.cz);
        const entry = index.entry(i, bytes);
        if (read.kind !== 'damaged') {
          try {
            importRead(w.store, read);
            f.entries.set(key, entry!);
            continue;
          } catch {
            // Bytes that pass their checksum but do not decode are damage too.
          }
        }
        broken.push({ c: { cx: read.cx, cy: read.cy, cz: read.cz }, file: name, entry });
      }
    }
    const repairs = await repairChunks(grid, w.gridId, broken.map((b) => b.c), sources);
    repairs.forEach((r, k) => {
      const b = broken[k]!;
      const key = chunkKey(grid, b.c.cx, b.c.cy, b.c.cz);
      const f = w.files.get(b.file)!;
      if (r.repaired) {
        if (r.bytes === null) w.store.dropChunk(b.c.cx, b.c.cy, b.c.cz);
        else w.store.decodeChunk(b.c.cx, b.c.cy, b.c.cz, r.bytes);
        // The file still holds the damaged bytes: dirty, so the next save writes the repaired chunk.
        f.entries.delete(key);
        w.tracker.edited({ grid: w.gridId, key });
      } else {
        if (b.entry !== null) f.entries.set(key, b.entry);
        w.damaged.set(key, { file: b.file, reasons: r.reasons });
      }
    });
    return { world: w, repairs };
  }

  private fileOf(c: ChunkCoord): RegionFileState {
    const address = addressOf(this.opts.grid, this.opts.layout, this.opts.footprint, c);
    const name = addressName(address);
    let f = this.files.get(name);
    if (f === undefined) this.files.set(name, (f = { address, entries: new Map(), hash: null }));
    return f;
  }

  private bytesOf(a: RegionAddress, entries: Map<number, RegionEntry>): Uint8Array | null {
    if (entries.size === 0) return null;
    const tile: RegionTile = { worldId: this.opts.worldId, gridId: this.gridId, layout: a.layout, grid: this.opts.grid, footprint: a.footprint, rx: a.rx, ry: a.ry, rz: a.rz, compressor: 'zstd' };
    return writeRegion(tile, entries.values());
  }

  /** Whether a chunk can be edited (its data is sound and loaded). */
  readonly loaded = (gridId: number, cx: number, cy: number, cz: number): boolean => gridId === this.gridId && !this.damaged.has(chunkKey(this.opts.grid, cx, cy, cz));

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

  /** Saves every dirty file now; returns files and bytes written and chunks re-packed. */
  save(): { files: number; bytes: number; repacked: number } {
    let bytes = 0;
    let repacked = 0;
    const prepared = this.prepareSaves();
    for (const p of prepared) {
      const r = this.commit(p);
      if (!r.ok) throw new Error(`save ${p.name}: ${r.why}`);
      bytes += p.bytes?.length ?? 0;
      repacked += p.repacked;
    }
    return { files: prepared.length, bytes, repacked };
  }
}

/**
 * The shipped world, read only: a folder of region files, each read whole
 * once (an exported game reads ranges; the save logic only needs a chunk's
 * canonical codec bytes and their hash).
 */
export class ShippedWorld {
  private readonly cache = new Map<string, { index: RegionIndex; bytes: Uint8Array } | null>();
  constructor(
    readonly dir: string,
    readonly opts: WorldDirOptions,
  ) {}

  /** A chunk's canonical codec bytes (null: air). Throws on a damaged chunk. */
  chunkBytes(c: Readonly<ChunkCoord>): Uint8Array | null {
    return this.find(c) ?? null;
  }

  /** As {@link chunkBytes}, but undefined when the chunk's region file is missing. */
  private find(c: Readonly<ChunkCoord>): Uint8Array | null | undefined {
    const name = addressName(addressOf(this.opts.grid, this.opts.layout, this.opts.footprint, c));
    let f = this.cache.get(name);
    if (f === undefined) {
      const path = join(this.dir, name);
      if (existsSync(path)) {
        const bytes = new Uint8Array(readFileSync(path));
        f = { index: RegionIndex.parse(bytes), bytes };
      } else f = null;
      this.cache.set(name, f);
    }
    if (f === null) return undefined;
    const i = f.index.find(c.cx, c.cy, c.cz);
    if (i < 0) return null;
    return regionChunkCodecBytes(this.opts.grid, f.index.read(i, f.bytes), zstdDecompress);
  }

  hash(c: Readonly<ChunkCoord>): Uint8Array {
    return baseChunkHash(this.chunkBytes(c));
  }

  /**
   * A repair source: the shipped chunk. A missing region file means the
   * source does not have the chunk, never that it is air: claiming air for a
   * chunk the damaged file stored would drop it silently.
   */
  source(name = 'shipped world'): RepairSource {
    return { name, chunk: async (_g, c) => this.find(c) };
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
