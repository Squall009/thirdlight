/**
 * Culling instanced copies against the depth pyramid, without a GPU: the
 * rules `occlusion-instances.ts` runs in compute and the CPU references the
 * tests hold them to.
 *
 * Every culled draw has a range of copies in shared pools, each copy at its
 * slot, and its drawn order (the slot at each place: what the view sees
 * first, nearest first). A frame tests its first `n` places (the copies in
 * the frustum) in two steps:
 *
 * 1. Before the first pass: the copies that were visible last frame, in
 *    their order, make the first pass's list (only for a draw the first pass
 *    draws, an occluder; a draw new to the pools counts every copy visible).
 * 2. After the pyramid: each copy's sphere is tested against this frame's
 *    pyramid; its visibility is kept for the next frame, and the visible
 *    copies the first pass did not draw make the second pass's list.
 *
 * So every copy visible in the finished frame is drawn once: drawn in the
 * first pass, or else not hidden by the first pass's depth (which is only
 * ever farther than the finished frame's) and drawn in the second. A list
 * keeps the copies' order and names them by their place in the draw's order;
 * the vertex stage reads the slot at that place and the copy's 16 floats at
 * that slot as written, so its paint slot (the matrix's fourth row) travels
 * with it unchanged.
 *
 * Depth is compared as the pyramid stores it (standard and logarithmic
 * depth: larger is farther; reversed Z: smaller), with a margin that only
 * ever keeps a copy.
 */
import { occludeeClassOf, OCCLUSION_MIN_TRIANGLES } from '@thirdlight/runtime';

import { INSTANCE_MATRIX_FLOATS } from './attribute-instancing';
import { fartherDepth, type PyramidLayout } from './occlusion-pyramid-rule';

/**
 * Whether an instanced draw is worth culling copy by copy: opaque, worth a
 * test by the runtime's rule, and drawing at least
 * `OCCLUSION_MIN_TRIANGLES` with every copy it holds. A draw of one
 * copy (copies drawn per room often are) is tested as its one copy; the
 * runtime calls it a whole draw, which no other path culls.
 */
export function copiesWorthCulling(triangles: number, copies: number, transparent: boolean): boolean {
  return !transparent && occludeeClassOf({ kind: 'instanced', triangles, items: copies, screenShare: 0 }) !== 'never';
}

/**
 * Whether an instanced draw's copies in view this frame are worth its test: they draw at least
 * `OCCLUSION_MIN_TRIANGLES` together (else it is drawn whole that frame). Both paths ask it.
 */
export function copiesInViewWorthCulling(copiesInView: number, triangles: number): boolean {
  return copiesInView * triangles >= OCCLUSION_MIN_TRIANGLES;
}

/** Floats a copy's matrix takes in the pools (column-major, as drawn: the drawn buffer's own layout). */
export const COPY_FLOATS = INSTANCE_MATRIX_FLOATS;

/**
 * Where a copy tested as a box keeps it in its 16 floats (terrain nodes, which use the first eight, and draws
 * culled whole, which use none): its world box's min xyz from this float, its max xyz four floats later.
 */
export const COPY_BOX_FLOAT = 8;

/**
 * A copy is hidden only when its nearest depth is past the pyramid's
 * farthest by more than this (in depth units): a 24-bit depth buffer
 * rounds a surface's depth by 2^-24, which must never cull a copy whose
 * fragments would pass the depth test.
 */
export const HIDDEN_DEPTH_MARGIN = 2 ** -20;
/** The nearest point of a copy's sphere is moved this much nearer (metres, plus a share of its distance) before its depth is taken. */
export const HIDDEN_NEAR_MARGIN_M = 1e-3;
export const HIDDEN_NEAR_MARGIN_SHARE = 1e-4;

/**
 * Ranges in a pool of copies: first fit, freed ranges joined with their
 * neighbours; when nothing fits, the pool grows (at least doubling), and the
 * new range starts where the old pool ended.
 */
export class RangeAllocator {
  /** Free ranges, by start. */
  private readonly free: { start: number; size: number }[] = [];
  size: number;

  constructor(initial: number) {
    this.size = Math.max(1, Math.floor(initial));
    this.free.push({ start: 0, size: this.size });
  }

  /** A range of `n` copies (the pool may have grown: compare `size`). */
  alloc(n: number): number {
    const want = Math.max(1, Math.floor(n));
    for (let i = 0; i < this.free.length; i += 1) {
      const f = this.free[i]!;
      if (f.size < want) continue;
      const at = f.start;
      f.start += want;
      f.size -= want;
      if (f.size === 0) this.free.splice(i, 1);
      return at;
    }
    // Grow: the free range at the end (if any) is extended, the rest appended.
    const last = this.free.at(-1);
    const tail = last !== undefined && last.start + last.size === this.size ? last.size : 0;
    const grown = Math.max(this.size * 2, this.size - tail + want);
    if (tail > 0) last!.size += grown - this.size;
    else this.free.push({ start: this.size, size: grown - this.size });
    this.size = grown;
    return this.alloc(want);
  }

