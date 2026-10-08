/**
 * The sweep: a 2D profile carried along a path's samples. At every sample
 * the profile is placed on the mitre plane (the plane halving the turn), so
 * mouldings meet at corners, T-junctions and frames without gaps or
 * overlaps. Each profile segment is a strip wearing its trim row: u runs
 * along the strip in metres (measured on the strip's own edge, so a mitred
 * corner keeps its texel density), v spans the row exactly once across —
 * a segment taller than its row is stacked from several strips.
 *
 * Openings cut the strips (cells inside the opening's span along the path
 * and its height are left out) and add reveals; overridden spans leave
 * the strips out for a kit model. Vertex AO darkens inside corners of the
 * profile, the path's inside corners on the faces that look into them, and
 * where a wall meets the ground (the profile's lowest points).
 *
 * Pure; writes into an {@link ArchMeshWriter}.
 */
import { len2, len3 } from './arch-math';
import { type ArchMeshWriter, BOTH, FAR, fillPlanarPolygon, NEAR } from './arch-mesh';
import type { PathSamples } from './arch-path';
import type { ArchitectureProfile } from './architecture';
import type { TrimRow, TrimSheet } from './trim-sheet';
import { trimRowDensity, trimRowV } from './trim-sheet';

/** A profile ready to sweep (chamfer applied or not). */
export interface SweepProfile {
  /** xy pairs: across (right of travel), up. */
  pts: number[];
  /** Per segment: the slot, and the slot used when the sheet lacks it (chamfer faces wear `bevel`, else their neighbour's row). */
  slots: string[];
  fallback: string[];
  closed: boolean;
  smooth: boolean;
  /** Per segment: the definition's segment it is (a chamfer face: -1), for slots given per path segment. */
  source?: number[];
  /** The slot the ends of a closed profile on an open path wear (absent: open ends). */
  cap?: string;
}

/** The slot chamfer faces wear when the sheet has it. */
export const BEVEL_SLOT = 'bevel';

/** A profile from its definition, its corners chamfered when `chamfer` (the near level) and the definition asks. */
export function resolveProfile(def: ArchitectureProfile, chamfer: boolean): SweepProfile {
  const n = def.points.length;
  const closed = def.closed === true && n >= 3;
  const c = chamfer ? (def.chamfer ?? 0) : 0;
  const pts: number[] = [];
  const slots: string[] = [];
  const fallback: string[] = [];
  const segs = closed ? n : n - 1;
  const source: number[] = [];
  const cap = def.cap !== undefined && closed ? { cap: def.cap } : {};
  if (c <= 0) {
    for (const q of def.points) pts.push(q[0], q[1]);
    for (let k = 0; k < segs; k++) {
      slots.push(def.slots[k] ?? '');
      fallback.push(def.slots[k] ?? '');
      source.push(k);
    }
    return { pts, slots, fallback, closed, smooth: def.smooth === true, source, ...cap };
  }
  // Each corner (inner points; every point of a closed profile) becomes two points `c` either side.
  const at = (i: number): readonly [number, number] => def.points[((i % n) + n) % n]!;
  for (let i = 0; i < n; i++) {
    const corner = closed || (i > 0 && i < n - 1);
    const p = at(i);
    if (!corner) {
      pts.push(p[0], p[1]);
      if (i < segs) {
        slots.push(def.slots[i] ?? '');
        fallback.push(def.slots[i] ?? '');
        source.push(i);
      }
      continue;
    }
    const a = at(i - 1);
    const b = at(i + 1);
    const la = len2(p[0] - a[0], p[1] - a[1]);
    const lb = len2(b[0] - p[0], b[1] - p[1]);
    const ca = la > 0 ? Math.min(c, la * 0.45) / la : 0;
    const cb = lb > 0 ? Math.min(c, lb * 0.45) / lb : 0;
    pts.push(p[0] + (a[0] - p[0]) * ca, p[1] + (a[1] - p[1]) * ca);
    pts.push(p[0] + (b[0] - p[0]) * cb, p[1] + (b[1] - p[1]) * cb);
    const before = def.slots[(i - 1 + segs) % segs] ?? '';
    // The chamfer face between them, then the segment leaving the corner.
    slots.push(BEVEL_SLOT);
    fallback.push(before === '' ? (def.slots[i] ?? '') : before);
    source.push(-1);
    if (i < segs) {
      slots.push(def.slots[i] ?? '');
      fallback.push(def.slots[i] ?? '');
      source.push(i);
    }
  }
  return { pts, slots, fallback, closed, smooth: def.smooth === true, source, ...cap };
}

