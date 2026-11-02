/**
 * Hand edits on a structure, kept as overrides over its generated voxels,
 * format v1 DRAFT.
 *
 * A structure's voxels are a pure function of its definition. Hand edits on
 * top are stored apart from them, per chunk of the structure's own grid:
 * each overridden cell keeps the generated voxel it replaced (its base) and
 * the voxel the author left there. They live with the structure's record in
 * the project, not in its region files: exports bake the resolved voxels
 * and never carry them.
 *
 * Regenerating (a changed definition, or a generator upgrade applied to
 * every structure) writes the new generated voxels, then reapplies each
 * override that still fits:
 * - **absorbed** when the generator now makes the overridden voxel itself
 *   (the override is no longer needed and is dropped);
 * - **kept** when the cell's new generated voxel is the same kind as the
 *   base it was made over (both air, or both solid of the same category):
 *   the override's voxel is written and its base becomes the new generated
 *   voxel, so a painted wall cell stays painted after a material swap and a
 *   hole cut in a wall stays cut while the wall stays;
 * - **misfit** otherwise (the wall it was cut into moved away, a shelf now
 *   sits inside a new wall): not written, and reported so nothing changes
 *   silently. The report holds the misfits, so the caller can show them and
 *   the one undoable regenerate step can restore them.
 *
 * Bytes, version 1 (little-endian): 'T' 'L' 'V' 'O', u8 version, u8 chunk
 * edge, u16 reserved (0), u32 grid id, u32 chunk count, then per chunk in
 * key order: i16 cx, i16 cy, i16 cz, u32 cell count, then planes: cells
 * (u16 local index, ascending), base values (u32), base shapes (u8), values
 * (u32), shapes (u8); then the CRC-32 of everything before it.
 */
import { crc32 } from '@thirdlight/shared';
import { CellDelta, chunkScratch, exportOrAir } from './cell-delta';
import { chunkKey, chunkOfKey, type ChunkGrid } from './coords';
import { createDenseChunk, type DenseChunk } from './dense-chunk';
import { recordValue, valueCategory, valueMaterial } from './palette-image';
import type { VoxelStoreCandidate } from './store';

/** The override format this build writes and reads. */
export const OVERRIDE_FORMAT_VERSION = 1;

/** Bytes one overridden cell takes at rest. */
export const OVERRIDE_CELL_BYTES = 12;

const MAGIC = [0x54, 0x4c, 0x56, 0x4f] as const;
const HEADER = 16;
const CHUNK_HEADER = 10;

/** One chunk's overrides: cells ascending, the generated voxel each replaced, and the voxel it holds. */
export interface ChunkOverrides {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** Generated voxels under the overrides (cells, values, shapes). */
  readonly base: CellDelta;
  /** The overriding voxels, same cells in the same order. */
  readonly value: CellDelta;
}

export interface StructureOverrides {
  readonly grid: ChunkGrid;
  /** The structure's grid id. */
  readonly gridId: number;
  /** By chunk key. */
  readonly chunks: Map<number, ChunkOverrides>;
}

/** An override that no longer fits its structure. */
export interface OverrideMisfit {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** Local cell index. */
  readonly cell: number;
  /** The generated voxel it was made over (value, shape), what it holds, and what is generated there now. */
  readonly base: readonly [number, number];
  readonly value: readonly [number, number];
  readonly generated: readonly [number, number];
}

export interface OverrideReport {
  readonly kept: number;
  readonly absorbed: number;
  readonly misfits: readonly OverrideMisfit[];
  /** The overrides after regenerating: kept ones only, rebased on the new generated voxels. */
  readonly overrides: StructureOverrides;
}

function valueAt(c: DenseChunk, i: number): number {
  const m = c.material[i]!;
  return m === 0 ? 0 : recordValue(m, c.category[i]!, c.orientation[i]!);
}

/**
 * The overrides of one chunk: the cells where `edited` differs from
 * `generated` (null when none do).
 */
