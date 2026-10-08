/**
 * A spline component's curve in the world: positions, directions and
 * cross-sections by distance along it, the nearest point to a place, and
 * evenly spaced frames for whatever is made along it.
 *
 * Each segment between two points is a cubic Hermite curve through them with
 * their tangents (a point without one takes Catmull-Rom's: half the step
 * from the point before to the point after, or the step to its one
 * neighbour at an open end). Width and roll go linearly from point to point.
 * Distance along the curve comes from a table of samples about
 * {@link SPLINE_TABLE_STEP} metres apart, built once; a position at a
 * distance is the curve itself at the parameter the table gives, so frames
 * lie exactly on the curve whatever the table's step.
 *
 * A frame's right vector is level (horizontal, at right angles to the
 * curve's direction), turned about the direction by the roll; its up vector
 * completes the frame. A vertical direction keeps the right vector of the
 * frame before it.
 *
 * Pure: plain arithmetic, the same answers wherever it runs.
 */
import { SPLINE_WIDTH_DEFAULT, type SplineComponent, type SplinePoint } from './spline';

/** Metres between the distance table's samples. */
export const SPLINE_TABLE_STEP = 0.5;
/** Most table samples one segment gets (a tangent thousands of metres long would otherwise ask for millions). */
const SEGMENT_SAMPLES_MAX = 8192;

/** One place on the curve and its cross-section (world metres, unit vectors). */
export interface SplineFrame {
  /** Metres along the curve from its start. */
  distance: number;
  x: number;
  y: number;
  z: number;
  /** Direction along the curve. */
  tx: number;
  ty: number;
  tz: number;
  /** Across, to the right, turned by the roll. */
  rx: number;
  ry: number;
  rz: number;
  /** Up from the cross-section. */
  ux: number;
  uy: number;
  uz: number;
  /** Metres across, and degrees of roll. */
  width: number;
  roll: number;
}

export const newSplineFrame = (): SplineFrame => ({ distance: 0, x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 1, rx: -1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, width: 0, roll: 0 });

/** The nearest place on the curve to a point. */
export interface SplineNearest {
  /** Metres along the curve. */
  distance: number;
  /** Metres from the point to the curve. */
  offset: number;
  x: number;
  y: number;
  z: number;
}

export class SplineCurve {
  readonly closed: boolean;
  /** Metres along the whole curve. */
  readonly length: number;
  /** World box of the curve's points and samples: [x0, y0, z0, x1, y1, z1]. */
  readonly bounds: [number, number, number, number, number, number];
  /** The widest point (metres). */
  readonly maxWidth: number;
  private readonly n: number;
  private readonly p: Float64Array;
  private readonly t: Float64Array;
  private readonly w: Float64Array;
  private readonly r: Float64Array;
  /** The table: per sample its segment + parameter (seg + u) and distance. */
  private readonly su: Float64Array;
  private readonly sd: Float64Array;
  /** Table samples' positions (for the nearest point). */
  private readonly sp: Float64Array;

