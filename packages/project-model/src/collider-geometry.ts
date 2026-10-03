/**
 * Collider shapes made from geometry: a model's collision parts (or its
 * render geometry) turned into the shapes the project model stores — a
 * convex hull of at most 64 extreme points, a triangle mesh, a box from
 * bounds, and on a 2D plane a convex polygon of at most 8 corners. The
 * editor (from a loaded model), the backend's conversion command and the
 * build that resolves `{type: 'model'}` all make shapes here, so one model
 * gives the same collider wherever it is made.
 *
 * Coordinates are rounded to 1 mm (the stored grid). Pure: no I/O, no three.js.
 */
import { COLLIDER_3D_LIMITS, MAX_COLLIDER_EXTENT, MAX_POLYGON_VERTICES, spansVolume } from './collider-shapes';

export type Vec3Tuple = [number, number, number];
export type Vec2Tuple = [number, number];

/** A collider shape made from geometry, or why none could be made. */
export type GeometryCollider =
  | { ok: true; shape: { type: 'mesh'; vertices: Vec3Tuple[]; triangles: Vec3Tuple[] } | { type: 'convex'; points: Vec3Tuple[] } }
  | { ok: false; message: string };

/** Round to the millimetre (−0 → 0). */
export function roundMm(x: number): number {
  const r = Math.round(x * 1000) / 1000;
  return r === 0 ? 0 : r;
}

/**
 * Directions a hull keeps its extreme points along: the six axes, then
 * points spread evenly over the sphere (a golden spiral), 64 in all.
 */
const HULL_DIRECTIONS: readonly Vec3Tuple[] = (() => {
  const dirs: Vec3Tuple[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const n = COLLIDER_3D_LIMITS.convexPoints - dirs.length;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i += 1) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    dirs.push([Math.cos(golden * i) * r, y, Math.sin(golden * i) * r]);
  }
  return dirs;
})();

/**
 * At most 64 of `points` whose hull stands for theirs: all of them when
 * there are few enough, else the furthest point toward each hull direction
 * (in their original order). The points are taken as they are (not rounded).
 */
export function hullPoints(points: readonly Vec3Tuple[]): Vec3Tuple[] {
  if (points.length <= COLLIDER_3D_LIMITS.convexPoints) return points.map((p) => [p[0], p[1], p[2]]);
  const pick = new Set<number>();
  for (const d of HULL_DIRECTIONS) {
    let best = 0;
    let bestDot = -Infinity;
    points.forEach((p, i) => {
      const dot = p[0] * d[0] + p[1] * d[1] + p[2] * d[2];
      if (dot > bestDot) [bestDot, best] = [dot, i];
    });
    pick.add(best);
  }
  return [...pick].sort((a, b) => a - b).map((i) => [points[i]![0], points[i]![1], points[i]![2]]);
}

