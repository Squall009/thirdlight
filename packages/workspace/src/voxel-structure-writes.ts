/**
 * What a voxel world's structure grids hold beside their region files, and
 * the writes a structure's command makes to them.
 *
 * A structure grid (id ≥ 1, `grid-<id>/` in the world's folder) holds what
 * its generator writes from the structure's definition plus the hand edits
 * kept over it: its overrides, `grid-<id>/overrides.tlvo` (TLVO, the voxel
 * package's `structure-overrides.ts`), written in the same staged write as
 * the grid's region files and the manifest, and absent while the structure
 * has none. Nothing else is stored: where the grid stands is its structure
 * object's, the definition is in the scene, and a regenerate's misfits are
 * answered and held in memory only.
 *
 * The changes here run inside a world's command (voxel-worlds.ts): each
 * returns the undo record of what it changed (chunks of the grids, with
 * their grid ids, in the voxel package's undo record) and the overrides
 * files it would write; the world's command writes them as one stroke, and
 * memory takes the new overrides only once they are on disk.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_PLANES,
  captureOverrides,
  chunkOfKey,
  createDenseChunk,
  decodeOverrides,
  denseValue,
  encodeOverrides,
  exportOrAir,
  regenerateStructure,
  type ChunkCoord,
  type ChunkGrid,
  type ChunkUndo,
  type StructureDefinition,
  type StructureGenerator,
  type StructureMisfit,
  type StructureOverrides,
} from '@thirdlight/voxel';
import { sha256HexNative } from './digest';
import type { RegionWorld } from './voxel-world-files';

/** A structure grid's overrides file, in its grid's folder. */
export const STRUCTURE_OVERRIDES_FILE = 'overrides.tlvo';

/** A grid's overrides as this process last read or wrote them: the file's bytes and hash (null: no file) and their value. */
export interface HeldOverrides {
  readonly bytes: Uint8Array | null;
  readonly hash: string | null;
  readonly value: StructureOverrides;
}

/** No overrides for a grid. */
export function noOverrides(grid: ChunkGrid, gridId: number): StructureOverrides {
  return { grid, gridId, chunks: new Map() };
}

/** Reads a grid's overrides file (absent: none). Throws when it is unreadable or damaged. */
export function readOverrides(gridDir: string, grid: ChunkGrid, gridId: number): HeldOverrides {
  const path = join(gridDir, STRUCTURE_OVERRIDES_FILE);
  if (!existsSync(path)) return { bytes: null, hash: null, value: noOverrides(grid, gridId) };
  const bytes = new Uint8Array(readFileSync(path));
  const value = decodeOverrides(grid, bytes);
  if (value.gridId !== gridId) throw new RangeError(`${STRUCTURE_OVERRIDES_FILE} is grid ${value.gridId}'s, in grid ${gridId}'s folder`);
  return { bytes, hash: sha256HexNative(bytes), value };
}

/** The bytes a grid's overrides file holds (null: none, the file goes). */
export function overridesBytes(o: StructureOverrides): Uint8Array | null {
  return o.chunks.size === 0 ? null : encodeOverrides(o);
}

const sameBytes = (a: Uint8Array | null, b: Uint8Array | null): boolean => (a === null || b === null ? a === b : a.length === b.length && a.every((v, i) => v === b[i]));

/** A change to one structure's grid, as a structure command asks it. */
export type StructureChange =
  /** The structure's voxels written from `definition` (a new structure, or its definition changed: `previous` the one that wrote them). */
  | { readonly kind: 'write'; readonly grid: number; readonly definition: StructureDefinition; readonly previous: StructureDefinition | null }
  /** A new grid holding another's voxels and overrides (a duplicated structure). */
  | { readonly kind: 'copy'; readonly grid: number; readonly from: number }
  /** The grid emptied: its region files and overrides go (a deleted structure). */
  | { readonly kind: 'delete'; readonly grid: number };

/** What one change did to its grid (the command's answer names each). */
export interface StructureChangeReport {
  readonly grid: number;
  readonly kind: StructureChange['kind'];
  readonly cells: number;
  readonly kept: number;
  readonly absorbed: number;
  readonly misfits: readonly StructureMisfit[];
  readonly materialSwaps: readonly number[];
  /** The fields that changed (PLANE_BIT mask). */
  readonly fields: number;
}

/** The changes' result: one undo record over the grids, the overrides files to write (null: delete), and a report a change. */
export interface StructureWrites {
  readonly record: ChunkUndo[];
  readonly cells: number;
  readonly fields: number;
  readonly materialSwaps: readonly number[];
  readonly overrides: Map<number, { readonly bytes: Uint8Array | null; readonly value: StructureOverrides }>;
  readonly reports: StructureChangeReport[];
}

/** What a structure change needs of its world: its grids (made on demand) and their overrides as held. */
export interface StructureGridHost {
  readonly grid: ChunkGrid;
  gridWorld(gridId: number): RegionWorld;
  overrides(gridId: number): HeldOverrides;
}

/** Cells of a chunk that are not air. */
function solidCells(grid: ChunkGrid, store: RegionWorld['store'], c: ChunkCoord): number {
  const d = exportOrAir(store, c.cx, c.cy, c.cz, createDenseChunk(grid));
  let n = 0;
  for (let i = 0; i < grid.cellsPerChunk; i++) if (denseValue(d, i) !== 0) n++;
  return n;
}

/** Why a grid cannot be changed now (a listed file damaged), or null. */
function damaged(rw: RegionWorld): string | null {
  const first = rw.damagedRegions.entries().next();
  if (!first.done) return `grid ${rw.gridId}'s region ${first.value[0]} cannot be read: ${first.value[1]}`;
  return rw.damaged.size > 0 ? `grid ${rw.gridId} holds ${rw.damaged.size} damaged chunk${rw.damaged.size === 1 ? '' : 's'}` : null;
}

