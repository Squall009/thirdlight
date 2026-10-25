/**
 * The 3D form of a 2D collider shape, for the one 3D physics backend.
 *
 * A 2D shape is an outline in its object's X/Y plane; on the 3D backend it
 * becomes a solid with a depth along the plane's normal:
 * - a box without `hz` is a box `depth` deep;
 * - a polygon is a prism: one convex hull when its outline is convex, else
 *   a compound of convex prisms (the outline split deterministically);
 * - a circle is a cylinder whose axis is the plane's normal.
 *
 * The plane's normal is the collider's plane axis (`z` when it has none). On
 * an X plane the outline stands in the Y/Z plane: its x runs along −Z (to
 * the right of a camera on the plane's +X side looking back at it, as the
 * outline's x is to the right of one on +Z), its depth along X.
 *
 * Pure and total: same input → same output, never throws.
 */
import { COLLIDER_3D_LIMITS, MAX_COLLIDER_EXTENT } from './collider-shapes';
import type { ModelErrorV2 } from './errors';
import type { PlaneAxis } from './plane-lock';
import type { ColliderPrimitiveShape, ColliderShape } from './types-v2';
import { checkFiniteNumber, isPlainObject } from './validate';

/** The depth (m) a 2D shape gets when its collider names none: a side-scroller's tile is about a metre deep. */
export const DEFAULT_COLLIDER_DEPTH = 1;
/** The deepest a 2D shape is made (m): the collider extent either side of its plane. */
export const MAX_COLLIDER_DEPTH = 2 * MAX_COLLIDER_EXTENT;
/** A prism has two corners per outline corner, so one hull holds at most half the hull's points. */
const PRISM_MAX_CORNERS = Math.floor(COLLIDER_3D_LIMITS.convexPoints / 2);

/** The `depth` field's errors (a positive length up to `MAX_COLLIDER_DEPTH`). */
export function validateColliderDepth(v: unknown, path: string, errors: ModelErrorV2[]): void {
  checkFiniteNumber(v, path, { positive: true, absMax: MAX_COLLIDER_DEPTH }, `0 < depth <= ${MAX_COLLIDER_DEPTH}`, errors);
}

/** A collider's depth for its 2D shapes (absent: the default). */
export function colliderDepthOf(collider: unknown): number {
  const d = isPlainObject(collider) ? collider['depth'] : undefined;
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : DEFAULT_COLLIDER_DEPTH;
}

/** A collider's canonical `depth` (absent when it names none, so it keeps its old canonical bytes). */
export function colliderDepthField(collider: unknown): { depth?: number } {
  const d = isPlainObject(collider) ? collider['depth'] : undefined;
  return typeof d === 'number' ? { depth: d === 0 ? 0 : d } : {};
}

// ---- outlines --------------------------------------------------------------

type P2 = readonly [number, number];
const cross = (o: P2, a: P2, b: P2): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function signedArea(poly: readonly P2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * The outline counter-clockwise without repeated or collinear corners
 * (a corner within `eps` of the line through its neighbours adds nothing to
 * a hull and would make a sliver piece).
 */
function cleanOutline(input: readonly P2[], eps: number): P2[] {
  let pts: P2[] = [];
  for (const p of input) {
    const last = pts[pts.length - 1];
    if (last === undefined || last[0] !== p[0] || last[1] !== p[1]) pts.push([p[0], p[1]]);
  }
  while (pts.length > 1 && pts[0]![0] === pts[pts.length - 1]![0] && pts[0]![1] === pts[pts.length - 1]![1]) pts.pop();
  if (signedArea(pts) < 0) pts.reverse();
  let removed = true;
  while (removed && pts.length >= 3) {
    removed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length]!;
      const b = pts[i]!;
      const c = pts[(i + 1) % pts.length]!;
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (Math.abs(cross(a, b, c)) <= eps * Math.max(len, eps)) {
        pts = pts.filter((_, j) => j !== i);
        removed = true;
        break;
      }
    }
  }
  return pts.length >= 3 ? pts : [];
}