  release(start: number, n: number): void {
    const size = Math.max(1, Math.floor(n));
    let i = 0;
    while (i < this.free.length && this.free[i]!.start < start) i += 1;
    this.free.splice(i, 0, { start, size });
    // Joined with the next, then with the previous.
    const at = this.free[i]!;
    const next = this.free[i + 1];
    if (next !== undefined && at.start + at.size === next.start) {
      at.size += next.size;
      this.free.splice(i + 1, 1);
    }
    const prev = this.free[i - 1];
    if (prev !== undefined && prev.start + prev.size === at.start) {
      prev.size += at.size;
      this.free.splice(i, 1);
    }
  }

  /** Copies free in all. */
  freeCopies(): number {
    return this.free.reduce((s, f) => s + f.size, 0);
  }
}

/** One draw's step in a frame, as the compute passes see it. */
export interface CopyStep {
  /** Copies tested (the first `n` of the draw's order: those in the frustum). */
  readonly n: number;
  /** Whether the first pass draws this draw (an occluder); else only the second does. */
  readonly firstPass: boolean;
  /** New to the pools: no visibility kept yet (every copy counts as visible last frame). */
  readonly fresh: boolean;
  /** Each tested copy's slot (its place in the draw's own slots), by its place in the order. */
  readonly slots: ArrayLike<number>;
  /** Visibility kept from last frame, by slot (1: visible); written by {@link secondPassList}. */
  readonly visible: Uint8Array;
}

/** The first pass's list: the places, in order, of the copies visible last frame (none for a draw the first pass does not draw). */
export function firstPassList(s: CopyStep): number[] {
  const out: number[] = [];
  if (!s.firstPass) return out;
  for (let p = 0; p < s.n; p += 1) if (s.fresh || s.visible[s.slots[p]!] !== 0) out.push(p);
  return out;
}

/**
 * The second pass's list from this frame's test (`seen(p)`: copy at place p
 * not hidden by the pyramid): the visible copies the first pass did not
 * draw, in order. Keeps each tested copy's visibility for the next frame.
 */
export function secondPassList(s: CopyStep, seen: (place: number) => boolean): number[] {
  const out: number[] = [];
  for (let p = 0; p < s.n; p += 1) {
    const slot = s.slots[p]!;
    const was = s.firstPass && (s.fresh || s.visible[slot] !== 0);
    const now = seen(p);
    s.visible[slot] = now ? 1 : 0;
    if (now && !was) out.push(p);
  }
  return out;
}

/**
 * The 16 floats the vertex stage reads for list entry `i` of a draw whose range starts at `base`: the slot its
 * order (`slots`, by place, the pools' own) holds at the listed place, and the copy there as written (the paint
 * slot rides in float 3).
 */
export function listedCopy(pool: Float32Array, slots: ArrayLike<number>, base: number, list: readonly number[], i: number): Float32Array {
  const at = (base + slots[base + list[i]!]!) * COPY_FLOATS;
  return pool.slice(at, at + COPY_FLOATS);
}

/** What a sphere is tested with: the view (column-major view and projection matrices), its planes, the depth buffer's kind and the pyramid. */
export interface SphereTest {
  readonly view: ArrayLike<number>;
  readonly projection: ArrayLike<number>;
  readonly near: number;
  readonly far: number;
  readonly perspective: boolean;
  readonly reversed: boolean;
  readonly logarithmic: boolean;
  readonly layout: PyramidLayout;
  readonly pyramid: ArrayLike<number>;
}

/** The depth buffer's value at view-space z (negative ahead), as three writes it on WebGPU (z from 0 near to 1 far; reversed: 1 to 0). */
export function depthOfViewZ(viewZ: number, t: Pick<SphereTest, 'near' | 'far' | 'perspective' | 'reversed' | 'logarithmic'>): number {
  const { near, far } = t;
  if (t.perspective && t.logarithmic) return Math.log2(-viewZ / near) / Math.log2(far / near);
  const d = t.perspective ? ((near + viewZ) * far) / ((far - near) * viewZ) : (viewZ + near) / (near - far);
  return t.reversed ? 1 - d : d;
}

