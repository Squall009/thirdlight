/**
 * The path operator of generated architecture: an element's path turned
 * into samples (positions, distances, which samples are sharp corners),
 * with arcs, the smooth curve, the offset and the chamfer applied.
 *
 * Arcs are rational quadratic Béziers (exact circles, no trig: the weight
 * is cos(θ/2) = (1 − b²)/(1 + b²) from the bulge b = tan(θ/4)); arcs past a
 * half circle are halved first. The curve is the spline component's
 * (`SplineCurve.point`, plain arithmetic). Lengths use `Math.sqrt` only, so
 * the samples are the same bits everywhere (`arch-math.ts`).
 *
 * Pure.
 */
import { len3 } from './arch-math';
import { ARCHITECTURE_STEP_DEFAULT, type ArchitecturePath } from './architecture';
import { SplineCurve } from './spline-curve';

/** A path's samples. A closed path does not repeat its first sample; its last segment runs back to it. */
export interface PathSamples {
  n: number;
  closed: boolean;
  /** xyz per sample. */
  pos: Float64Array;
  /** Distance along the path to each sample; one more entry than samples for a closed path (its length). */
  dist: Float64Array;
  /** 1 where the path turns at a sample (a corner: faces on either side keep their own normals). */
  sharp: Uint8Array;
  length: number;
  /** Distance along the path to each authored point (where a chamfer cut it: the middle of the cut). */
  pointDist: Float64Array;
}

/** A turn sharper than this (cosine between directions) at an authored point is a corner. */
const SMOOTH_DOT = 0.99995;
/** The most a mitred offset may scale (a hairpin's spike is cut to this). */
const MITRE_MAX = 4;

function pushArc(out: number[], sharp: number[], ax: number, ay: number, az: number, bx: number, by: number, bz: number, bulge: number, step: number): void {
  const dx = bx - ax;
  const dz = bz - az;
  const chord = Math.sqrt(dx * dx + dz * dz);
  if (chord < 1e-9 || bulge === 0) {
    out.push(bx, by, bz);
    sharp.push(1);
    return;
  }
  // Right of travel in XZ: (-dz, dx) / chord.
  const rx = -dz / chord;
  const rz = dx / chord;
  if (Math.abs(bulge) >= 1) {
    // Halve the arc at its middle: sagitta s = b · c / 2; each half's bulge is tan(θ/8).
    const s = (bulge * chord) / 2;
    const mx = (ax + bx) / 2 + rx * s;
    const mz = (az + bz) / 2 + rz * s;
    const my = (ay + by) / 2;
    const half = (Math.sqrt(1 + bulge * bulge) - 1) / bulge;
    pushArc(out, sharp, ax, ay, az, mx, my, mz, half, step);
    sharp[sharp.length - 1] = 0;
    pushArc(out, sharp, mx, my, mz, bx, by, bz, half, step);
    return;
  }
  const b2 = bulge * bulge;
  const w = (1 - b2) / (1 + b2);
  // The control point where the end tangents meet: (c/2) · tan(θ/2) from the chord's middle, tan(θ/2) = 2b / (1 − b²).
  const h = (chord / 2) * ((2 * bulge) / (1 - b2));
  const cx = (ax + bx) / 2 + rx * h;
  const cz = (az + bz) / 2 + rz * h;
  const approx = (len3(cx - ax, 0, cz - az) + len3(bx - cx, 0, bz - cz) + chord) / 2;
  const n = Math.max(2, Math.ceil(approx / step));
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const a = (1 - t) * (1 - t);
    const m = 2 * t * (1 - t) * w;
    const c = t * t;
    const d = a + m + c;
    out.push((a * ax + m * cx + c * bx) / d, ay + (by - ay) * t, (a * az + m * cz + c * bz) / d);
    sharp.push(k === n ? 1 : 0);
  }
}

