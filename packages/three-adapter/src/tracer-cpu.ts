/**
 * The tracer on the CPU: the same walk as the GPU pass (`tracer-wgsl.ts`)
 * over the same packed words (`tracer-scene.ts`), step for step and with
 * the same step budgets. It is the reference the GPU pass is checked
 * against, and what a caller without a device (a worker, a test) traces
 * with.
 */
import { LIGHT_LAYERS_ALL } from '@thirdlight/runtime';
import {
  CHUNK_BLOCK_WORDS,
  CHUNK_WORDS,
  HEADER,
  HIT_WORDS,
  LAYER_WORDS,
  TERRAIN_WORDS,
  TRACE_BLOCKS,
  TRACE_CHUNK,
  TRACE_MISS,
  TRACE_STEPS,
  TRACE_SUB,
  TRACE_TERRAIN,
  TRACE_UNFINISHED,
  type PackedTraceScene,
} from './tracer-scene';
import { traceArchCpu, traceBricksCpu } from './tracer-cpu-objects';
import { EXACT_TRACE, mapRay, newHit, packUnorm2, rayTriangle, safeDir, sceneView, worldNormal, type SceneView, type TraceHit, type TraceOptions, type TraceState, type V3 } from './tracer-cpu-math';

export { EXACT_TRACE, rayTriangle, sceneView, unpackUnorm2, packUnorm2, type SceneView, type TraceHit, type TraceOptions, type V3 } from './tracer-cpu-math';

type Axis = 0 | 1 | 2;

/** The (u, v) axes of a face plane by its axis. */
const PLANE_AXES: readonly (readonly [Axis, Axis])[] = [[2, 1], [0, 2], [0, 1]];

function argmin3(v: V3): Axis {
  return v[0] < v[1] && v[0] < v[2] ? 0 : v[1] < v[2] ? 1 : 2;
}

/**
 * One block layer: one DDA loop inside the occupied cells' box whose step is
 * the largest empty node the ray is in: a whole empty chunk, a whole empty
 * 4³ sub-block of an occupied chunk, else one cell. A single loop keeps
 * neighbouring GPU threads on the same path whatever node size each is at.
 */