  /** `origin`: the object's position (the points are offsets from it). */
  constructor(points: readonly SplinePoint[], origin: readonly number[], opts: { closed?: boolean; width?: number } = {}) {
    const n = points.length;
    this.n = n;
    this.closed = opts.closed === true && n >= 3;
    const width = opts.width ?? SPLINE_WIDTH_DEFAULT;
    this.p = new Float64Array(n * 3);
    this.t = new Float64Array(n * 3);
    this.w = new Float64Array(n);
    this.r = new Float64Array(n);
    let maxWidth = 0;
    for (let i = 0; i < n; i++) {
      const q = points[i]!;
      for (let k = 0; k < 3; k++) this.p[i * 3 + k] = (origin[k] ?? 0) + q.at[k]!;
      this.w[i] = q.width ?? width;
      this.r[i] = q.roll ?? 0;
      maxWidth = Math.max(maxWidth, this.w[i]!);
    }
    this.maxWidth = maxWidth;
    for (let i = 0; i < n; i++) {
      const own = points[i]!.tangent;
      for (let k = 0; k < 3; k++) {
        if (own !== undefined) {
          this.t[i * 3 + k] = own[k]!;
          continue;
        }
        const prev = i > 0 ? i - 1 : this.closed ? n - 1 : -1;
        const next = i < n - 1 ? i + 1 : this.closed ? 0 : -1;
        const a = prev < 0 ? this.p[i * 3 + k]! : this.p[prev * 3 + k]!;
        const b = next < 0 ? this.p[i * 3 + k]! : this.p[next * 3 + k]!;
        this.t[i * 3 + k] = prev < 0 || next < 0 ? b - a : (b - a) / 2;
      }
    }
    // The distance table.
    const segs = this.segments;
    const su: number[] = [0];
    const sd: number[] = [0];
    const sp: number[] = [this.p[0]!, this.p[1]!, this.p[2]!];
    const at = [0, 0, 0];
    let px = this.p[0]!;
    let py = this.p[1]!;
    let pz = this.p[2]!;
    let total = 0;
    const b = [px, py, pz, px, py, pz];
    for (let s = 0; s < segs; s++) {
      const i = s * 3;
      const j = ((s + 1) % n) * 3;
      const chord = Math.hypot(this.p[j]! - this.p[i]!, this.p[j + 1]! - this.p[i + 1]!, this.p[j + 2]! - this.p[i + 2]!);
      const pull = (Math.hypot(this.t[i]!, this.t[i + 1]!, this.t[i + 2]!) + Math.hypot(this.t[j]!, this.t[j + 1]!, this.t[j + 2]!)) / 3;
      const steps = Math.max(2, Math.min(SEGMENT_SAMPLES_MAX, Math.ceil((chord + pull) / SPLINE_TABLE_STEP)));
      for (let k = 1; k <= steps; k++) {
        const u = k / steps;
        this.point(s, u, at);
        total += Math.hypot(at[0]! - px, at[1]! - py, at[2]! - pz);
        px = at[0]!;
        py = at[1]!;
        pz = at[2]!;
        su.push(s + u);
        sd.push(total);
        sp.push(px, py, pz);
        if (px < b[0]!) b[0] = px;
        if (py < b[1]!) b[1] = py;
        if (pz < b[2]!) b[2] = pz;
        if (px > b[3]!) b[3] = px;
        if (py > b[4]!) b[4] = py;
        if (pz > b[5]!) b[5] = pz;
      }
    }
    this.su = Float64Array.from(su);
    this.sd = Float64Array.from(sd);
    this.sp = Float64Array.from(sp);
    this.length = total;
    this.bounds = b as [number, number, number, number, number, number];
  }

  /** The curve of a spline component placed at `origin` (the object's position). */
  static of(c: Pick<SplineComponent, 'points' | 'closed' | 'width'>, origin: readonly number[]): SplineCurve {
    return new SplineCurve(c.points, origin, { ...(c.closed !== undefined ? { closed: c.closed } : {}), ...(c.width !== undefined ? { width: c.width } : {}) });
  }

  /** Segments between points (a closed curve has one more, back to the start). */
  get segments(): number {
    return this.closed ? this.n : this.n - 1;
  }

  /** The curve's position on segment `s` at parameter `u` (0–1). */
  point(s: number, u: number, out: number[]): void {
    const i = s * 3;
    const j = ((s + 1) % this.n) * 3;
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    for (let k = 0; k < 3; k++) out[k] = h00 * this.p[i + k]! + h10 * this.t[i + k]! + h01 * this.p[j + k]! + h11 * this.t[j + k]!;
  }

  /** The curve's derivative on segment `s` at `u`. */
  private derivative(s: number, u: number, out: number[]): void {
    const i = s * 3;
    const j = ((s + 1) % this.n) * 3;
    const u2 = u * u;
    const d00 = 6 * u2 - 6 * u;
    const d10 = 3 * u2 - 4 * u + 1;
    const d01 = -6 * u2 + 6 * u;
    const d11 = 3 * u2 - 2 * u;
    for (let k = 0; k < 3; k++) out[k] = d00 * this.p[i + k]! + d10 * this.t[i + k]! + d01 * this.p[j + k]! + d11 * this.t[j + k]!;
  }

