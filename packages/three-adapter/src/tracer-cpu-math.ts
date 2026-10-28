/**
 * The CPU twin's shared pieces: the hit it answers, the scene's two word
 * views, affine maps of rays and normals, and the ray / triangle test.
 */
import { TRACE_MISS, type PackedTraceScene } from './tracer-scene';
import type { BrickAtlas } from './tracer-objects';

/** One traced ray's answer. */
export interface TraceHit {
  /** `TRACE_MISS`, a geometry kind, or `TRACE_UNFINISHED` (then `t` is where to resume). */
  kind: number;
  t: number;
  normal: [number, number, number];
  /** The kind's face: a block or box face (axis × 2 + 1 when it faces −axis), else 0. */
  face: number;
  /** The layer, terrain, box or instance hit, by packing order. */
  object: number;
  /** The kind's address words (see `HIT_WORDS`). */
  a0: number;
  a1: number;
}

/** The scene's words as both views. */
export interface SceneView {
  u: Uint32Array;
  f: Float32Array;
  atlas: BrickAtlas;
}

export function sceneView(scene: PackedTraceScene): SceneView {
  return { u: scene.words, f: new Float32Array(scene.words.buffer, scene.words.byteOffset, scene.words.length), atlas: scene.brickAtlas };
}

/** The best answer so far while a ray is traced through every kind. */
export interface TraceState {
  hit: TraceHit;
  /** The nearest distance at which a kind ran out of steps (Infinity: none did). */
  unfinished: number;
  /** Brick steps the ray has taken in this pass, over every model it met (their budget is shared). */
  brickSteps: number;
  /** `TraceOptions.cone`. */
  cone: number;
  /** `TraceOptions.casterMask`. */
  mask: number;
}

/**
 * How a batch is traced. Shadow rays ask less than the nearest exact hit:
 * - `anyHit`: stop at the first kind that hits (the light is blocked either way);
 * - `cone` (radians): a model's distance field counts as hit once the ray
 *   passes within `cone × distance` of it, as a cone toward a light of that
 *   angular size would be touched. Grazing rays then stop early instead of
 *   creeping along a surface.
 */
export interface TraceOptions {
  readonly anyHit: boolean;
  readonly cone: number;
  /**
   * The light layers whose objects stop the ray (a light's shadow caster
   * mask; absent: every layer). On the GPU each ray carries its own.
   */
  readonly casterMask?: number;
  /** How often a ray that ran out of steps is traced on from where it stopped (absent: `TRACE_RESUMES`; at most 255). */
  readonly resumes?: number;
}

/** The nearest hit, exactly (bounce and reflection rays). */
export const EXACT_TRACE: TraceOptions = { anyHit: false, cone: 0 };

export type V3 = [number, number, number];

/** Round to f32, as the GPU computes. */
export const f32 = Math.fround;

/** A direction with no zero component (1 / d stays finite, as in the GPU pass). */
export function safeDir(d: V3): V3 {
  return d.map((v) => (Math.abs(v) < 1e-7 ? (v >= 0 ? 1e-7 : -1e-7) : v)) as V3;
}

/** A point and a direction through a packed world → local map at word `at`. */
export function mapRay(f: Float32Array, at: number, o: readonly number[], d: readonly number[]): { o: V3; d: V3 } {
  const lo: V3 = [0, 0, 0];
  const ld: V3 = [0, 0, 0];
  for (let r = 0; r < 3; r += 1) {
    const m = at + r * 4;
    lo[r] = f[m]! * o[0]! + f[m + 1]! * o[1]! + f[m + 2]! * o[2]! + f[m + 3]!;
    ld[r] = f[m]! * d[0]! + f[m + 1]! * d[1]! + f[m + 2]! * d[2]!;
  }
  return { o: lo, d: ld };
}

/** A local normal back to world through the packed map's transpose, unit length. */
export function worldNormal(f: Float32Array, at: number, n: readonly number[]): V3 {
  const w: V3 = [0, 0, 0];
  for (let c = 0; c < 3; c += 1) w[c] = f[at + c]! * n[0]! + f[at + 4 + c]! * n[1]! + f[at + 8 + c]! * n[2]!;
  const l = Math.hypot(w[0], w[1], w[2]) || 1;
  return [w[0] / l, w[1] / l, w[2] / l];
}

/** Two numbers in [0, 1] as one word (unorm16 × 2, x low). */
export function packUnorm2(x: number, y: number): number {
  const q = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 65535);
  return (q(x) | (q(y) << 16)) >>> 0;
}

export function unpackUnorm2(w: number): [number, number] {
  return [(w & 0xffff) / 65535, (w >>> 16) / 65535];
}


export function newHit(): TraceHit {
  return { kind: TRACE_MISS, t: Infinity, normal: [0, 0, 0], face: 0, object: 0, a0: 0, a1: 0 };
}

/**
 * Where a ray meets a triangle (two-sided), as a distance in [lo, hi], or
 * Infinity (Möller–Trumbore).
 */
export function rayTriangle(o: V3, d: V3, a: V3, b: V3, c: V3, lo: number, hi: number): number {
  const e1: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p: V3 = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-12) return Infinity;
  const r = 1 / det;
  const s: V3 = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const uu = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * r;
  if (uu < -1e-6 || uu > 1 + 1e-6) return Infinity;
  const q: V3 = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const vv = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * r;
  if (vv < -1e-6 || uu + vv > 1 + 1e-6) return Infinity;
  const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * r;
  return t >= lo && t <= hi ? t : Infinity;
}