function traceLayer(s: SceneView, layer: number, at: number, ro: readonly number[], rd: readonly number[], tmin: number, st: TraceState): void {
  if ((s.u[at + 26]! & st.mask) === 0) return;
  const { u, f } = s;
  const { o, d: dRaw } = mapRay(f, at, ro, rd);
  const d = safeDir(dRaw);
  const D: V3 = [u[at + 12]!, u[at + 13]!, u[at + 14]!];
  const CD: V3 = [u[at + 15]!, u[at + 16]!, u[at + 17]!];
  const table = u[at + 18]!;
  const bits = u[at + 19]!;
  const lo: V3 = [u[at + 20]!, u[at + 21]!, u[at + 22]!];
  const hi: V3 = [u[at + 23]!, u[at + 24]!, u[at + 25]!];
  const inv: V3 = [1 / d[0], 1 / d[1], 1 / d[2]];
  let tEnter = tmin;
  let tExit = Math.min(st.hit.t, st.unfinished);
  let axis: Axis | -1 = -1;
  for (const k of [0, 1, 2] as const) {
    const a = (lo[k] - o[k]) * inv[k];
    const b = (hi[k] - o[k]) * inv[k];
    const near = Math.min(a, b);
    if (near > tEnter) {
      tEnter = near;
      axis = k;
    }
    tExit = Math.min(tExit, Math.max(a, b));
  }
  if (!(tEnter < tExit)) return;
  const step: V3 = [Math.sign(d[0]), Math.sign(d[1]), Math.sign(d[2])];
  const up: V3 = [d[0] > 0 ? 1 : 0, d[1] > 0 ? 1 : 0, d[2] > 0 ? 1 : 0];
  const cell: V3 = [0, 1, 2].map((k) => Math.min(hi[k]! - 1, Math.max(lo[k]!, Math.floor(o[k]! + d[k]! * tEnter)))) as V3;
  const side: V3 = [0, 1, 2].map((k) => (cell[k]! + up[k]! - o[k]!) * inv[k]!) as V3;
  const delta: V3 = [Math.abs(inv[0]), Math.abs(inv[1]), Math.abs(inv[2])];
  const subs = TRACE_CHUNK / TRACE_SUB;
  let t = tEnter;
  for (let steps = 0; ; steps += 1) {
    if (steps >= TRACE_STEPS.blocks) {
      st.unfinished = Math.min(st.unfinished, t);
      return;
    }
    const cx = Math.floor(cell[0] / TRACE_CHUNK);
    const cy = Math.floor(cell[1] / TRACE_CHUNK);
    const cz = Math.floor(cell[2] / TRACE_CHUNK);
    const block = u[table + (cy * CD[2] + cz) * CD[0] + cx]!;
    let size = TRACE_CHUNK;
    if (block !== 0) {
      const base = bits + (block - 1) * CHUNK_BLOCK_WORDS;
      const l: V3 = [cell[0] - cx * TRACE_CHUNK, cell[1] - cy * TRACE_CHUNK, cell[2] - cz * TRACE_CHUNK];
      const sbit = (Math.floor(l[1] / TRACE_SUB) * subs + Math.floor(l[2] / TRACE_SUB)) * subs + Math.floor(l[0] / TRACE_SUB);
      size = TRACE_SUB;
      if (((u[base + CHUNK_WORDS + (sbit >> 5)]! >>> (sbit & 31)) & 1) !== 0) {
        const bit = (l[1] * TRACE_CHUNK + l[2]) * TRACE_CHUNK + l[0];
        if (((u[base + (bit >> 5)]! >>> (bit & 31)) & 1) !== 0) {
          blockHit(s, layer, at, o, d, t, axis, cell, D, st);
          return;
        }
        size = 1;
      }
    }
    let a: Axis;
    if (size === 1) {
      a = argmin3(side);
      t = side[a];
      side[a] += delta[a];
      cell[a] += step[a];
    } else {
      // Leave the empty node whole: its exit face, then the cell just past it (the other axes clamped into the node and the box).
      const n0: V3 = [0, 1, 2].map((k) => Math.floor(cell[k]! / size) * size) as V3;
      const exitT: V3 = [0, 1, 2].map((k) => (n0[k]! + up[k]! * size - o[k]!) * inv[k]!) as V3;
      a = argmin3(exitT);
      t = Math.max(t, exitT[a]);
      for (const k of [0, 1, 2] as const) {
        cell[k] = k === a ? (step[k] > 0 ? n0[k] + size : n0[k] - 1) : Math.min(Math.min(n0[k] + size, hi[k]) - 1, Math.max(Math.max(n0[k], lo[k]), Math.floor(o[k] + d[k] * t)));
        side[k] = (cell[k] + up[k] - o[k]) * inv[k];
      }
    }
    axis = a;
    if (t >= tExit || cell[a] < lo[a] || cell[a] >= hi[a]) return;
  }
}

function blockHit(s: SceneView, layer: number, at: number, o: V3, d: V3, t: number, axisIn: Axis | -1, cell: V3, D: V3, st: TraceState): void {
  // Started inside an opaque cell: it faces the ray's major axis.
  const axis: Axis = axisIn !== -1 ? axisIn : argmin3([-Math.abs(d[0]), -Math.abs(d[1]), -Math.abs(d[2])]);
  const sgn = d[axis] > 0 ? -1 : 1;
  const n: V3 = [0, 0, 0];
  n[axis] = sgn;
  const [pu, pv] = PLANE_AXES[axis]!;
  const fu = o[pu] + d[pu] * t - cell[pu];
  const fv = o[pv] + d[pv] * t - cell[pv];
  st.hit = {
    kind: TRACE_BLOCKS,
    t,
    normal: worldNormal(s.f, at, n),
    face: axis * 2 + (sgn > 0 ? 0 : 1),
    object: layer,
    a0: ((cell[1] * D[2] + cell[2]) * D[0] + cell[0]) >>> 0,
    a1: packUnorm2(fu, fv),
  };
}

