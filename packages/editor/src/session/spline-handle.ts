/**
 * The Scene-view handle of a `spline`: the pure part (no DOM, no three.js),
 * dispatched from `handles.ts` like every other handle kind.
 *
 * A spline lies on the ground, so its grips move across it (a horizontal
 * plane through the grip), not on the object's X/Y plane as a 2D path's do.
 * Each point has a grip on the curve (`p<i>`: across the ground), one above
 * it for its height (`h<i>`: up and down), one at its right edge for its
 * width (`w<i>`) and one where its tangent pulls (`t<i>`: drawn where the
 * curve heads, a third of the tangent out, as a Bézier handle sits). Grips
 * between points (`i<k>`) add a point on the curve there. Alt+click
 * deletes a point, or a tangent (the point goes back to a smooth curve).
 *
 * The model is the curve in the handle's frame (the object's position:
 * points are offsets from it), evaluated by project-model's curve, so the
 * outline drawn is the curve the engine carves and builds along.
 */
import { SPLINE_WIDTH_DEFAULT, SplineCurve, type SplinePoint } from '@thirdlight/runtime';

/** Metres above a point its height grip floats. */
export const SPLINE_HEIGHT_GRIP_M = 1.5;
/** The most segments the outline draws along a curve (a long road keeps a light outline). */
const OUTLINE_SEGMENTS_MAX = 512;

export interface SplineP3 {
  x: number;
  y: number;
  z: number;
}

export interface SplineHandlePoint {
  at: SplineP3;
  tangent?: SplineP3;
  width?: number;
  roll?: number;
}

export interface SplineHandleModel {
  type: 'spline';
  pts: SplineHandlePoint[];
  /** The width of a point without one. */
  width: number;
  closed: boolean;
  minItems: number;
  maxItems: number;
}

export interface SplineGrip {
  id: string;
  at: SplineP3;
  drag: 'level' | 'axis';
  axis?: SplineP3;
  role: 'size' | 'vertex' | 'insert';
}

type Range = { min: number; max: number };
const p3 = (x: number, y: number, z: number): SplineP3 => ({ x, y, z });
const N = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const round3 = (v: number): number => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};
const snapTo = (v: number, step: number, on: boolean): number => (on ? Math.round(v / step) * step : v);
const clamp = (v: number, r: Range | undefined): number => (r === undefined ? v : Math.min(r.max, Math.max(r.min, v)));

/** The model of a stored `points` list (null: not a list of points). */
export function readSplineModel(points: unknown, width: unknown, closed: boolean, minItems: number, maxItems: number): SplineHandleModel | null {
  if (!Array.isArray(points)) return null;
  const pts: SplineHandlePoint[] = [];
  for (const q of points) {
    const o = (typeof q === 'object' && q !== null ? q : {}) as { at?: unknown; tangent?: unknown; width?: unknown; roll?: unknown };
    const a = Array.isArray(o.at) ? o.at : [0, 0, 0];
    const t = Array.isArray(o.tangent) ? o.tangent : null;
    pts.push({ at: p3(N(a[0]), N(a[1]), N(a[2])), ...(t !== null ? { tangent: p3(N(t[0]), N(t[1]), N(t[2])) } : {}), ...(typeof o.width === 'number' ? { width: o.width } : {}), ...(typeof o.roll === 'number' ? { roll: o.roll } : {}) });
  }
  return { type: 'spline', pts, width: N(width, SPLINE_WIDTH_DEFAULT), closed: closed && pts.length >= 3, minItems, maxItems };
}

const asPoints = (m: SplineHandleModel): SplinePoint[] =>
  m.pts.map((q) => ({ at: [q.at.x, q.at.y, q.at.z], ...(q.tangent !== undefined ? { tangent: [q.tangent.x, q.tangent.y, q.tangent.z] } : {}), ...(q.width !== undefined ? { width: q.width } : {}), ...(q.roll !== undefined ? { roll: q.roll } : {}) }));

/** The model's curve (frame coordinates), or null with fewer than two points. */
export function splineCurveOf(m: SplineHandleModel): SplineCurve | null {
  return m.pts.length < 2 ? null : new SplineCurve(asPoints(m), [0, 0, 0], { closed: m.closed, width: m.width });
}

