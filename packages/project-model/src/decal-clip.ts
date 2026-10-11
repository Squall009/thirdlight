/**
 * The decal clipper: the mesh of a `clipped` decal, cut from the surfaces of
 * its receivers inside the decal's box (three's `DecalGeometry` idea, made
 * for loading levels rather than for one click on one mesh).
 *
 * What it does that `DecalGeometry` does not:
 * - several receivers in one call, each with its own world matrix (a block
 *   chunk, an architecture chunk, a spline piece and a model all under one
 *   mark);
 * - typed arrays in and out, no object per vertex: the receivers' vertices
 *   are moved into box space once each, and a triangle wholly outside one of
 *   the box's planes is dropped by its vertices' outcodes before any
 *   clipping;
 * - faces turned past the decal's normal fade are left out (they would carry
 *   a mark of weight 0, or smear it down a wall the projector only grazes);
 * - welded and indexed output with tangents, so a decal material's normal
 *   map works on it;
 * - a per-vertex fade (the normal fade and the edge fades, the same terms as
 *   projected decals), so a clipped mark ends as softly as a projected one.
 *
 * Output space: relative to the decal entity (its local space), so the mesh
 * is drawn as the entity's child and follows it; the box is centred on the
 * entity and projects along its −Z, the image in its XY plane with +Y up
 * (`decals.ts`). Box UVs land in the given page rectangle [u0, v0, u1, v1]
 * (top-left origin, the pages' and glTF's), 0–1 when none is given.
 * Vertices are lifted off the surface along its normal by a millimetre so
 * the mark never lies exactly in the face it marks; the mesh decal's
 * view-space push does the rest when it is drawn.
 *
 * Deterministic: only + − × ÷ and `Math.sqrt` (fixed to the bit by IEEE 754)
 * and the generator's own trig (`arch-math.ts`), receivers and triangles in
 * the order given, the first of equal vertices kept. The same inputs give the
 * same bytes on the page, in a worker and on the backend, so the output can
 * be cached by a hash of its inputs and {@link DECAL_CLIP_VERSION}.
 *
 * Receivers are base poses (no skinning, no morphs): a mark that must follow
 * a skin is a mesh decal on a bone. Interleaved vertex buffers are the
 * caller's to split.
 *
 * Pure: no three.js, no I/O.
 */
import { DEG, detSinCos } from './arch-math';
import { DECAL_DEFAULTS, DECAL_LIMITS } from './decals';

/**
 * The clipper's output version. Any change to what the same inputs make
 * (clipping, welding, rounding, attributes) bumps it, so caches keyed by it
 * make their meshes again.
 */
export const DECAL_CLIP_VERSION = 1;

/**
 * Metres a clipped vertex is lifted off the surface along its normal: small
 * enough not to float visibly at any distance a decal is seen from, large
 * enough to leave the surface's own plane before depth precision decides.
 */
export const DECAL_CLIP_LIFT = 0.001;

/** One surface the decal may mark, in its own space. */
export interface DecalClipReceiver {
  /** xyz per vertex. */
  readonly positions: ArrayLike<number>;
  /** xyz per vertex (absent: flat faces, each triangle's own normal). */
  readonly normals?: ArrayLike<number> | null;
  /** Three per triangle (absent: every three vertices are a triangle). */
  readonly index?: ArrayLike<number> | null;
  /** Its world matrix, 16 numbers column-major (three's order; absent: identity). */
  readonly matrix?: ArrayLike<number> | null;
}

/** The decal: its entity's world matrix and the component's box and fades. */
export interface DecalClipProjector {
  /** The decal entity's world matrix, 16 numbers column-major. */
  readonly matrix: ArrayLike<number>;
  /** The box [width, height, depth] in the entity's units (the component's `size`). */
  readonly size: readonly number[];
  /** Degrees (the component's `normalFade`; absent: its default). */
  readonly normalFade?: number;
  /** [front, back] fractions of the box depth (the component's `edgeFade`; absent: its default). */
  readonly edgeFade?: readonly number[];
  /** Where the box's UVs land: [u0, v0, u1, v1] (absent: 0–1). */
  readonly rect?: readonly number[];
  /** Metres along the normal (absent: {@link DECAL_CLIP_LIFT}). */
  readonly lift?: number;
}

