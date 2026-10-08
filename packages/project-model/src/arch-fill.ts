/**
 * Fills: a closed path filled with a surface. Flat floors and ceilings,
 * coffered ceilings (a flat ceiling and beams swept along a grid), barrel
 * vaults (an arc swept along the room), groin vaults (two barrels, each
 * kept where it is the lower), and gable, hip and mansard roofs (planes
 * between the eaves and the ridge). Vaults and roofs ask for a rectangular
 * path; any other is reported and left unfilled (a straight skeleton for
 * any footprint is a follow-up). Flat and coffered fills take any simple
 * polygon.
 *
 * Every plane goes through `fillPlanarPolygon` (strips one trim row tall),
 * every arc through the sweep (strips stacked along the arc), so fills wear
 * the same rows as walls.
 *
 * Pure.
 */
import { len2, len3 } from './arch-math';
import { type ArchMeshWriter, fillPlanarPolygon, type PlaneFrame } from './arch-mesh';
import type { PathSamples } from './arch-path';
import { type SweepProfile, sweepProfile } from './arch-sweep';
import type { ArchitectureFill } from './architecture';
import { type TrimRow, type TrimSheet, trimRowDensity, trimRowMetres, trimRowV } from './trim-sheet';

export interface FillContext {
  sheet: TrimSheet;
  rowOf(slot: string): TrimRow | null;
  aoStrength: number;
  aoRadius: number;
  /** Metres between samples on arcs. */
  step: number;
}

/** Coffer beams: metres apart and deep (and as wide as deep). */
export const COFFER_CELL_DEFAULT = 1.5;
export const COFFER_DEPTH_DEFAULT = 0.2;
/** Mansard: the lower slope's share of the rise. */
export const MANSARD_BREAK_DEFAULT = 0.7;

/** A rectangle found in a path: a corner, the axis along (unit, level), the axis across, and their lengths. */
export interface PathRect {
  o: [number, number, number];
  a: [number, number, number];
  b: [number, number, number];
  la: number;
  lb: number;
}

/** The base height of a fill: the mean of its path's sample heights. */
export function fillBaseY(s: PathSamples): number {
  let y = 0;
  for (let i = 0; i < s.n; i++) y += s.pos[i * 3 + 1]!;
  return s.n > 0 ? y / s.n : 0;
}

/** The path's outline in XZ (xy pairs: x, z). */
export function fillOutline(s: PathSamples): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.n; i++) out.push(s.pos[i * 3]!, s.pos[i * 3 + 2]!);
  return out;
}

/** The rectangle a path draws (four samples at right angles, level), its axis along the longer or shorter side; or null. */
export function pathRect(s: PathSamples, axis: 'long' | 'short' = 'long'): PathRect | null {
  if (!s.closed || s.n !== 4) return null;
  const e: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    e.push([s.pos[j * 3]! - s.pos[i * 3]!, 0, s.pos[j * 3 + 2]! - s.pos[i * 3 + 2]!]);
  }
  const l = e.map((v) => len3(v[0]!, 0, v[2]!));
  if (l.some((x) => x < 1e-6)) return null;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    if (Math.abs(e[i]![0]! * e[j]![0]! + e[i]![2]! * e[j]![2]!) > 1e-3 * l[i]! * l[j]!) return null;
  }
  const y = fillBaseY(s);
  const longFirst = l[0]! >= l[1]!;
  const alongFirst = axis === 'long' ? longFirst : !longFirst;
  // The corner the axes leave from: sample 0 with edges 0 and 3 (reversed), or 1 with edges 1 and 0 (reversed).
  if (alongFirst) {
    const a = [e[0]![0]! / l[0]!, 0, e[0]![2]! / l[0]!] as [number, number, number];
    const b = [-e[3]![0]! / l[3]!, 0, -e[3]![2]! / l[3]!] as [number, number, number];
    return { o: [s.pos[0]!, y, s.pos[2]!], a, b, la: l[0]!, lb: l[3]! };
  }
  const a = [e[1]![0]! / l[1]!, 0, e[1]![2]! / l[1]!] as [number, number, number];
  const b = [-e[0]![0]! / l[0]!, 0, -e[0]![2]! / l[0]!] as [number, number, number];
  return { o: [s.pos[3]!, y, s.pos[5]!], a, b, la: l[1]!, lb: l[0]! };
}

