/**
 * Roofs: gable, hip and mansard roofs over a fill's closed path, their
 * eaves at the fill's height and their faces looking out and up.
 *
 * - A rectangle: planes between the eaves and the ridge (the ridge along
 *   its longer or shorter side), gable ends on the trim slot.
 * - Any other convex polygon: a hip — every eave's plane rising inward at
 *   one slope, each kept where it is the lowest. That is the straight
 *   skeleton of a convex polygon, made without one: an eave's face is the
 *   polygon cut by the half-planes where that eave is nearer than each
 *   other. A mansard bends every face at its inset; a gable needs two
 *   parallel eaves, so over these footprints it is a hip.
 * - A polygon with only right angles (L, T, U and stepped footprints): the
 *   roofs of its largest rectangles (each rectangle inside it that cannot
 *   grow on any side), all at one slope, overlapping. With one slope a
 *   hip's height at a point is the slope times the half-side of the
 *   largest square centred there that fits the footprint (its walls move
 *   in with mitred corners, the straight skeleton's wavefront), and that
 *   square lies in one of those rectangles, whose own hip is exactly that
 *   high there: the highest of the rectangles' hips is the straight
 *   skeleton's roof, with no skeleton computed and no degenerate events to
 *   handle. Mansards likewise (one break height and inset for all); gables
 *   become crossed gables, each wing's ridge running out to its own gable.
 * - Other footprints (concave with slanted sides) are reported and left
 *   without a roof.
 *
 * `rise` over a rectangle keeps its meaning (absent: a quarter of the side
 * across the ridge); over the other footprints it is the height of the
 * highest point over the eaves (absent: half the deepest inset, the same
 * slope as a rectangle's default).
 *
 * Pure. Plain arithmetic (no `Math.sin`, …): the same bytes everywhere.
 */
import { len3 } from './arch-math';
import { type ArchMeshWriter, fillPlanarPolygon, pointInPolygon, polygonArea2, type PlaneFrame } from './arch-mesh';
import type { ArchitectureFill } from './architecture';
import type { TrimRow } from './trim-sheet';
import type { FillContext, PathRect } from './arch-fill';

/** Mansard: the lower slope's share of the rise. */
export const MANSARD_BREAK_DEFAULT = 0.7;

/** The roof shapes this module makes. */
export const ROOF_SHAPES: ReadonlySet<string> = new Set(['gable', 'hip', 'mansard']);

/** Lengths closer than this are one (metres): footprints are drawn on cells, so sides meet exactly. */
const EPS = 1e-6;

/** Fill a 3D planar polygon whose first edge is its along axis; the face looks to the side with `facing` (positive dot). */
export function fillPlane(w: ArchMeshWriter, pts: readonly number[][], facing: readonly number[], ctx: FillContext, row: TrimRow, edgesAo: boolean): void {
  const p0 = pts[0]!;
  const p1 = pts[1]!;
  const a = [p1[0]! - p0[0]!, p1[1]! - p0[1]!, p1[2]! - p0[2]!];
  const la = len3(a[0]!, a[1]!, a[2]!);
  if (la < 1e-9) return;
  for (let k = 0; k < 3; k++) a[k]! /= la;
  // The normal from the polygon's area vector (Newell), then the across axis in the plane.
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    nx += (p[1]! - q[1]!) * (p[2]! + q[2]!);
    ny += (p[2]! - q[2]!) * (p[0]! + q[0]!);
    nz += (p[0]! - q[0]!) * (p[1]! + q[1]!);
  }
  const nl = len3(nx, ny, nz);
  if (nl < 1e-12) return;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  if (nx * facing[0]! + ny * facing[1]! + nz * facing[2]! < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  // b = n × a: across the strips, in the plane.
  const b = [ny * a[2]! - nz * a[1]!, nz * a[0]! - nx * a[2]!, nx * a[1]! - ny * a[0]!];
  const poly: number[] = [];
  for (const p of pts) {
    const dx = p[0]! - p0[0]!;
    const dy = p[1]! - p0[1]!;
    const dz = p[2]! - p0[2]!;
    poly.push(dx * a[0]! + dy * a[1]! + dz * a[2]!, dx * b[0]! + dy * b[1]! + dz * b[2]!);
  }
  const f: PlaneFrame = { o: p0, a, b, n: [nx, ny, nz] };
  fillPlanarPolygon(w, poly, f, { sheet: ctx.sheet, row, aoStrength: edgesAo ? ctx.aoStrength : 0, aoRadius: ctx.aoRadius });
}