/** A clipped decal mesh in the decal entity's space. */
export interface DecalClipMesh {
  /** xyz per vertex. */
  readonly positions: Float32Array;
  /** xyz per vertex, unit length. */
  readonly normals: Float32Array;
  /** uv per vertex, inside the projector's rectangle. */
  readonly uvs: Float32Array;
  /** xyzw per vertex: along +u, w the handedness (glTF's: bitangent = w · normal × tangent, toward the image's up). */
  readonly tangents: Float32Array;
  /** 0–1 per vertex: how much of the mark is there (normal fade × edge fades). */
  readonly fades: Float32Array;
  /** Three per triangle; 16-bit while the vertices fit. */
  readonly index: Uint16Array | Uint32Array;
  /** Receiver triangles looked at, of them left out past the normal fade, and as degenerate (no area). */
  readonly stats: { readonly triangles: number; readonly faded: number; readonly degenerate: number };
}

/** Growable typed storage (the output's size is known only at the end). */
class F32 {
  a: Float32Array;
  n = 0;
  constructor(cap: number) {
    this.a = new Float32Array(cap);
  }
  reserve(k: number): void {
    if (this.n + k <= this.a.length) return;
    const b = new Float32Array(Math.max(this.a.length * 2, this.n + k));
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
}

/** The smooth ramp the projected decals' fades use (GLSL's smoothstep). */
function smoothstep(e0: number, e1: number, x: number): number {
  const t = e1 === e0 ? (x < e0 ? 0 : 1) : Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
const f32 = (a: ArrayLike<number>): Float32Array => (a instanceof Float32Array ? a : new Float32Array(a));
const sat = (x: number): number => Math.min(1, Math.max(0, x));
const finite = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Inverse of a column-major 4×4's affine part into `o`, row-major 3×4 (false: singular). */
function invertAffine(m: Float64Array, o: Float64Array): boolean {
  const a = m[0]!, b = m[4]!, c = m[8]!;
  const d = m[1]!, e = m[5]!, f = m[9]!;
  const g = m[2]!, h = m[6]!, i = m[10]!;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 0) || !Number.isFinite(det)) return false;
  const r = 1 / det;
  o[0] = A * r;
  o[1] = (c * h - b * i) * r;
  o[2] = (b * f - c * e) * r;
  o[4] = B * r;
  o[5] = (a * i - c * g) * r;
  o[6] = (c * d - a * f) * r;
  o[8] = C * r;
  o[9] = (b * g - a * h) * r;
  o[10] = (a * e - b * d) * r;
  const tx = m[12]!, ty = m[13]!, tz = m[14]!;
  o[3] = -(o[0] * tx + o[1] * ty + o[2] * tz);
  o[7] = -(o[4] * tx + o[5] * ty + o[6] * tz);
  o[11] = -(o[8] * tx + o[9] * ty + o[10] * tz);
  return true;
}

/** The determinant's sign of a column-major 4×4's linear part. */
function detSign(m: Float64Array): number {
  const det = m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
  return det < 0 ? -1 : 1;
}

const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** A clipped polygon's vertex: box position (3) and world normal (3). */
const STRIDE = 6;
/**
 * Corners a clipped polygon may have: a triangle cut by the box's six planes
 * has at most nine; the rest is room for rounding near a plane, never
 * written past.
 */
const POLY_MAX = 32;

/**
 * Clip the receivers' triangles inside the decal's box (see the module
 * comment). An empty mesh when nothing is inside.
 */
export function clipDecal(projector: DecalClipProjector, receivers: readonly DecalClipReceiver[]): DecalClipMesh {
  const c = new Clipper(projector);
  if (c.ok) for (const r of receivers) c.receiver(r);
  return c.finish();
}

/**
 * One clip's state. A class of small methods rather than one long function:
 * the engine compiles a method once it has been called often, where a long
 * loop inside one big function stays slow until on-stack replacement
 * reaches it (a worker's first decal on 50k triangles took 20 ms that way,
 * 1 ms warm).
 */