export function chunkOverridesOf(grid: ChunkGrid, cx: number, cy: number, cz: number, generated: DenseChunk, edited: DenseChunk): ChunkOverrides | null {
  const base = new CellDelta();
  const value = new CellDelta();
  for (let i = 0; i < grid.cellsPerChunk; i++) {
    const g = valueAt(generated, i);
    const e = valueAt(edited, i);
    const gs = g === 0 ? 0 : generated.shape[i]!;
    const es = e === 0 ? 0 : edited.shape[i]!;
    if (g === e && gs === es) continue;
    base.push(i, g, gs);
    value.push(i, e, es);
  }
  return base.count === 0 ? null : { cx, cy, cz, base, value };
}

/** Whether a voxel generated now is the same kind as the base an override was made over. */
function fits(baseValue: number, nowValue: number): boolean {
  const baseAir = valueMaterial(baseValue) === 0;
  const nowAir = valueMaterial(nowValue) === 0;
  return baseAir === nowAir && (baseAir || valueCategory(baseValue) === valueCategory(nowValue));
}

/**
 * Reapplies overrides after the structure's store has been rewritten with
 * its newly generated voxels (every chunk the overrides name must be
 * loaded): writes the overrides that fit and reports the rest.
 */
export function reapplyOverrides(store: VoxelStoreCandidate, overrides: StructureOverrides): OverrideReport {
  const grid = store.grid;
  const now = chunkScratch(grid).cells;
  const kept = new Map<number, ChunkOverrides>();
  const misfits: OverrideMisfit[] = [];
  let keptCells = 0;
  let absorbed = 0;
  for (const key of [...overrides.chunks.keys()].sort((a, b) => a - b)) {
    const o = overrides.chunks.get(key)!;
    exportOrAir(store, o.cx, o.cy, o.cz, now);
    const base = new CellDelta();
    const value = new CellDelta();
    for (let k = 0; k < o.value.count; k++) {
      const i = o.value.cells[k]!;
      const g = valueAt(now, i);
      const gs = g === 0 ? 0 : now.shape[i]!;
      const want = o.value.values[k]!;
      const wantShape = o.value.shapes[k]!;
      if (g === want && gs === wantShape) {
        absorbed++;
        continue;
      }
      if (!fits(o.base.values[k]!, g)) {
        misfits.push({ cx: o.cx, cy: o.cy, cz: o.cz, cell: i, base: [o.base.values[k]!, o.base.shapes[k]!], value: [want, wantShape], generated: [g, gs] });
        continue;
      }
      base.push(i, g, gs);
      value.push(i, want, wantShape);
      keptCells++;
    }
    if (value.count === 0) continue;
    value.applyToStore(store, o.cx, o.cy, o.cz);
    kept.set(key, { cx: o.cx, cy: o.cy, cz: o.cz, base, value });
  }
  return { kept: keptCells, absorbed, misfits, overrides: { grid, gridId: overrides.gridId, chunks: kept } };
}

/** The overrides' bytes (see the file comment). */
export function encodeOverrides(o: StructureOverrides): Uint8Array {
  const keys = [...o.chunks.keys()].sort((a, b) => a - b);
  let n = HEADER + 4;
  for (const k of keys) n += CHUNK_HEADER + o.chunks.get(k)!.value.count * OVERRIDE_CELL_BYTES;
  const out = new Uint8Array(n);
  const view = new DataView(out.buffer);
  MAGIC.forEach((b, i) => (out[i] = b));
  out[4] = OVERRIDE_FORMAT_VERSION;
  out[5] = o.grid.edge;
  view.setUint32(8, o.gridId, true);
  view.setUint32(12, keys.length, true);
  let at = HEADER;
  for (const k of keys) {
    const c = o.chunks.get(k)!;
    const count = c.value.count;
    if (c.base.count !== count) throw new RangeError('override base and value cells differ');
    view.setInt16(at, c.cx, true);
    view.setInt16(at + 2, c.cy, true);
    view.setInt16(at + 4, c.cz, true);
    view.setUint32(at + 6, count, true);
    at += CHUNK_HEADER;
    for (let i = 0; i < count; i++) {
      if (c.base.cells[i] !== c.value.cells[i]) throw new RangeError('override base and value cells differ');
      view.setUint16(at + i * 2, c.value.cells[i]!, true);
      view.setUint32(at + count * 2 + i * 4, c.base.values[i]!, true);
      out[at + count * 6 + i] = c.base.shapes[i]!;
      view.setUint32(at + count * 7 + i * 4, c.value.values[i]!, true);
      out[at + count * 11 + i] = c.value.shapes[i]!;
    }
    at += count * OVERRIDE_CELL_BYTES;
  }
  view.setUint32(at, crc32(out.subarray(0, at)), true);
  return out;
}