/** What a rectangle's roof is made with (the fill's numbers, or a piece of a larger footprint's at the footprint's slope). */
interface RectRoof {
  shape: 'gable' | 'hip' | 'mansard';
  rise: number;
  overhang: number;
  /** Mansard: metres the break steps in and the break's height over the eaves. */
  inset: number;
  lower: number;
}

/** A rectangle's roof (`r`: its corner and axes, the ridge along `a`). */
function rectRoof(w: ArchMeshWriter, trim: ArchMeshWriter, r: PathRect, base: number, roof: RectRoof, row: TrimRow, trimRow: TrimRow, ctx: FillContext): void {
  const P = (a: number, b: number, y: number): number[] => [r.o[0] + r.a[0] * a + r.b[0] * b, y, r.o[2] + r.a[2] * a + r.b[2] * b];
  const overhang = roof.overhang;
  const W = r.lb;
  const L = r.la;
  const rise = roof.rise;
  if (roof.shape === 'gable') {
    const slope = rise / (W / 2);
    const ye = base - overhang * slope;
    const yr = base + rise;
    fillPlane(w, [P(-overhang, -overhang, ye), P(L + overhang, -overhang, ye), P(L + overhang, W / 2, yr), P(-overhang, W / 2, yr)], [0, 1, 0], ctx, row, false);
    fillPlane(w, [P(L + overhang, W + overhang, ye), P(-overhang, W + overhang, ye), P(-overhang, W / 2, yr), P(L + overhang, W / 2, yr)], [0, 1, 0], ctx, row, false);
    const outA = [-r.a[0], 0, -r.a[2]];
    fillPlane(trim, [P(0, 0, base), P(0, W, base), P(0, W / 2, yr)], outA, ctx, trimRow, false);
    fillPlane(trim, [P(L, W, base), P(L, 0, base), P(L, W / 2, yr)], r.a, ctx, trimRow, false);
    return;
  }
  if (roof.shape === 'hip') {
    hip(w, P, 0, 0, L, W, base, rise, overhang, row, ctx);
    return;
  }
  // Mansard: a steep lower slope to an inset break line, then a shallow hip.
  const inset = roof.inset;
  const lower = roof.lower;
  const slope = inset > 0 ? lower / inset : 0;
  const ye = base - overhang * slope;
  const yb = base + lower;
  const eave = [P(-overhang, -overhang, ye), P(L + overhang, -overhang, ye), P(L + overhang, W + overhang, ye), P(-overhang, W + overhang, ye)];
  const brk = [P(inset, inset, yb), P(L - inset, inset, yb), P(L - inset, W - inset, yb), P(inset, W - inset, yb)];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    fillPlane(w, [eave[i]!, eave[j]!, brk[j]!, brk[i]!], [0, 1, 0], ctx, row, false);
  }
  hip(w, P, inset, inset, L - 2 * inset, W - 2 * inset, yb, rise - lower, 0, row, ctx);
}

/** A hip roof over the rectangle [a0, a0 + L] × [b0, b0 + W], ridge along a. */
function hip(w: ArchMeshWriter, P: (a: number, b: number, y: number) => number[], a0: number, b0: number, L: number, W: number, base: number, rise: number, overhang: number, row: TrimRow, ctx: FillContext): void {
  if (L < W) {
    // The ridge runs along the longer side: swap by walking the rectangle the other way round.
    const Q = (a: number, b: number, y: number): number[] => P(a0 + (b - b0), b0 + (a - a0), y);
    hipAligned(w, Q, a0, b0, W, L, base, rise, overhang, row, ctx);
    return;
  }
  hipAligned(w, P, a0, b0, L, W, base, rise, overhang, row, ctx);
}