/** Points of an arc in 2D from (ax, ay) to (bx, by), bulging to the left of travel (up for a left-to-right chord), as a rational Bézier. */
export function arcPoints2D(ax: number, ay: number, bx: number, by: number, bulge: number, step: number, out: number[]): void {
  const dx = bx - ax;
  const dy = by - ay;
  const chord = Math.sqrt(dx * dx + dy * dy);
  if (chord < 1e-9 || bulge === 0) {
    out.push(bx, by);
    return;
  }
  const lx = -dy / chord;
  const ly = dx / chord;
  if (Math.abs(bulge) >= 1) {
    const sg = (bulge * chord) / 2;
    const mx = (ax + bx) / 2 + lx * sg;
    const my = (ay + by) / 2 + ly * sg;
    const half = (Math.sqrt(1 + bulge * bulge) - 1) / bulge;
    arcPoints2D(ax, ay, mx, my, half, step, out);
    arcPoints2D(mx, my, bx, by, half, step, out);
    return;
  }
  const b2 = bulge * bulge;
  const w = (1 - b2) / (1 + b2);
  const h = (chord / 2) * ((2 * bulge) / (1 - b2));
  const cx = (ax + bx) / 2 + lx * h;
  const cy = (ay + by) / 2 + ly * h;
  const approx = (len2(cx - ax, cy - ay) + len2(bx - cx, by - cy) + chord) / 2;
  const n = Math.max(2, Math.ceil(approx / step));
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const p = (1 - t) * (1 - t);
    const m = 2 * t * (1 - t) * w;
    const c = t * t;
    const d = p + m + c;
    out.push((p * ax + m * cx + c * bx) / d, (p * ay + m * cy + c * by) / d);
  }
}

/** Fill a 3D planar polygon whose first edge is its along axis; the face looks to the side with `facing` (positive dot). */
function plane(w: ArchMeshWriter, pts: readonly number[][], facing: readonly number[], ctx: FillContext, row: TrimRow, edgesAo: boolean): void {
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

/** Intervals of the line {z = c} (in the outline's xy) inside a polygon: x pairs. */
function lineIntervals(poly: readonly number[], c: number, alongX: boolean): number[] {
  const n = poly.length / 2;
  const xs: number[] = [];
  const u = alongX ? 0 : 1;
  const v = alongX ? 1 : 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const pv = poly[i * 2 + v]!;
    const qv = poly[j * 2 + v]!;
    if (pv <= c === qv <= c) continue;
    const t = (c - pv) / (qv - pv);
    xs.push(poly[i * 2 + u]! + (poly[j * 2 + u]! - poly[i * 2 + u]!) * t);
  }
  xs.sort((a, b) => a - b);
  return xs;
}

const RECT_SHAPES = new Set(['barrel', 'groin', 'gable', 'hip', 'mansard']);

/**
 * Write one fill into `w` (its surface) and `trim` (beams, gable ends; may be
 * the same writer). Returns a problem to report, or null.
 */