/** Reads {@link encodeOverrides}' bytes; throws on damage, another edge or an unknown version. */
export function decodeOverrides(grid: ChunkGrid, bytes: Uint8Array): StructureOverrides {
  if (bytes.length < HEADER + 4 || !MAGIC.every((b, i) => bytes[i] === b)) throw new RangeError('structure overrides: bad magic');
  if (bytes[4] !== OVERRIDE_FORMAT_VERSION) throw new RangeError(`structure overrides: unknown version ${bytes[4]}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[5] !== grid.edge || view.getUint16(6, true) !== 0) throw new RangeError('structure overrides: another chunk edge, or reserved bytes set');
  const end = bytes.length - 4;
  if (crc32(bytes.subarray(0, end)) !== view.getUint32(end, true)) throw new RangeError('structure overrides: checksum mismatch');
  const gridId = view.getUint32(8, true);
  const n = view.getUint32(12, true);
  const chunks = new Map<number, ChunkOverrides>();
  let at = HEADER;
  let prevKey = -1;
  for (let k = 0; k < n; k++) {
    if (at + CHUNK_HEADER > end) throw new RangeError('structure overrides: truncated');
    const cx = view.getInt16(at, true);
    const cy = view.getInt16(at + 2, true);
    const cz = view.getInt16(at + 4, true);
    const count = view.getUint32(at + 6, true);
    at += CHUNK_HEADER;
    if (count === 0 || at + count * OVERRIDE_CELL_BYTES > end) throw new RangeError('structure overrides: truncated or empty chunk');
    const key = chunkKey(grid, cx, cy, cz);
    if (key <= prevKey) throw new RangeError('structure overrides: chunks out of order or repeated');
    prevKey = key;
    const base = new CellDelta(count);
    const value = new CellDelta(count);
    let prev = -1;
    for (let i = 0; i < count; i++) {
      const cell = view.getUint16(at + i * 2, true);
      if (cell <= prev || cell >= grid.cellsPerChunk) throw new RangeError('structure overrides: cells out of order or outside the chunk');
      prev = cell;
      base.push(cell, view.getUint32(at + count * 2 + i * 4, true), bytes[at + count * 6 + i]!);
      value.push(cell, view.getUint32(at + count * 7 + i * 4, true), bytes[at + count * 11 + i]!);
    }
    at += count * OVERRIDE_CELL_BYTES;
    chunks.set(key, { cx, cy, cz, base, value });
  }
  if (at !== end) throw new RangeError('structure overrides: trailing bytes');
  return { grid, gridId, chunks };
}

/** Overrides of every chunk of a structure, from its generated and its edited stores (chunk keys of either). */
export function overridesOf(generated: VoxelStoreCandidate, edited: VoxelStoreCandidate, gridId: number): StructureOverrides {
  const grid = edited.grid;
  const keys = new Set<number>([...generated.chunkKeys(), ...edited.chunkKeys()]);
  const g = chunkScratch(grid).cells;
  const e = createDenseChunk(grid);
  const chunks = new Map<number, ChunkOverrides>();
  for (const key of [...keys].sort((a, b) => a - b)) {
    const { cx, cy, cz } = chunkOfKey(grid, key);
    exportOrAir(generated, cx, cy, cz, g);
    exportOrAir(edited, cx, cy, cz, e);
    const o = chunkOverridesOf(grid, cx, cy, cz, g, e);
    if (o !== null) chunks.set(key, o);
  }
  return { grid, gridId, chunks };
}