function hipAligned(w: ArchMeshWriter, P: (a: number, b: number, y: number) => number[], a0: number, b0: number, L: number, W: number, base: number, rise: number, overhang: number, row: TrimRow, ctx: FillContext): void {
  const slope = W > 0 ? rise / (W / 2) : 0;
  const ye = base - overhang * slope;
  const yr = base + rise;
  const o = overhang;
  const e0 = P(a0 - o, b0 - o, ye);
  const e1 = P(a0 + L + o, b0 - o, ye);
  const e2 = P(a0 + L + o, b0 + W + o, ye);
  const e3 = P(a0 - o, b0 + W + o, ye);
  const r0 = P(a0 + W / 2, b0 + W / 2, yr);
  const r1 = P(a0 + L - W / 2, b0 + W / 2, yr);
  const up = [0, 1, 0];
  const ridge = L - W > 1e-6;
  fillPlane(w, ridge ? [e0, e1, r1, r0] : [e0, e1, r0], up, ctx, row, false);
  fillPlane(w, [e1, e2, r1], up, ctx, row, false);
  fillPlane(w, ridge ? [e2, e3, r0, r1] : [e2, e3, r0], up, ctx, row, false);
  fillPlane(w, [e3, e0, r0], up, ctx, row, false);
}

/**
 * Write a roof fill. `rect` is the path as a rectangle (null: it is not one).
 * Returns a problem to report, or null.
 */
export function writeRoof(w: ArchMeshWriter, trim: ArchMeshWriter, e: ArchitectureFill, outline: readonly number[], rect: PathRect | null, base: number, row: TrimRow, trimRow: TrimRow, ctx: FillContext): string | null {
  const overhang = e.overhang ?? 0;
  if (rect !== null) {
    const W = rect.lb;
    const L = rect.la;
    const rise = e.rise ?? W / 4;
    const inset = Math.min(e.inset ?? W / 6, W / 2 - 1e-3, L / 2 - 1e-3);
    const lower = rise * (e.breakRise ?? MANSARD_BREAK_DEFAULT);
    rectRoof(w, trim, rect, base, { shape: e.shape as RectRoof['shape'], rise, overhang, inset, lower }, row, trimRow, ctx);
    return null;
  }
  const poly = footprint(outline);
  if (poly === null) return `fill "${e.id}": a ${e.shape} needs a footprint of at least three corners`;
  // Right angles first: a rectangle drawn with a split side is still a rectangle (its gable stays a gable).
  const frame = rightAngled(poly);
  if (frame !== null) {
    rectilinearRoof(w, trim, poly, frame, e, base, overhang, row, trimRow, ctx);
    return null;
  }
  if (!convex(poly)) return `fill "${e.id}": a ${e.shape} needs a convex footprint or one with only right angles`;
  convexRoof(w, poly, e, base, overhang, row, ctx);
  return null;
}

// ---- footprints --------------------------------------------------------------------------------

/** The outline's corners counter-clockwise in (x, z), repeated and in-line points left out (null: no area). */
function footprint(outline: readonly number[]): number[] | null {
  const pts: number[] = [];
  const n = outline.length / 2;
  for (let i = 0; i < n; i++) {
    const x = outline[i * 2]!;
    const z = outline[i * 2 + 1]!;
    const k = pts.length / 2;
    if (k > 0 && Math.abs(pts[(k - 1) * 2]! - x) < EPS && Math.abs(pts[(k - 1) * 2 + 1]! - z) < EPS) continue;
    pts.push(x, z);
  }
  let k = pts.length / 2;
  if (k > 1 && Math.abs(pts[0]! - pts[(k - 1) * 2]!) < EPS && Math.abs(pts[1]! - pts[(k - 1) * 2 + 1]!) < EPS) {
    pts.length -= 2;
    k -= 1;
  }
  // In-line corners (a side split in two) are no corners.
  const out: number[] = [];
  for (let i = 0; i < k; i++) {
    const ax = pts[((i + k - 1) % k) * 2]!;
    const az = pts[((i + k - 1) % k) * 2 + 1]!;
    const bx = pts[i * 2]!;
    const bz = pts[i * 2 + 1]!;
    const cx = pts[((i + 1) % k) * 2]!;
    const cz = pts[((i + 1) % k) * 2 + 1]!;
    const cross = (bx - ax) * (cz - bz) - (bz - az) * (cx - bx);
    const l = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az)) * Math.sqrt((cx - bx) * (cx - bx) + (cz - bz) * (cz - bz));
    if (Math.abs(cross) <= EPS * Math.max(l, EPS)) continue;
    out.push(bx, bz);
  }
  if (out.length < 6) return null;
  const area = polygonArea2(out);
  if (Math.abs(area) < EPS) return null;
  if (area > 0) return out;
  const rev: number[] = [];
  for (let i = out.length / 2 - 1; i >= 0; i--) rev.push(out[i * 2]!, out[i * 2 + 1]!);
  return rev;
}