class Clipper {
  readonly ok: boolean;
  private readonly D = new Float64Array(16);
  /** World → entity space (row-major 3×4), and world → box space ([−½, ½]³). */
  private readonly Di = new Float64Array(12);
  private readonly W = new Float64Array(12);
  private readonly sx: number;
  private readonly sy: number;
  private readonly sz: number;
  private readonly signD: number;
  /** The direction the projector faces from (its box's +Z plane normal in the world), as projected decals read it. */
  private readonly zx: number;
  private readonly zy: number;
  private readonly zz: number;
  private readonly fadeCos: number;
  private readonly fullCos: number;
  /** At 180° every face may take the mark, back faces included. */
  private readonly keepAll: boolean;
  private readonly edgeFront: number;
  private readonly edgeBack: number;
  private readonly u0: number;
  private readonly v0: number;
  private readonly u1: number;
  private readonly v1: number;
  private readonly lift: number;

  private readonly stats = { triangles: 0, faded: 0, degenerate: 0 };
  private readonly pos = new F32(1024);
  private readonly nrm = new F32(1024);
  private readonly uv = new F32(1024);
  private readonly tan = new F32(1024);
  private readonly fad = new F32(512);
  private idx = new Uint32Array(1024);
  private idxN = 0;

  /** Welding: a hash of each output vertex's position and normal bits; equal ones are one vertex. */
  private readonly key = new Float32Array(6);
  private readonly keyBits = new Uint32Array(this.key.buffer);
  private slots = new Int32Array(4096).fill(-1);

  /** The polygon being clipped, the one being written, and which receiver vertex each corner is (−1: a cut point). */
  private polyA = new Float64Array(POLY_MAX * STRIDE);
  private polyB = new Float64Array(POLY_MAX * STRIDE);
  private fromA = new Int32Array(POLY_MAX);
  private fromB = new Int32Array(POLY_MAX);
  private readonly corner = new Int32Array(POLY_MAX);

  /** The receiver being clipped: its vertices in box space and their outcodes, its normals in the world. */
  private q = new Float64Array(0);
  private codes = new Uint8Array(0);
  private worldN = new Float64Array(0);
  private worldNDone = new Uint8Array(0);
  /**
   * A receiver vertex's output vertex once made (−1: not yet), while vertices carry their own normals: most
   * corners of a mark are receiver vertices shared by several triangles, made and welded once.
   */
  private made = new Int32Array(0);
  private N: Float32Array | null = null;
  private readonly Ri = new Float64Array(12);
  private signR = 1;

  constructor(projector: DecalClipProjector) {
    for (let k = 0; k < 16; k++) this.D[k] = finite(projector.matrix[k], IDENTITY[k]!);
    this.sx = Math.max(1e-9, finite(projector.size[0], 1));
    this.sy = Math.max(1e-9, finite(projector.size[1], 1));
    this.sz = Math.max(1e-9, finite(projector.size[2], 1));
    const fadeDeg = Math.min(DECAL_LIMITS.normalFadeMax, Math.max(DECAL_LIMITS.normalFadeMin, finite(projector.normalFade, DECAL_DEFAULTS.normalFade)));
    this.edgeFront = Math.max(1e-4, finite(projector.edgeFade?.[0], DECAL_DEFAULTS.edgeFade[0]));
    this.edgeBack = Math.max(1e-4, finite(projector.edgeFade?.[1], DECAL_DEFAULTS.edgeFade[1]));
    const rect = projector.rect;
    this.u0 = finite(rect?.[0], 0);
    this.v0 = finite(rect?.[1], 0);
    this.u1 = finite(rect?.[2], 1);
    this.v1 = finite(rect?.[3], 1);
    this.lift = finite(projector.lift, DECAL_CLIP_LIFT);
    const sc: [number, number] = [0, 0];
    this.fadeCos = detSinCos(fadeDeg * DEG, sc)[1];
    this.fullCos = detSinCos(fadeDeg * 0.8 * DEG, sc)[1];
    this.keepAll = fadeDeg >= DECAL_LIMITS.normalFadeMax;
    this.signD = detSign(this.D);
    this.ok = invertAffine(this.D, this.Di);
    const { Di, W } = this;
    for (let k = 0; k < 4; k++) {
      W[k] = Di[k]! / this.sx;
      W[4 + k] = Di[4 + k]! / this.sy;
      W[8 + k] = Di[8 + k]! / this.sz;
    }
    const zl = Math.sqrt(W[8]! * W[8]! + W[9]! * W[9]! + W[10]! * W[10]!);
    this.zx = W[8]! / zl;
    this.zy = W[9]! / zl;
    this.zz = W[10]! / zl;
  }

