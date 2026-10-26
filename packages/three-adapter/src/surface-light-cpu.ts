/**
 * The light pass's CPU twin (`surface-light-wgsl.ts` line for line, the same
 * random sequence per ray): a frame's texels lit on the CPU through the CPU
 * tracer. The checks hold its light maths to references, and a caller
 * without a device (a bake in a worker) lights with it.
 *
 * Pure (no three.js, no device).
 */
import { AREA_CONE, AREA_LINE, LIGHT_SHADOWS, LIGHT_WORDS, POINT_LIGHT_RADIUS, RAY_BIAS, SLICE_WORDS, SUN_DISC_RADIANS, SUN_WORDS, packLightFrame, type LightPassFrame } from './surface-light-frame';
import { sceneView, traceRayCpu, type TraceOptions } from './tracer-cpu';
import { TRACE_MISS, TRACE_UNFINISHED, type PackedTraceScene } from './tracer-scene';

type V3 = [number, number, number];

function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

/** The per-ray random sequence the shaders draw (`raySeed`, `rnd`). */
class Rng {
  private s: number;
  constructor(ray: number, seed: number) {
    this.s = pcg((ray ^ Math.imul(seed, 0x9e3779b9)) >>> 0);
  }
  next(): number {
    this.s = pcg(this.s);
    return Math.fround(this.s) / 4294967296;
  }
}

const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];