/** A refusal of a structure change (the grid named, what to do). */
export class StructureWriteRefused extends Error {
  override readonly name = 'StructureWriteRefused';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Applies the changes to the grids in memory, in order, and answers what
 * they did. Nothing is written here; a refusal leaves earlier changes of the
 * same call applied (the caller writes the record back).
 */
export async function applyStructureChanges(host: StructureGridHost, generator: StructureGenerator<StructureDefinition>, changes: readonly StructureChange[]): Promise<StructureWrites> {
  const record: ChunkUndo[] = [];
  const overrides = new Map<number, { bytes: Uint8Array | null; value: StructureOverrides }>();
  const reports: StructureChangeReport[] = [];
  const swaps = new Set<number>();
  let cells = 0;
  let fields = 0;
  const heldNow = (id: number): StructureOverrides => overrides.get(id)?.value ?? host.overrides(id).value;
  const bytesNow = (id: number): Uint8Array | null => (overrides.has(id) ? overrides.get(id)!.bytes : host.overrides(id).bytes);
  for (const ch of changes) {
    const rw = host.gridWorld(ch.grid);
    await rw.ensureAll();
    const bad = damaged(rw);
    if (bad !== null) throw new StructureWriteRefused('region_damaged', bad);
    if (ch.kind === 'write') {
      const r = regenerateStructure(generator, rw.store, ch.grid, heldNow(ch.grid), ch.definition, ch.previous ?? undefined);
      rw.markEdited(r.undo);
      record.push(...r.undo);
      const bytes = overridesBytes(r.overrides);
      if (!sameBytes(bytes, bytesNow(ch.grid))) overrides.set(ch.grid, { bytes, value: r.overrides });
      for (const s of r.materialSwaps) swaps.add(s);
      cells += r.cells;
      fields |= r.fields;
      reports.push({ grid: ch.grid, kind: 'write', cells: r.cells, kept: r.kept, absorbed: r.absorbed, misfits: r.misfits, materialSwaps: r.materialSwaps, fields: r.fields });
    } else if (ch.kind === 'copy') {
      if ([...rw.store.chunkKeys()].length > 0) throw new StructureWriteRefused('grid_taken', `grid ${ch.grid} already holds voxels: a copy goes into a new grid`);
      const src = host.gridWorld(ch.from);
      await src.ensureAll();
      const badSrc = damaged(src);
      if (badSrc !== null) throw new StructureWriteRefused('region_damaged', badSrc);
      let n = 0;
      const copied: ChunkCoord[] = [];
      for (const key of [...src.store.chunkKeys()].sort((a, b) => a - b)) {
        const c = chunkOfKey(host.grid, key);
        const bytes = src.store.encodeChunk(c.cx, c.cy, c.cz);
        if (bytes === null) continue;
        rw.store.decodeChunk(c.cx, c.cy, c.cz, bytes);
        record.push({ grid: ch.grid, cx: c.cx, cy: c.cy, cz: c.cz, before: { kind: 'image', bytes: null } });
        copied.push(c);
        n += solidCells(host.grid, rw.store, c);
      }
      rw.markEdited(copied);
      const from = heldNow(ch.from);
      const value: StructureOverrides = { grid: host.grid, gridId: ch.grid, chunks: new Map(from.chunks) };
      const bytes = overridesBytes(value);
      if (bytes !== null) overrides.set(ch.grid, { bytes, value });
      cells += n;
      if (n > 0) fields |= ALL_PLANES;
      reports.push({ grid: ch.grid, kind: 'copy', cells: n, kept: 0, absorbed: 0, misfits: [], materialSwaps: [], fields: n > 0 ? ALL_PLANES : 0 });
    } else {
      let n = 0;
      const gone: ChunkCoord[] = [];
      for (const key of [...rw.store.chunkKeys()].sort((a, b) => a - b)) {
        const c = chunkOfKey(host.grid, key);
        n += solidCells(host.grid, rw.store, c);
        record.push({ grid: ch.grid, cx: c.cx, cy: c.cy, cz: c.cz, before: { kind: 'image', bytes: rw.store.encodeChunk(c.cx, c.cy, c.cz) } });
        rw.store.dropChunk(c.cx, c.cy, c.cz);
        gone.push(c);
      }
      rw.markEdited(gone);
      if (bytesNow(ch.grid) !== null) overrides.set(ch.grid, { bytes: null, value: { grid: host.grid, gridId: ch.grid, chunks: new Map() } });
      cells += n;
      if (n > 0) fields |= ALL_PLANES;
      reports.push({ grid: ch.grid, kind: 'delete', cells: n, kept: 0, absorbed: 0, misfits: [], materialSwaps: [], fields: n > 0 ? ALL_PLANES : 0 });
    }
  }
  return { record, cells, fields, materialSwaps: [...swaps].sort((a, b) => a - b), overrides, reports };
}

/**
 * A hand edit on a structure's grid kept as overrides: for each chunk the
 * edit changed, the cells where the grid now differs from what the
 * generator makes there. Null when the overrides file would not change.
 */
export function capturedOverrides(host: StructureGridHost, generator: StructureGenerator<StructureDefinition>, gridId: number, definition: StructureDefinition, chunks: readonly ChunkCoord[]): { bytes: Uint8Array | null; value: StructureOverrides } | null {
  const held = host.overrides(gridId);
  const value = captureOverrides(generator, definition, host.gridWorld(gridId).store, held.value, chunks);
  const bytes = overridesBytes(value);
  return sameBytes(bytes, held.bytes) ? null : { bytes, value };
}
