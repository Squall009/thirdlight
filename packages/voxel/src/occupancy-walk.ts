/**
 * One occupancy walk: a ray through a voxel world's cells, 6-connected (it
 * steps one axis at a time, so it never slips between two solid cells that
 * touch only by an edge), from its first cell to the first cell that stops
 * it. The CPU's walk; three-adapter's WGSL walk (voxel-walk-wgsl.ts) runs
 * the same steps over the same blocks on the GPU (walk-steps.ts: one
 * definition of the arithmetic; the loop and the lookups are each side's,
 * and the browser check runs both on the same rays).
 *
 * - **Blocks, bricks, cells.** A world is read as blocks of one level's
 *   cells (a derive section at level 0, a mip node at level 1 and up, or
 *   the GPU mirror's 32³ blocks: walk-pages.ts), each empty, solid or mixed;
 *   a mixed block as 4³ bricks, each empty, solid or mixed; a mixed brick
 *   cell by cell. Empty blocks and bricks are crossed in one step: the walk
 *   finds the crossing where the ray leaves the box and, along the other
 *   axes, how many cell faces it crossed before that (a search over the
 *   same crossing times), so it lands in exactly the cell a cell-by-cell
 *   walk would reach (the tests check every hit against one).
 * - **Levels.** At each block it enters, the walk takes the finest level
 *   that knows the block holding its level-0 cell there (level 0 within the
 *   detail ring, the mip levels past it); a coarser block once entered is
 *   walked whole. Where no level knows the place, a far node's distance
 *   bricks are marched (the brick renderer's own march, far-bricks-node.ts);
 *   where nothing at all is known the walk passes as through air.
 * - **What stops it** (`stop`). `solid`, what a pick hits: a cell drawn as a
 *   body (the derived occupancy: a whole-box form, or ground at least half
 *   full). `light`, what blocks light: a solid cell whose light coverage is
 *   at least {@link LIGHT_STOP_COVERAGE} of 255 (half or more: ground by its
 *   fill, construction by its integrity once damaged); a coverage under it
 *   lets the ray on. Liquid, openings and air never stop either; props'
 *   coverage is not part of the walk.
 */
import { F32_SCALAR_OPS } from '@thirdlight/shared';

import { BRICK_EDGE } from './brick-layout';
import { cellInWorld, VOXEL_SIZE_M } from './coords';
import { OCCUPANCY } from './derived-data';
import type { FarBricks } from './far-bricks';
import { marchFarNodeFrom, rayBox } from './far-bricks-node';
import { walkBeforeSteps, walkCrossSteps, walkFaceRel, walkFirstSteps, type WalkRay } from './walk-steps';

/** What stops a walk: a body drawn (`solid`, picks) or a cell that blocks light (`light`). */
export const WALK_STOPS = Object.freeze(['solid', 'light'] as const);
export type WalkStop = (typeof WALK_STOPS)[number];

/** Light coverage (of 255) from which a cell stops a light ray: half or more (the proxy threshold of R103). */
export const LIGHT_STOP_COVERAGE = 128;

/** Steps one walk takes at most (a block, a brick or a cell crossed is one), past which it ends unfinished. */
export const WALK_MAX_STEPS = 1 << 16;

/** Metres a walk moves past a far node's box before it looks again (a far node's march ends on its box). */
const FAR_EXIT_M = 1e-3;

/** Bricks a block's edge holds at a block edge of `edge` cells. */
const bricksPerEdge = (edge: number): number => edge / BRICK_EDGE;

/** One block of a level's cells as one stop reads it. */
export interface WalkBlockView {
  /** {@link OCCUPANCY} of the whole block for the stop. */
  readonly flag: number;
  /** {@link OCCUPANCY} of a 4³ brick (index `(bx · n + bz) · n + by`) for the stop. */
  brick(i: number): number;
  /** Whether a cell (index `(x · E + z) · E + y`) stops the ray; right for every cell, whatever the flags say. */
  cell(i: number): boolean;
  /**
   * A column's E cells at once (column `x · E + z`, E ≤ 32): bit y set where {@link cell} of `(x · E + z) · E + y`
   * is true. Absent: read cell by cell. A view over bit masks has it, so packing a block for the page reads words.
   */
  column?(c: number): number;
}

/** A far node a walk marches where no level knows the place: its level, coordinates and bricks (node cells). */
export interface WalkFarNode {
  readonly level: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly bricks: FarBricks;
}