function isConvex(poly: readonly P2[], eps: number): boolean {
  for (let i = 0; i < poly.length; i++) {
    if (cross(poly[i]!, poly[(i + 1) % poly.length]!, poly[(i + 2) % poly.length]!) < -eps) return false;
  }
  return true;
}

/** Whether `p` lies inside or on the counter-clockwise triangle a, b, c. */
function inTriangle(p: P2, a: P2, b: P2, c: P2, eps: number): boolean {
  return cross(a, b, p) >= -eps && cross(b, c, p) >= -eps && cross(c, a, p) >= -eps;
}

/**
 * Ear clipping, always the lowest-indexed ear first, so the same outline
 * splits the same way. A corner whose triangle holds another corner is no
 * ear; an outline with no ear left (it crosses itself) clips its first
 * convex corner, so the split always ends.
 */
function triangulate(pts: readonly P2[], eps: number): [number, number, number][] {
  const idx = pts.map((_, i) => i);
  const tris: [number, number, number][] = [];
  while (idx.length > 3) {
    let ear = -1;
    let firstConvex = -1;
    for (let k = 0; k < idx.length && ear < 0; k++) {
      const ia = idx[(k + idx.length - 1) % idx.length]!;
      const ib = idx[k]!;
      const ic = idx[(k + 1) % idx.length]!;
      if (cross(pts[ia]!, pts[ib]!, pts[ic]!) <= eps) continue;
      if (firstConvex < 0) firstConvex = k;
      let empty = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inTriangle(pts[j]!, pts[ia]!, pts[ib]!, pts[ic]!, eps)) {
          empty = false;
          break;
        }
      }
      if (empty) ear = k;
    }
    const k = ear >= 0 ? ear : Math.max(0, firstConvex);
    tris.push([idx[(k + idx.length - 1) % idx.length]!, idx[k]!, idx[(k + 1) % idx.length]!]);
    idx.splice(k, 1);
  }
  if (idx.length === 3) tris.push([idx[0]!, idx[1]!, idx[2]!]);
  return tris;
}

/** A convex piece with more corners than a hull holds, as a fan of pieces that do. */
function fanSplit(piece: readonly number[], max: number): number[][] {
  if (piece.length <= max) return [[...piece]];
  const out: number[][] = [];
  for (let start = 1; start < piece.length - 1; start += max - 2) {
    out.push([piece[0]!, ...piece.slice(start, Math.min(piece.length, start + max - 1))]);
  }
  return out;
}

/**
 * The convex pieces of a simple outline (either winding; counter-clockwise
 * out), each with at most `maxCorners` corners. A convex outline is one
 * piece; a concave one is ear-clipped and its triangles merged back across
 * their shared edges, in the order the edges were made, while the merge
 * stays convex (Hertel–Mehlhorn: at most four times the fewest pieces). The
 * same outline always gives the same pieces. Empty for a degenerate outline.
 */
