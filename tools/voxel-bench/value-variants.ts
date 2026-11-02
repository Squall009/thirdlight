/**
 * Variants of the test worlds for measuring the voxel value: a coarser
 * fill level (8 levels instead of 16) and wetness patterns (authored
 * patches, a runtime rain pattern). Each wraps a world's grids and changes
 * the generated cells after the generator wrote them, so the variant is
 * still a pure function of the cell position (any chunk order gives the
 * same bytes).
 *
 * Test data only, never a product feature: the patterns stand for what an
 * author or a weather system could write, to see what the value's fields
 * cost in palettes, memory and compressed bytes.
 */
import { createDenseChunk, SHAPE_FULL, VOXEL_ROLE, WETNESS_MAX, type ChunkGrid, type DenseChunk } from '@thirdlight/voxel';
import { latticeHash4 } from '@thirdlight/shared';
import type { TestGrid, TestWorld } from './world-kit';

export type WetnessPattern = 'none' | 'patches' | 'rain';
export const WETNESS_PATTERNS: readonly WetnessPattern[] = ['none', 'patches', 'rain'];

export interface ValueVariant {
  /** Fill-level bits the world is quantized to: 4 (the format) or 3 (8 levels, stored in the same field). */
  readonly shapeBits: 3 | 4;
  readonly wetness: WetnessPattern;
}

export const DEFAULT_VARIANT: ValueVariant = { shapeBits: 4, wetness: 'none' };

/** A fill level 0 … 15 rounded to `bits` bits and back (any fill above 0 stays above 0). */
export function quantizeShape(shape: number, bits: 3 | 4): number {
  if (bits === 4 || shape === 0 || shape === SHAPE_FULL) return shape;
  const levels = (1 << bits) - 1;
  const q = Math.max(1, Math.round((shape * levels) / SHAPE_FULL));
  return Math.round((q * SHAPE_FULL) / levels);
}

/** A number in [0, 1) from a 2D lattice point, a lane and a seed. */
function unit(seed: number, x: number, z: number, lane: number): number {
  return latticeHash4(x, lane, z, seed) / 2 ** 32;
}

/** Cells per side of the patch lattice (32 m). */
const PATCH_CELL = 64;

/** Authored wet patches: in about a third of the 32 m lattice cells a ball of 6–12 m, wettest at its centre. */
function patchWetness(seed: number, x: number, y: number, z: number): number {
  const lx = Math.floor(x / PATCH_CELL);
  const lz = Math.floor(z / PATCH_CELL);
  let best = 0;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const px = lx + dx;
    const pz = lz + dz;
    if (unit(seed, px, pz, 0) > 0.33) continue;
    const cx = (px + unit(seed, px, pz, 1)) * PATCH_CELL;
    const cz = (pz + unit(seed, px, pz, 2)) * PATCH_CELL;
    const cy = (unit(seed, px, pz, 3) - 0.5) * 80;
    const r = 12 + unit(seed, px, pz, 4) * 12;
    const d = Math.hypot(x - cx, y - cy, z - cz);
    if (d < r) best = Math.max(best, 1 + Math.floor((WETNESS_MAX - 1) * (1 - d / r) + 0.5));
  }
  return best;
}

/** Rain on exposed cells: 3 … 7, varying per 2 m patch (puddles and drier spots). */
function rainWetness(seed: number, x: number, z: number): number {
  return 3 + Math.floor(unit(seed, x >> 2, z >> 2, 7) * (WETNESS_MAX - 2));
}

function variantGrid(g: TestGrid, v: ValueVariant, seed: number): TestGrid {
  const above = new Map<number, DenseChunk>();
  return {
    ...g,
    fill(grid: ChunkGrid, cx: number, cy: number, cz: number, out: DenseChunk): boolean {
      const any = g.fill(grid, cx, cy, cz, out);
      if (!any) return false;
      const n = grid.cellsPerChunk;
      const s = grid.shift;
      const m = grid.mask;
      if (v.shapeBits !== 4) for (let i = 0; i < n; i++) if (out.material[i] !== 0) out.shape[i] = quantizeShape(out.shape[i]!, v.shapeBits);
      if (v.wetness === 'patches') {
        for (let i = 0; i < n; i++) {
          if (out.material[i] === 0 || out.role[i] === VOXEL_ROLE.liquid) continue;
          out.wetness[i] = patchWetness(seed, (cx << s) | (i >>> (s << 1)), (cy << s) | (i & m), (cz << s) | ((i >>> s) & m));
        }
      } else if (v.wetness === 'rain') {
        // A cell is exposed when the cell above it is air; the top layer looks into the chunk above.
        let up = above.get(grid.edge);
        if (up === undefined) above.set(grid.edge, (up = createDenseChunk(grid)));
        const upAny = g.fill(grid, cx, cy + 1, cz, up);
        for (let i = 0; i < n; i++) {
          if (out.material[i] === 0 || out.role[i] === VOXEL_ROLE.liquid) continue;
          const y = i & m;
          const airAbove = y < m ? out.material[i + 1] === 0 : !upAny || up.material[i - m] === 0;
          if (airAbove) out.wetness[i] = rainWetness(seed, (cx << s) | (i >>> (s << 1)), (cz << s) | ((i >>> s) & m));
        }
      }
      return true;
    },
  };
}

/** The world with the variant applied to every grid (the world itself when it is the default). */
export function variantWorld(w: TestWorld, v: ValueVariant): TestWorld {
  if (v.shapeBits === 4 && v.wetness === 'none') return w;
  const seed = w.seed * 31 + 7;
  return { ...w, grids: w.grids.map((g) => variantGrid(g, v, seed)) };
}

/** A short label for reports. */
export function variantLabel(v: ValueVariant): string {
  return `shape ${v.shapeBits} bit, wetness ${v.wetness}`;
}