/**
 * The finest pyramid level whose 2 × 2 texels cover pixel columns x0..x1 and rows y0..y1 (each texel of level L
 * covers 2^(L+1) pixels a side). It starts at the level whose texels are at least half the rectangle's pixels, where
 * the rectangle spans two or three texels, and goes one coarser only for three: starting where one texel holds the
 * whole rectangle reads texels up to twice as wide as needed, and a draw just behind a wall's edge then reads the
 * sky beyond it, so it is culled at one render size and not at another.
 */
export function levelFor(x0: number, x1: number, y0: number, y1: number, levels: number): number {
  const span = Math.max(x1 - x0, y1 - y0);
  let l = span > 0 ? Math.max(0, Math.ceil(Math.log2(span + 1)) - 2) : 0;
  if ((x1 >> (l + 1)) - (x0 >> (l + 1)) > 1 || (y1 >> (l + 1)) - (y0 >> (l + 1)) > 1) l += 1;
  return Math.min(l, levels - 1);
}

const mul4 = (m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number, number] => [
  m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
  m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
  m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  m[3]! * x + m[7]! * y + m[11]! * z + m[15]!,
];

/**
 * Whether a world-space sphere (centre, radius) may show a pixel: false only
 * when the pyramid's farthest depth over every pixel its projection can
 * touch is nearer than the sphere's nearest point. A sphere reaching the near
 * plane is always kept.
 */
export function sphereMayShow(t: SphereTest, cx: number, cy: number, cz: number, r: number): boolean {
  const [vx, vy, vz] = mul4(t.view, cx, cy, cz);
  const corners: [number, number, number][] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) corners.push([vx + sx * r, vy + sy * r, vz + sz * r]);
  return rectMayShow(t, corners, vz + r);
}

/**
 * Whether a world-space box (min xyz, max xyz) may show a pixel: the same
 * test over its eight corners (a flat terrain node or a long wall is far
 * tighter as a box than as its sphere).
 */
export function boxMayShow(t: SphereTest, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
  const corners: [number, number, number][] = [];
  let nearest = -Infinity;
  for (const x of [x0, x1]) {
    for (const y of [y0, y1]) {
      for (const z of [z0, z1]) {
        const [vx, vy, vz] = mul4(t.view, x, y, z);
        corners.push([vx, vy, vz]);
        nearest = Math.max(nearest, vz);
      }
    }
  }
  return rectMayShow(t, corners, nearest);
}

/**
 * The test both bounds share: `corners` (view space) bound what may be drawn,
 * `nearest` is the view-space z of its nearest point (negative ahead). Hidden
 * only when that point, moved a margin nearer, is past the pyramid's farthest
 * depth over every pixel the corners' projection covers.
 */
function rectMayShow(t: SphereTest, corners: readonly (readonly [number, number, number])[], nearest: number): boolean {
  const nearZ = nearest + HIDDEN_NEAR_MARGIN_M - nearest * HIDDEN_NEAR_MARGIN_SHARE;
  if (-nearZ <= t.near) return true;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [vx, vy, vz] of corners) {
    const c = mul4(t.projection, vx, vy, vz);
    const nx = c[0] / c[3];
    const ny = c[1] / c[3];
    x0 = Math.min(x0, nx);
    x1 = Math.max(x1, nx);
    y0 = Math.min(y0, ny);
    y1 = Math.max(y1, ny);
  }
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  const W = t.layout.sourceWidth;
  const H = t.layout.sourceHeight;
  const px0 = Math.min(Math.floor(clamp(x0 * 0.5 + 0.5) * W), W - 1);
  const px1 = Math.min(Math.floor(clamp(x1 * 0.5 + 0.5) * W), W - 1);
  const py0 = Math.min(Math.floor(clamp(0.5 - y1 * 0.5) * H), H - 1);
  const py1 = Math.min(Math.floor(clamp(0.5 - y0 * 0.5) * H), H - 1);
  const l = levelFor(px0, px1, py0, py1, t.layout.levels.length);
  const lv = t.layout.levels[l]!;
  const tx0 = Math.min(px0 >> (l + 1), lv.width - 1);
  const tx1 = Math.min(px1 >> (l + 1), lv.width - 1);
  const ty0 = Math.min(py0 >> (l + 1), lv.height - 1);
  const ty1 = Math.min(py1 >> (l + 1), lv.height - 1);
  const at = (x: number, y: number): number => t.pyramid[lv.offset + y * lv.width + x]!;
  const far = fartherDepth(fartherDepth(at(tx0, ty0), at(tx1, ty0), t.reversed), fartherDepth(at(tx0, ty1), at(tx1, ty1), t.reversed), t.reversed);
  const d = depthOfViewZ(nearZ, t);
  return t.reversed ? !(d < far - HIDDEN_DEPTH_MARGIN) : !(d > far + HIDDEN_DEPTH_MARGIN);
}