/** Whether a counter-clockwise polygon is convex (every corner turns left). */
function convex(p: readonly number[]): boolean {
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    const b = ((i + 1) % n) * 2;
    const c = ((i + 2) % n) * 2;
    const cross = (p[b]! - p[a]!) * (p[c + 1]! - p[b + 1]!) - (p[b + 1]! - p[a + 1]!) * (p[c]! - p[b]!);
    if (cross < 0) return false;
  }
  return true;
}

/** The axes of a polygon whose sides all run along two perpendicular directions (unit u, then v = u turned left), or null. */
function rightAngled(p: readonly number[]): { u: [number, number]; v: [number, number] } | null {
  const n = p.length / 2;
  const dx = p[2]! - p[0]!;
  const dz = p[3]! - p[1]!;
  const l = Math.sqrt(dx * dx + dz * dz);
  const u: [number, number] = [dx / l, dz / l];
  for (let i = 0; i < n; i++) {
    const ex = p[((i + 1) % n) * 2]! - p[i * 2]!;
    const ez = p[((i + 1) % n) * 2 + 1]! - p[i * 2 + 1]!;
    const el = Math.sqrt(ex * ex + ez * ez);
    const along = Math.abs(ex * u[0] + ez * u[1]);
    const across = Math.abs(-ex * u[1] + ez * u[0]);
    if (Math.min(along, across) > 1e-6 * el) return null;
  }
  return { u, v: [-u[1], u[0]] };
}

// ---- convex footprints: the lowest of the eaves' planes ------------------------------------

/** Keep the part of a convex polygon (xy pairs) where `f` ≤ 0 (f affine). */
function clip(poly: readonly number[], f: (x: number, y: number) => number): number[] {
  const out: number[] = [];
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2]!;
    const ay = poly[i * 2 + 1]!;
    const bx = poly[((i + 1) % n) * 2]!;
    const by = poly[((i + 1) % n) * 2 + 1]!;
    const fa = f(ax, ay);
    const fb = f(bx, by);
    if (fa <= 0) out.push(ax, ay);
    if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) {
      const t = fa / (fa - fb);
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  }
  return out;
}