  /** The segment and parameter (seg + u) at a distance along (clamped to the curve; a closed curve wraps). */
  private paramAt(distance: number): number {
    const L = this.length;
    let d = distance;
    if (this.closed && L > 0) d = ((d % L) + L) % L;
    else d = Math.max(0, Math.min(L, d));
    const sd = this.sd;
    let lo = 0;
    let hi = sd.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (sd[mid]! <= d) lo = mid;
      else hi = mid;
    }
    const span = sd[hi]! - sd[lo]!;
    const f = span > 0 ? (d - sd[lo]!) / span : 0;
    return this.su[lo]! + (this.su[hi]! - this.su[lo]!) * f;
  }

  /**
   * The frame at `distance` metres along (clamped to the ends; a closed
   * curve wraps). `prev`: a frame just before it, whose right vector a
   * vertical direction keeps.
   */
  frameAt(distance: number, out: SplineFrame = newSplineFrame(), prev?: SplineFrame): SplineFrame {
    const su = this.paramAt(distance);
    let s = Math.floor(su);
    let u = su - s;
    if (s >= this.segments) {
      s = this.segments - 1;
      u = 1;
    }
    this.frameOn(s, u, out, prev);
    out.distance = this.closed && this.length > 0 ? ((distance % this.length) + this.length) % this.length : Math.max(0, Math.min(this.length, distance));
    return out;
  }

  /**
   * Frames along segment `s` at its own evenly spaced parameters, about
   * `step` metres apart by an estimate from the segment's points and
   * tangents alone: a segment whose points, tangents, widths and rolls stay
   * the same gives the same frames whatever happens elsewhere on the curve
   * (what lets a change re-bake only round the segments it moved).
   */
  segmentFrames(s: number, step: number): SplineFrame[] {
    const i = s * 3;
    const j = ((s + 1) % this.n) * 3;
    const chord = Math.hypot(this.p[j]! - this.p[i]!, this.p[j + 1]! - this.p[i + 1]!, this.p[j + 2]! - this.p[i + 2]!);
    const pull = (Math.hypot(this.t[i]!, this.t[i + 1]!, this.t[i + 2]!) + Math.hypot(this.t[j]!, this.t[j + 1]!, this.t[j + 2]!)) / 3;
    const m = Math.max(1, Math.min(SEGMENT_SAMPLES_MAX, Math.ceil((chord + pull) / Math.max(1e-3, step))));
    const out: SplineFrame[] = [];
    let prev: SplineFrame | undefined;
    for (let k = 0; k <= m; k++) {
      const f = this.frameOn(s, k / m, newSplineFrame(), prev);
      f.distance = Number.NaN;
      out.push(f);
      prev = f;
    }
    return out;
  }

  /** Every segment's frames (`segmentFrames`) in order, a join kept once. */
  pieces(step: number): SplineFrame[] {
    const out: SplineFrame[] = [];
    for (let s = 0; s < this.segments; s++) {
      const f = this.segmentFrames(s, step);
      for (let k = s === 0 ? 0 : 1; k < f.length; k++) out.push(f[k]!);
    }
    return out;
  }

  /** The frame on segment `s` at parameter `u` (its distance not set). */
  private frameOn(s: number, u: number, out: SplineFrame, prev?: SplineFrame): SplineFrame {
    const pos = [0, 0, 0];
    const d = [0, 0, 0];
    this.point(s, u, pos);
    this.derivative(s, u, d);
    let len = Math.hypot(d[0]!, d[1]!, d[2]!);
    if (len < 1e-9) {
      // A cusp (two points on one spot with no pull): the chord's direction.
      const i = s * 3;
      const j = ((s + 1) % this.n) * 3;
      for (let k = 0; k < 3; k++) d[k] = this.p[j + k]! - this.p[i + k]!;
      len = Math.hypot(d[0]!, d[1]!, d[2]!);
    }
    const tx = len > 0 ? d[0]! / len : 0;
    const ty = len > 0 ? d[1]! / len : 0;
    const tz = len > 0 ? d[2]! / len : 1;
    // Level right vector: direction × up.
    let rx = -tz;
    let rz = tx;
    const rl = Math.hypot(rx, rz);
    if (rl < 1e-6) {
      rx = prev?.rx ?? 1;
      rz = prev?.rz ?? 0;
      const l2 = Math.hypot(rx, rz) || 1;
      rx /= l2;
      rz /= l2;
    } else {
      rx /= rl;
      rz /= rl;
    }
    // Up = right × direction.
    let ux = 0 * tz - rz * ty;
    let uy = rz * tx - rx * tz;
    let uz = rx * ty - 0 * tx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const i = s;
    const j = (s + 1) % this.n;
    const width = this.w[i]! + (this.w[j]! - this.w[i]!) * u;
    const roll = this.r[i]! + (this.r[j]! - this.r[i]!) * u;
    let fx = rx;
    let fy = 0;
    let fz = rz;
    if (roll !== 0) {
      const a = (roll * Math.PI) / 180;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      fx = rx * c + ux * sn;
      fy = ux * 0 + uy * sn;
      fz = rz * c + uz * sn;
      const nux = ux * c - rx * sn;
      const nuy = uy * c;
      const nuz = uz * c - rz * sn;
      ux = nux;
      uy = nuy;
      uz = nuz;
    }
    out.x = pos[0]!;
    out.y = pos[1]!;
    out.z = pos[2]!;
    out.tx = tx;
    out.ty = ty;
    out.tz = tz;
    out.rx = fx;
    out.ry = fy;
    out.rz = fz;
    out.ux = ux;
    out.uy = uy;
    out.uz = uz;
    out.width = width;
    out.roll = roll;
    return out;
  }

  /**
   * Frames along the whole curve about `step` metres apart (evenly: the
   * curve's length divided into whole steps), first and last included (a
   * closed curve's last frame is its first again). With `from`/`to`
   * (metres along): only the part between them, ends included.
   */
  frames(step: number, from = 0, to = this.length): SplineFrame[] {
    const a = Math.max(0, Math.min(this.length, from));
    const b = Math.max(a, Math.min(this.length, to));
    const count = Math.max(1, Math.ceil((b - a) / Math.max(1e-3, step)));
    const out: SplineFrame[] = [];
    let prev: SplineFrame | undefined;
    for (let k = 0; k <= count; k++) {
      const d = k === count ? b : a + ((b - a) * k) / count;
      const f = this.frameAt(d, newSplineFrame(), prev);
      if (d === this.length && this.closed) f.distance = this.length;
      out.push(f);
      prev = f;
    }
    return out;
  }

  /** Metres along the curve to point `i` (a closed curve's point 0 is at 0; `i` = the point count: its whole length). */
  pointDistance(i: number): number {
    if (i <= 0) return 0;
    if (i >= this.segments) return this.length;
    const su = this.su;
    let lo = 0;
    let hi = su.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (su[mid]! <= i) lo = mid;
      else hi = mid;
    }
    return this.sd[lo]!;
  }

  /** The nearest place on the curve to a world point (`level`: across the ground only, x and z). */
  nearest(x: number, y: number, z: number, level = false): SplineNearest {
    const sp = this.sp;
    const count = this.sd.length;
    let best = Infinity;
    let bestD = 0;
    let bx = sp[0]!;
    let by = sp[1]!;
    let bz = sp[2]!;
    for (let k = 0; k + 1 < count; k++) {
      const ax = sp[k * 3]!;
      const ay = sp[k * 3 + 1]!;
      const az = sp[k * 3 + 2]!;
      const ex = sp[k * 3 + 3]! - ax;
      const ey = level ? 0 : sp[k * 3 + 4]! - ay;
      const ez = sp[k * 3 + 5]! - az;
      const e2 = ex * ex + ey * ey + ez * ez;
      let f = e2 > 0 ? ((x - ax) * ex + (level ? 0 : (y - ay) * ey) + (z - az) * ez) / e2 : 0;
      f = Math.max(0, Math.min(1, f));
      const qx = ax + ex * f;
      const qy = level ? y : ay + ey * f;
      const qz = az + ez * f;
      const d2 = (x - qx) ** 2 + (y - qy) ** 2 + (z - qz) ** 2;
      if (d2 < best) {
        best = d2;
        bestD = this.sd[k]! + (this.sd[k + 1]! - this.sd[k]!) * f;
        bx = qx;
        by = level ? ay + (sp[k * 3 + 4]! - ay) * f : qy;
        bz = qz;
      }
    }
    if (count === 1) best = (x - bx) ** 2 + (level ? 0 : (y - by) ** 2) + (z - bz) ** 2;
    return { distance: bestD, offset: Math.sqrt(best), x: bx, y: by, z: bz };
  }
}