/** Raw samples before offset and chamfer: positions and corner flags, and the index of each authored point's sample. */
function rawSamples(p: ArchitecturePath): { pos: number[]; sharp: number[]; at: number[] } {
  const pts = p.points;
  const closed = p.closed === true && pts.length >= 3;
  const step = p.step ?? ARCHITECTURE_STEP_DEFAULT;
  const pos: number[] = [];
  const sharp: number[] = [];
  const at: number[] = [];
  const segs = closed ? pts.length : pts.length - 1;
  if (p.curve === true) {
    const curve = new SplineCurve(pts.map((q) => ({ at: [q[0], q[1], q[2]] as [number, number, number] })), [0, 0, 0], { closed });
    const q = [0, 0, 0];
    pos.push(pts[0]![0], pts[0]![1], pts[0]![2]);
    sharp.push(0);
    at.push(0);
    for (let s = 0; s < segs; s++) {
      const a = pts[s]!;
      const b = pts[(s + 1) % pts.length]!;
      const n = Math.max(2, Math.ceil((len3(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * 1.15) / step));
      const last = closed && s === segs - 1;
      for (let k = 1; k <= n; k++) {
        if (last && k === n) break;
        curve.point(s, k / n, q);
        pos.push(q[0]!, q[1]!, q[2]!);
        sharp.push(0);
      }
      if (!last) at.push(pos.length / 3 - 1);
    }
    return { pos, sharp, at };
  }
  pos.push(pts[0]![0], pts[0]![1], pts[0]![2]);
  sharp.push(1);
  at.push(0);
  for (let s = 0; s < segs; s++) {
    const a = pts[s]!;
    const b = pts[(s + 1) % pts.length]!;
    const bulge = p.bulges?.[s] ?? 0;
    pushArc(pos, sharp, a[0], a[1], a[2], b[0], b[1], b[2], bulge, step);
    if (closed && s === segs - 1) {
      // The closing segment ends on the first sample: drop the duplicate.
      pos.length -= 3;
      sharp.length -= 1;
    } else at.push(pos.length / 3 - 1);
  }
  return { pos, sharp, at };
}

function dir(pos: readonly number[], i: number, j: number, out: number[]): boolean {
  const dx = pos[j * 3]! - pos[i * 3]!;
  const dy = pos[j * 3 + 1]! - pos[i * 3 + 1]!;
  const dz = pos[j * 3 + 2]! - pos[i * 3 + 2]!;
  const l = len3(dx, dy, dz);
  if (l < 1e-12) return false;
  out[0] = dx / l;
  out[1] = dy / l;
  out[2] = dz / l;
  return true;
}

/** Drop samples that repeat the one before (zero-length segments). */
function dedupe(pos: number[], sharp: number[], at: number[], closed: boolean): void {
  const keep: number[] = [];
  const map: number[] = [];
  const n = pos.length / 3;
  for (let i = 0; i < n; i++) {
    const j = keep.length > 0 ? keep[keep.length - 1]! : -1;
    if (j >= 0 && len3(pos[i * 3]! - pos[j * 3]!, pos[i * 3 + 1]! - pos[j * 3 + 1]!, pos[i * 3 + 2]! - pos[j * 3 + 2]!) < 1e-9) {
      map.push(keep.length - 1);
      continue;
    }
    map.push(keep.length);
    keep.push(i);
  }
  if (closed && keep.length > 1) {
    const f = keep[0]!;
    const l = keep[keep.length - 1]!;
    if (len3(pos[f * 3]! - pos[l * 3]!, pos[f * 3 + 1]! - pos[l * 3 + 1]!, pos[f * 3 + 2]! - pos[l * 3 + 2]!) < 1e-9) {
      keep.pop();
      for (let i = 0; i < map.length; i++) if (map[i] === keep.length) map[i] = 0;
    }
  }
  const p2: number[] = [];
  const s2: number[] = [];
  for (const i of keep) {
    p2.push(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!);
    s2.push(sharp[i]!);
  }
  pos.length = 0;
  pos.push(...p2);
  sharp.length = 0;
  sharp.push(...s2);
  for (let k = 0; k < at.length; k++) at[k] = map[at[k]!]!;
}

/** The path's samples with arcs, the curve, the offset and the chamfer applied. */
export function samplePath(p: ArchitecturePath): PathSamples {
  const closed = p.closed === true && p.points.length >= 3;
  const { pos, sharp, at } = rawSamples(p);
  dedupe(pos, sharp, at, closed);
  let n = pos.length / 3;
  const da = [0, 0, 0];
  const db = [0, 0, 0];
  // A sample is a corner only where the path really turns.
  for (let i = 0; i < n; i++) {
    if (sharp[i] !== 1) continue;
    const prev = i > 0 ? i - 1 : closed ? n - 1 : -1;
    const next = i < n - 1 ? i + 1 : closed ? 0 : -1;
    if (prev < 0 || next < 0) continue;
    if (dir(pos, prev, i, da) && dir(pos, i, next, db) && da[0]! * db[0]! + da[1]! * db[1]! + da[2]! * db[2]! > SMOOTH_DOT) sharp[i] = 0;
  }
  const offset = p.offset ?? 0;
  if (offset !== 0 && n >= 2) {
    const out = pos.slice();
    for (let i = 0; i < n; i++) {
      const prev = i > 0 ? i - 1 : closed ? n - 1 : -1;
      const next = i < n - 1 ? i + 1 : closed ? 0 : -1;
      const ha = prev >= 0 && dir(pos, prev, i, da);
      const hb = next >= 0 && dir(pos, i, next, db);
      // Right of travel, level: (-tz, 0, tx).
      let ax = ha ? -da[2]! : 0;
      let az = ha ? da[0]! : 0;
      let bx = hb ? -db[2]! : 0;
      let bz = hb ? db[0]! : 0;
      if (!ha) {
        ax = bx;
        az = bz;
      }
      if (!hb) {
        bx = ax;
        bz = az;
      }
      const la = Math.sqrt(ax * ax + az * az) || 1;
      const lb = Math.sqrt(bx * bx + bz * bz) || 1;
      ax /= la;
      az /= la;
      bx /= lb;
      bz /= lb;
      let mx = ax + bx;
      let mz = az + bz;
      const ml = Math.sqrt(mx * mx + mz * mz);
      if (ml < 1e-9) {
        mx = ax;
        mz = az;
      } else {
        mx /= ml;
        mz /= ml;
      }
      const cos = mx * ax + mz * az;
      const scale = Math.min(MITRE_MAX, 1 / Math.max(1e-6, cos));
      out[i * 3] = pos[i * 3]! + mx * offset * scale;
      out[i * 3 + 2] = pos[i * 3 + 2]! + mz * offset * scale;
    }
    for (let k = 0; k < out.length; k++) pos[k] = out[k]!;
  }
  const chamfer = p.chamfer ?? 0;
  const chamfered: number[] = [];
  if (chamfer > 0 && n >= 3) {
    const np: number[] = [];
    const ns: number[] = [];
    const map: number[] = [];
    for (let i = 0; i < n; i++) {
      const prev = i > 0 ? i - 1 : closed ? n - 1 : -1;
      const next = i < n - 1 ? i + 1 : closed ? 0 : -1;
      if (sharp[i] === 1 && prev >= 0 && next >= 0) {
        const la = len3(pos[i * 3]! - pos[prev * 3]!, pos[i * 3 + 1]! - pos[prev * 3 + 1]!, pos[i * 3 + 2]! - pos[prev * 3 + 2]!);
        const lb = len3(pos[next * 3]! - pos[i * 3]!, pos[next * 3 + 1]! - pos[i * 3 + 1]!, pos[next * 3 + 2]! - pos[i * 3 + 2]!);
        const ca = Math.min(chamfer, la * 0.45) / la;
        const cb = Math.min(chamfer, lb * 0.45) / lb;
        map.push(np.length / 3);
        chamfered.push(np.length / 3);
        for (let k = 0; k < 3; k++) np.push(pos[i * 3 + k]! + (pos[prev * 3 + k]! - pos[i * 3 + k]!) * ca);
        for (let k = 0; k < 3; k++) np.push(pos[i * 3 + k]! + (pos[next * 3 + k]! - pos[i * 3 + k]!) * cb);
        ns.push(1, 1);
        continue;
      }
      map.push(np.length / 3);
      for (let k = 0; k < 3; k++) np.push(pos[i * 3 + k]!);
      ns.push(sharp[i]!);
    }
    pos.length = 0;
    pos.push(...np);
    sharp.length = 0;
    sharp.push(...ns);
    for (let k = 0; k < at.length; k++) at[k] = map[at[k]!]!;
    n = pos.length / 3;
  }
  const dist = new Float64Array(closed ? n + 1 : n);
  let total = 0;
  for (let i = 1; i < dist.length; i++) {
    const a = i - 1;
    const b = i % n;
    total += len3(pos[b * 3]! - pos[a * 3]!, pos[b * 3 + 1]! - pos[a * 3 + 1]!, pos[b * 3 + 2]! - pos[a * 3 + 2]!);
    dist[i] = total;
  }
  const isChamfered = new Set(chamfered);
  const pointDist = new Float64Array(at.length);
  for (let k = 0; k < at.length; k++) {
    const i = at[k]!;
    // A chamfered corner's authored point is the middle of its cut.
    pointDist[k] = isChamfered.has(i) ? (dist[i]! + dist[i + 1]!) / 2 : dist[i]!;
  }
  return { n, closed, pos: Float64Array.from(pos), dist, sharp: Uint8Array.from(sharp), length: total, pointDist };
}

/** The position and unit direction at `d` metres along (clamped; a closed path wraps). */
export function pathPointAt(s: PathSamples, d: number, out: number[], tangent: number[]): void {
  const L = s.length;
  let x = d;
  if (s.closed && L > 0) x = ((x % L) + L) % L;
  else x = Math.max(0, Math.min(L, x));
  const segs = s.closed ? s.n : s.n - 1;
  let lo = 0;
  let hi = segs;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s.dist[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const i = lo;
  const j = (i + 1) % s.n;
  const span = s.dist[i + 1]! - s.dist[i]!;
  const f = span > 0 ? (x - s.dist[i]!) / span : 0;
  for (let k = 0; k < 3; k++) out[k] = s.pos[i * 3 + k]! + (s.pos[j * 3 + k]! - s.pos[i * 3 + k]!) * f;
  const dx = s.pos[j * 3]! - s.pos[i * 3]!;
  const dy = s.pos[j * 3 + 1]! - s.pos[i * 3 + 1]!;
  const dz = s.pos[j * 3 + 2]! - s.pos[i * 3 + 2]!;
  const l = len3(dx, dy, dz) || 1;
  tangent[0] = dx / l;
  tangent[1] = dy / l;
  tangent[2] = dz / l;
}