export function writeFill(w: ArchMeshWriter, trim: ArchMeshWriter, e: ArchitectureFill, s: PathSamples, ctx: FillContext): string | null {
  const row = ctx.rowOf(e.slot);
  if (row === null) return `fill "${e.id}": the sheet has no row "${e.slot}"`;
  const trimRow = ctx.rowOf(e.trimSlot ?? e.slot) ?? row;
  const height = e.height ?? 0;
  const base = fillBaseY(s) + height;
  if (!RECT_SHAPES.has(e.shape)) {
    const outline = fillOutline(s);
    const faceDown = (e.face ?? (e.shape === 'coffered' ? 'down' : 'up')) === 'down';
    const n = faceDown ? [0, -1, 0] : [0, 1, 0];
    fillPlanarPolygon(w, outline, { o: [0, base, 0], a: [1, 0, 0], b: [0, 0, 1], n }, { sheet: ctx.sheet, row, aoStrength: ctx.aoStrength, aoRadius: ctx.aoRadius });
    if (e.shape === 'coffered') {
      // The beams are detail: the far level keeps the flat ceiling.
      const was = trim.detail;
      trim.detail = true;
      const cell = e.cell ?? COFFER_CELL_DEFAULT;
      const depth = e.depth ?? COFFER_DEPTH_DEFAULT;
      // Faces look right of each segment's direction: walked so the sides look out and the bottom away from the surface.
      const prof: SweepProfile = {
        pts: faceDown ? [-depth / 2, 0, -depth / 2, -depth, depth / 2, -depth, depth / 2, 0] : [depth / 2, 0, depth / 2, depth, -depth / 2, depth, -depth / 2, 0],
        slots: [e.trimSlot ?? e.slot, e.trimSlot ?? e.slot, e.trimSlot ?? e.slot],
        fallback: [e.slot, e.slot, e.slot],
        closed: false,
        smooth: false,
      };
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < outline.length; i += 2) {
        minX = Math.min(minX, outline[i]!);
        maxX = Math.max(maxX, outline[i]!);
        minZ = Math.min(minZ, outline[i + 1]!);
        maxZ = Math.max(maxZ, outline[i + 1]!);
      }
      for (const alongX of [true, false]) {
        const lo = alongX ? minZ : minX;
        const hi = alongX ? maxZ : maxX;
        for (let k = Math.floor(lo / cell) + 1; k * cell < hi; k++) {
          const c = k * cell;
          const xs = lineIntervals(outline, c, alongX);
          for (let q = 0; q + 1 < xs.length; q += 2) {
            const a0 = xs[q]!;
            const a1 = xs[q + 1]!;
            if (a1 - a0 < depth) continue;
            const pts = alongX ? [a0, base, c, a1, base, c] : [c, base, a0, c, base, a1];
            sweepProfile(trim, { n: 2, closed: false, pos: Float64Array.from(pts), dist: Float64Array.from([0, a1 - a0]), sharp: Uint8Array.from([1, 1]), length: a1 - a0, pointDist: Float64Array.from([0, a1 - a0]) }, prof, {
              sheet: ctx.sheet,
              rowOf: ctx.rowOf,
              aoStrength: ctx.aoStrength,
              aoRadius: ctx.aoRadius,
              ground: false,
            });
          }
        }
      }
      trim.detail = was;
    }
    return null;
  }
  const r = pathRect(s, e.axis ?? 'long');
  if (r === null) return `fill "${e.id}": a ${e.shape} needs a rectangular path (four corners at right angles)`;
  const P = (a: number, b: number, y: number): number[] => [r.o[0] + r.a[0] * a + r.b[0] * b, y, r.o[2] + r.a[2] * a + r.b[2] * b];
  if (e.shape === 'barrel') {
    const rise = Math.min(e.rise ?? r.lb / 2, r.lb / 2);
    const prof = arcProfile(r.lb, rise, e.slot, ctx.step);
    // Along the axis through the middle of the span; the path's right is +b or −b, the arc is symmetric either way.
    const p0 = P(0, r.lb / 2, base);
    const p1 = P(r.la, r.lb / 2, base);
    sweepProfile(w, straightPath(p0, p1), prof, { sheet: ctx.sheet, rowOf: ctx.rowOf, aoStrength: ctx.aoStrength, aoRadius: ctx.aoRadius, ground: true });
    return null;
  }
  if (e.shape === 'groin') {
    const rise = Math.min(e.rise ?? Math.min(r.la, r.lb) / 2, Math.min(r.la, r.lb) / 2);
    groin(w, r, base, rise, row, ctx);
    return null;
  }
  // Roofs: their eaves at the fill's height, faces looking out and up.
  const overhang = e.overhang ?? 0;
  const W = r.lb;
  const L = r.la;
  const rise = e.rise ?? W / 4;
  if (e.shape === 'gable') {
    const slope = rise / (W / 2);
    const ye = base - overhang * slope;
    const yr = base + rise;
    plane(w, [P(-overhang, -overhang, ye), P(L + overhang, -overhang, ye), P(L + overhang, W / 2, yr), P(-overhang, W / 2, yr)], [0, 1, 0], ctx, row, false);
    plane(w, [P(L + overhang, W + overhang, ye), P(-overhang, W + overhang, ye), P(-overhang, W / 2, yr), P(L + overhang, W / 2, yr)], [0, 1, 0], ctx, row, false);
    const outA = [-r.a[0], 0, -r.a[2]];
    plane(trim, [P(0, 0, base), P(0, W, base), P(0, W / 2, yr)], outA, ctx, trimRow, false);
    plane(trim, [P(L, W, base), P(L, 0, base), P(L, W / 2, yr)], r.a, ctx, trimRow, false);
    return null;
  }
  if (e.shape === 'hip') {
    hip(w, P, 0, 0, L, W, base, rise, overhang, row, ctx);
    return null;
  }
  // Mansard: a steep lower slope to an inset break line, then a shallow hip.
  const inset = Math.min(e.inset ?? W / 6, W / 2 - 1e-3, L / 2 - 1e-3);
  const lower = rise * (e.breakRise ?? MANSARD_BREAK_DEFAULT);
  const slope = inset > 0 ? lower / inset : 0;
  const ye = base - overhang * slope;
  const yb = base + lower;
  const eave = [P(-overhang, -overhang, ye), P(L + overhang, -overhang, ye), P(L + overhang, W + overhang, ye), P(-overhang, W + overhang, ye)];
  const brk = [P(inset, inset, yb), P(L - inset, inset, yb), P(L - inset, W - inset, yb), P(inset, W - inset, yb)];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    plane(w, [eave[i]!, eave[j]!, brk[j]!, brk[i]!], [0, 1, 0], ctx, row, false);
  }
  hip(w, P, inset, inset, L - 2 * inset, W - 2 * inset, yb, rise - lower, 0, row, ctx);
  return null;
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
  plane(w, ridge ? [e0, e1, r1, r0] : [e0, e1, r0], up, ctx, row, false);
  plane(w, [e1, e2, r1], up, ctx, row, false);
  plane(w, ridge ? [e2, e3, r0, r1] : [e2, e3, r0], up, ctx, row, false);
  plane(w, [e3, e0, r0], up, ctx, row, false);
}

