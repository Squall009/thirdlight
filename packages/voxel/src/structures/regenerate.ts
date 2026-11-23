/**
 * Regenerating a structure and keeping its hand edits: the one step every
 * definition change, material swap and generator upgrade goes through.
 *
 * A structure's grid holds what its generator makes plus its overrides
 * (structure-overrides.ts), and nothing else: one structure, one grid. So a
 * regenerate writes the generator's voxels over every chunk the grid holds
 * or the new definition reaches (cells no longer generated become air),
 * reapplies the overrides by the fit rule, and hands back one undo record
 * (each changed chunk as it was) with the chunks as they are after, the
 * fields that changed for the feeds, and the misfits with their cells.
 *
 * Hand edits become overrides as they are made: after an edit, the
 * overrides of the chunks it touched are the cells where the grid now
 * differs from what the generator makes there, generated for those chunks
 * only. An edit that puts a cell back to its generated voxel so drops its
 * override.
 */
import { CellDelta, chunkScratch, denseValue, encodeDenseChunk, exportOrAir } from '../cell-delta';
import { chunkKey, chunkOfKey, type ChunkCoord, type ChunkGrid } from '../coords';
import { copyDenseChunk, createDenseChunk, isAirChunk, type DenseChunk } from '../dense-chunk';
import { UNDO_IMAGE_CHECK_BYTES, type ChunkBefore, type ChunkUndo } from '../edit-apply';
import { changedFields, changeFeeds, materialSwap, valueMaterial } from '../record';
import type { VoxelStoreCandidate } from '../store';
import { chunkOverridesOf, reapplyOverrides, type ChunkOverrides, type StructureOverrides } from '../structure-overrides';
import { boxChunks, type GeneratedDefinition, type StructureGenerator } from './generator';

/** An override that no longer fits, with its cell in the structure's grid. */
export interface StructureMisfit {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The generated voxel it was made over, the voxel it holds, and what is generated there now. */
  readonly base: number;
  readonly value: number;
  readonly generated: number;
}

export interface RegenerateReport<D> {
  /** False when nothing changed (the command layer refuses that as `no_change`). */
  readonly changed: boolean;
  /** Cells whose voxel changed. */
  readonly cells: number;
  /** The undo record: each changed chunk as it was, in key order. */
  readonly undo: readonly ChunkUndo[];
  /** The same chunks as they are now (writing them back is the redo). */
  readonly redo: readonly ChunkUndo[];
  /** The fields that changed in any cell (a PLANE_BIT mask) and the derived parts they feed. */
  readonly fields: number;
  readonly parts: number;
  /** Distinct material changes (from, to), ascending: whether a swap moves cells to another kit. */
  readonly materialSwaps: readonly number[];
  readonly kept: number;
  readonly absorbed: number;
  readonly misfits: readonly StructureMisfit[];
  /** The overrides after: the kept ones, rebased on the new generated voxels. */
  readonly overrides: StructureOverrides;
  /** The definition as now written: the new one with the generator's version. */
  readonly definition: D;
}

/** One chunk's record from its cells: the changed cells' values as a delta, or the whole image when that is smaller. */
export function chunkRecordOf(grid: ChunkGrid, cells: DenseChunk, changed: CellDelta): ChunkBefore {
  if (isAirChunk(cells)) return { kind: 'image', bytes: null };
  // Encoding costs about half a millisecond a chunk: only a delta past the edit's own threshold is weighed against it.
  if (changed.byteLength <= UNDO_IMAGE_CHECK_BYTES) return { kind: 'delta', delta: changed };
  const image = encodeDenseChunk(grid, cells)!;
  return image.length < changed.byteLength ? { kind: 'image', bytes: image } : { kind: 'delta', delta: changed };
}

/**
 * Regenerates a structure from `definition` (canonical) over its grid's
 * store, every chunk it holds and the new definition reaches loaded:
 * writes the generated voxels, reapplies `overrides` by the fit rule and
 * reports. `previous`, the definition that last wrote the grid, adds its
 * box when the store holds only part of the grid.
 */