  finish(): DecalClipMesh {
    const { pos, nrm, uv, tan, fad } = this;
    const vc = pos.n / 3;
    const index = vc <= 0x10000 ? Uint16Array.from(this.idx.subarray(0, this.idxN)) : this.idx.slice(0, this.idxN);
    return { positions: pos.a.slice(0, pos.n), normals: nrm.a.slice(0, nrm.n), uvs: uv.a.slice(0, uv.n), tangents: tan.a.slice(0, tan.n), fades: fad.a.slice(0, fad.n), index, stats: this.stats };
  }

  receiver(r: DecalClipReceiver): void {
    // One array type each in the loops below: a second element kind met halfway through a big receiver drops the
    // compiled loop back to the interpreter.
    const P = f32(r.positions);
    const vc = Math.floor(P.length / 3);
    if (vc === 0) return;
    const R = new Float64Array(16);
    for (let k = 0; k < 16; k++) R[k] = r.matrix !== undefined && r.matrix !== null ? finite(r.matrix[k], IDENTITY[k]!) : IDENTITY[k]!;
    if (!invertAffine(R, this.Ri)) return;
    // Box from receiver space, W × R (row-major 3×4).
    const W = this.W;
    const M = new Float64Array(12);
    for (let row = 0; row < 3; row++) {
      const w0 = W[row * 4]!, w1 = W[row * 4 + 1]!, w2 = W[row * 4 + 2]!;
      for (let col = 0; col < 3; col++) M[row * 4 + col] = w0 * R[col * 4]! + w1 * R[col * 4 + 1]! + w2 * R[col * 4 + 2]!;
      M[row * 4 + 3] = w0 * R[12]! + w1 * R[13]! + w2 * R[14]! + W[row * 4 + 3]!;
    }
    this.signR = detSign(R);
    if (this.q.length < vc * 3) {
      this.q = new Float64Array(vc * 3);
      this.codes = new Uint8Array(vc);
    }
    toBox(P, vc, M, this.q, this.codes);
    this.N = r.normals !== undefined && r.normals !== null && r.normals.length >= vc * 3 ? f32(r.normals) : null;
    if (this.N !== null) {
      if (this.worldN.length < vc * 3) {
        this.worldN = new Float64Array(vc * 3);
        this.worldNDone = new Uint8Array(vc);
      } else this.worldNDone.fill(0, 0, vc);
      if (this.made.length < vc) this.made = new Int32Array(vc);
      this.made.fill(-1, 0, vc);
    }
    const codes = this.codes;
    if (r.index !== undefined && r.index !== null) {
      const I = r.index instanceof Uint32Array ? r.index : new Uint32Array(r.index);
      const end = I.length - (I.length % 3);
      for (let t = 0; t < end; t += 3) {
        const ia = I[t]!, ib = I[t + 1]!, ic = I[t + 2]!;
        if (ia < vc && ib < vc && ic < vc && (codes[ia]! & codes[ib]! & codes[ic]!) === 0) this.triangle(ia, ib, ic);
      }
    } else {
      for (let v = 0; v + 2 < vc; v += 3) if ((codes[v]! & codes[v + 1]! & codes[v + 2]!) === 0) this.triangle(v, v + 1, v + 2);
    }
  }

