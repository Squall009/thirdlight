/**
 * Structures that write into the world grid over what is there: a road, a
 * path or a river along a spline. A building owns a grid of its own and
 * leaves the ground alone; these cut and fill the ground itself, so moving
 * one must give the ground back. Each keeps a record of what it replaced:
 * for every cell it wrote, the voxel that lay there ("before") and the voxel
 * it wrote ("written"), in the layout of a structure's overrides
 * (structure-overrides.ts, TLVO: its base values read as before, its values
 * as written). Authoring data beside the region files, never exported.
 *
 * Rewriting one ({@link rewriteInWorld}) after its definition changed (or
 * with no definition: it is gone) puts "before" back wherever a cell still
 * holds what was written, then writes the new course; a cell someone edited
 * since is not a cell the record may put back:
 * - where the new course writes it, the hand edit is an override over what
 *   was written, kept or reported by the same fit rule as a building's
 *   (`reapplyOverrides`: absorbed, kept, misfit);
 * - where it does not, it is left alone and reported.
 * A cell that only went between air and liquid since counts as written:
 * water is the bodies' and the rivers' to move, never a hand edit.
 *
 * The writer is a pure function of its definition and the ground: the world
 * as it is without this structure (its record put back, read, never
 * written, while the new course is made), so a rewrite gives the cells a
 * fresh write over the same ground gives, in any chunk order. A chunk whose
 * record comes out the same is not touched, so a change rewrites only the
 * chunks where the course moved, though the writer is run over its whole
 * box.
 */
import { CellDelta, denseValue, exportOrAir } from '../cell-delta';
import { chunkKeyOrNone, chunkOfKey, localIndex, type ChunkCoord, type ChunkGrid } from '../coords';
import { createDenseChunk } from '../dense-chunk';
import type { ChunkUndo } from '../edit-apply';
import { changedFields, changeFeeds, materialSwap, readValue, ROLE_MASK, ROLE_SHIFT, valueMaterial, valueOf, type VoxelRecord } from '../record';
import { isMediumRole } from '../role-traits';
import type { VoxelStoreCandidate } from '../store';
import type { CellBox } from '../stroke';
import { reapplyOverrides, type ChunkOverrides, type StructureOverrides } from '../structure-overrides';
import { boxChunks, type GeneratedDefinition } from './generator';
import { chunkRecordOf, type StructureMisfit } from './regenerate';

/** The ground a writer reads: a world cell's voxel value. */
export interface GroundReader {
  value(x: number, y: number, z: number): number;
}

/** A structure written into the world grid over the ground (see the module's comment). */
export interface WorldWriter<D extends GeneratedDefinition> {
  /** What it makes ('spline', …): reports name it. */
  readonly kind: string;
  /** Moves by one whenever its output for any definition and ground changes. */
  readonly version: number;
  /** The world cells it can write or read for a definition (inclusive); null: none. */
  box(def: D): CellBox | null;
  /** The chunks it can write or read (the box's chunks when absent): a long diagonal course touches few of its box's. */
  chunks?(def: D, grid: ChunkGrid): ChunkCoord[];
  /**
   * The cells it writes in chunk (cx, cy, cz) of the world grid, appended to `out` ascending by local index with the
   * value each takes, reading the ground through `ground`.
   */
  chunk(def: D, grid: ChunkGrid, cx: number, cy: number, cz: number, ground: GroundReader, out: CellDelta): void;
}

/**
 * A world-grid structure's record: by chunk, the cells it wrote, the voxel each replaced (`base`: before) and the
 * voxel it wrote (`value`). The overrides' type, so it is stored and read by their codec.
 */
export type WorldRecord = StructureOverrides;

/** A record holding nothing. */
export function emptyWorldRecord(grid: ChunkGrid, gridId = 0): WorldRecord {
  return { grid, gridId, chunks: new Map() };
}

/** Cells a record holds. */
export function worldRecordCells(r: WorldRecord): number {
  let n = 0;
  for (const c of r.chunks.values()) n += c.value.count;
  return n;
}

/** A cell someone edited since it was written, which a rewrite did not put back. */
export interface LeftAlone {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** What lay there before, what was written, and what it holds. */
  readonly before: number;
  readonly written: number;
  readonly value: number;
}

export interface WorldRewriteReport {
  /** False when no cell changed. */
  readonly changed: boolean;
  readonly cells: number;
  /** Each changed chunk as it was (key order), and as it is now (writing them back is the redo). */
  readonly undo: readonly ChunkUndo[];
  readonly redo: readonly ChunkUndo[];
  readonly fields: number;
  readonly parts: number;
  readonly materialSwaps: readonly number[];
  /** Cells given back what lay there. */
  readonly putBack: number;
  /** Cells the record holds after (what the new course wrote). */
  readonly written: number;
  readonly leftAlone: readonly LeftAlone[];
  /** Hand edits on the new course by the fit rule (cells in world cells). */
  readonly kept: number;
  readonly absorbed: number;
  readonly misfits: readonly StructureMisfit[];
  /** The record after. */
  readonly record: WorldRecord;
  /** The cells that changed (inclusive; null: none). */
  readonly box: CellBox | null;
}