/** What a walk reads of a world. */
export interface WalkSource {
  /** The coarsest level it may know (0: level 0 only). */
  readonly maxLevel: number;
  /** log2 of a block's edge at a level, in that level's cells. */
  blockShift(level: number): number;
  /** The block at block coordinates of a level, as the stop reads it; null: the level does not know it. */
  block(level: number, bx: number, by: number, bz: number, stop: WalkStop): WalkBlockView | null;
  /** The voxel record of a level-0 cell (null: not loaded). */
  record?(x: number, y: number, z: number): number | null;
  /** The far node drawn over a level-0 cell (null: none). */
  farAt?(x: number, y: number, z: number): WalkFarNode | null;
  /** Cells a side of a far node of the source (its chunk edge). */
  readonly farEdge?: number;
}

/** Where a walk was stopped. */
export interface WalkHit {
  /** Metres from the origin to where the ray enters what stopped it. */
  readonly t: number;
  /** The level-0 cell the ray is in there (for a coarser cell, the level-0 cell it enters it by). */
  readonly cell: readonly [number, number, number];
  /** The face it entered by, as the outward normal of the stopping cell (0, 0, 0: it started inside). */
  readonly normal: readonly [number, number, number];
  /** The level whose cell stopped it. */
  readonly level: number;
  /** Stopped by a far node's bricks (the cell and normal are then the point's and the ray's dominant axis's). */
  readonly far: boolean;
  /** The voxel record of the cell (level-0 hits on a source that reads records; else null). */
  readonly record: number | null;
}

/** How a walk ended. */
export type WalkEnd = 'hit' | 'distance' | 'world' | 'steps';

export interface WalkResult {
  readonly hit: WalkHit | null;
  readonly end: WalkEnd;
  /** Blocks, bricks and cells crossed, and far nodes marched. */
  readonly steps: number;
  readonly farNodes: number;
}

export interface WalkOptions {
  readonly stop?: WalkStop;
  /** false: test every cell one by one (the reference the skipping is checked against). */
  readonly skip?: boolean;
  /** false: never march far nodes (where no level knows a place, it is air). */
  readonly far?: boolean;
  /** Steps it takes at most ({@link WALK_MAX_STEPS}): a GPU walk's own limit, for comparing with one. */
  readonly maxSteps?: number;
}

const O = F32_SCALAR_OPS;

/** Ray order of (ta, a) against (tb, b): 1 before. */
const before = (ta: number, a: number, tb: number, b: number): number => walkBeforeSteps(O, ta, a, tb, b);

/** The walk's state between steps. */
interface State {
  level: number;
  /** The cell at `level`. */
  readonly c: number[];
  /** The block at `level` holding `c`, and its view (null: unknown, crossed as air). */
  readonly b: number[];
  view: WalkBlockView | null;
  /** The time it entered `c`, and the axis it entered by (−1: the first cell). */
  t: number;
  axis: number;
  /** The level-0 cell it entered the block by. */
  readonly c0: number[];
}

/** Time the ray crosses the face out of `cell` (of `level`) along axis `a`. */
function crossOut(r: WalkRay, a: number, cell: number, level: number): number {
  return walkCrossSteps(O, O.n(walkFaceRel(cell, level, r.step[a]!, r.cell[a]!)), r.frac[a]!, r.inv[a]!);
}

/**
 * How many of the faces out of cells `from`, `from + step`, … (at `level`, at most `most` of them) the ray crosses
 * along axis `a` before the crossing (t, axis): a search over a sorted run of times.
 */