/** One terrain: down and up its min/max pyramid, two triangles per cell at the bottom. */
function traceTerrain(s: SceneView, index: number, at: number, ro: readonly number[], rd: readonly number[], tmin: number, st: TraceState): void {
  if ((s.u[at + 19]! & st.mask) === 0) return;
  const { u, f } = s;
  const { o, d: dRaw } = mapRay(f, at, ro, rd);
  const d = safeDir(dRaw);
  const NX = u[at + 12]!;
  const NZ = u[at + 13]!;
  const L = u[at + 14]!;
  const H = u[at + 15]!;
  const P = u[at + 16]!;
  const levelOffset = (l: number): number => u[P + l * 3]!;
  const levelDims = (l: number): [number, number] => [u[P + l * 3 + 1]!, u[P + l * 3 + 2]!];
  const top = L - 1;
  const rootLo = f[levelOffset(top)]!;
  const rootHi = f[levelOffset(top) + 1]!;
  if (rootLo > rootHi) return;
  const inv: V3 = [1 / d[0], 1 / d[1], 1 / d[2]];
  let t = tmin;
  let tEnd = Math.min(st.hit.t, st.unfinished);
  const box: [number, number][] = [[0, NX], [rootLo, rootHi], [0, NZ]];
  for (let k = 0; k < 3; k += 1) {
    const a = (box[k]![0] - o[k]!) * inv[k]!;
    const b = (box[k]![1] - o[k]!) * inv[k]!;
    t = Math.max(t, Math.min(a, b));
    tEnd = Math.min(tEnd, Math.max(a, b));
  }
  if (!(t < tEnd)) return;
  const sx = d[0] > 0 ? 1 : -1;
  const sz = d[2] > 0 ? 1 : -1;
  let level = top;
  let cx = 0;
  let cz = 0;
  // The node under the entry point at the top level is the root (one node).
  for (let steps = 0; ; steps += 1) {
    if (steps >= TRACE_STEPS.terrain) {
      st.unfinished = Math.min(st.unfinished, t);
      return;
    }
    const cs = 2 ** level;
    const nbx = (cx + (sx > 0 ? 1 : 0)) * cs;
    const nbz = (cz + (sz > 0 ? 1 : 0)) * cs;
    const tx = (nbx - o[0]) * inv[0];
    const tz = (nbz - o[2]) * inv[2];
    const tExit = Math.min(tx, tz, tEnd);
    const [lx] = levelDims(level);
    const node = levelOffset(level) + (cz * lx + cx) * 2;
    const lo = f[node]!;
    const hi = f[node + 1]!;
    const y0 = o[1] + d[1] * t;
    const y1 = o[1] + d[1] * tExit;
    if (Math.max(y0, y1) < lo || Math.min(y0, y1) > hi) {
      // Nothing in this node: on to the next one along the ray, one level up (its parent covers it).
      if (tExit >= tEnd) return;
      // Up only after real progress: a node the ray merely touches (its exit at the entry) is stepped past on its own level.
      const moved = tExit > t;
      t = tExit;
      if (tx < tz) cx += sx;
      else cz += sz;
      const [dx, dz] = levelDims(level);
      if (cx < 0 || cz < 0 || cx >= dx || cz >= dz) return;
      if (level < top && moved) {
        level += 1;
        cx = Math.floor(cx / 2);
        cz = Math.floor(cz / 2);
      }
      continue;
    }
    if (level === 0) {
      const sxN = NX + 1;
      const i = H + cz * sxN + cx;
      const a: V3 = [cx, f[i]!, cz];
      const b: V3 = [cx + 1, f[i + 1]!, cz];
      const c: V3 = [cx, f[i + sxN]!, cz + 1];
      const e: V3 = [cx + 1, f[i + sxN + 1]!, cz + 1];
      const slack = 1e-5 * (1 + Math.abs(tExit));
      const t1 = rayTriangle(o, d, a, b, c, t - slack, tExit + slack);
      const t2 = rayTriangle(o, d, e, c, b, t - slack, tExit + slack);
      const th = Math.min(t1, t2);
      if (th < Infinity && th >= tmin) {
        const [p, q, r] = th === t1 ? [a, b, c] : [e, c, b];
        const e1 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
        const e2 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
        let n: V3 = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
        if (n[1] < 0) n = [-n[0], -n[1], -n[2]];
        const fx = o[0] + d[0] * th - cx;
        const fz = o[2] + d[2] * th - cz;
        st.hit = { kind: TRACE_TERRAIN, t: th, normal: worldNormal(f, at, n), face: 0, object: index, a0: (cz * NX + cx) >>> 0, a1: packUnorm2(fx, fz) };
        return;
      }
      if (tExit >= tEnd) return;
      t = tExit;
      if (tx < tz) cx += sx;
      else cz += sz;
      if (cx < 0 || cz < 0 || cx >= NX || cz >= NZ) return;
      continue;
    }
    // Into the child under the ray's current point.
    level -= 1;
    const ccs = 2 ** level;
    const [dx, dz] = levelDims(level);
    const px = o[0] + d[0] * t;
    const pz = o[2] + d[2] * t;
    cx = Math.min(Math.min(cx * 2 + 1, dx - 1), Math.max(cx * 2, Math.floor(px / ccs)));
    cz = Math.min(Math.min(cz * 2 + 1, dz - 1), Math.max(cz * 2, Math.floor(pz / ccs)));
  }
}