  /** One receiver triangle not wholly outside a plane of the box. */
  private triangle(ia: number, ib: number, ic: number): void {
    const { q, W, stats } = this;
    stats.triangles++;
    const ax = q[ia * 3]!, ay = q[ia * 3 + 1]!, az = q[ia * 3 + 2]!;
    const e1x = q[ib * 3]! - ax, e1y = q[ib * 3 + 1]! - ay, e1z = q[ib * 3 + 2]! - az;
    const e2x = q[ic * 3]! - ax, e2y = q[ic * 3 + 1]! - ay, e2z = q[ic * 3 + 2]! - az;
    const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
    if (cx * cx + cy * cy + cz * cz <= 1e-12 * (e1x * e1x + e1y * e1y + e1z * e1z) * (e2x * e2x + e2y * e2y + e2z * e2z)) {
      stats.degenerate++;
      return;
    }
    // The face's normal in the world: box-space cross product through Wᵀ, its sign set by the two matrices' mirroring.
    const s = this.signD * this.signR;
    let fx = s * (W[0]! * cx + W[4]! * cy + W[8]! * cz);
    let fy = s * (W[1]! * cx + W[5]! * cy + W[9]! * cz);
    let fz = s * (W[2]! * cx + W[6]! * cy + W[10]! * cz);
    const fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
    fx /= fl;
    fy /= fl;
    fz /= fl;
    if (!this.keepAll && fx * this.zx + fy * this.zy + fz * this.zz <= this.fadeCos) {
      stats.faded++;
      return;
    }
    // The triangle as a polygon, its corners' world normals the receiver's (or the face's).
    this.start(0, ia, fx, fy, fz);
    this.start(1, ib, fx, fy, fz);
    this.start(2, ic, fx, fy, fz);
    const codes = this.codes;
    const n = this.clip(codes[ia]! | codes[ib]! | codes[ic]!);
    if (n < 3) return;
    const { polyA, fromA, corner, made } = this;
    const own = this.N !== null;
    for (let k = 0; k < n; k++) {
      const o = k * STRIDE;
      const from = own ? fromA[k]! : -1;
      if (from >= 0 && made[from]! >= 0) {
        corner[k] = made[from]!;
        continue;
      }
      corner[k] = this.vertex(polyA[o]!, polyA[o + 1]!, polyA[o + 2]!, polyA[o + 3]!, polyA[o + 4]!, polyA[o + 5]!);
      if (from >= 0) made[from] = corner[k]!;
    }
    // Faces' winding turns with a mirroring matrix: keep the side the receiver's own front faces are on, in the entity's space.
    const flip = s < 0;
    for (let k = 1; k + 1 < n; k++) {
      if (flip) this.emit(corner[0]!, corner[k + 1]!, corner[k]!);
      else this.emit(corner[0]!, corner[k]!, corner[k + 1]!);
    }
  }

  /** Corner `k` of the polygon: receiver vertex `v`, its world normal its own (made once) or the face's. */
  private start(k: number, v: number, fx: number, fy: number, fz: number): void {
    const { polyA, q } = this;
    const o = k * STRIDE;
    this.fromA[k] = v;
    polyA[o] = q[v * 3]!;
    polyA[o + 1] = q[v * 3 + 1]!;
    polyA[o + 2] = q[v * 3 + 2]!;
    const N = this.N;
    if (N === null) {
      polyA[o + 3] = fx;
      polyA[o + 4] = fy;
      polyA[o + 5] = fz;
      return;
    }
    const worldN = this.worldN;
    if (this.worldNDone[v] === 0) {
      // The normal matrix: the inverse transpose of the receiver's linear part.
      const Ri = this.Ri;
      const x = N[v * 3]!, y = N[v * 3 + 1]!, z = N[v * 3 + 2]!;
      let wx = Ri[0]! * x + Ri[4]! * y + Ri[8]! * z;
      let wy = Ri[1]! * x + Ri[5]! * y + Ri[9]! * z;
      let wz = Ri[2]! * x + Ri[6]! * y + Ri[10]! * z;
      const wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
      if (wl > 0) {
        wx /= wl;
        wy /= wl;
        wz /= wl;
      } else {
        wx = fx;
        wy = fy;
        wz = fz;
      }
      worldN[v * 3] = wx;
      worldN[v * 3 + 1] = wy;
      worldN[v * 3 + 2] = wz;
      this.worldNDone[v] = 1;
    }
    polyA[o + 3] = worldN[v * 3]!;
    polyA[o + 4] = worldN[v * 3 + 1]!;
    polyA[o + 5] = worldN[v * 3 + 2]!;
  }

