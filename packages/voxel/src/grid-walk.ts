/**
 * The occupancy walk through a world and its structure grids, each grid
 * stepped in its own frame: the exact answer for a ray in a world that holds
 * turned grids, on the CPU.
 *
 * The world grid is walked as it is (occupancy-walk.ts). For each grid whose
 * box the ray meets, the ray is moved into the grid's frame
 * ({@link GridFrame}: turned by its yaw, moved by its place; lengths are kept,
 * so distances along the ray are the same in both frames), clipped to the
 * grid's box, and walked through the grid's own cells from where it enters
 * to where it leaves or meets something nearer already found. The nearest
 * stop of all wins.
 *
 * What a GPU twin would need beyond the world's walk: the grids in reach (a
 * box and a frame each) tested at each ray, and a block table a grid; this
 * module is the reference such a twin and a stamp of the grids
 * (structure-stamp.ts) are measured against.
 */
import { rayBox } from './far-bricks-node';
import type { GridFrame } from './grid-place';
import { walkVoxels, type WalkHit, type WalkOptions, type WalkSource } from './occupancy-walk';
import { walkRay, type WalkRay } from './walk-steps';

/** A structure grid as the walk steps it: its frame, its cells as a walk source (its own frame), and the box (grid metres) its cells lie in. */
export interface GridWalk {
  readonly frame: GridFrame;
  readonly source: WalkSource;
  readonly box: { readonly lo: readonly [number, number, number]; readonly hi: readonly [number, number, number] };
}

/** A stop of a walk through a world and its grids: the world's hit, or a grid's (its id; its cell and normal in its own frame). */
export interface GridWalkHit {
  /** Metres along the ray (the same in every frame). */
  readonly t: number;
  /** 0: the world grid. */
  readonly gridId: number;
  readonly hit: WalkHit;
}

/** Grids whose boxes a ray met and walked, for measurements. */
export interface GridWalkCounts {
  tested: number;
  entered: number;
}

/**
 * Walks `r` (world metres) up to `maxT` through `world` and every grid of `grids` whose box it meets, each in its own
 * frame; the nearest stop (null: none within `maxT`). `counts`: grids tested and entered, added to.
 */
export function walkWithGrids(world: WalkSource, grids: readonly GridWalk[], r: WalkRay, maxT: number, opts: WalkOptions = {}, counts?: GridWalkCounts): GridWalkHit | null {
  const w = walkVoxels(world, r, maxT, opts).hit;
  let best: GridWalkHit | null = w === null ? null : { t: w.t, gridId: 0, hit: w };
  for (const g of grids) {
    if (counts !== undefined) counts.tested++;
    const reach = best === null ? maxT : best.t;
    const o = g.frame.toGrid(r.origin[0], r.origin[1], r.origin[2]);
    const d = g.frame.directionToGrid(r.dir[0], r.dir[1], r.dir[2]);
    const span = rayBox(o, d, { lo: [g.box.lo[0], g.box.lo[1], g.box.lo[2]], hi: [g.box.hi[0], g.box.hi[1], g.box.hi[2]] });
    if (span === null || span[0] > reach) continue;
    if (counts !== undefined) counts.entered++;
    const t0 = span[0];
    const gr = walkRay([o[0] + d[0] * t0, o[1] + d[1] * t0, o[2] + d[2] * t0], d);
    if (gr === null) continue;
    const h = walkVoxels(g.source, gr, Math.min(span[1], reach) - t0, { ...opts, far: false }).hit;
    if (h === null) continue;
    const t = t0 + h.t;
    if (t <= reach) best = { t, gridId: g.frame.gridId, hit: h };
  }
  return best;
}