/** Cut ranges along the path: an opening (also a height range) or an overridden span. */
export interface SweepCut {
  a: number;
  b: number;
  /** Heights (profile up) cut; absent: the whole profile. */
  bottom?: number;
  top?: number;
}

export interface SweepOptions {
  sheet: TrimSheet;
  rowOf(slot: string): TrimRow | null;
  /** The path's reference up (absent: +Y). */
  up?: readonly number[];
  cuts?: readonly SweepCut[];
  /** Only cells whose middle lies here are written (a chunk's share). */
  own?: (x: number, z: number) => boolean;
  aoStrength: number;
  aoRadius: number;
  /** Treat the profile's lowest points as meeting the ground (absent: true). */
  ground?: boolean;
  /** The most metres between cross-sections along a straight run (absent: only where the path or a cut needs one). */
  cell?: number;
  /** Per path segment: the definition's slots worn along it instead of the profile's (absent or undefined: the profile's). */
  segmentSlots?: (segment: number) => readonly string[] | undefined;
}

/** Per-sample frames along a path: the mitred axes the profile is placed with, and the faces' frames. */
export interface SweepFrames {
  /** Mitred placement axes per sample (xyz each): profile x and y. */
  mx: Float64Array;
  my: Float64Array;
  /** Per segment: tangent, right, up. */
  st: Float64Array;
  sr: Float64Array;
  su: Float64Array;
  /** Per sample: averaged right and up (for smooth samples' normals). */
  ar: Float64Array;
  au: Float64Array;
  /** Per sample: the turn (positive: to the right of travel) and how sharp it is (0 straight, 1 a right angle or more). */
  turn: Float64Array;
}

const Y_UP = [0, 1, 0] as const;

function norm(v: number[]): boolean {
  const l = len3(v[0]!, v[1]!, v[2]!);
  if (l < 1e-12) return false;
  v[0]! /= l;
  v[1]! /= l;
  v[2]! /= l;
  return true;
}

