/**
 * The arithmetic of the occupancy walk (occupancy-walk.ts), written once
 * over `ScalarOps` for the CPU and the GPU: the CPU walk runs these steps
 * with 32-bit floats (`F32_SCALAR_OPS`), and three-adapter's WGSL walk is
 * written from the same steps (`wgslScalarWriter`), so both order a ray's
 * crossings the same way to the bit.
 *
 * A ray starts in a level-0 cell (integer, `ocell`) at a fraction `frac`
 * (0 ≤ frac < 1, 32-bit) of it along each axis, and moves by `inv` metres a
 * level-0 cell along each axis (0.5 m ÷ the direction's part, signed). It
 * crosses a cell face `rel` level-0 cells from the low corner of its first
 * cell at `(rel − frac) × inv` metres: `rel` is an integer, so the times are
 * computed from integers each time and never summed, and a GPU (whose f32
 * add, subtract, multiply and compare are correctly rounded) gives the same
 * times as `Math.fround`. Every level's faces are level-0 faces, so one
 * time rule serves all of them.
 *
 * Ray order: crossings sort by time, ties by axis (x before y before z).
 * A walk steps one axis at a time in that order, so it never passes
 * diagonally between two cells that touch only by an edge or a corner
 * (6-connected).
 */
import type { ScalarOps } from '@thirdlight/shared';

import { VOXEL_SIZE_M } from './coords';

/** What `inv` is along an axis the ray does not move along (finite: GPUs need not keep infinities). */
export const WALK_INV_NONE = 1e30;

/** Metres along the ray where it crosses the cell face `rel` level-0 cells from its first cell's low corner. */
export function walkCrossSteps<F, B>(o: ScalarOps<F, B>, rel: F, frac: F, inv: F): F {
  return o.mul(o.sub(rel, frac), inv);
}

/** The first of three crossings in ray order (ties: x, then y, then z) and its axis (0, 1, 2). */
export function walkFirstSteps<F, B>(o: ScalarOps<F, B>, tx: F, ty: F, tz: F): { readonly t: F; readonly axis: F } {
  const yFirst = o.lt(ty, tx);
  const t01 = o.select(yFirst, ty, tx);
  const a01 = o.select(yFirst, o.n(1), o.n(0));
  const zFirst = o.lt(tz, t01);
  return { t: o.select(zFirst, tz, t01), axis: o.select(zFirst, o.n(2), a01) };
}

/** 1 when the crossing at `ta` on axis `a` comes before the one at `tb` on axis `b` in ray order, else 0. */
export function walkBeforeSteps<F, B>(o: ScalarOps<F, B>, ta: F, a: F, tb: F, b: F): F {
  return o.select(o.lt(ta, tb), o.n(1), o.select(o.lt(tb, ta), o.n(0), o.select(o.lt(a, b), o.n(1), o.n(0))));
}

/**
 * The level-0 face a ray leaving `cell` (a cell of `level`, 2^level level-0 cells a side) along an axis crosses, as
 * `rel` from the ray's first cell: the cell's high face moving up (`step` 1), its low face moving down.
 */
export function walkFaceRel(cell: number, level: number, step: number, ocell: number): number {
  return (step > 0 ? cell + 1 : cell) * 2 ** level - ocell;
}

/** A ray as the walk takes it: its first level-0 cell, its place in it, metres a cell along each axis, and its direction. */
export interface WalkRay {
  readonly cell: readonly [number, number, number];
  readonly frac: readonly [number, number, number];
  readonly inv: readonly [number, number, number];
  readonly step: readonly [number, number, number];
  /** The origin and unit direction in metres (what a far march and a hit's point are computed from). */
  readonly origin: readonly [number, number, number];
  readonly dir: readonly [number, number, number];
}

/** A ray from `origin` (metres) along `dir` (any length; null: no direction). */
export function walkRay(origin: readonly number[], dir: readonly number[]): WalkRay | null {
  const len = Math.hypot(dir[0]!, dir[1]!, dir[2]!);
  if (!(len > 0) || !Number.isFinite(len) || !origin.slice(0, 3).every(Number.isFinite)) return null;
  const d = [dir[0]! / len, dir[1]! / len, dir[2]! / len] as const;
  const cell: number[] = [];
  const frac: number[] = [];
  const inv: number[] = [];
  const step: number[] = [];
  for (let a = 0; a < 3; a++) {
    const p = origin[a]! / VOXEL_SIZE_M;
    const c = Math.floor(p);
    // A fraction that rounds up to 1 in 32 bits belongs to the next cell.
    let f = Math.fround(p - c);
    // + 0: a cell of −0 is cell 0.
    cell.push((f >= 1 ? c + 1 : c) + 0);
    if (f >= 1) f = 0;
    frac.push(f);
    const da = d[a]!;
    inv.push(Math.abs(da) < 1e-20 ? WALK_INV_NONE : Math.fround(VOXEL_SIZE_M / da));
    step.push(da < 0 && Math.abs(da) >= 1e-20 ? -1 : 1);
  }
  return { cell: cell as [number, number, number], frac: frac as [number, number, number], inv: inv as [number, number, number], step: step as [number, number, number], origin: [origin[0]!, origin[1]!, origin[2]!], dir: d };
}