export function convexPieces(outline: readonly (readonly [number, number])[], maxCorners: number = PRISM_MAX_CORNERS): [number, number][][] {
  let span = 0;
  for (const p of outline) span = Math.max(span, Math.abs(p[0]), Math.abs(p[1]));
  const eps = 1e-9 * Math.max(1, span);
  const pts = cleanOutline(outline, eps);
  if (pts.length < 3) return [];
  const max = Math.max(3, maxCorners);
  const asPoints = (piece: readonly number[]): [number, number][] => piece.map((i) => [pts[i]![0], pts[i]![1]]);
  if (isConvex(pts, eps)) return fanSplit(pts.map((_, i) => i), max).map(asPoints);
  const n = pts.length;
  // Each piece is a counter-clockwise list of corner indices; `owner` maps a directed edge to its piece.
  const pieces: (number[] | null)[] = [];
  const owner = new Map<string, number>();
  const key = (a: number, b: number): string => `${a},${b}`;
  const diagonals: [number, number][] = [];
  for (const t of triangulate(pts, eps)) {
    const id = pieces.length;
    pieces.push([...t]);
    for (let e = 0; e < 3; e++) {
      const a = t[e]!;
      const b = t[(e + 1) % 3]!;
      owner.set(key(a, b), id);
      // An edge between corners that are not neighbours on the outline is a diagonal (listed once).
      if ((b - a + n) % n !== 1 && a < b) diagonals.push([a, b]);
    }
  }
  for (const [a, b] of diagonals) {
    const ip = owner.get(key(a, b));
    const iq = owner.get(key(b, a));
    if (ip === undefined || iq === undefined || ip === iq) continue;
    const P = pieces[ip]!;
    const Q = pieces[iq]!;
    // P runs a → b, Q runs b → a: P from b round to a, then Q's corners strictly between a and b.
    const pb = P.indexOf(b);
    const qa = Q.indexOf(a);
    const fromP = [...P.slice(pb), ...P.slice(0, pb)];
    const fromQ = [...Q.slice(qa), ...Q.slice(0, qa)].slice(1, -1);
    const merged = [...fromP, ...fromQ];
    if (merged.length > max || !isConvex(merged.map((i) => pts[i]!), eps)) continue;
    pieces[ip] = merged;
    pieces[iq] = null;
    for (let e = 0; e < merged.length; e++) owner.set(key(merged[e]!, merged[(e + 1) % merged.length]!), ip);
    owner.delete(key(a, b));
    owner.delete(key(b, a));
  }
  return pieces.filter((p): p is number[] => p !== null).map(asPoints);
}

// ---- shapes ----------------------------------------------------------------

type Quat = [number, number, number, number];
type V3 = [number, number, number];
const IDENTITY: Quat = [0, 0, 0, 1];
const S45 = Math.SQRT1_2;
/** A cylinder stands along its local Y; this turns that onto Z, the Z plane's normal. */
const Y_TO_Z: Quat = [S45, 0, 0, S45];
/** The Z plane's frame turned onto the X plane's: Z (the depth) onto X, X onto −Z. */
const Z_PLANE_TO_X: Quat = [0, S45, 0, S45];

