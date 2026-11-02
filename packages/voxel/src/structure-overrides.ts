/**
 * Hand edits on a structure, kept as overrides over its generated voxels,
 * format v2 DRAFT.
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
 *   base it was made over (both air, or both solid of the same role):
 *   the override's voxel is written and its base becomes the new generated
 *   voxel, so a painted wall cell stays painted after a material swap and a
 *   hole cut in a wall stays cut while the wall stays;
 * - **misfit** otherwise (the wall it was cut into moved away, a shelf now
 *   sits inside a new wall): not written, and reported so nothing changes
 *   silently. The report holds the misfits, so the caller can show them and
 *   the one undoable regenerate step can restore them.
 *
 * Bytes, version 2 (little-endian; version 1, the draft with shapes beside
 * the 23/4/5 values, is not read): 'T' 'L' 'V' 'O', u8 version, u8 chunk
 * edge, u8 record value form of its values (record.ts), u8 reserved (0),
 * u32 grid id, u32 chunk count, then per chunk in key order: i16 cx,
 * i16 cy, i16 cz, u32 cell count, then planes: cells (u16 local index,
 * ascending), base values (u32), values (u32); then the CRC-32 of
 * everything before it.
 *
 * Overrides live as long as the project, so they upgrade like saves: an
 * unknown (newer) version is refused, and each later version appends a
 * step that lifts decoded overrides of the version before it.
 */
import { crc32 } from '@thirdlight/shared';
import { CellDelta, chunkScratch, denseValue, exportOrAir } from './cell-delta';
import { chunkKey, chunkOfKey, type ChunkGrid } from './coords';
import { createDenseChunk, type DenseChunk } from './dense-chunk';
import { checkRecordValue, checkValueForm, RECORD_VALUE_FORM, valueMaterial, valueRole } from './record';
import type { VoxelStoreCandidate } from './store';

/** The override format this build writes and reads. */
export const OVERRIDE_FORMAT_VERSION = 2;

/** The oldest override version this build reads (version 1 was a draft that was never approved). */
export const OVERRIDE_FIRST_VERSION = 2;

/** Lifts decoded overrides of version n to n + 1 (`OVERRIDE_UPGRADES[n - OVERRIDE_FIRST_VERSION]`). */
export type OverrideUpgradeStep = (o: StructureOverrides) => StructureOverrides;

/** The upgrade steps, oldest first; only ever appended to. Version 2 has none. */
export const OVERRIDE_UPGRADES: readonly OverrideUpgradeStep[] = Object.freeze([]);

/** Bytes one overridden cell takes at rest. */
export const OVERRIDE_CELL_BYTES = 10;

const MAGIC = [0x54, 0x4c, 0x56, 0x4f] as const;
const HEADER = 16;
const CHUNK_HEADER = 10;

/** One chunk's overrides: cells ascending, the generated voxel each replaced, and the voxel it holds. */
export interface ChunkOverrides {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** Generated voxels under the overrides (cells, values). */
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
  /** The generated voxel value it was made over, the value it holds, and what is generated there now. */
  readonly base: number;
  readonly value: number;
  readonly generated: number;
}

export interface OverrideReport {
  readonly kept: number;
  readonly absorbed: number;
  readonly misfits: readonly OverrideMisfit[];
  /** The overrides after regenerating: kept ones only, rebased on the new generated voxels. */
  readonly overrides: StructureOverrides;
}


/**
 * The overrides of one chunk: the cells where `edited` differs from
 * `generated` (null when none do).
 */
export function chunkOverridesOf(grid: ChunkGrid, cx: number, cy: number, cz: number, generated: DenseChunk, edited: DenseChunk): ChunkOverrides | null {
  const base = new CellDelta();
  const value = new CellDelta();
  for (let i = 0; i < grid.cellsPerChunk; i++) {
    const g = denseValue(generated, i);
    const e = denseValue(edited, i);
    if (g === e) continue;
    base.push(i, g);
    value.push(i, e);
  }
  return base.count === 0 ? null : { cx, cy, cz, base, value };
}

/** Whether a voxel generated now is the same kind as the base an override was made over. */
function fits(baseValue: number, nowValue: number): boolean {
  const baseAir = valueMaterial(baseValue) === 0;
  const nowAir = valueMaterial(nowValue) === 0;
  return baseAir === nowAir && (baseAir || valueRole(baseValue) === valueRole(nowValue));
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
      const g = denseValue(now, i);
      const want = o.value.values[k]!;
      if (g === want) {
        absorbed++;
        continue;
      }
      if (!fits(o.base.values[k]!, g)) {
        misfits.push({ cx: o.cx, cy: o.cy, cz: o.cz, cell: i, base: o.base.values[k]!, value: want, generated: g });
        continue;
      }
      base.push(i, g);
      value.push(i, want);
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
  out[6] = RECORD_VALUE_FORM;
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
      view.setUint32(at + count * 6 + i * 4, c.value.values[i]!, true);
    }
    at += count * OVERRIDE_CELL_BYTES;
  }
  view.setUint32(at, crc32(out.subarray(0, at)), true);
  return out;
}

/**
 * Reads {@link encodeOverrides}' bytes; throws on damage, another edge, a
 * value the format does not hold, or a version newer than this build (or
 * `steps`) knows; an older version is lifted through the upgrade steps.
 */
export function decodeOverrides(grid: ChunkGrid, bytes: Uint8Array, steps: readonly OverrideUpgradeStep[] = OVERRIDE_UPGRADES): StructureOverrides {
  if (bytes.length < HEADER + 4 || !MAGIC.every((b, i) => bytes[i] === b)) throw new RangeError('structure overrides: bad magic');
  const version = bytes[4]!;
  const current = OVERRIDE_FIRST_VERSION + steps.length;
  if (version < OVERRIDE_FIRST_VERSION || version > current) throw new RangeError(`structure overrides: unknown version ${version} (this build reads ${OVERRIDE_FIRST_VERSION} to ${current})`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[5] !== grid.edge || bytes[7] !== 0) throw new RangeError('structure overrides: another chunk edge, or reserved bytes set');
  checkValueForm('structure overrides', bytes[6]!);
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
      const bv = view.getUint32(at + count * 2 + i * 4, true);
      const vv = view.getUint32(at + count * 6 + i * 4, true);
      checkRecordValue(bv, 'structure overrides');
      checkRecordValue(vv, 'structure overrides');
      base.push(cell, bv);
      value.push(cell, vv);
    }
    at += count * OVERRIDE_CELL_BYTES;
    chunks.set(key, { cx, cy, cz, base, value });
  }
  if (at !== end) throw new RangeError('structure overrides: trailing bytes');
  let o: StructureOverrides = { grid, gridId, chunks };
  for (let v = version; v < current; v++) o = steps[v - OVERRIDE_FIRST_VERSION]!(o);
  return o;
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