/** The frames of a path's samples for a reference up. */
export function sweepFrames(s: PathSamples, up: readonly number[] = Y_UP): SweepFrames {
  const n = s.n;
  const segs = s.closed ? n : n - 1;
  const st = new Float64Array(Math.max(1, segs) * 3);
  const sr = new Float64Array(Math.max(1, segs) * 3);
  const su = new Float64Array(Math.max(1, segs) * 3);
  let pr = [1, 0, 0];
  for (let j = 0; j < segs; j++) {
    const a = j;
    const b = (j + 1) % n;
    const t = [s.pos[b * 3]! - s.pos[a * 3]!, s.pos[b * 3 + 1]! - s.pos[a * 3 + 1]!, s.pos[b * 3 + 2]! - s.pos[a * 3 + 2]!];
    if (!norm(t)) t.splice(0, 3, 1, 0, 0);
    // right = t × up; up' = right × t.
    const r = [t[1]! * up[2]! - t[2]! * up[1]!, t[2]! * up[0]! - t[0]! * up[2]!, t[0]! * up[1]! - t[1]! * up[0]!];
    if (!norm(r)) r.splice(0, 3, pr[0]!, pr[1]!, pr[2]!);
    pr = r;
    const u = [r[1]! * t[2]! - r[2]! * t[1]!, r[2]! * t[0]! - r[0]! * t[2]!, r[0]! * t[1]! - r[1]! * t[0]!];
    for (let k = 0; k < 3; k++) {
      st[j * 3 + k] = t[k]!;
      sr[j * 3 + k] = r[k]!;
      su[j * 3 + k] = u[k]!;
    }
  }
  const mx = new Float64Array(n * 3);
  const my = new Float64Array(n * 3);
  const ar = new Float64Array(n * 3);
  const au = new Float64Array(n * 3);
  const turn = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const ja = i > 0 ? i - 1 : s.closed ? segs - 1 : -1;
    const jb = i < segs ? i : -1;
    const a = ja >= 0 ? ja : jb;
    const b = jb >= 0 ? jb : ja;
    const ta = [st[a * 3]!, st[a * 3 + 1]!, st[a * 3 + 2]!];
    const tb = [st[b * 3]!, st[b * 3 + 1]!, st[b * 3 + 2]!];
    const m = [ta[0]! + tb[0]!, ta[1]! + tb[1]!, ta[2]! + tb[2]!];
    if (!norm(m)) m.splice(0, 3, ta[0]!, ta[1]!, ta[2]!);
    const dm = ta[0]! * m[0]! + ta[1]! * m[1]! + ta[2]! * m[2]!;
    const k = Math.abs(dm) > 0.25 ? 1 / dm : 4 * Math.sign(dm || 1);
    for (const [src, dst] of [
      [sr, mx],
      [su, my],
    ] as const) {
      const v = [src[a * 3]!, src[a * 3 + 1]!, src[a * 3 + 2]!];
      const dv = (v[0]! * m[0]! + v[1]! * m[1]! + v[2]! * m[2]!) * k;
      for (let c = 0; c < 3; c++) dst[i * 3 + c] = v[c]! - ta[c]! * dv;
    }
    const r = [sr[a * 3]! + sr[b * 3]!, sr[a * 3 + 1]! + sr[b * 3 + 1]!, sr[a * 3 + 2]! + sr[b * 3 + 2]!];
    if (!norm(r)) r.splice(0, 3, sr[a * 3]!, sr[a * 3 + 1]!, sr[a * 3 + 2]!);
    const u = [su[a * 3]! + su[b * 3]!, su[a * 3 + 1]! + su[b * 3 + 1]!, su[a * 3 + 2]! + su[b * 3 + 2]!];
    if (!norm(u)) u.splice(0, 3, su[a * 3]!, su[a * 3 + 1]!, su[a * 3 + 2]!);
    for (let c = 0; c < 3; c++) {
      ar[i * 3 + c] = r[c]!;
      au[i * 3 + c] = u[c]!;
    }
    // Turn about up: −(ta × tb)·up > 0 turns right.
    const cx = ta[1]! * tb[2]! - ta[2]! * tb[1]!;
    const cy = ta[2]! * tb[0]! - ta[0]! * tb[2]!;
    const cz = ta[0]! * tb[1]! - ta[1]! * tb[0]!;
    turn[i * 2] = -(cx * up[0]! + cy * up[1]! + cz * up[2]!);
    turn[i * 2 + 1] = Math.min(1, 1 - (ta[0]! * tb[0]! + ta[1]! * tb[1]! + ta[2]! * tb[2]!));
  }
  return { mx, my, st, sr, su, ar, au, turn };
}

/** A column: a cross-section's place along the path, on segment `seg` at fraction `f` of it. */
interface Column {
  seg: number;
  f: number;
  d: number;
}

/** The columns along a path: every sample plus the extra distances, sorted, per segment. */
function columnsOf(s: PathSamples, extra: readonly number[]): Column[] {
  const segs = s.closed ? s.n : s.n - 1;
  const cols: Column[] = [];
  const xs = [...extra].sort((a, b) => a - b);
  let x = 0;
  for (let j = 0; j < segs; j++) {
    const d0 = s.dist[j]!;
    const d1 = s.dist[j + 1]!;
    cols.push({ seg: j, f: 0, d: d0 });
    while (x < xs.length && xs[x]! <= d0 + 1e-6) x++;
    while (x < xs.length && xs[x]! < d1 - 1e-6) {
      const d = xs[x]!;
      cols.push({ seg: j, f: (d - d0) / (d1 - d0), d });
      x++;
    }
    cols.push({ seg: j, f: 1, d: d1 });
  }
  return cols;
}

/** Profile x/y extents. */
export function profileBounds(pts: readonly number[]): [number, number, number, number] {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]!);
    x1 = Math.max(x1, pts[i]!);
    y0 = Math.min(y0, pts[i + 1]!);
    y1 = Math.max(y1, pts[i + 1]!);
  }
  return [x0, x1, y0, y1];
}

/**
 * Sweep `p` along `s` into `w`. Columns are the samples plus the cut edges
 * and AO rows near corners; rows are the profile's points plus stack
 * boundaries, AO rows and cut heights.
 */
