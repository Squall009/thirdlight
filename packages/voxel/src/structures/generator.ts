/**
 * The contract every regenerated structure's generator keeps: buildings
 * today, road and river splines and water bodies on the same terms later.
 *
 * A generator is a pure function of a definition: the same definition gives
 * the same voxels, cell for cell, in any order and any process, a chunk at a
 * time over the structure's own grid. Its `version` changes whenever its
 * output for some definition changes; a definition records the version that
 * last wrote its voxels, so an engine with a newer generator knows which
 * structures to regenerate (one regenerate-all step, never a pin).
 */
import { chunkKey, type ChunkCoord, type ChunkGrid } from '../coords';
import type { DenseChunk } from '../dense-chunk';
import type { CellBox } from '../stroke';

/** What every definition carries: the version of the generator that last wrote it. */
export interface GeneratedDefinition {
  readonly generator: number;
}

export interface StructureGenerator<D extends GeneratedDefinition> {
  /** What it makes ('building', …): reports and errors name it. */
  readonly kind: string;
  /** Moves by one whenever its output for any definition changes. */
  readonly version: number;
  /** The definition checked and rebuilt field by field (refusing with a message a designer can act on). */
  canonical(input: unknown): D;
  /** The cells it can write for a definition (inclusive), in the structure's grid; nothing lies outside. */
  box(def: D): CellBox;
  /** Writes chunk (cx, cy, cz) of the structure's grid into `out` (every cell); whether any cell is not air. */
  chunk(def: D, grid: ChunkGrid, cx: number, cy: number, cz: number, out: DenseChunk): boolean;
}

/** The chunks a cell box spans, in key order. */
export function boxChunks(grid: ChunkGrid, b: CellBox): ChunkCoord[] {
  const s = grid.shift;
  const out: ChunkCoord[] = [];
  for (let cx = b.minX >> s; cx <= b.maxX >> s; cx++) for (let cz = b.minZ >> s; cz <= b.maxZ >> s; cz++) for (let cy = b.minY >> s; cy <= b.maxY >> s; cy++) out.push({ cx, cy, cz });
  return out;
}

/** The keys of the chunks a cell box spans. */
export function boxChunkKeys(grid: ChunkGrid, b: CellBox): number[] {
  return boxChunks(grid, b).map((c) => chunkKey(grid, c.cx, c.cy, c.cz));
}