/** Where along the curve each point lies (metres), via the nearest place to it. */
function pointDistances(m: SplineHandleModel, c: SplineCurve): number[] {
  return m.pts.map((q, i) => (i === 0 ? 0 : !m.closed && i === m.pts.length - 1 ? c.length : c.nearest(q.at.x, q.at.y, q.at.z).distance));
}

export function splineGrips(m: SplineHandleModel): SplineGrip[] {
  const c = splineCurveOf(m);
  const g: SplineGrip[] = [];
  const dist = c === null ? [] : pointDistances(m, c);
  m.pts.forEach((q, i) => {
    g.push({ id: `p${i}`, at: q.at, drag: 'level', role: 'vertex' });
    g.push({ id: `h${i}`, at: p3(q.at.x, q.at.y + SPLINE_HEIGHT_GRIP_M, q.at.z), drag: 'axis', axis: p3(0, 1, 0), role: 'size' });
    if (c === null) return;
    const f = c.frameAt(dist[i]!);
    const w = q.width ?? m.width;
    g.push({ id: `w${i}`, at: p3(q.at.x + f.rx * (w / 2), q.at.y + f.ry * (w / 2), q.at.z + f.rz * (w / 2)), drag: 'level', role: 'size' });
    // A tangent's handle a third of it out (where a Bézier control point sits); without one, where the smooth curve heads.
    const t = q.tangent ?? autoTangent(m, i);
    // A vertex grip (Alt+click deletes the point's own tangent).
    g.push({ id: `t${i}`, at: p3(q.at.x + t.x / 3, q.at.y + t.y / 3, q.at.z + t.z / 3), drag: 'level', role: 'vertex' });
  });
  if (c !== null && m.pts.length < m.maxItems) {
    const n = m.pts.length;
    const segs = m.closed ? n : n - 1;
    for (let k = 1; k <= segs; k++) {
      const mid = segmentMid(m, c, dist, k);
      g.push({ id: `i${k}`, at: mid.at, drag: 'level', role: 'insert' });
    }
  }
  return g;
}

/** Catmull-Rom's tangent at point i (what the curve uses without one). */
function autoTangent(m: SplineHandleModel, i: number): SplineP3 {
  const n = m.pts.length;
  const prev = i > 0 ? i - 1 : m.closed ? n - 1 : -1;
  const next = i < n - 1 ? i + 1 : m.closed ? 0 : -1;
  const a = m.pts[prev < 0 ? i : prev]!.at;
  const b = m.pts[next < 0 ? i : next]!.at;
  const k = prev < 0 || next < 0 ? 1 : 0.5;
  return p3((b.x - a.x) * k, (b.y - a.y) * k, (b.z - a.z) * k);
}

/** The curve's middle between point k-1 and point k (k = n: back to the start of a closed curve), with the width there. */
function segmentMid(m: SplineHandleModel, c: SplineCurve, dist: readonly number[], k: number): { at: SplineP3; width: number } {
  const n = m.pts.length;
  const d0 = dist[k - 1]!;
  const d1 = k < n ? dist[k]! : c.length;
  const f = c.frameAt((d0 + Math.max(d0, d1)) / 2);
  return { at: p3(round3(f.x), round3(f.y), round3(f.z)), width: f.width };
}

export function dragSplineGrip(m: SplineHandleModel, id: string, p: SplineP3, snap: boolean, step: number, limits: Readonly<Record<string, Range>>): SplineHandleModel {
  const i = Number(id.slice(1));
  const q = m.pts[i];
  if (!Number.isInteger(i) || q === undefined) return m;
  const put = (next: SplineHandlePoint): SplineHandleModel => ({ ...m, pts: m.pts.map((x, j) => (j === i ? next : x)) });
  const r = limits['points'];
  switch (id[0]) {
    case 'p':
      return put({ ...q, at: p3(round3(clamp(snapTo(p.x, step, snap), r)), q.at.y, round3(clamp(snapTo(p.z, step, snap), r))) });
    case 'h':
      return put({ ...q, at: { ...q.at, y: round3(clamp(snapTo(p.y - SPLINE_HEIGHT_GRIP_M, step, snap), r)) } });
    case 'w': {
      // Twice the distance across the ground from the point (snapped to 5 cm steps, at most the field's range).
      const w = 2 * Math.hypot(p.x - q.at.x, p.z - q.at.z);
      return put({ ...q, width: round3(clamp(snap ? Math.round(w / 0.05) * 0.05 : w, limits['width'] ?? { min: 0, max: 1000 })) });
    }
    case 't': {
      // Across the ground; the tangent keeps its rise.
      const t = q.tangent ?? autoTangent(m, i);
      return put({ ...q, tangent: p3(round3(3 * (p.x - q.at.x)), round3(t.y), round3(3 * (p.z - q.at.z))) });
    }
    default:
      return m;
  }
}