/** A two-point straight path. */
function straightPath(p0: readonly number[], p1: readonly number[]): PathSamples {
  const l = len3(p1[0]! - p0[0]!, p1[1]! - p0[1]!, p1[2]! - p0[2]!);
  return { n: 2, closed: false, pos: Float64Array.from([p0[0]!, p0[1]!, p0[2]!, p1[0]!, p1[1]!, p1[2]!]), dist: Float64Array.from([0, l]), sharp: Uint8Array.from([1, 1]), length: l, pointDist: Float64Array.from([0, l]) };
}

/** A vault's arc as a smooth profile (faces looking in and down), across from −span/2 to span/2. */
function arcProfile(span: number, rise: number, slot: string, step: number): SweepProfile {
  const pts: number[] = [-span / 2, 0];
  // Left to right over the top: the arc bulges up, to the left of travel.
  arcPoints2D(-span / 2, 0, span / 2, 0, rise > 0 ? (2 * rise) / span : 0, step, pts);
  const segs = pts.length / 2 - 1;
  return { pts, slots: new Array<string>(segs).fill(slot), fallback: new Array<string>(segs).fill(slot), closed: false, smooth: true };
}

/** A groin vault: two barrels crossing, each kept where it is the lower (the sectors between the diagonals). */
function groin(w: ArchMeshWriter, r: PathRect, base: number, rise: number, row: TrimRow, ctx: FillContext): void {
  const density = trimRowDensity(ctx.sheet, row);
  const rowMetres = trimRowMetres(ctx.sheet, row);
  const [v0, v1] = trimRowV(ctx.sheet, row);
  const su = density / ctx.sheet.size[0];
  for (const barrel of [0, 1]) {
    // Barrel 0 spans b (its arc across b, running along a); barrel 1 spans a.
    const S = barrel === 0 ? r.lb : r.la;
    const Lr = barrel === 0 ? r.la : r.lb;
    const pts: number[] = [-S / 2, 0];
    arcPoints2D(-S / 2, 0, S / 2, 0, (2 * Math.min(rise, S / 2)) / S, ctx.step, pts);
    const np = pts.length / 2;
    // Scale the arc's height so both barrels reach the same crown.
    const crown = Math.max(...pts.filter((_, i) => i % 2 === 1));
    const ys = crown > 0 ? rise / crown : 0;
    const cum = new Float64Array(np);
    for (let i = 1; i < np; i++) cum[i] = cum[i - 1]! + len2(pts[i * 2]! - pts[i * 2 - 2]!, (pts[i * 2 + 1]! - pts[i * 2 - 1]!) * ys);
    const half = cum[np - 1]! / 2;
    const stacks = Math.max(1, Math.round(half / rowMetres));
    const cols = Math.max(1, Math.ceil(Lr / Math.max(0.25, rowMetres)));
    const at = (c: number, along: number, y: number): number[] => {
      // along: −Lr/2…Lr/2 on the running axis; c: −S/2…S/2 across.
      const a = barrel === 0 ? along + r.la / 2 : c + r.la / 2;
      const b = barrel === 0 ? c + r.lb / 2 : along + r.lb / 2;
      return [r.o[0] + r.a[0] * a + r.b[0] * b, base + y, r.o[2] + r.a[2] * a + r.b[2] * b];
    };
    for (let i = 0; i + 1 < np; i++) {
      const ca = pts[i * 2]!;
      const cb = pts[i * 2 + 2]!;
      const ya = pts[i * 2 + 1]! * ys;
      const yb = pts[i * 2 + 3]! * ys;
      // The arc's inward normal in (across, up): left of travel turned in → (dy, -dx) of the direction faces in for this winding.
      const dx = cb - ca;
      const dy = yb - ya;
      const dl = Math.sqrt(dx * dx + dy * dy) || 1;
      const ncx = dy / dl;
      const ncy = -dx / dl;
      const nWorld = (): number[] => {
        const nx = barrel === 0 ? r.b[0] * ncx : r.a[0] * ncx;
        const nz = barrel === 0 ? r.b[2] * ncx : r.a[2] * ncx;
        return [nx, ncy, nz];
      };
      const n = nWorld();
      const ka = Math.abs(ca) / (S / 2);
      const kb = Math.abs(cb) / (S / 2);
      // Arc length from the nearer springing, for the strips' stacking and the AO.
      const qa = cum[i]! <= half ? cum[i]! : cum[np - 1]! - cum[i]!;
      const qb = cum[i + 1]! <= half ? cum[i + 1]! : cum[np - 1]! - cum[i + 1]!;
      const stack = Math.min(stacks - 1, Math.floor(((qa + qb) / 2 / half) * stacks));
      const tOf = (q: number): number => Math.max(0, Math.min(1, (q / half) * stacks - stack));
      const aoOf = (q: number): number => (ctx.aoStrength > 0 ? ctx.aoStrength * Math.max(0, 1 - q / ctx.aoRadius) : 0);
      for (let m = 0; m < cols; m++) {
        const f0 = m / cols;
        const f1 = (m + 1) / cols;
        const quad = [
          [ca, (2 * f0 - 1) * (Lr / 2) * ka, ya, qa],
          [ca, (2 * f1 - 1) * (Lr / 2) * ka, ya, qa],
          [cb, (2 * f1 - 1) * (Lr / 2) * kb, yb, qb],
          [cb, (2 * f0 - 1) * (Lr / 2) * kb, yb, qb],
        ];
        const first = w.vertexCount;
        for (const [c, along, y, q] of quad) {
          const p = at(c!, along!, y!);
          w.vertex(p[0]!, p[1]!, p[2]!, n[0]!, n[1]!, n[2]!, (along! + Lr / 2) * su, v0 + (v1 - v0) * tOf(q!), aoOf(q!));
        }
        w.triangle(first, first + 1, first + 2, n[0]!, n[1]!, n[2]!);
        w.triangle(first, first + 2, first + 3, n[0]!, n[1]!, n[2]!);
      }
    }
  }
}