export function sweepProfile(w: ArchMeshWriter, s: PathSamples, p: SweepProfile, o: SweepOptions): void {
  const n = s.n;
  const segs = s.closed ? n : n - 1;
  const np = p.pts.length / 2;
  const psegs = p.closed ? np : np - 1;
  if (segs < 1 || psegs < 1) return;
  const fr = sweepFrames(s, o.up ?? Y_UP);
  const cuts = o.cuts ?? [];
  const r = o.aoRadius;
  const ao = o.aoStrength > 0 && r > 0;
  // Extra columns: cut edges, and either side of sharp corners for AO.
  const extra: number[] = [];
  for (const c of cuts) extra.push(c.a, c.b);
  if (ao) {
    for (let i = 0; i < n; i++) {
      if (s.sharp[i] !== 1 || fr.turn[i * 2 + 1]! < 1e-3) continue;
      const d = s.dist[i]!;
      extra.push(d - r, d + r);
      if (s.closed && i === 0) extra.push(s.length - r);
    }
  }
  if (o.cell !== undefined && o.cell > 0) {
    // Cross-sections along long runs: the vertex density baked AO and painted grime and wetness are read at.
    for (let j = 0; j < segs; j++) {
      const d0 = s.dist[j]!;
      const d1 = s.dist[j + 1]!;
      const k = Math.ceil((d1 - d0) / o.cell - 1e-9);
      for (let q = 1; q < k; q++) extra.push(d0 + ((d1 - d0) * q) / k);
    }
  }
  const cols = columnsOf(s, extra);
  const nc = cols.length;
  // Column positions and placement axes (lerped along the segment).
  const cp = new Float64Array(nc * 3);
  const cx = new Float64Array(nc * 3);
  const cy = new Float64Array(nc * 3);
  for (let c = 0; c < nc; c++) {
    const { seg, f } = cols[c]!;
    const a = seg;
    const b = (seg + 1) % n;
    for (let k = 0; k < 3; k++) {
      cp[c * 3 + k] = s.pos[a * 3 + k]! + (s.pos[b * 3 + k]! - s.pos[a * 3 + k]!) * f;
      cx[c * 3 + k] = fr.mx[a * 3 + k]! + (fr.mx[b * 3 + k]! - fr.mx[a * 3 + k]!) * f;
      cy[c * 3 + k] = fr.my[a * 3 + k]! + (fr.my[b * 3 + k]! - fr.my[a * 3 + k]!) * f;
    }
  }
  // Path-corner AO per column, for faces looking right (index 0) and left (1).
  const pathAo = new Float64Array(nc * 2);
  if (ao) {
    for (let i = 0; i < n; i++) {
      if (s.sharp[i] !== 1) continue;
      const amount = fr.turn[i * 2 + 1]!;
      if (amount < 1e-3) continue;
      const side = fr.turn[i * 2]! > 0 ? 0 : 1;
      const ds = s.closed && i === 0 ? [0, s.length] : [s.dist[i]!];
      for (let c = 0; c < nc; c++) {
        for (const d of ds) {
          const t = amount * Math.max(0, 1 - Math.abs(cols[c]!.d - d) / r);
          if (t > pathAo[c * 2 + side]!) pathAo[c * 2 + side] = t;
        }
      }
    }
  }
  // Profile corner amounts: inside corners (turning toward the faces) and the ground.
  const [, , ymin] = profileBounds(p.pts);
  const corner = new Float64Array(np);
  if (ao) {
    for (let i = 0; i < np; i++) {
      const hasPrev = p.closed || i > 0;
      const hasNext = p.closed || i < np - 1;
      const px = p.pts[i * 2]!;
      const py = p.pts[i * 2 + 1]!;
      if ((o.ground ?? true) && py <= ymin + 1e-6) corner[i] = 1;
      // A smooth profile bends gradually: no inside corner to darken.
      if (!hasPrev || !hasNext || p.smooth) continue;
      const a = (i - 1 + np) % np;
      const b = (i + 1) % np;
      let ax = px - p.pts[a * 2]!;
      let ay = py - p.pts[a * 2 + 1]!;
      let bx = p.pts[b * 2]! - px;
      let by = p.pts[b * 2 + 1]! - py;
      const la = Math.sqrt(ax * ax + ay * ay) || 1;
      const lb = Math.sqrt(bx * bx + by * by) || 1;
      ax /= la;
      ay /= la;
      bx /= lb;
      by /= lb;
      // Faces look right of travel: a right turn (negative cross) folds toward them.
      if (ax * by - ay * bx < -1e-9) corner[i] = Math.max(corner[i]!, Math.min(1, 1 - (ax * bx + ay * by)));
    }
  }
  // Per profile segment: rows (params along it), the strip stacking and normals.
  // Runs: a smooth profile's neighbouring segments wearing one slot are one strip across (a vault's arc spans its
  // row once over its whole length, not once per segment); a hard-edged profile's segments are each their own.
  const segLen = new Float64Array(psegs);
  for (let k = 0; k < psegs; k++) {
    const i1 = (k + 1) % np;
    segLen[k] = len2(p.pts[i1 * 2]! - p.pts[k * 2]!, p.pts[i1 * 2 + 1]! - p.pts[k * 2 + 1]!);
  }
  const runBefore = new Float64Array(psegs);
  const runLen = new Float64Array(psegs);
  const runTopAtEnd = new Uint8Array(psegs);
  for (let k = 0; k < psegs; ) {
    let e = k + 1;
    while (p.smooth && e < psegs && p.slots[e] === p.slots[k]) e++;
    let total = 0;
    for (let q = k; q < e; q++) {
      runBefore[q] = total;
      total += segLen[q]!;
    }
    const ys = p.pts[k * 2 + 1]!;
    const ye = p.pts[(e % np) * 2 + 1]!;
    for (let q = k; q < e; q++) {
      runLen[q] = total;
      runTopAtEnd[q] = ye >= ys ? 1 : 0;
    }
    k = e;
  }
  // A profile segment's slot along each path segment: the profile's, or the segment's own (a shared wall's other side).
  const slotAlong = (k: number, seg: number): string => {
    const src = p.source?.[k] ?? k;
    const own = src >= 0 ? o.segmentSlots?.(seg)?.[src] : undefined;
    return own ?? p.slots[k]!;
  };
  for (let k = 0; k < psegs; k++) {
    if (o.segmentSlots === undefined) {
      strip(k, p.slots[k]!, null);
      continue;
    }
    // One strip per slot worn, each over the path segments wearing it.
    const bySlot = new Map<string, Set<number>>();
    for (let j = 0; j < segs; j++) {
      const sl = slotAlong(k, j);
      let set = bySlot.get(sl);
      if (set === undefined) bySlot.set(sl, (set = new Set()));
      set.add(j);
    }
    for (const [sl, set] of bySlot) strip(k, sl, bySlot.size === 1 ? null : set);
  }
  if (p.cap !== undefined && p.closed && !s.closed && nc > 0) writeCaps(w, s, p, o, cols, cp, cx, cy);

  function strip(k: number, slot: string, segOk: ReadonlySet<number> | null): void {
    if (slot === '') return;
    const fb = p.fallback[k]!;
    const row = o.rowOf(slot) ?? (fb !== slot && slot === p.slots[k] ? o.rowOf(fb) : null);
    if (row === null) return;
    const i0 = k;
    const i1 = (k + 1) % np;
    const ax = p.pts[i0 * 2]!;
    const ay = p.pts[i0 * 2 + 1]!;
    const bx = p.pts[i1 * 2]!;
    const by = p.pts[i1 * 2 + 1]!;
    const len = len2(bx - ax, by - ay);
    if (len < 1e-9) return;
    const density = trimRowDensity(o.sheet, row);
    const rowMetres = (row.bottom - row.top) / density;
    const stacks = Math.max(1, Math.round(runLen[k]! / rowMetres));
    const stackLen = runLen[k]! / stacks;
    const q0 = runBefore[k]!;
    const params = new Set<number>([0, 1]);
    for (let q = Math.ceil(q0 / stackLen + 1e-9); q * stackLen < q0 + len - 1e-9; q++) params.add((q * stackLen - q0) / len);
    // Where the darkening of an end's corner fades out (a segment shorter than the reach darkens all along).
    if (ao && r < len) {
      if (corner[i0]! > 0) params.add(r / len);
      if (corner[i1]! > 0) params.add(1 - r / len);
    }
    for (const c of cuts) {
      for (const y of [c.bottom, c.top]) {
        if (y === undefined || by === ay) continue;
        const t = (y - ay) / (by - ay);
        if (t > 1e-6 && t < 1 - 1e-6) params.add(t);
      }
    }
    const rows = [...params].sort((a, b) => a - b);
    // The segment's 2D normal (right of its direction) and, smooth, the averaged ones at its ends.
    const snx = (by - ay) / len;
    const sny = -(bx - ax) / len;
    const endNormal = (i: number, other: number): [number, number] => {
      if (!p.smooth) return [snx, sny];
      const hasOther = p.closed || (other >= 0 && other < np);
      if (!hasOther) return [snx, sny];
      const j = (other + np) % np;
      const ox = i === i0 ? px2(p, i0) - px2(p, j) : px2(p, j) - px2(p, i1);
      const oy = i === i0 ? py2(p, i0) - py2(p, j) : py2(p, j) - py2(p, i1);
      const ol = Math.sqrt(ox * ox + oy * oy) || 1;
      let nx = snx + oy / ol;
      let ny = sny - ox / ol;
      const l = Math.sqrt(nx * nx + ny * ny) || 1;
      nx /= l;
      ny /= l;
      return [nx, ny];
    };
    const n0 = endNormal(i0, i0 - 1);
    const n1 = endNormal(i1, i1 + 1);
    const [v0, v1] = trimRowV(o.sheet, row);
    const su = density / o.sheet.size[0];
    const topAtEnd = runTopAtEnd[k] === 1;
    // u along each row's own edge: cumulative over columns.
    const nr = rows.length;
    const rx = new Float64Array(nr);
    const ry = new Float64Array(nr);
    for (let m = 0; m < nr; m++) {
      rx[m] = ax + (bx - ax) * rows[m]!;
      ry[m] = ay + (by - ay) * rows[m]!;
    }
    const uAlong = new Float64Array(nr * nc);
    for (let m = 0; m < nr; m++) {
      let acc = 0;
      let qx = 0;
      let qy = 0;
      let qz = 0;
      for (let c = 0; c < nc; c++) {
        const x = cp[c * 3]! + cx[c * 3]! * rx[m]! + cy[c * 3]! * ry[m]!;
        const y = cp[c * 3 + 1]! + cx[c * 3 + 1]! * rx[m]! + cy[c * 3 + 1]! * ry[m]!;
        const z = cp[c * 3 + 2]! + cx[c * 3 + 2]! * rx[m]! + cy[c * 3 + 2]! * ry[m]!;
        if (c > 0) acc += len3(x - qx, y - qy, z - qz);
        uAlong[m * nc + c] = acc;
        qx = x;
        qy = y;
        qz = z;
      }
    }
    const profAo = (m: number): number => {
      if (!ao) return 0;
      const t = rows[m]!;
      return Math.max(corner[i0]! * Math.max(0, 1 - (t * len) / r), corner[i1]! * Math.max(0, 1 - ((1 - t) * len) / r));
    };
    // Each cell's stack piece; a row on a stack boundary has a vertex for each side (v jumps there), else one shared.
    const cellStack = new Int32Array(Math.max(1, nr - 1));
    for (let m = 0; m + 1 < nr; m++) cellStack[m] = Math.min(stacks - 1, Math.floor((q0 + ((rows[m]! + rows[m + 1]!) / 2) * len) / stackLen));
    const cache = new Int32Array(nc * nr * 2).fill(-1);
    // Per row: the face's 2D normal (smooth profiles blend their end normals), the profile's AO and v's place.
    const rn = new Float64Array(nr * 2);
    const rowAo = new Float64Array(nr);
    for (let m = 0; m < nr; m++) {
      const t = rows[m]!;
      const n2x = n0[0] + (n1[0] - n0[0]) * t;
      const n2y = n0[1] + (n1[1] - n0[1]) * t;
      const nl = Math.sqrt(n2x * n2x + n2y * n2y) || 1;
      rn[m * 2] = n2x / nl;
      rn[m * 2 + 1] = n2y / nl;
      rowAo[m] = profAo(m);
    }
    // Per column: the 3D frame the normals turn with — a sharp sample keeps its segment's own, a smooth one the
    // averaged, lerped between.
    const colFrame = new Float64Array(nc * 6);
    for (let cc = 0; cc < nc; cc++) {
      const col = cols[cc]!;
      const seg = col.seg;
      const ia = seg;
      const ib = (seg + 1) % n;
      for (let q = 0; q < 3; q++) {
        const ra = s.sharp[ia] === 1 ? fr.sr[seg * 3 + q]! : fr.ar[ia * 3 + q]!;
        const rb = s.sharp[ib] === 1 ? fr.sr[seg * 3 + q]! : fr.ar[ib * 3 + q]!;
        const ua = s.sharp[ia] === 1 ? fr.su[seg * 3 + q]! : fr.au[ia * 3 + q]!;
        const ub = s.sharp[ib] === 1 ? fr.su[seg * 3 + q]! : fr.au[ib * 3 + q]!;
        colFrame[cc * 6 + q] = ra + (rb - ra) * col.f;
        colFrame[cc * 6 + 3 + q] = ua + (ub - ua) * col.f;
      }
    }
    /** The vertex at column `cc`, row `mm`, as the cell of stack piece `stack` uses it (made once, shared by its cells). */
    const vertexAt = (cc: number, mm: number, stack: number): number => {
      const below = mm > 0 ? cellStack[mm - 1]! : -1;
      const above = mm < nr - 1 ? cellStack[mm]! : -1;
      const slot = below === above || stack === above ? 0 : 1;
      const k = (cc * nr + mm) * 2 + slot;
      if (cache[k]! >= 0) return cache[k]!;
      const x2 = rx[mm]!;
      const y2 = ry[mm]!;
      const c3 = cc * 3;
      const px = cp[c3]! + cx[c3]! * x2 + cy[c3]! * y2;
      const py = cp[c3 + 1]! + cx[c3 + 1]! * x2 + cy[c3 + 1]! * y2;
      const pz = cp[c3 + 2]! + cx[c3 + 2]! * x2 + cy[c3 + 2]! * y2;
      const n2x = rn[mm * 2]!;
      const n2y = rn[mm * 2 + 1]!;
      const f = cc * 6;
      let nx = colFrame[f]! * n2x + colFrame[f + 3]! * n2y;
      let ny = colFrame[f + 1]! * n2x + colFrame[f + 4]! * n2y;
      let nz = colFrame[f + 2]! * n2x + colFrame[f + 5]! * n2y;
      const l3 = len3(nx, ny, nz) || 1;
      nx /= l3;
      ny /= l3;
      nz /= l3;
      const local = (q0 + rows[mm]! * len) / stackLen - stack;
      const across = topAtEnd ? 1 - local : local;
      let occ = 0;
      if (ao) {
        const sideAo = n2x > 0 ? pathAo[cc * 2]! * n2x : n2x < 0 ? pathAo[cc * 2 + 1]! * -n2x : 0;
        occ = o.aoStrength * (1 - (1 - rowAo[mm]!) * (1 - sideAo));
      }
      const i = w.vertex(px, py, pz, nx, ny, nz, uAlong[mm * nc + cc]! * su, v0 + (v1 - v0) * (across < 0 ? 0 : across > 1 ? 1 : across), occ);
      cache[k] = i;
      return i;
    };
    // The far level: a run of whole cells along one path segment (no opening near, all the chunk's) is one quad
    // per row there, over the run's end vertices (positions and UVs run straight along a segment, so the quad
    // shows the same texture; only the vertex AO between its ends is lost). Cells an opening reaches keep theirs.
    let runFrom = -1;
    const endRun = (to: number): void => {
      if (runFrom < 0) return;
      for (let m = 0; m + 1 < nr; m++) {
        const stack = cellStack[m]!;
        const a = vertexAt(runFrom, m, stack);
        const b = vertexAt(to, m, stack);
        const cc = vertexAt(to, m + 1, stack);
        const d = vertexAt(runFrom, m + 1, stack);
        w.triangleFacing(a, b, cc, FAR);
        w.triangleFacing(a, cc, d, FAR);
      }
      runFrom = -1;
    };
    for (let c = 0; c + 1 < nc; c++) {
      const A = cols[c]!;
      const B = cols[c + 1]!;
      if (A.seg !== B.seg || B.d - A.d < 1e-9 || (runFrom >= 0 && cols[runFrom]!.seg !== A.seg)) endRun(c);
      if (A.seg !== B.seg || B.d - A.d < 1e-9) continue;
      if (segOk !== null && !segOk.has(A.seg)) {
        endRun(c);
        continue;
      }
      const dm = (A.d + B.d) / 2;
      if (o.own !== undefined) {
        const mx = (cp[c * 3]! + cp[c * 3 + 3]!) / 2;
        const mz = (cp[c * 3 + 2]! + cp[c * 3 + 5]!) / 2;
        if (!o.own(mx, mz)) {
          endRun(c);
          continue;
        }
      }
      const opened = cuts.some((q) => dm > q.a && dm < q.b);
      if (opened) endRun(c);
      else if (runFrom < 0) runFrom = c;
      if (cuts.some((q) => q.bottom === undefined && dm > q.a && dm < q.b)) continue;
      for (let m = 0; m + 1 < nr; m++) {
        const ym = (ry[m]! + ry[m + 1]!) / 2;
        const flat = Math.abs(ry[m]! - ry[m + 1]!) < 1e-9;
        // A level face (a sill's or a footing's) inside the opening's heights goes too; a sloped or upright one only strictly inside.
        if (cuts.some((q) => q.bottom !== undefined && dm > q.a && dm < q.b && (flat ? ym >= q.bottom && ym <= q.top! : ym > q.bottom && ym < q.top!))) continue;
        const stack = cellStack[m]!;
        const a = vertexAt(c, m, stack);
        const b = vertexAt(c + 1, m, stack);
        const cc = vertexAt(c + 1, m + 1, stack);
        const d = vertexAt(c, m + 1, stack);
        w.triangleFacing(a, b, cc, opened ? BOTH : NEAR);
        w.triangleFacing(a, cc, d, opened ? BOTH : NEAR);
      }
    }
    endRun(nc - 1);
  }
}

