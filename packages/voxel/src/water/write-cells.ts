/**
 * Cell writes made into a store with their undo record: what a water
 * body's regenerate hands the backend, written the way an edit writes (a
 * before-record a chunk, each cell's derived parts decided on its own by
 * `changeFeeds`, so water moved between air and liquid feeds the liquid
 * part alone).
 *
 * Pure but for the store it writes.
 */
import { CellDelta } from '../cell-delta';
import { localIndex, type ChunkGrid } from '../coords';
import type { ChunkUndo } from '../edit-apply';
import { changedFields, changeFeeds, materialSwap, readValue, valueMaterial, valueOf, type VoxelRecord } from '../record';
import type { VoxelStoreCandidate } from '../store';
import type { CellBox } from '../stroke';
import type { CellWrites } from './body';

/** Chunk coordinates as sort keys: shifted to be positive (the world spans 4,096 chunks of the smallest edge), so a key stays an exact float. */
const KEY_OFFSET = 2048;
const KEY_SPAN = 2 * KEY_OFFSET;

/** What {@link writeCells} did. */
export interface CellsWritten {
  /** Chunks changed, in key order, each with the values its changed cells held before. */
  readonly chunks: ChunkUndo[];
  readonly cells: number;
  /** The fields changed (PLANE_BIT mask) and the derived parts fed (DERIVED_PART bits). */
  readonly fields: number;
  readonly parts: number;
  readonly materialSwaps: number[];
  /** The cells changed (inclusive; null: none). */
  readonly box: CellBox | null;
}

/** Writes `writes` into `store` (grid `gridId`), cells whose value already matches left alone. */
export function writeCells(store: VoxelStoreCandidate, gridId: number, writes: CellWrites): CellsWritten {
  const g: ChunkGrid = store.grid;
  const s = g.shift;
  const n = writes.values.length;
  const order = new Uint32Array(n);
  const keys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = writes.cells[3 * i]!;
    const y = writes.cells[3 * i + 1]!;
    const z = writes.cells[3 * i + 2]!;
    order[i] = i;
    // Chunks in x, z, y order (as an edit's chunks), cells ascending by local index inside each.
    keys[i] = ((((x >> s) + KEY_OFFSET) * KEY_SPAN + ((z >> s) + KEY_OFFSET)) * KEY_SPAN + ((y >> s) + KEY_OFFSET)) * g.cellsPerChunk + localIndex(g, x & g.mask, y & g.mask, z & g.mask);
  }
  order.sort((a, b) => keys[a]! - keys[b]!);
  const old: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  const next: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  const chunks: ChunkUndo[] = [];
  const swaps = new Set<number>();
  let cells = 0;
  let fields = 0;
  let parts = 0;
  let box: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null = null;
  let k = 0;
  while (k < n) {
    const first = order[k]!;
    const cx = writes.cells[3 * first]! >> s;
    const cy = writes.cells[3 * first + 1]! >> s;
    const cz = writes.cells[3 * first + 2]! >> s;
    let end = k;
    while (end < n) {
      const j = order[end]!;
      if (writes.cells[3 * j]! >> s !== cx || writes.cells[3 * j + 1]! >> s !== cy || writes.cells[3 * j + 2]! >> s !== cz) break;
      end++;
    }
    const delta = new CellDelta(end - k);
    for (; k < end; k++) {
      const j = order[k]!;
      const x = writes.cells[3 * j]!;
      const y = writes.cells[3 * j + 1]!;
      const z = writes.cells[3 * j + 2]!;
      const before = valueOf(store.voxelAt(x, y, z, old));
      const after = writes.values[j]!;
      if (before === after) continue;
      readValue(after, next);
      fields |= changedFields(before, after);
      parts |= changeFeeds(before, after);
      if (valueMaterial(before) !== valueMaterial(after)) swaps.add(materialSwap(valueMaterial(before), valueMaterial(after)));
      delta.push(localIndex(g, x & g.mask, y & g.mask, z & g.mask), before);
      store.setVoxel(x, y, z, next);
      if (box === null) box = { minX: x, minY: y, minZ: z, maxX: x, maxY: y, maxZ: z };
      else {
        if (x < box.minX) box.minX = x;
        if (y < box.minY) box.minY = y;
        if (z < box.minZ) box.minZ = z;
        if (x > box.maxX) box.maxX = x;
        if (y > box.maxY) box.maxY = y;
        if (z > box.maxZ) box.maxZ = z;
      }
    }
    if (delta.count === 0) continue;
    cells += delta.count;
    chunks.push({ grid: gridId, cx, cy, cz, before: { kind: 'delta', delta: trimmed(delta) } });
  }
  return { chunks, cells, fields, parts, materialSwaps: [...swaps].sort((a, b) => a - b), box };
}

/** A delta whose arrays are exactly as long as its cells (memory equals its counted bytes). */
function trimmed(d: CellDelta): CellDelta {
  if (d.cells.length === d.count) return d;
  const t = new CellDelta(d.count);
  t.cells.set(d.cells.subarray(0, d.count));
  t.values.set(d.values.subarray(0, d.count));
  t.count = d.count;
  return t;
}