/** Trace one ray through every kind in the scene: the nearest hit, or where to resume (with `anyHit`, the first kind's hit). */
export function traceRayCpu(s: SceneView, o: readonly number[], d: readonly number[], tmin: number, tmax: number, opts: TraceOptions = EXACT_TRACE): TraceHit {
  const st: TraceState = { hit: { ...newHit(), t: tmax }, unfinished: Infinity, brickSteps: 0, cone: opts.cone, mask: opts.casterMask ?? LIGHT_LAYERS_ALL };
  const { u } = s;
  const done = (): boolean => opts.anyHit && st.hit.kind !== TRACE_MISS;
  for (let i = 0; i < u[HEADER.blocks]! && !done(); i += 1) traceLayer(s, i, u[HEADER.blocks + 1]! + i * LAYER_WORDS, o, d, tmin, st);
  if (!done()) traceArchCpu(s, o, d, tmin, st);
  for (let i = 0; i < u[HEADER.terrain]! && !done(); i += 1) traceTerrain(s, i, u[HEADER.terrain + 1]! + i * TERRAIN_WORDS, o, d, tmin, st);
  if (!done()) traceBricksCpu(s, o, d, tmin, st);
  if (st.unfinished < st.hit.t) return { ...newHit(), kind: TRACE_UNFINISHED, t: st.unfinished };
  if (st.hit.kind === TRACE_MISS) return { ...newHit(), t: tmax };
  return st.hit;
}

/** Trace a batch (`RAY_FLOATS` per ray) into hit words (`HIT_WORDS` per ray), as the GPU pass writes them. */
export function traceRaysCpu(scene: PackedTraceScene, rays: Float32Array, opts: TraceOptions = EXACT_TRACE): Uint32Array {
  const s = sceneView(scene);
  const n = Math.floor(rays.length / 8);
  const out = new Uint32Array(n * HIT_WORDS);
  const of = new Float32Array(out.buffer);
  for (let i = 0; i < n; i += 1) {
    const r = i * 8;
    const h = traceRayCpu(s, [rays[r]!, rays[r + 1]!, rays[r + 2]!], [rays[r + 4]!, rays[r + 5]!, rays[r + 6]!], rays[r + 3]!, rays[r + 7]!, opts);
    const w = i * HIT_WORDS;
    of[w] = h.t;
    of[w + 1] = h.normal[0];
    of[w + 2] = h.normal[1];
    of[w + 3] = h.normal[2];
    out[w + 4] = (h.kind | (h.face << 8)) >>> 0;
    out[w + 5] = h.object >>> 0;
    out[w + 6] = h.a0 >>> 0;
    out[w + 7] = h.a1 >>> 0;
  }
  return out;
}