function mulQ(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function rotV(q: Quat, v: V3): V3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** Rounding noise of the frame turn (1e-12 m) is not part of a shape: it would change canonical bytes for nothing. */
const tidy = (v: number): number => {
  const r = Math.round(v * 1e12) / 1e12;
  return r === 0 ? 0 : r;
};

/** A 2D circle: the outline a 2D overlap and a future 2D collider name, whose 3D form is a cylinder. */
export interface ColliderCircleShape2D {
  type: 'circle';
  radius: number;
  center?: readonly number[];
  rotation?: readonly number[];
}

export interface Shape3DOptions {
  /** The depth along the plane's normal (m; absent: `DEFAULT_COLLIDER_DEPTH`). */
  depth?: number;
  /** The plane's normal axis (absent or null: `z`). */
  plane?: PlaneAxis | null;
}

/** What the conversion did, for telling a game team what to check (one entry per converted shape). */
export interface Shape3DChange {
  /** The 2D shape it was. */
  from: 'box' | 'polygon' | 'circle';
  /** The 3D form: a box, one prism, several prisms (`pieces`) or a cylinder. */
  to: 'box' | 'prism' | 'prisms' | 'cylinder';
  pieces?: number;
}

const isTwoD = (p: Record<string, unknown>): boolean => (p['type'] === 'box' && p['hz'] === undefined) || p['type'] === 'polygon' || p['type'] === 'circle';

/** Whether a collider shape holds a 2D shape (a box without `hz`, a polygon or a circle), whose 3D form `shape2DTo3D` makes. */
export function hasTwoDShape(shape: unknown): boolean {
  if (!isPlainObject(shape)) return false;
  const parts = shape['type'] === 'compound' ? (Array.isArray(shape['shapes']) ? (shape['shapes'] as unknown[]) : []) : [shape];
  return parts.some((p) => isPlainObject(p) && isTwoD(p));
}

/**
 * The 3D form of one primitive (several parts for a split polygon), each in
 * the Z plane's frame with its pose; null for a shape that is already 3D.
 */
function partsOf3D(p: Record<string, unknown>, depth: number, changes: Shape3DChange[]): { shape: ColliderPrimitiveShape; center: V3; rotation: Quat }[] | null {
  if (!isTwoD(p)) return null;
  const c = Array.isArray(p['center']) ? (p['center'] as number[]) : [0, 0, 0];
  const center: V3 = [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
  const q = Array.isArray(p['rotation']) ? (p['rotation'] as number[]) : IDENTITY;
  const rotation: Quat = [q[0] ?? 0, q[1] ?? 0, q[2] ?? 0, q[3] ?? 1];
  const half = depth / 2;
  if (p['type'] === 'box') {
    changes.push({ from: 'box', to: 'box' });
    return [{ shape: { type: 'box', hx: p['hx'] as number, hy: p['hy'] as number, hz: half }, center, rotation }];
  }
  if (p['type'] === 'circle') {
    changes.push({ from: 'circle', to: 'cylinder' });
    return [{ shape: { type: 'cylinder', radius: p['radius'] as number, height: depth }, center, rotation: mulQ(rotation, Y_TO_Z) }];
  }
  const outline = Array.isArray(p['vertices']) ? (p['vertices'] as [number, number][]) : [];
  const pieces = convexPieces(outline);
  changes.push(pieces.length === 1 ? { from: 'polygon', to: 'prism' } : { from: 'polygon', to: 'prisms', pieces: pieces.length });
  return pieces.map((piece) => ({
    shape: { type: 'convex', points: piece.flatMap(([x, y]): V3[] => [[x, y, -half], [x, y, half]]) },
    center,
    rotation,
  }));
}

/** A part with its pose turned into the plane's frame and written only where it is not the default. */
function placed(part: { shape: ColliderPrimitiveShape; center: V3; rotation: Quat }, toPlane: Quat | null): ColliderPrimitiveShape {
  const center = toPlane === null ? part.center : rotV(toPlane, part.center);
  const rotation = toPlane === null ? part.rotation : mulQ(toPlane, part.rotation);
  const c = center.map(tidy) as V3;
  const r = rotation.map(tidy) as Quat;
  const { center: _c, rotation: _r, ...bare } = part.shape as ColliderPrimitiveShape & { center?: unknown; rotation?: unknown };
  return {
    ...(bare as ColliderPrimitiveShape),
    ...(c.some((v) => v !== 0) ? { center: c } : {}),
    ...(r[0] !== 0 || r[1] !== 0 || r[2] !== 0 ? { rotation: r } : {}),
  };
}

/**
 * The 3D form of a collider shape: each 2D primitive (a box without `hz`, a
 * polygon, a circle) made solid along the plane's normal, the 3D ones kept
 * as they are (in a compound too). A polygon split into several prisms makes
 * the shape a compound. `changes` lists each converted primitive. The shape
 * comes back unchanged (the same object) when it holds no 2D primitive; null
 * when nothing is left (a polygon with no area).
 */
export function shape2DTo3D(shape: unknown, options: Shape3DOptions = {}, changes: Shape3DChange[] = []): ColliderShape | null {
  if (!isPlainObject(shape)) return null;
  if (!hasTwoDShape(shape)) return shape as unknown as ColliderShape;
  const depth = options.depth !== undefined && Number.isFinite(options.depth) && options.depth > 0 ? options.depth : DEFAULT_COLLIDER_DEPTH;
  const toPlane = options.plane === 'x' ? Z_PLANE_TO_X : null;
  const compound = shape['type'] === 'compound';
  const list = compound ? (shape['shapes'] as unknown[]).filter(isPlainObject) : [shape];
  const out: ColliderPrimitiveShape[] = [];
  for (const p of list) {
    const made = partsOf3D(p, depth, changes);
    if (made === null) out.push(p as unknown as ColliderPrimitiveShape);
    else for (const part of made) out.push(placed(part, toPlane));
  }
  if (out.length === 0) return null;
  return out.length === 1 && !compound ? out[0]! : { type: 'compound', shapes: out };
}