/**
 * The ends of a closed profile swept along an open path (a stair's sides, a
 * beam's ends): the profile's polygon on the end's cross-section, facing
 * away along the path, wearing the cap slot in strips like any flat face.
 */
function writeCaps(w: ArchMeshWriter, s: PathSamples, p: SweepProfile, o: SweepOptions, cols: readonly Column[], cp: Float64Array, cx: Float64Array, cy: Float64Array): void {
  const row = o.rowOf(p.cap!);
  if (row === null) return;
  const n = s.n;
  const ends: [number, number, number][] = [
    [0, 0, 1],
    [cols.length - 1, n - 1, n - 2],
  ];
  for (const [c, at, from] of ends) {
    if (o.own !== undefined && !o.own(cp[c * 3]!, cp[c * 3 + 2]!)) continue;
    const tx = s.pos[at * 3]! - s.pos[from * 3]!;
    const ty = s.pos[at * 3 + 1]! - s.pos[from * 3 + 1]!;
    const tz = s.pos[at * 3 + 2]! - s.pos[from * 3 + 2]!;
    const l = len3(tx, ty, tz);
    if (l < 1e-9) continue;
    const f = { o: [cp[c * 3]!, cp[c * 3 + 1]!, cp[c * 3 + 2]!], a: [cx[c * 3]!, cx[c * 3 + 1]!, cx[c * 3 + 2]!], b: [cy[c * 3]!, cy[c * 3 + 1]!, cy[c * 3 + 2]!], n: [tx / l, ty / l, tz / l] };
    fillPlanarPolygon(w, p.pts, f, { sheet: o.sheet, row, aoStrength: 0, aoRadius: 1 });
  }
}