export function regenerateStructure<D extends GeneratedDefinition>(generator: StructureGenerator<D>, store: VoxelStoreCandidate, gridId: number, overrides: StructureOverrides, definition: D, previous?: D): RegenerateReport<D> {
  const grid = store.grid;
  const keys = new Set<number>(store.chunkKeys());
  for (const c of boxChunks(grid, generator.box(definition))) keys.add(chunkKey(grid, c.cx, c.cy, c.cz));
  if (previous !== undefined) for (const c of boxChunks(grid, generator.box(previous))) keys.add(chunkKey(grid, c.cx, c.cy, c.cz));
  for (const k of overrides.chunks.keys()) keys.add(k);
  const order = [...keys].sort((a, b) => a - b);
  const before = new Map<number, DenseChunk>();
  const gen = chunkScratch(grid).cells;
  for (const key of order) {
    const { cx, cy, cz } = chunkOfKey(grid, key);
    const was = createDenseChunk(grid);
    exportOrAir(store, cx, cy, cz, was);
    before.set(key, was);
    if (generator.chunk(definition, grid, cx, cy, cz, gen)) store.importChunk(cx, cy, cz, gen);
    else store.dropChunk(cx, cy, cz);
  }
  const fit = reapplyOverrides(store, overrides);
  const undo: ChunkUndo[] = [];
  const redo: ChunkUndo[] = [];
  const swaps = new Set<number>();
  let fields = 0;
  let parts = 0;
  let cells = 0;
  const now = createDenseChunk(grid);
  for (const key of order) {
    const { cx, cy, cz } = chunkOfKey(grid, key);
    const was = before.get(key)!;
    exportOrAir(store, cx, cy, cz, now);
    const old = new CellDelta();
    const next = new CellDelta();
    for (let i = 0; i < grid.cellsPerChunk; i++) {
      const a = denseValue(was, i);
      const b = denseValue(now, i);
      if (a === b) continue;
      old.push(i, a);
      next.push(i, b);
      fields |= changedFields(a, b);
      parts |= changeFeeds(a, b);
      if (valueMaterial(a) !== valueMaterial(b)) swaps.add(materialSwap(valueMaterial(a), valueMaterial(b)));
    }
    if (old.count === 0) continue;
    cells += old.count;
    undo.push({ grid: gridId, cx, cy, cz, before: chunkRecordOf(grid, was, old) });
    const after = createDenseChunk(grid);
    copyDenseChunk(now, after);
    redo.push({ grid: gridId, cx, cy, cz, before: chunkRecordOf(grid, after, next) });
  }
  const misfits = fit.misfits.map((m): StructureMisfit => {
    const s = grid.shift;
    const i = m.cell;
    return { x: (m.cx << s) + (i >>> (s << 1)), y: (m.cy << s) + (i & grid.mask), z: (m.cz << s) + ((i >>> s) & grid.mask), base: m.base, value: m.value, generated: m.generated };
  });
  return {
    changed: cells > 0,
    cells,
    undo,
    redo,
    fields,
    parts,
    materialSwaps: [...swaps].sort((a, b) => a - b),
    kept: fit.kept,
    absorbed: fit.absorbed,
    misfits,
    overrides: { grid: overrides.grid, gridId, chunks: fit.overrides.chunks },
    definition: definition.generator === generator.version ? definition : { ...definition, generator: generator.version },
  };
}

/**
 * The overrides after a hand edit on a structure's grid: for each chunk the
 * edit changed, the cells where the store now differs from what the
 * generator makes there (generated for those chunks only), replacing that
 * chunk's overrides; every other chunk's are kept as they are.
 */
export function captureOverrides<D extends GeneratedDefinition>(generator: StructureGenerator<D>, definition: D, store: VoxelStoreCandidate, overrides: StructureOverrides, changed: Iterable<ChunkCoord>): StructureOverrides {
  const grid = store.grid;
  const chunks = new Map<number, ChunkOverrides>(overrides.chunks);
  const gen = chunkScratch(grid).cells;
  const now = createDenseChunk(grid);
  for (const { cx, cy, cz } of changed) {
    const key = chunkKey(grid, cx, cy, cz);
    generator.chunk(definition, grid, cx, cy, cz, gen);
    exportOrAir(store, cx, cy, cz, now);
    const o = chunkOverridesOf(grid, cx, cy, cz, gen, now);
    if (o === null) chunks.delete(key);
    else chunks.set(key, o);
  }
  return { grid: overrides.grid, gridId: overrides.gridId, chunks };
}

/** One structure for {@link regenerateAll}: its grid's store, id, overrides and definition. */
export interface StructureToRegenerate<D> {
  readonly name: string;
  readonly store: VoxelStoreCandidate;
  readonly gridId: number;
  readonly overrides: StructureOverrides;
  readonly definition: D;
}

export interface RegenerateAllReport<D> {
  /** The structures an older generator wrote, each regenerated (in the order given). */
  readonly regenerated: readonly { readonly name: string; readonly report: RegenerateReport<D> }[];
  /** The structures already written by this generator, left alone. */
  readonly current: readonly string[];
  readonly cells: number;
  readonly kept: number;
  readonly absorbed: number;
  readonly misfits: number;
}

/**
 * Regenerates every structure whose definition an older version of the
 * generator wrote (R34: no pinning), and sums what happened, so the command
 * layer can make it one undo step (the undo records together) and report
 * every misfit. A definition from a newer generator is refused by its
 * canonical form before it gets here.
 */
export function regenerateAll<D extends GeneratedDefinition>(generator: StructureGenerator<D>, structures: readonly StructureToRegenerate<D>[]): RegenerateAllReport<D> {
  const regenerated: { name: string; report: RegenerateReport<D> }[] = [];
  const current: string[] = [];
  let cells = 0;
  let kept = 0;
  let absorbed = 0;
  let misfits = 0;
  for (const s of structures) {
    if (s.definition.generator >= generator.version) {
      current.push(s.name);
      continue;
    }
    const report = regenerateStructure(generator, s.store, s.gridId, s.overrides, s.definition);
    regenerated.push({ name: s.name, report });
    cells += report.cells;
    kept += report.kept;
    absorbed += report.absorbed;
    misfits += report.misfits.length;
  }
  return { regenerated, current, cells, kept, absorbed, misfits };
}