function windowOf(d2: number, reach: number): number {
  const w = Math.min(1, Math.max(0, 1 - (d2 / (reach * reach)) ** 2));
  return w * w;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Each texel's irradiance (rgb, `frame.slices` in order) as the pass gives
 * it with this `seed`, its shadow rays traced through `scene` with `opts`.
 */
export function lightFrameCpu(frame: LightPassFrame, scene: PackedTraceScene, seed: number, opts: TraceOptions): Float32Array {
  const { words } = packLightFrame(frame);
  const F = words;
  const f = new Float32Array(words.buffer);
  const fv = (i: number): V3 => [f[i]!, f[i + 1]!, f[i + 2]!];
  const view = sceneView(scene);
  const { sunAt } = packLightFrame(frame);
  const lightAt = (j: number): number => sunAt + SUN_WORDS + j * LIGHT_WORDS;
  const raysOf = (at: number, level: number): number => Math.max(1, (F[at + 19]! & 255) >> level);
  const lightPoint = (at: number, k: number, n: number, rng: Rng): V3 => {
    const c = fv(at);
    if (f[at + 7] === AREA_CONE) {
      const sx = 1 << ((31 - Math.clz32(Math.max(n, 1)) + 1) >> 1);
      const sy = Math.ceil(n / sx);
      const a = ((k % sx) / sx + rng.next() / sx) * 2 - 1;
      const b = (Math.floor(k / sx) / sy + rng.next() / sy) * 2 - 1;
      const u = fv(at + 12);
      const v = fv(at + 16);
      return [c[0] + u[0] * a + v[0] * b, c[1] + u[1] * a + v[1] * b, c[2] + u[2] * a + v[2] * b];
    }
    const u: V3 = [rng.next() * 2 - 1, rng.next() * 2 - 1, rng.next() * 2 - 1];
    const d = norm([u[0] + 1e-6, u[1] + 1e-6, u[2] + 1e-6]);
    const r = POINT_LIGHT_RADIUS * rng.next() ** 0.3333;
    return [c[0] + d[0] * r, c[1] + d[1] * r, c[2] + d[2] * r];
  };
  const visible = (o: V3, d: V3, tmax: number, mask: number): number => {
    if (!(tmax > 0)) return 1;
    const h = traceRayCpu(view, o, d, 0, tmax, { ...opts, casterMask: mask });
    return h.kind === TRACE_MISS || h.kind === TRACE_UNFINISHED ? 1 : 0;
  };
  const out = new Float32Array(frame.slices.reduce((n, s) => n + s.texels, 0) * 3);
  let t = 0;
  frame.slices.forEach((_, si) => {
    const s = si * SLICE_WORDS;
    const rpt = F[s + 3]!;
    const sunRays = F[s + 6]!;
    const level = F[s + 7]!;
    for (let i = 0; i < F[s + 1]!; i += 1, t += 1) {
      const P = frame.points;
      const p: V3 = [P[t * 6]!, P[t * 6 + 1]!, P[t * 6 + 2]!];
      const n: V3 = [P[t * 6 + 3]!, P[t * 6 + 4]!, P[t * 6 + 5]!];
      if (dot(n, n) === 0) continue;
      const o: V3 = [p[0] + n[0] * RAY_BIAS, p[1] + n[1] * RAY_BIAS, p[2] + n[2] * RAY_BIAS];
      const r0 = F[s + 2]! + i * rpt;
      const e: V3 = [0, 0, 0];
      const add = (c: V3, k: number): void => {
        for (let q = 0; q < 3; q += 1) e[q]! += c[q]! * k;
      };
      let k = 0;
      if (sunRays !== 0) {
        const sd = fv(sunAt);
        let v = 0;
        for (; k < sunRays; k += 1) {
          const rng = new Rng(r0 + k, seed);
          const a = ((k + rng.next()) / sunRays) * 6.2831853;
          const q = SUN_DISC_RADIANS * Math.sqrt(rng.next());
          const ax = Math.abs(sd[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
          const tt = norm(cross(sd, ax));
          const bb = cross(sd, tt);
          const d = norm([0, 1, 2].map((j) => sd[j]! + (tt[j]! * Math.cos(a) + bb[j]! * Math.sin(a)) * q) as V3);
          v += dot(d, n) > 0 && F[sunAt + 7] !== 0 ? visible(o, d, 1e4, F[sunAt + 3]!) : 1;
        }
        add(fv(sunAt + 4), (Math.max(0, dot(n, sd)) * v) / sunRays);
      }
      for (let jj = 0; jj < F[s + 5]!; jj += 1) {
        const at = lightAt(F[F[s + 4]! + jj]!);
        const rj = raysOf(at, level);
        const reach = f[at + 3]!;
        const area = f[at + 7] === AREA_CONE;
        const shadows = (F[at + 19]! & LIGHT_SHADOWS) !== 0;
        // The rays' visibility, as the rays pass makes them.
        const vis: number[] = [];
        const pts: V3[] = [];
        for (let q = 0; q < rj; q += 1) {
          const lp = lightPoint(at, q, rj, new Rng(r0 + k + q, seed));
          pts.push(lp);
          const lv: V3 = [lp[0] - o[0], lp[1] - o[1], lp[2] - o[2]];
          const len = Math.hypot(lv[0], lv[1], lv[2]);
          const d: V3 = [lv[0] / Math.max(len, 1e-6), lv[1] / Math.max(len, 1e-6), lv[2] / Math.max(len, 1e-6)];
          const margin = area ? RAY_BIAS : POINT_LIGHT_RADIUS;
          vis.push(dot(d, n) > 0 && len < reach && shadows ? visible(o, d, Math.max(0, len - margin), (F[at + 19]! >>> 16) & 0xff) : 1);
        }
        if (area) {
          const facing = fv(at + 8);
          const two = f[at + 11]! > 0.5;
          const line = F[at + 15] === AREA_LINE;
          let sum = 0;
          for (let q = 0; q < rj; q += 1) {
            const lp = pts[q]!;
            const lv: V3 = [lp[0] - p[0], lp[1] - p[1], lp[2] - p[2]];
            const d2 = Math.max(dot(lv, lv), 1e-4);
            const l: V3 = [lv[0] / Math.sqrt(d2), lv[1] / Math.sqrt(d2), lv[2] / Math.sqrt(d2)];
            const ce = -dot(facing, l);
            let emit = two ? Math.abs(ce) : Math.max(ce, 0);
            if (line) emit = two ? 1 : ce > 0 ? 1 : 0;
            sum += ((Math.max(0, dot(n, l)) * emit * windowOf(d2, reach)) / d2) * vis[q]!;
          }
          add(fv(at + 4), sum / rj);
        } else {
          const v = vis.reduce((a, b) => a + b, 0);
          const lp = fv(at);
          const lv: V3 = [lp[0] - p[0], lp[1] - p[1], lp[2] - p[2]];
          const d2 = Math.max(dot(lv, lv), 1e-4);
          const l: V3 = [lv[0] / Math.sqrt(d2), lv[1] / Math.sqrt(d2), lv[2] / Math.sqrt(d2)];
          const cone = f[at + 7]! > -2 ? smoothstep(f[at + 7]!, f[at + 11]!, -dot(l, fv(at + 8))) : 1;
          add(fv(at + 4), ((Math.max(0, dot(n, l)) * windowOf(d2, reach)) / d2) * cone * (v / rj));
        }
        k += rj;
      }
      out.set(e, t * 3);
    }
  });
  return out;
}
