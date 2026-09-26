/**
 * Phase 15.2: a collider from a model's outline — the pure part.
 *
 * The Scene view projects the model's vertices onto the play plane (X/Y,
 * relative to the object origin, its rotation about Z undone); this module
 * turns those points into a collider shape: the convex hull, simplified to
 * the polygon collider's corner limit by dropping the corner whose removal
 * loses the least area (the outline stays inside the hull), rounded to
 * millimetres and kept valid (convex, counter-clockwise, no repeated or
 * collinear-duplicate corner). A box needs no offset from the origin (box
 * colliders are centred), so "box from model" is a box only when the
 * model's outline is centred on the origin; otherwise it is the same
 * rectangle as a 4-corner polygon.
 */
import { polygonProblem } from './handles';

export interface XY {
  x: number;
  y: number;
}

const round3 = (v: number): number => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};
const crossO = (o: XY, a: XY, b: XY): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** The convex hull, counter-clockwise, without collinear points (Andrew's monotone chain). */
export function convexHull(points: readonly XY[]): XY[] {
  const pts = [...points].filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const lower: XY[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && crossO(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: XY[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && crossO(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Drop the corner that loses the least area until at most `max` remain (the result stays convex). */
export function simplifyConvex(hull: readonly XY[], max: number): XY[] {
  const out = [...hull];
  while (out.length > max && out.length > 3) {
    let best = 0;
    let bestArea = Infinity;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length]!;
      const b = out[i]!;
      const c = out[(i + 1) % out.length]!;
      const area = Math.abs(crossO(a, b, c)) / 2;
      if (area < bestArea) {
        bestArea = area;
        best = i;
      }
    }
    out.splice(best, 1);
  }
  return out;
}

/** Round to millimetres and drop corners that become repeated or bend inwards after rounding. */
function cleanRounded(poly: readonly XY[]): XY[] {
  let pts = poly.map((p) => ({ x: round3(p.x), y: round3(p.y) }));
  for (let guard = 0; guard < 16 && pts.length > 3 && polygonProblem(pts) !== null; guard++) {
    // Remove the corner with the smallest (or negative) turn.
    let worst = 0;
    let worstTurn = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const t = crossO(pts[(i - 1 + pts.length) % pts.length]!, pts[i]!, pts[(i + 1) % pts.length]!);
      if (t < worstTurn) {
        worstTurn = t;
        worst = i;
      }
    }
    pts = pts.filter((_, j) => j !== worst);
  }
  return pts;
}

export type OutlineCollider =
  | { ok: true; shape: { type: 'box'; hx: number; hy: number } | { type: 'polygon'; vertices: [number, number][] }; note?: string }
  | { ok: false; message: string };

/** A polygon collider (at most `maxVertices` corners) from outline points. */
export function polygonFromOutline(points: readonly XY[], maxVertices: number): OutlineCollider {
  const hull = convexHull(points);
  if (hull.length < 3) return { ok: false, message: 'the model has no outline on the play plane (it is flat or empty seen from the front)' };
  const pts = cleanRounded(simplifyConvex(hull, maxVertices));
  const problem = polygonProblem(pts);
  if (problem !== null) return { ok: false, message: `the model outline gives no valid polygon (${problem})` };
  return { ok: true, shape: { type: 'polygon', vertices: pts.map((p) => [p.x, p.y]) } };
}

/** A box collider around outline points: a box when centred on the origin, else the same rectangle as a polygon. */
export function boxFromOutline(points: readonly XY[]): OutlineCollider {
  // A loop, not Math.min(...): a model has many thousands of vertices.
  let [lx, hx, ly, hy] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    lx = Math.min(lx, p.x);
    hx = Math.max(hx, p.x);
    ly = Math.min(ly, p.y);
    hy = Math.max(hy, p.y);
  }
  if (lx === Infinity) return { ok: false, message: 'the model has no outline on the play plane' };
  const [x0, x1, y0, y1] = [lx, hx, ly, hy].map(round3) as [number, number, number, number];
  if (x1 - x0 < 0.002 || y1 - y0 < 0.002) return { ok: false, message: 'the model has no area on the play plane' };
  const centred = Math.abs(x0 + x1) / 2 < 0.01 && Math.abs(y0 + y1) / 2 < 0.01;
  if (centred) return { ok: true, shape: { type: 'box', hx: round3((x1 - x0) / 2), hy: round3((y1 - y0) / 2) } };
  return {
    ok: true,
    shape: { type: 'polygon', vertices: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] },
    note: 'the model is not centred on the object origin, so the box is a 4-corner polygon (a box collider is always centred)',
  };
}

/**
 * Phase 23.1 (a 3D project): a box collider from a model's bounds — centred
 * on the object origin a box with its depth; otherwise (a box collider is
 * always centred) the convex hull of the bounds' eight corners, the same box
 * in place.
 */
export function boxFromBounds3D(bounds: { min: readonly number[]; max: readonly number[] } | null):
  | { ok: true; shape: { type: 'box'; hx: number; hy: number; hz: number } | { type: 'convex'; points: [number, number, number][] }; note?: string }
  | { ok: false; message: string } {
  if (bounds === null) return { ok: false, message: 'the model has no geometry' };
  const lo = bounds.min.map((v) => round3(v ?? 0));
  const hi = bounds.max.map((v) => round3(v ?? 0));
  if ([0, 1, 2].some((i) => hi[i]! - lo[i]! < 0.002)) return { ok: false, message: 'the model is flat: a box collider needs a size on every axis (use a mesh collider)' };
  if ([0, 1, 2].some((i) => Math.abs(lo[i]!) > 64 || Math.abs(hi[i]!) > 64)) return { ok: false, message: 'the model reaches beyond 64 m of its origin (a collider stays within 64 m)' };
  const centred = [0, 1, 2].every((i) => Math.abs(lo[i]! + hi[i]!) / 2 < 0.01);
  if (centred) return { ok: true, shape: { type: 'box', hx: round3((hi[0]! - lo[0]!) / 2), hy: round3((hi[1]! - lo[1]!) / 2), hz: round3((hi[2]! - lo[2]!) / 2) } };
  const points: [number, number, number][] = [];
  for (const x of [lo[0]!, hi[0]!]) for (const y of [lo[1]!, hi[1]!]) for (const z of [lo[2]!, hi[2]!]) points.push([x, y, z]);
  return { ok: true, shape: { type: 'convex', points }, note: 'the model is not centred on the object origin, so the box is an 8-corner convex hull (a box collider is always centred)' };
}
