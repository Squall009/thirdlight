/**
 * Fine far levels baked ahead of time: a voxel world's bake level (the
 * finest far level its far cache stores bricks for) and the fine node bake.
 *
 * A world's far cache always holds its bricks from level 2 (2 m cells) up;
 * a world may ask for its fine levels too, 1 (1 m) or 1 and 0 (0.5 m), so
 * that past the detail ring nothing is built at run time where a level is
 * baked: the page decodes and uploads it, and the voxels need not be held
 * as far as fine bricks are drawn. Only levels finer than the bake are built
 * on the GPU from the streamed chunks (far-fine.ts).
 *
 * A baked fine node is the GPU build's CPU oracle run ahead of time
 * ({@link bakeFarFineNode}): the very block the page would send (its cells
 * read through the same gather, packed and unpacked as the page's block),
 * the CPU build of it and its occlusion. So a node baked and a node built
 * again after an edit are the same bytes (the GPU's build within its 32-bit
 * rounding), and an edit seams against baked neighbours as any node does.
 */
import { VOXEL_SIZE_M, type ChunkGrid } from './coords';
import { farBrickCount, type FarBricks } from './far-bricks';
import { farBricksFromBlock, gatherFarCells, type ChunkCells } from './far-bricks-faces';
import { farBrickOcclusion } from './far-bricks-shade';
import { FAR_FINE_TOP_LEVEL, farFineScale, packFarFine, unpackFarFine } from './far-fine';
import type { MipNode } from './voxel-mips';

/** The bake levels a voxel world may choose, as the metres of a cell at the finest level baked: 2 m (the far cache's own levels), 1 m, 0.5 m. */
export const FAR_BAKE_LEVELS_M = [2, 1, 0.5] as const;

export type FarBakeLevelM = (typeof FAR_BAKE_LEVELS_M)[number];

/** A world's bake level when it sets none: the far cache's own levels, the fine ones built at run time. */
export const DEFAULT_FAR_BAKE_LEVEL_M: FarBakeLevelM = 2;

/** Whether a value is one of {@link FAR_BAKE_LEVELS_M}. */
export function isFarBakeLevelM(v: unknown): v is FarBakeLevelM {
  return (FAR_BAKE_LEVELS_M as readonly unknown[]).includes(v);
}

/** The far level a bake level in metres bakes down to (2 m → 2, 1 m → 1, 0.5 m → 0). */
export function farBakeLevelOf(m: FarBakeLevelM): number {
  return Math.round(Math.log2(m / VOXEL_SIZE_M));
}

/** The finer of two bake levels (a world two scenes name is baked to the finer). */
export function finerFarBakeLevel(a: FarBakeLevelM, b: FarBakeLevelM): FarBakeLevelM {
  return a < b ? a : b;
}

/** The fine levels a bake level stores, coarsest first (the order a bake runs them: a 1 m bake is a 0.5 m bake's first half). */
export function farFineBakedLevels(bakeLevel: number): number[] {
  const out: number[] = [];
  for (let l = FAR_FINE_TOP_LEVEL; l >= Math.max(0, bakeLevel); l--) out.push(l);
  return out;
}

/**
 * The version of a baked fine node's build: the fine block's gather (construction words, roof planes) and the CPU
 * build of it with its occlusion. Another is not this build's (the fine levels are baked again).
 */
export const FAR_FINE_BAKE_BUILD = 1;

/**
 * A fine node's bricks baked (levels 0 and 1): the block the page would send for it, read a chunk at a time through
 * `cells` (the world's chunks), the CPU build of that block and its occlusion; null when it draws nothing (no surface
 * in the block, or no brick stored), which a baked level does not store.
 */
export function bakeFarFineNode(g: ChunkGrid, cells: ChunkCells, n: MipNode): FarBricks | null {
  if (n.level > FAR_FINE_TOP_LEVEL || n.level < 0) throw new RangeError(`far fine bake: level ${n.level} is not a fine level`);
  const packed = packFarFine(gatherFarCells(g, cells, [n.nx, n.ny, n.nz], farFineScale(n.level), true));
  if (packed === null) return null;
  const b = farBricksFromBlock(g, unpackFarFine(packed));
  if (farBrickCount(b) === 0) return null;
  return { ...b, occlusion: farBrickOcclusion(b) };
}