/** Points rounded to the millimetre with repeats dropped (first kept). */
function roundedUnique(points: readonly Vec3Tuple[]): Vec3Tuple[] {
  const seen = new Set<string>();
  const out: Vec3Tuple[] = [];
  for (const p of points) {
    const q: Vec3Tuple = [roundMm(p[0]), roundMm(p[1]), roundMm(p[2])];
    const key = `${q[0]},${q[1]},${q[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

/**
 * A convex hull shape of points (one collision part, or a whole model): at
 * most 64 points, rounded to 1 mm; refused when they reach beyond the
 * collider extent or span no volume.
 */
export function convexFromPoints(points: readonly Vec3Tuple[], what = 'geometry'): GeometryCollider {
  const rounded = roundedUnique(points);
  if (rounded.length === 0) return { ok: false, message: `the model's ${what} has no points to make a collider from` };
  if (rounded.some((p) => p.some((c) => Math.abs(c) > MAX_COLLIDER_EXTENT))) return { ok: false, message: `the model's ${what} reaches beyond ${MAX_COLLIDER_EXTENT} m of its origin (a collider stays within ${MAX_COLLIDER_EXTENT} m)` };
  const kept = hullPoints(rounded);
  if (kept.length < 4 || !spansVolume(kept)) return { ok: false, message: `the model's ${what} is flat: a convex hull needs volume (use a mesh collider, or a box)` };
  return { ok: true, shape: { type: 'convex', points: kept } };
}

/**
 * A collider from triangles in the object's frame (`vertices` already merged
 * on the 1 mm grid): a triangle mesh (exact; refused past the mesh limits
 * with a hint) or a convex hull of the vertices.
 */
export function colliderFromTriangles(vertices: readonly Vec3Tuple[], triangles: readonly Vec3Tuple[], kind: 'mesh' | 'convex', what = 'geometry'): GeometryCollider {
  const L = COLLIDER_3D_LIMITS;
  if (vertices.length === 0) return { ok: false, message: 'the model has no geometry to make a collider from' };
  if (vertices.some((p) => p.some((c) => Math.abs(c) > MAX_COLLIDER_EXTENT))) return { ok: false, message: `the model's ${what} reaches beyond ${MAX_COLLIDER_EXTENT} m of its origin (a collider stays within ${MAX_COLLIDER_EXTENT} m)` };
  if (kind === 'convex') return convexFromPoints(vertices, what);
  // Only the vertices triangles use.
  const used = new Map<number, number>();
  const verts: Vec3Tuple[] = [];
  const tris = triangles.map((t) => t.map((i) => {
    let j = used.get(i);
    if (j === undefined) {
      j = verts.length;
      verts.push([vertices[i]![0], vertices[i]![1], vertices[i]![2]]);
      used.set(i, j);
    }
    return j;
  }) as Vec3Tuple);
  if (tris.length === 0) return { ok: false, message: `the model's ${what} has no triangles` };
  if (verts.length > L.meshVertices || tris.length > L.meshTriangles) {
    return { ok: false, message: `the model's ${what} has ${tris.length} triangles and ${verts.length} vertices; a mesh collider takes at most ${L.meshTriangles} and ${L.meshVertices} — add a simpler _COL node, or use a convex hull` };
  }
  return { ok: true, shape: { type: 'mesh', vertices: verts, triangles: tris } };
}

/**
 * A box around bounds in the object's frame, centred where the bounds are
 * (`center` when off the origin by a millimetre or more); refused for a flat
 * model or one beyond the collider extent.
 */
export function boxFromBounds(bounds: { min: readonly number[]; max: readonly number[] } | null):
  | { ok: true; shape: { type: 'box'; hx: number; hy: number; hz: number; center?: Vec3Tuple } }
  | { ok: false; message: string } {
  if (bounds === null) return { ok: false, message: 'the model has no geometry' };
  const lo = [0, 1, 2].map((i) => roundMm(bounds.min[i] ?? 0));
  const hi = [0, 1, 2].map((i) => roundMm(bounds.max[i] ?? 0));
  if ([0, 1, 2].some((i) => hi[i]! - lo[i]! < 0.002)) return { ok: false, message: 'the model is flat: a box collider needs a size on every axis (use a mesh collider)' };
  if ([0, 1, 2].some((i) => Math.abs(lo[i]!) > MAX_COLLIDER_EXTENT || Math.abs(hi[i]!) > MAX_COLLIDER_EXTENT)) return { ok: false, message: `the model reaches beyond ${MAX_COLLIDER_EXTENT} m of its origin (a collider stays within ${MAX_COLLIDER_EXTENT} m)` };
  const center = [0, 1, 2].map((i) => roundMm((lo[i]! + hi[i]!) / 2)) as Vec3Tuple;
  const half = [0, 1, 2].map((i) => roundMm((hi[i]! - lo[i]!) / 2));
  return { ok: true, shape: { type: 'box', hx: half[0]!, hy: half[1]!, hz: half[2]!, ...(center.some((c) => c !== 0) ? { center } : {}) } };
}

// ---- the 2D plane ----------------------------------------------------------------

function cross2(o: Vec2Tuple, a: Vec2Tuple, b: Vec2Tuple): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Andrew's monotone chain: counter-clockwise, no collinear points. */
export function convexHull2(input: readonly Vec2Tuple[]): Vec2Tuple[] {
  const pts = [...input].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  if (pts.length < 3) return pts.map((p) => [p[0], p[1]]);
  const lower: Vec2Tuple[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross2(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 1e-9) lower.pop();
    lower.push([p[0], p[1]]);
  }
  const upper: Vec2Tuple[] = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross2(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 1e-9) upper.pop();
    upper.push([p[0], p[1]]);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function signedArea2(poly: readonly Vec2Tuple[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Remove the corner whose removal loses the least area (the hull stays convex). */
function dropLeastArea(poly: Vec2Tuple[]): Vec2Tuple[] {
  let best = 0;
  let bestLoss = Infinity;
  for (let i = 0; i < poly.length; i += 1) {
    const loss = Math.abs(cross2(poly[(i + poly.length - 1) % poly.length]!, poly[i]!, poly[(i + 1) % poly.length]!));
    if (loss < bestLoss) [bestLoss, best] = [loss, i];
  }
  return poly.filter((_, i) => i !== best);
}

/**
 * The 2D plane's polygon for points: the convex hull of their XY,
 * counter-clockwise, at most 8 corners (the least area dropped first),
 * rounded to 1 mm; null when it has no area.
 */
export function polygonFromPoints(points: readonly (readonly number[])[]): Vec2Tuple[] | null {
  let hull = convexHull2(points.map((p) => [p[0] ?? 0, p[1] ?? 0] as Vec2Tuple));
  while (hull.length > MAX_POLYGON_VERTICES) hull = dropLeastArea(hull);
  const rounded: Vec2Tuple[] = [];
  for (const [x, y] of hull) {
    const q: Vec2Tuple = [roundMm(x), roundMm(y)];
    const last = rounded[rounded.length - 1];
    if (last === undefined || last[0] !== q[0] || last[1] !== q[1]) rounded.push(q);
  }
  const first = rounded[0];
  const last = rounded[rounded.length - 1];
  if (rounded.length > 1 && first !== undefined && last !== undefined && first[0] === last[0] && first[1] === last[1]) rounded.pop();
  const out = convexHull2(rounded);
  if (out.length < 3 || Math.abs(signedArea2(out)) < 1e-4) return null;
  if (out.some((p) => Math.abs(p[0]) > MAX_COLLIDER_EXTENT || Math.abs(p[1]) > MAX_COLLIDER_EXTENT)) return null;
  return out;
}
