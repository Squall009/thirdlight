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
import type { ChunkBox, GridFrame } from './grid-place';
import { walkVoxels, type WalkHit, type WalkOptions, type WalkSource } from './occupancy-walk';
import { walkRay, type WalkRay } from './walk-steps';

/** A structure grid as the walk steps it: its frame, its cells as a walk source (its own frame), and the box (grid metres) its cells lie in. */
export interface GridWalk {
  readonly frame: GridFrame;
  readonly source: WalkSource;
  readonly box: { readonly lo: readonly [number, number, number]; readonly hi: readonly [number, number, number] };
}

/** How far before a grid's box (metres along the ray) the walk through the grid starts. */
const GRID_ENTRY_M = 1e-3;

/** A structure grid as the walk steps it: `source` its cells, its box the chunks its files hold (`extent`, chunks of `edge` cells). */
export function gridWalkOf(frame: GridFrame, source: WalkSource, extent: ChunkBox, edge: number, cellM: number): GridWalk {
  const m = edge * cellM;
  const e = extent;
  return { frame, source, box: { lo: [e.min[0] * m, e.min[1] * m, e.min[2] * m], hi: [(e.max[0] + 1) * m, (e.max[1] + 1) * m, (e.max[2] + 1) * m] } };
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
    // Entered a hair before the box: a solid cell on the box's face (a house anchored on its grid's cell 0) is then met
    // by its face, with its normal, not started inside.
    const t0 = Math.max(0, span[0] - GRID_ENTRY_M);
    const gr = walkRay([o[0] + d[0] * t0, o[1] + d[1] * t0, o[2] + d[2] * t0], d);
    if (gr === null) continue;
    const h = walkVoxels(g.source, gr, Math.min(span[1], reach) - t0, { ...opts, far: false }).hit;
    if (h === null) continue;
    const t = t0 + h.t;
    if (t <= reach) best = { t, gridId: g.frame.gridId, hit: h };
  }
  return best;
}

/** The edge (metres) of the square tiles {@link GridWalkIndex} files grids under: a storage chunk's. */
export const GRID_WALK_TILE_M = 16;

/** A tile's key (tiles within ±32,768 of the origin on each axis: ±524 km at 16 m). */
const tileKey = (tx: number, tz: number): number => (tx + 32768) * 65536 + (tz + 32768);

/**
 * Structure grids filed by the square tiles (in x and z) their turned boxes cover, so a ray tests only the grids
 * standing along its way: the tiles its path crosses up to its length, walked tile by tile, each grid once. A town's
 * grids are then a few boxes a ray, not every grid in reach.
 */
export class GridWalkIndex {
  private readonly tiles = new Map<number, number[]>();
  private readonly seen: Int32Array;
  private mark = 0;

  constructor(
    readonly grids: readonly GridWalk[],
    private readonly tileM = GRID_WALK_TILE_M,
  ) {
    this.seen = new Int32Array(grids.length);
    grids.forEach((g, k) => {
      let x0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let z1 = -Infinity;
      for (let c = 0; c < 4; c++) {
        const w = g.frame.toWorld(c & 1 ? g.box.hi[0] : g.box.lo[0], 0, c & 2 ? g.box.hi[2] : g.box.lo[2]);
        x0 = Math.min(x0, w[0]);
        x1 = Math.max(x1, w[0]);
        z0 = Math.min(z0, w[2]);
        z1 = Math.max(z1, w[2]);
      }
      for (let tx = Math.floor(x0 / tileM); tx <= Math.floor(x1 / tileM); tx++) for (let tz = Math.floor(z0 / tileM); tz <= Math.floor(z1 / tileM); tz++) {
        const key = tileKey(tx, tz);
        let list = this.tiles.get(key);
        if (list === undefined) this.tiles.set(key, (list = []));
        list.push(k);
      }
    });
  }

  /** The grids whose tiles a ray's path up to `maxT` (metres) crosses, each once, in their order. */
  along(r: WalkRay, maxT: number): GridWalk[] {
    if (this.grids.length === 0) return [];
    // The grids met so far this call are marked with its number (all cleared before the marks could run out).
    if (this.mark >= 0x3fffffff) {
      this.seen.fill(0);
      this.mark = 0;
    }
    const m = ++this.mark;
    const hit: number[] = [];
    const s = this.tileM;
    const ox = r.origin[0];
    const oz = r.origin[2];
    const dx = r.dir[0];
    const dz = r.dir[2];
    let tx = Math.floor(ox / s);
    let tz = Math.floor(oz / s);
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    // Ray length to the next tile face on each axis, and between faces (2D DDA over the tiles).
    let nextX = stepX === 0 ? Infinity : ((tx + (stepX > 0 ? 1 : 0)) * s - ox) / dx;
    let nextZ = stepZ === 0 ? Infinity : ((tz + (stepZ > 0 ? 1 : 0)) * s - oz) / dz;
    const dtX = stepX === 0 ? Infinity : s / Math.abs(dx);
    const dtZ = stepZ === 0 ? Infinity : s / Math.abs(dz);
    for (;;) {
      for (const k of this.tiles.get(tileKey(tx, tz)) ?? []) {
        if (this.seen[k] === m) continue;
        this.seen[k] = m;
        hit.push(k);
      }
      const t = Math.min(nextX, nextZ);
      if (t > maxT) break;
      if (nextX < nextZ) {
        tx += stepX;
        nextX += dtX;
      } else {
        tz += stepZ;
        nextZ += dtZ;
      }
    }
    return hit.sort((a, b) => a - b).map((k) => this.grids[k]!);
  }
}