  /** The triangle in `polyA` clipped by each plane its corners are outside of (Sutherland–Hodgman); its corner count. */
  private clip(outside: number): number {
    let n = 3;
    for (let plane = 0; plane < 6 && n >= 3; plane++) {
      if ((outside & (1 << plane)) === 0) continue;
      const { polyA, polyB, fromA, fromB } = this;
      const axis = plane >> 1;
      const sign = (plane & 1) === 0 ? 1 : -1;
      let m = 0;
      for (let k = 0; k < n; k++) {
        const cur = k * STRIDE;
        const prev = ((k + n - 1) % n) * STRIDE;
        const dc = sign * polyA[cur + axis]! - 0.5;
        const dp = sign * polyA[prev + axis]! - 0.5;
        // A crossing is cut from its inside corner toward its outside one, so the two triangles sharing an edge
        // cut it at the very same point (their meshes weld there).
        if (dc <= 0) {
          if (dp > 0 && dc < 0 && m < POLY_MAX) {
            fromB[m] = -1;
            m = cut(polyA, cur, prev, dc, dp, polyB, m);
          }
          if (m < POLY_MAX) {
            for (let j = 0; j < STRIDE; j++) polyB[m * STRIDE + j] = polyA[cur + j]!;
            fromB[m] = fromA[k]!;
            m++;
          }
        } else if (dp < 0 && m < POLY_MAX) {
          fromB[m] = -1;
          m = cut(polyA, prev, cur, dp, dc, polyB, m);
        }
      }
      this.polyA = polyB;
      this.polyB = polyA;
      this.fromA = fromB;
      this.fromB = fromA;
      n = m;
    }
    return n;
  }

  private hashOf(): number {
    const bits = this.keyBits;
    let h = 0x811c9dc5;
    for (let k = 0; k < 6; k++) h = Math.imul(h ^ bits[k]!, 0x01000193);
    return h >>> 0;
  }

  private rehash(): void {
    const { key, pos, nrm } = this;
    const next = new Int32Array(this.slots.length * 2).fill(-1);
    const mask = next.length - 1;
    const count = pos.n / 3;
    for (let v = 0; v < count; v++) {
      for (let k = 0; k < 3; k++) {
        key[k] = pos.a[v * 3 + k]!;
        key[3 + k] = nrm.a[v * 3 + k]!;
      }
      let s = this.hashOf() & mask;
      while (next[s]! >= 0) s = (s + 1) & mask;
      next[s] = v;
    }
    this.slots = next;
  }