/** A convex polygon's roof: each eave's face, where its plane is the lowest, rising `slope` per metre in from it. */
function convexRoof(w: ArchMeshWriter, p: readonly number[], e: ArchitectureFill, base: number, overhang: number, row: TrimRow, ctx: FillContext): void {
  const n = p.length / 2;
  // Each side's inward normal (left of travel, counter-clockwise) and its offset: d_i(x, y) = nx·x + ny·y − c.
  const nx: number[] = [];
  const ny: number[] = [];
  const c: number[] = [];
  for (let i = 0; i < n; i++) {
    const ax = p[i * 2]!;
    const ay = p[i * 2 + 1]!;
    const bx = p[((i + 1) % n) * 2]!;
    const by = p[((i + 1) % n) * 2 + 1]!;
    const l = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
    nx.push(-(by - ay) / l);
    ny.push((bx - ax) / l);
    c.push(nx[i]! * ax + ny[i]! * ay);
  }
  const d = (i: number, x: number, y: number): number => nx[i]! * x + ny[i]! * y - c[i]!;
  // The eaves: the footprint moved out by the overhang, corners mitred (each side's line moved along its normal).
  const outer: number[] = [];
  for (let i = 0; i < n; i++) {
    const h = (i + n - 1) % n;
    // The corner where sides h and i, each moved out by `overhang`, meet.
    const det = nx[h]! * ny[i]! - ny[h]! * nx[i]!;
    const ch = c[h]! - overhang;
    const ci = c[i]! - overhang;
    outer.push((ch * ny[i]! - ny[h]! * ci) / det, (nx[h]! * ci - ch * nx[i]!) / det);
  }
  // Each side's face: the eaves' polygon where that side is the nearest.
  const faces: number[][] = [];
  let deepest = 0;
  for (let i = 0; i < n; i++) {
    let f = outer;
    for (let j = 0; j < n && f.length >= 6; j++) if (j !== i) f = clip(f, (x, y) => d(i, x, y) - d(j, x, y));
    faces.push(f);
    for (let k = 0; k < f.length; k += 2) deepest = Math.max(deepest, d(i, f[k]!, f[k + 1]!));
  }
  if (deepest <= EPS) return;
  const rise = e.rise ?? deepest / 2;
  const slope = rise / deepest;
  const mansard = e.shape === 'mansard';
  const inset = mansard ? Math.min(e.inset ?? deepest / 3, deepest - 1e-3) : 0;
  const lower = rise * (e.breakRise ?? MANSARD_BREAK_DEFAULT);
  const lowSlope = inset > 0 ? lower / inset : slope;
  const highSlope = deepest - inset > 0 ? (rise - lower) / (deepest - inset) : 0;
  const height = (dist: number): number => (!mansard ? base + slope * dist : dist <= inset ? base + lowSlope * dist : base + lower + highSlope * (dist - inset));
  for (let i = 0; i < n; i++) {
    const f = faces[i]!;
    if (f.length < 6) continue;
    const parts = mansard ? [clip(f, (x, y) => d(i, x, y) - inset), clip(f, (x, y) => inset - d(i, x, y))] : [f];
    for (const part of parts) {
      if (part.length < 6) continue;
      const pts: number[][] = [];
      for (let k = 0; k < part.length; k += 2) pts.push([part[k]!, height(d(i, part[k]!, part[k + 1]!)), part[k + 1]!]);
      fillPlane(w, alongEave(pts, (q) => d(i, q[0]!, q[2]!)), [0, 1, 0], ctx, row, false);
    }
  }
}

/** A face's corners turned so its first edge is the one nearest its eave (the strips run along the eave). */
function alongEave(pts: number[][], dist: (q: readonly number[]) => number): number[][] {
  let best = 0;
  let bestD = Infinity;
  let bestL = -1;
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k]!;
    const b = pts[(k + 1) % pts.length]!;
    const l = (b[0]! - a[0]!) * (b[0]! - a[0]!) + (b[2]! - a[2]!) * (b[2]! - a[2]!);
    if (l < EPS) continue;
    const m = (dist(a) + dist(b)) / 2;
    if (m < bestD - EPS || (Math.abs(m - bestD) <= EPS && l > bestL)) {
      best = k;
      bestD = m;
      bestL = l;
    }
  }
  return [...pts.slice(best), ...pts.slice(0, best)];
}

// ---- right-angled footprints: the largest rectangles' roofs at one slope ------------------

/**
 * Every rectangle inside a right-angled polygon that cannot grow on any side,
 * in the polygon's axes: [u0, u1, v0, v1] (metres along u and v).
 */