function crossedBefore(r: WalkRay, a: number, from: number, most: number, level: number, t: number, axis: number): number {
  const s = r.step[a]!;
  let lo = 0;
  let hi = most;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (before(crossOut(r, a, from + s * (mid - 1), level), a, t, axis) === 1) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Leaves the box `lo`–`hi` (cells of the state's level, holding its cell): the crossing out of it first in ray
 * order, and the cell after it along every axis.
 */
function leaveBox(r: WalkRay, st: State, lo: readonly number[], hi: readonly number[]): void {
  const L = st.level;
  const m0 = r.step[0]! > 0 ? hi[0]! : lo[0]!;
  const m1 = r.step[1]! > 0 ? hi[1]! : lo[1]!;
  const m2 = r.step[2]! > 0 ? hi[2]! : lo[2]!;
  const first = walkFirstSteps(O, crossOut(r, 0, m0, L), crossOut(r, 1, m1, L), crossOut(r, 2, m2, L));
  const x = first.axis;
  const m = [m0, m1, m2];
  for (let a = 0; a < 3; a++) {
    if (a === x) continue;
    const most = Math.abs(m[a]! - st.c[a]!);
    if (most > 0) st.c[a]! += r.step[a]! * crossedBefore(r, a, st.c[a]!, most, L, first.t, x);
  }
  st.c[x] = m[x]! + r.step[x]!;
  st.t = first.t;
  st.axis = x;
}

/**
 * The level-0 cell the ray is in just after the crossing (t, axis) into `c` (a cell of `level`): along `axis` the
 * first level-0 cell of `c` it meets, along the others the one it has reached within `c`.
 */
function levelZeroCell(r: WalkRay, c: readonly number[], level: number, t: number, axis: number, out: number[]): void {
  const span = 2 ** level;
  for (let a = 0; a < 3; a++) {
    const s = r.step[a]!;
    const first = s > 0 ? c[a]! * span : (c[a]! + 1) * span - 1;
    if (level === 0) out[a] = c[a]!;
    else if (a === axis) out[a] = first;
    else {
      // The ray may have begun inside `c`: it is never behind its first cell.
      const from = s > 0 ? Math.max(first, r.cell[a]!) : Math.min(first, r.cell[a]!);
      const last = s > 0 ? (c[a]! + 1) * span - 1 : c[a]! * span;
      out[a] = from + s * crossedBefore(r, a, from, Math.abs(last - from), 0, t, axis);
    }
  }
}

/** Takes the finest level that knows the block holding level-0 cell `c0` (unknown everywhere: level 0, no view). */
function enterBlock(src: WalkSource, st: State, c0: readonly number[], stop: WalkStop): void {
  for (let L = 0; L <= src.maxLevel; L++) {
    const sh = src.blockShift(L);
    const cx = Math.floor(c0[0]! / 2 ** L);
    const cy = Math.floor(c0[1]! / 2 ** L);
    const cz = Math.floor(c0[2]! / 2 ** L);
    const view = src.block(L, cx >> sh, cy >> sh, cz >> sh, stop);
    if (view === null) continue;
    setState(st, L, [cx, cy, cz], sh, view, c0);
    return;
  }
  setState(st, 0, c0, src.blockShift(0), null, c0);
}

function setState(st: State, level: number, c: readonly number[], sh: number, view: WalkBlockView | null, c0: readonly number[]): void {
  st.level = level;
  for (let a = 0; a < 3; a++) {
    st.c[a] = c[a]!;
    st.b[a] = c[a]! >> sh;
    st.c0[a] = c0[a]!;
  }
  st.view = view;
}

const hitOf = (src: WalkSource, r: WalkRay, st: State): WalkHit => {
  const normal: [number, number, number] = [0, 0, 0];
  if (st.axis >= 0) normal[st.axis] = -r.step[st.axis]!;
  const cell: [number, number, number] = [st.c[0]!, st.c[1]!, st.c[2]!];
  if (st.level > 0) {
    if (st.axis < 0) cell.splice(0, 3, r.cell[0], r.cell[1], r.cell[2]);
    else levelZeroCell(r, st.c, st.level, st.t, st.axis, cell);
  }
  return { t: Math.max(0, st.t), cell, normal, level: st.level, far: false, record: st.level === 0 ? (src.record?.(cell[0], cell[1], cell[2]) ?? null) : null };
};

/**
 * Walks `r` up to `maxT` metres through `src` (CPU). A ray starting inside a stopping cell is stopped there
 * (distance 0, normal 0).
 */
export function walkVoxels(src: WalkSource, r: WalkRay, maxT: number, opts: WalkOptions = {}): WalkResult {
  const stop = opts.stop ?? 'solid';
  const skip = opts.skip !== false;
  const marchFar = opts.far !== false && src.farAt !== undefined;
  const st: State = { level: 0, c: [0, 0, 0], b: [0, 0, 0], view: null, t: 0, axis: -1, c0: [0, 0, 0] };
  enterBlock(src, st, r.cell, stop);
  const lo = [0, 0, 0];
  const hi = [0, 0, 0];
  let farNodes = 0;
  const most = opts.maxSteps ?? WALK_MAX_STEPS;
  for (let steps = 1; steps <= most; steps++) {
    if (st.t > maxT) return { hit: null, end: 'distance', steps, farNodes };
    if (!cellInWorld(st.c0[0]!, st.c0[1]!, st.c0[2]!)) return { hit: null, end: 'world', steps, farNodes };
    const sh = src.blockShift(st.level);
    const E = 1 << sh;
    const view = st.view;
    let box = 0;
    if (view === null) {
      const far = marchFar ? src.farAt!(st.c0[0]!, st.c0[1]!, st.c0[2]!) : null;
      if (far !== null) {
        farNodes++;
        const out = farStep(src, r, st, far, maxT);
        if (out !== null) return { hit: out, end: 'hit', steps, farNodes };
        if (st.t > maxT) return { hit: null, end: 'distance', steps, farNodes };
        enterBlock(src, st, st.c0, stop);
        continue;
      }
      box = E;
    } else {
      const local = [st.c[0]! - st.b[0]! * E, st.c[1]! - st.b[1]! * E, st.c[2]! - st.b[2]! * E];
      const ci = (local[0]! * E + local[2]!) * E + local[1]!;
      if (!skip) box = view.cell(ci) ? -1 : 1;
      else if (view.flag === OCCUPANCY.empty) box = E;
      else if (view.flag === OCCUPANCY.solid) box = -1;
      else {
        const n = bricksPerEdge(E);
        const bi = ((local[0]! >> 2) * n + (local[2]! >> 2)) * n + (local[1]! >> 2);
        const bf = view.brick(bi);
        box = bf === OCCUPANCY.empty ? BRICK_EDGE : bf === OCCUPANCY.solid ? -1 : view.cell(ci) ? -1 : 1;
      }
    }
    if (box < 0) return { hit: hitOf(src, r, st), end: 'hit', steps, farNodes };
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.floor(st.c[a]! / box) * box;
      hi[a] = lo[a]! + box - 1;
    }
    leaveBox(r, st, lo, hi);
    // Still in the same block: walk on in it; else the block it enters, at the finest level that knows it.
    if ((st.c[0]! >> sh) === st.b[0] && (st.c[1]! >> sh) === st.b[1] && (st.c[2]! >> sh) === st.b[2]) continue;
    const c0 = [0, 0, 0];
    levelZeroCell(r, st.c, st.level, st.t, st.axis, c0);
    const t = st.t;
    const axis = st.axis;
    enterBlock(src, st, c0, stop);
    st.t = t;
    st.axis = axis;
  }
  return { hit: null, end: 'steps', steps: most, farNodes };
}

/**
 * A far node's march from where the ray is (metres `st.t`): its hit, or null with the state moved just past the
 * node's box (`st.c0` the level-0 cell there).
 */
function farStep(src: WalkSource, r: WalkRay, st: State, far: WalkFarNode, maxT: number): WalkHit | null {
  const edge = src.farEdge ?? 32;
  const cellM = VOXEL_SIZE_M * 2 ** far.level;
  const corner = [far.nx * edge, far.ny * edge, far.nz * edge];
  const t0 = Math.max(0, st.t);
  const o = [0, 1, 2].map((a) => (r.origin[a]! + r.dir[a]! * t0) / cellM - corner[a]!);
  const hit = marchFarNodeFrom(far.bricks, o, r.dir);
  if (hit !== null) {
    const t = t0 + hit.t * cellM;
    if (t > maxT) {
      st.t = t;
      return null;
    }
    const p = [0, 1, 2].map((a) => r.origin[a]! + r.dir[a]! * t);
    let axis = 0;
    for (let a = 1; a < 3; a++) if (Math.abs(r.dir[a]!) > Math.abs(r.dir[axis]!)) axis = a;
    const normal: [number, number, number] = [0, 0, 0];
    normal[axis] = -r.step[axis]!;
    const cell: [number, number, number] = [Math.floor(p[0]! / VOXEL_SIZE_M), Math.floor(p[1]! / VOXEL_SIZE_M), Math.floor(p[2]! / VOXEL_SIZE_M)];
    return { t, cell, normal, level: far.level, far: true, record: null };
  }
  const span = rayBox(o, r.dir, { lo: [0, 0, 0], hi: [edge, edge, edge] });
  const t = t0 + (span === null ? 0 : span[1]) * cellM + FAR_EXIT_M;
  st.t = t;
  st.axis = -1;
  for (let a = 0; a < 3; a++) st.c0[a] = Math.floor((r.origin[a]! + r.dir[a]! * t) / VOXEL_SIZE_M);
  return null;
}