  /** One output vertex from a clipped corner (box position q, world normal n); its index, welded. */
  private vertex(qx: number, qy: number, qz: number, nwx: number, nwy: number, nwz: number): number {
    const { D, Di, key, pos, nrm, uv, tan, fad } = this;
    const nl = Math.sqrt(nwx * nwx + nwy * nwy + nwz * nwz);
    if (nl > 0) {
      nwx /= nl;
      nwy /= nl;
      nwz /= nl;
    }
    // Entity space: the box scaled by its size, lifted along the world normal brought into entity space.
    const lift = this.lift;
    const lx = Di[0]! * nwx + Di[1]! * nwy + Di[2]! * nwz;
    const ly = Di[4]! * nwx + Di[5]! * nwy + Di[6]! * nwz;
    const lz = Di[8]! * nwx + Di[9]! * nwy + Di[10]! * nwz;
    const px = qx * this.sx + lift * lx;
    const py = qy * this.sy + lift * ly;
    const pz = qz * this.sz + lift * lz;
    // The normal in entity space: the transpose of the entity's linear part.
    let nx = D[0]! * nwx + D[1]! * nwy + D[2]! * nwz;
    let ny = D[4]! * nwx + D[5]! * nwy + D[6]! * nwz;
    let nz = D[8]! * nwx + D[9]! * nwy + D[10]! * nwz;
    const ll = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (ll > 0) {
      nx /= ll;
      ny /= ll;
      nz /= ll;
    }
    // −0 and +0 are one vertex: the bits must agree.
    key[0] = px + 0;
    key[1] = py + 0;
    key[2] = pz + 0;
    key[3] = nx + 0;
    key[4] = ny + 0;
    key[5] = nz + 0;
    const slots = this.slots;
    const mask = slots.length - 1;
    let s = this.hashOf() & mask;
    for (;;) {
      const v = slots[s]!;
      if (v < 0) break;
      const o = v * 3;
      if (pos.a[o] === key[0] && pos.a[o + 1] === key[1] && pos.a[o + 2] === key[2] && nrm.a[o] === key[3] && nrm.a[o + 1] === key[4] && nrm.a[o + 2] === key[5]) return v;
      s = (s + 1) & mask;
    }
    const v = pos.n / 3;
    slots[s] = v;
    pos.reserve(3);
    nrm.reserve(3);
    uv.reserve(2);
    tan.reserve(4);
    fad.reserve(1);
    for (let k = 0; k < 3; k++) {
      pos.a[pos.n++] = key[k]!;
      nrm.a[nrm.n++] = key[3 + k]!;
    }
    // Image +Y up, rectangles from the top-left (as projected decals sample their pages).
    uv.a[uv.n++] = this.u0 + (qx + 0.5) * (this.u1 - this.u0);
    uv.a[uv.n++] = this.v0 + (0.5 - qy) * (this.v1 - this.v0);
    // Tangent: the box's +X (the image's +u) along the surface; where the surface faces ±X, any direction in it.
    let tx = 1 - nx * nx, ty = -nx * ny, tz = -nx * nz;
    let tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tl < 1e-6) {
      tx = -ny * nx;
      ty = 1 - ny * ny;
      tz = -ny * nz;
      tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
    }
    tx /= tl;
    ty /= tl;
    tz /= tl;
    // Handedness: the bitangent toward the image's up (+Y), wherever the face looks.
    const by = nz * tx - nx * tz;
    tan.a[tan.n++] = tx;
    tan.a[tan.n++] = ty;
    tan.a[tan.n++] = tz;
    tan.a[tan.n++] = by < 0 ? -1 : 1;
    // The projected decals' fades: facing the projector, and the box's ends (0 at its front, +Z, 1 at its back).
    const facing = this.keepAll ? 1 : smoothstep(this.fadeCos, this.fullCos, nwx * this.zx + nwy * this.zy + nwz * this.zz);
    const depth = 0.5 - qz;
    fad.a[fad.n++] = facing * sat(depth / this.edgeFront) * sat((1 - depth) / this.edgeBack);
    if (v * 2 >= slots.length) this.rehash();
    return v;
  }

  private emit(a: number, b: number, c: number): void {
    if (a === b || b === c || a === c) return;
    // Slivers the clip leaves along a plane cover nothing; left out.
    const p = this.pos.a;
    const pa = a * 3, pb = b * 3, pc = c * 3;
    const ex = p[pb]! - p[pa]!, ey = p[pb + 1]! - p[pa + 1]!, ez = p[pb + 2]! - p[pa + 2]!;
    const fx = p[pc]! - p[pa]!, fy = p[pc + 1]! - p[pa + 1]!, fz = p[pc + 2]! - p[pa + 2]!;
    const cx = ey * fz - ez * fy, cy = ez * fx - ex * fz, cz = ex * fy - ey * fx;
    if (cx * cx + cy * cy + cz * cz <= 1e-12 * (ex * ex + ey * ey + ez * ez) * (fx * fx + fy * fy + fz * fz)) return;
    if (this.idxN + 3 > this.idx.length) {
      const next = new Uint32Array(this.idx.length * 2);
      next.set(this.idx);
      this.idx = next;
    }
    this.idx[this.idxN++] = a;
    this.idx[this.idxN++] = b;
    this.idx[this.idxN++] = c;
  }
}

/** A receiver's vertices in box space (`M`, row-major 3×4) and their outcodes (bit per box plane they are outside of). */
function toBox(P: Float32Array, vc: number, M: Float64Array, q: Float64Array, codes: Uint8Array): void {
  for (let v = 0; v < vc; v++) {
    const x = P[v * 3]!, y = P[v * 3 + 1]!, z = P[v * 3 + 2]!;
    const bx = M[0]! * x + M[1]! * y + M[2]! * z + M[3]!;
    const by = M[4]! * x + M[5]! * y + M[6]! * z + M[7]!;
    const bz = M[8]! * x + M[9]! * y + M[10]! * z + M[11]!;
    q[v * 3] = bx;
    q[v * 3 + 1] = by;
    q[v * 3 + 2] = bz;
    codes[v] = (bx > 0.5 ? 1 : 0) | (bx < -0.5 ? 2 : 0) | (by > 0.5 ? 4 : 0) | (by < -0.5 ? 8 : 0) | (bz > 0.5 ? 16 : 0) | (bz < -0.5 ? 32 : 0);
  }
}

/** The point where the edge from an inside corner to an outside one crosses the plane, appended to `out`. */
function cut(poly: Float64Array, inside: number, outside: number, dIn: number, dOut: number, out: Float64Array, m: number): number {
  const s = dIn / (dIn - dOut);
  const o = m * STRIDE;
  for (let j = 0; j < STRIDE; j++) out[o + j] = poly[inside + j]! + s * (poly[outside + j]! - poly[inside + j]!);
  return m + 1;
}
