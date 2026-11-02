/**
 * Repairing damaged chunks: a chunk whose stored bytes fail their checksum
 * or do not decode is repaired from the first source that has a sound copy,
 * or reported; it is never read as air and never silently dropped.
 *
 * Sources are tried in the caller's order, for example: the shipped world
 * (for a game's loaded chunk), the last committed version of the region file
 * (for the editor's working copy), or regenerating it (a structure's grid,
 * whose voxels are a pure function of its definition plus its overrides).
 * A source's bytes are accepted only when they decode as a chunk of the
 * grid and, when the caller knows the content hash the chunk should have,
 * match it. A chunk no source can repair stays reported and unloaded: edits
 * into it are refused and rewrites carry its damaged bytes over verbatim
 * ({@link RegionIndex.entry}), so the damage stays visible until someone
 * decides.
 */
import type { ChunkCoord, ChunkGrid } from './coords';
import { readPaletteHeader } from './palette-codec';

/** A place a chunk's sound bytes may come from. */
export interface RepairSource {
  /** Shown in reports ("shipped world", "last commit", "regenerated"). */
  readonly name: string;
  /**
   * The chunk's canonical codec bytes (null: it is all air), or undefined
   * when this source does not have the chunk.
   */
  chunk(gridId: number, c: Readonly<ChunkCoord>): Promise<Uint8Array | null | undefined>;
}

export type RepairOutcome =
  | { readonly gridId: number; readonly cx: number; readonly cy: number; readonly cz: number; readonly repaired: true; readonly source: string; readonly bytes: Uint8Array | null }
  | { readonly gridId: number; readonly cx: number; readonly cy: number; readonly cz: number; readonly repaired: false; readonly reasons: readonly string[] };

/**
 * Tries each source for each damaged chunk. `expectHash` (optional) gives
 * the content check a source's bytes must pass (e.g. a save's base hash);
 * it returns why the bytes do not match, or null when they do.
 */
export async function repairChunks(
  grid: ChunkGrid,
  gridId: number,
  damaged: readonly Readonly<ChunkCoord>[],
  sources: readonly RepairSource[],
  expectHash?: (c: Readonly<ChunkCoord>, bytes: Uint8Array | null) => string | null,
): Promise<RepairOutcome[]> {
  const out: RepairOutcome[] = [];
  for (const c of damaged) {
    const reasons: string[] = [];
    let done: RepairOutcome | null = null;
    for (const s of sources) {
      let bytes: Uint8Array | null | undefined;
      try {
        bytes = await s.chunk(gridId, c);
      } catch (e) {
        reasons.push(`${s.name}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (bytes === undefined) {
        reasons.push(`${s.name}: does not have it`);
        continue;
      }
      if (bytes !== null) {
        try {
          readPaletteHeader(grid, bytes);
        } catch (e) {
          reasons.push(`${s.name}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
      }
      const mismatch = expectHash?.(c, bytes) ?? null;
      if (mismatch !== null) {
        reasons.push(`${s.name}: ${mismatch}`);
        continue;
      }
      done = { gridId, cx: c.cx, cy: c.cy, cz: c.cz, repaired: true, source: s.name, bytes };
      break;
    }
    out.push(done ?? { gridId, cx: c.cx, cy: c.cy, cz: c.cz, repaired: false, reasons: reasons.length > 0 ? reasons : ['no repair source'] });
  }
  return out;
}