export function largestRectangles(p: readonly number[], u: readonly number[], v: readonly number[]): [number, number, number, number][] {
  const n = p.length / 2;
  const us: number[] = [];
  const vs: number[] = [];
  const local: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = p[i * 2]!;
    const y = p[i * 2 + 1]!;
    const a = x * u[0]! + y * u[1]!;
    const b = x * v[0]! + y * v[1]!;
    local.push(a, b);
    us.push(a);
    vs.push(b);
  }
  const uniq = (xs: number[]): number[] => {
    xs.sort((a, b) => a - b);
    const out: number[] = [];
    for (const x of xs) if (out.length === 0 || x - out[out.length - 1]! > EPS) out.push(x);
    return out;
  };
  const U = uniq(us);
  const V = uniq(vs);
  const nu = U.length - 1;
  const nv = V.length - 1;
  // Which cells of the grid the corners make are inside.
  const inside: boolean[] = [];
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) inside.push(pointInPolygon((U[i]! + U[i + 1]!) / 2, (V[j]! + V[j + 1]!) / 2, local));
  const cell = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < nu && j < nv && inside[j * nu + i]!;
  const out: [number, number, number, number][] = [];
  const rows = new Array<boolean>(nv);
  for (let i0 = 0; i0 < nu; i0++) {
    rows.fill(true);
    for (let i1 = i0 + 1; i1 <= nu; i1++) {
      for (let j = 0; j < nv; j++) rows[j] = rows[j]! && cell(i1 - 1, j);
      // Each run of rows the columns [i0, i1) fill is a rectangle that cannot grow up or down.
      for (let j = 0; j < nv; ) {
        if (!rows[j]) {
          j++;
          continue;
        }
        let k = j;
        while (k < nv && rows[k]) k++;
        // It cannot grow left or right either when a column beside it is not filled over the whole run.
        let left = i0 > 0;
        let right = i1 < nu;
        for (let r = j; r < k && (left || right); r++) {
          if (!cell(i0 - 1, r)) left = false;
          if (!cell(i1, r)) right = false;
        }
        if (!left && !right) out.push([U[i0]!, U[i1]!, V[j]!, V[k]!]);
        j = k;
      }
    }
  }
  return out;
}

/** A right-angled polygon's roof: its largest rectangles' roofs, at the slope (and break) the deepest of them sets. */
function rectilinearRoof(w: ArchMeshWriter, trim: ArchMeshWriter, p: readonly number[], axes: { u: [number, number]; v: [number, number] }, e: ArchitectureFill, base: number, overhang: number, row: TrimRow, trimRow: TrimRow, ctx: FillContext): void {
  const rects = largestRectangles(p, axes.u, axes.v);
  let deepest = 0;
  for (const [u0, u1, v0, v1] of rects) deepest = Math.max(deepest, Math.min(u1 - u0, v1 - v0) / 2);
  if (deepest <= EPS) return;
  const rise = e.rise ?? deepest / 2;
  const slope = rise / deepest;
  const inset = Math.min(e.inset ?? deepest / 3, deepest - 1e-3);
  const lower = rise * (e.breakRise ?? MANSARD_BREAK_DEFAULT);
  const lowSlope = inset > 0 ? lower / inset : slope;
  const highSlope = deepest - inset > 0 ? (rise - lower) / (deepest - inset) : 0;
  const [ux, uz] = axes.u;
  const [vx, vz] = axes.v;
  for (const [u0, u1, v0, v1] of rects) {
    const du = u1 - u0;
    const dv = v1 - v0;
    // The ridge along the longer side (or the shorter one): a runs along it, b across.
    const alongU = (e.axis ?? 'long') === 'long' ? du >= dv : du < dv;
    const la = alongU ? du : dv;
    const lb = alongU ? dv : du;
    // The corner the axes leave from, with b turned left of a (the rectangle on b's positive side).
    const a: [number, number, number] = alongU ? [ux, 0, uz] : [vx, 0, vz];
    const b: [number, number, number] = alongU ? [vx, 0, vz] : [-ux, 0, -uz];
    const o: [number, number, number] = alongU ? [ux * u0 + vx * v0, base, uz * u0 + vz * v0] : [ux * u1 + vx * v0, base, uz * u1 + vz * v0];
    const r: PathRect = { o, a, b, la, lb };
    const half = Math.min(du, dv) / 2;
    if (e.shape === 'gable') rectRoof(w, trim, r, base, { shape: 'gable', rise: slope * (lb / 2), overhang, inset: 0, lower: 0 }, row, trimRow, ctx);
    else if (e.shape === 'hip') rectRoof(w, trim, r, base, { shape: 'hip', rise: slope * half, overhang, inset: 0, lower: 0 }, row, trimRow, ctx);
    else if (half <= inset) rectRoof(w, trim, r, base, { shape: 'hip', rise: lowSlope * half, overhang, inset: 0, lower: 0 }, row, trimRow, ctx);
    else rectRoof(w, trim, r, base, { shape: 'mansard', rise: lower + highSlope * (half - inset), overhang, inset, lower }, row, trimRow, ctx);
  }
}