/** Whether a cell holding `now` still holds what was written there, `written`. */
export function stillWritten(now: number, written: number): boolean {
  return now === written || (airOrLiquid(now) && airOrLiquid(written));
}

const airOrLiquid = (v: number): boolean => v === 0 || isMediumRole((v >>> ROLE_SHIFT) & ROLE_MASK);

/** The index of `cell` among a delta's ascending cells, or −1. */
function find(d: CellDelta, cell: number): number {
  let lo = 0;
  let hi = d.count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = d.cells[mid]!;
    if (c === cell) return mid;
    if (c < cell) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

const sameChunk = (a: ChunkOverrides, b: ChunkOverrides): boolean => {
  if (a.value.count !== b.value.count) return false;
  for (let i = 0; i < a.value.count; i++) if (a.value.cells[i] !== b.value.cells[i] || a.value.values[i] !== b.value.values[i] || a.base.values[i] !== b.base.values[i]) return false;
  return true;
};

/** The world without the structure: the record's "before" where it wrote, the store elsewhere. */
export function groundOf(store: VoxelStoreCandidate, record: WorldRecord): GroundReader {
  const g = store.grid;
  const s = g.shift;
  const rec: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  return {
    value: (x, y, z) => {
      const key = chunkKeyOrNone(g, x >> s, y >> s, z >> s);
      if (key < 0) return 0;
      const o = record.chunks.get(key);
      if (o !== undefined) {
        const k = find(o.base, localIndex(g, x & g.mask, y & g.mask, z & g.mask));
        if (k >= 0) return o.base.values[k]!;
      }
      return valueOf(store.voxelAt(x, y, z, rec));
    },
  };
}

/**
 * The record a writer would make for `def` over the ground: by chunk of its box, the cells whose value it changes,
 * with the ground's value and its own.
 */
export function writeRecordOf<D extends GeneratedDefinition>(writer: WorldWriter<D>, grid: ChunkGrid, def: D, ground: GroundReader, gridId = 0): WorldRecord {
  const out = emptyWorldRecord(grid, gridId);
  const box = writer.box(def);
  if (box === null) return out;
  const s = grid.shift;
  const scratch = new CellDelta(1024);
  for (const c of writer.chunks?.(def, grid) ?? boxChunks(grid, box)) {
    const key = chunkKeyOrNone(grid, c.cx, c.cy, c.cz);
    if (key < 0) continue;
    scratch.count = 0;
    writer.chunk(def, grid, c.cx, c.cy, c.cz, ground, scratch);
    if (scratch.count === 0) continue;
    const base = new CellDelta(scratch.count);
    const value = new CellDelta(scratch.count);
    for (let k = 0; k < scratch.count; k++) {
      const i = scratch.cells[k]!;
      const x = (c.cx << s) + (i >>> (s << 1));
      const y = (c.cy << s) + (i & grid.mask);
      const z = (c.cz << s) + ((i >>> s) & grid.mask);
      const was = ground.value(x, y, z);
      const v = scratch.values[k]!;
      if (v === was) continue;
      base.push(i, was);
      value.push(i, v);
    }
    if (value.count > 0) out.chunks.set(key, { cx: c.cx, cy: c.cy, cz: c.cz, base, value });
  }
  return out;
}

/** The chunks a record names (world grid), for loading them before a rewrite. */
export function worldRecordChunks(r: WorldRecord): Array<{ cx: number; cy: number; cz: number }> {
  return [...r.chunks.values()].map((c) => ({ cx: c.cx, cy: c.cy, cz: c.cz }));
}

/**
 * Rewrites a world-grid structure (see the module's comment): its record's cells put back, the new course written
 * (`def` null: none, the structure is gone), hand edits by the fit rule, into `store` (every chunk of the record
 * and of the new box loaded). `gridId` names the grid in the undo records.
 */
export function rewriteInWorld<D extends GeneratedDefinition>(writer: WorldWriter<D>, store: VoxelStoreCandidate, record: WorldRecord, def: D | null, gridId = 0): WorldRewriteReport {
  const grid = store.grid;
  const s = grid.shift;
  const next = def === null ? emptyWorldRecord(grid, gridId) : writeRecordOf(writer, grid, def, groundOf(store, record), gridId);
  const keys = [...new Set([...record.chunks.keys(), ...next.chunks.keys()])].sort((a, b) => a - b);
  const after = new Map<number, ChunkOverrides>();
  const undo: ChunkUndo[] = [];
  const redo: ChunkUndo[] = [];
  const leftAlone: LeftAlone[] = [];
  const misfits: StructureMisfit[] = [];
  const swaps = new Set<number>();
  const rec: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  let cells = 0;
  let fields = 0;
  let parts = 0;
  let putBack = 0;
  let kept = 0;
  let absorbed = 0;
  let box: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null = null;
  const was = createDenseChunk(grid);
  const now = createDenseChunk(grid);
  const set = (cx: number, cy: number, cz: number, i: number, v: number): void => {
    readValue(v, rec);
    store.setVoxel((cx << s) + (i >>> (s << 1)), (cy << s) + (i & grid.mask), (cz << s) + ((i >>> s) & grid.mask), rec);
  };
  for (const key of keys) {
    const o = record.chunks.get(key);
    const n = next.chunks.get(key);
    if (o !== undefined && n !== undefined && sameChunk(o, n)) {
      after.set(key, o);
      continue;
    }
    const { cx, cy, cz } = chunkOfKey(grid, key);
    exportOrAir(store, cx, cy, cz, was);
    // Hand edits on cells the old course wrote and the new one writes too: overrides over what was written.
    const fit = { cx, cy, cz, base: new CellDelta(), value: new CellDelta() };
    if (o !== undefined) {
      for (let k = 0; k < o.value.count; k++) {
        const i = o.value.cells[k]!;
        const before = o.base.values[k]!;
        const written = o.value.values[k]!;
        const v = denseValue(was, i);
        if (stillWritten(v, written)) {
          if (v !== before) set(cx, cy, cz, i, before);
          putBack++;
          continue;
        }
        if (n !== undefined && find(n.value, i) >= 0) {
          fit.base.push(i, written);
          fit.value.push(i, v);
        } else if (v !== before) {
          leftAlone.push({ x: (cx << s) + (i >>> (s << 1)), y: (cy << s) + (i & grid.mask), z: (cz << s) + ((i >>> s) & grid.mask), before, written, value: v });
        } else putBack++;
      }
    }
    if (n !== undefined) {
      for (let k = 0; k < n.value.count; k++) set(cx, cy, cz, n.value.cells[k]!, n.value.values[k]!);
      after.set(key, n);
    }
    if (fit.value.count > 0) {
      const r = reapplyOverrides(store, { grid, gridId, chunks: new Map([[key, fit]]) });
      kept += r.kept;
      absorbed += r.absorbed;
      for (const m of r.misfits) misfits.push({ x: (cx << s) + (m.cell >>> (s << 1)), y: (cy << s) + (m.cell & grid.mask), z: (cz << s) + ((m.cell >>> s) & grid.mask), base: m.base, value: m.value, generated: m.generated });
    }
    exportOrAir(store, cx, cy, cz, now);
    const old = new CellDelta();
    const nw = new CellDelta();
    for (let i = 0; i < grid.cellsPerChunk; i++) {
      const a = denseValue(was, i);
      const b = denseValue(now, i);
      if (a === b) continue;
      old.push(i, a);
      nw.push(i, b);
      fields |= changedFields(a, b);
      parts |= changeFeeds(a, b);
      if (valueMaterial(a) !== valueMaterial(b)) swaps.add(materialSwap(valueMaterial(a), valueMaterial(b)));
      const x = (cx << s) + (i >>> (s << 1));
      const y = (cy << s) + (i & grid.mask);
      const z = (cz << s) + ((i >>> s) & grid.mask);
      if (box === null) box = { minX: x, minY: y, minZ: z, maxX: x, maxY: y, maxZ: z };
      else {
        box.minX = Math.min(box.minX, x);
        box.minY = Math.min(box.minY, y);
        box.minZ = Math.min(box.minZ, z);
        box.maxX = Math.max(box.maxX, x);
        box.maxY = Math.max(box.maxY, y);
        box.maxZ = Math.max(box.maxZ, z);
      }
    }
    if (old.count === 0) continue;
    cells += old.count;
    undo.push({ grid: gridId, cx, cy, cz, before: chunkRecordOf(grid, was, old) });
    const copy = createDenseChunk(grid);
    exportOrAir(store, cx, cy, cz, copy);
    redo.push({ grid: gridId, cx, cy, cz, before: chunkRecordOf(grid, copy, nw) });
  }
  const recordAfter: WorldRecord = { grid, gridId, chunks: new Map([...after].sort((a, b) => a[0] - b[0])) };
  return { changed: cells > 0, cells, undo, redo, fields, parts, materialSwaps: [...swaps].sort((a, b) => a - b), putBack, written: worldRecordCells(recordAfter), leftAlone, kept, absorbed, misfits, record: recordAfter, box };
}