/** Start dragging an insert grip: a new point on the curve there (the drag then moves `p<k>`), or null when full. */
export function insertSplinePoint(m: SplineHandleModel, gripId: string): { model: SplineHandleModel; grip: string } | null {
  if (!gripId.startsWith('i') || m.pts.length >= m.maxItems) return null;
  const k = Number(gripId.slice(1));
  const c = splineCurveOf(m);
  if (c === null || !Number.isInteger(k) || k < 1 || k > (m.closed ? m.pts.length : m.pts.length - 1)) return null;
  const mid = segmentMid(m, c, pointDistances(m, c), k);
  const a = m.pts[k - 1]!;
  const b = m.pts[k % m.pts.length]!;
  // Its width only when a neighbour has one of its own (else the spline's still applies).
  const point: SplineHandlePoint = { at: mid.at, ...(a.width !== undefined || b.width !== undefined ? { width: round3(mid.width) } : {}) };
  return { model: { ...m, pts: [...m.pts.slice(0, k), point, ...m.pts.slice(k)] }, grip: `p${k}` };
}

/** Delete a point (`p<i>`) or a point's own tangent (`t<i>`), or say why not. */
export function deleteSplineGrip(m: SplineHandleModel, gripId: string, label: string): { ok: true; model: SplineHandleModel } | { ok: false; message: string } {
  const i = Number(gripId.slice(1));
  const q = m.pts[i];
  if (q === undefined) return { ok: false, message: 'only a point or its tangent can be deleted' };
  if (gripId.startsWith('t')) {
    if (q.tangent === undefined) return { ok: false, message: 'this point has no tangent of its own (its curve is already smooth)' };
    const { tangent: _drop, ...rest } = q;
    return { ok: true, model: { ...m, pts: m.pts.map((x, j) => (j === i ? rest : x)) } };
  }
  if (!gripId.startsWith('p')) return { ok: false, message: 'only a point or its tangent can be deleted' };
  if (m.pts.length <= m.minItems) return { ok: false, message: `${label} keeps at least ${m.minItems} points` };
  const pts = m.pts.filter((_, j) => j !== i);
  return { ok: true, model: { ...m, pts, closed: m.closed && pts.length >= 3 } };
}

/** The stored `points` value of the model. */
export function splinePointsValue(m: SplineHandleModel): unknown[] {
  const r3 = (v: SplineP3): number[] => [round3(v.x), round3(v.y), round3(v.z)];
  return m.pts.map((q) => ({ at: r3(q.at), ...(q.tangent !== undefined ? { tangent: r3(q.tangent) } : {}), ...(q.width !== undefined ? { width: q.width } : {}), ...(q.roll !== undefined ? { roll: q.roll } : {}) }));
}

/** The outline: the curve and its two edges (frame coordinates). */
export function splineLines(m: SplineHandleModel): SplineP3[][] {
  const c = splineCurveOf(m);
  if (c === null) return [m.pts.map((q) => q.at)];
  const frames = c.frames(Math.max(0.5, c.length / OUTLINE_SEGMENTS_MAX));
  const mid: SplineP3[] = [];
  const left: SplineP3[] = [];
  const right: SplineP3[] = [];
  for (const f of frames) {
    const h = f.width / 2;
    mid.push(p3(f.x, f.y, f.z));
    left.push(p3(f.x - f.rx * h, f.y - f.ry * h, f.z - f.rz * h));
    right.push(p3(f.x + f.rx * h, f.y + f.ry * h, f.z + f.rz * h));
  }
  // Each point's tangent handle, as a line from the point.
  const ticks = m.pts.map((q, i) => {
    const t = q.tangent ?? autoTangent(m, i);
    return [q.at, p3(q.at.x + t.x / 3, q.at.y + t.y / 3, q.at.z + t.z / 3)];
  });
  return [mid, left, right, ...ticks];
}