const px2 = (p: SweepProfile, i: number): number => p.pts[((i + p.pts.length / 2) % (p.pts.length / 2)) * 2]!;
const py2 = (p: SweepProfile, i: number): number => p.pts[((i + p.pts.length / 2) % (p.pts.length / 2)) * 2 + 1]!;

/** The 3D point at `d` metres along the path, `x` across and `y` up on the profile's plane there (mitred at samples). */
export function sweepPointAt(s: PathSamples, fr: SweepFrames, d: number, x: number, y: number, out: number[]): void {
  const segs = s.closed ? s.n : s.n - 1;
  let dd = d;
  if (s.closed && s.length > 0) dd = ((dd % s.length) + s.length) % s.length;
  else dd = Math.max(0, Math.min(s.length, dd));
  let j = 0;
  while (j < segs - 1 && s.dist[j + 1]! < dd) j++;
  const span = s.dist[j + 1]! - s.dist[j]!;
  const f = span > 0 ? (dd - s.dist[j]!) / span : 0;
  const a = j;
  const b = (j + 1) % s.n;
  for (let k = 0; k < 3; k++) {
    const p = s.pos[a * 3 + k]! + (s.pos[b * 3 + k]! - s.pos[a * 3 + k]!) * f;
    const ax = fr.mx[a * 3 + k]! + (fr.mx[b * 3 + k]! - fr.mx[a * 3 + k]!) * f;
    const ay = fr.my[a * 3 + k]! + (fr.my[b * 3 + k]! - fr.my[a * 3 + k]!) * f;
    out[k] = p + ax * x + ay * y;
  }
}

/** The segment index holding distance `d`. */
export function segmentAt(s: PathSamples, d: number): number {
  const segs = s.closed ? s.n : s.n - 1;
  let j = 0;
  while (j < segs - 1 && s.dist[j + 1]! < d) j++;
  return j;
}
