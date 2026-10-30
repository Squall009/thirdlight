/**
 * The CPU twin's object sections (`tracer-objects.ts`): a DDA over a
 * uniform grid whose cells list architecture pieces or model instances,
 * each listed item tested on its own; a model instance by sphere tracing
 * its distance-field bricks. The GPU pass (`tracer-wgsl-objects.ts`) walks
 * the same way.
 */
import { DISTANCE_BRICK_CELLS, DISTANCE_BRICK_INSIDE, DISTANCE_BRICK_OUTSIDE } from '@thirdlight/project-model';

import { mapRay, packUnorm2, rayTriangle, safeDir, worldNormal, type SceneView, type TraceState, type V3 } from './tracer-cpu-math';
import { ARCH_BOX, brickAtlasOrigin, type BrickAtlas } from './tracer-objects';
import { HEADER, TRACE_ARCH, TRACE_BRICKS, TRACE_STEPS } from './tracer-scene';

/** Sphere tracing stops this close to the surface (voxels). */
export const BRICK_HIT_VOXELS = 0.05;
/** Slack (relative to the distance) on whether a ray enters an instance's box in this grid cell: a tie is tested twice, never skipped. */
export const ENTRY_EPS = 1e-4;
/** The shortest sphere-tracing step (voxels): thinner features than this may be stepped over. */
export const BRICK_MIN_STEP_VOXELS = 0.25;

/** Test one item over [tmin, …) from the grid cell spanning [tlo, tcell] along the ray. */
type ItemTest = (s: SceneView, item: number, at: number, o: readonly number[], d: readonly number[], tmin: number, st: TraceState, tlo: number, tcell: number) => void;

/** Walk a section's grid (record at `g`) and test the items each cell lists, nearest cells first. */
function walkGrid(s: SceneView, g: number, o: readonly number[], d0: readonly number[], tmin: number, st: TraceState, test: ItemTest): void {
  const { u, f } = s;
  const lo: V3 = [f[g]!, f[g + 1]!, f[g + 2]!];
  const cs = f[g + 3]!;
  const D: V3 = [u[g + 4]!, u[g + 5]!, u[g + 6]!];
  const starts = u[g + 7]!;
  const list = u[g + 8]!;
  const items = u[g + 9]!;
  const stride = u[g + 11]!;
  const d = safeDir([d0[0]!, d0[1]!, d0[2]!]);
  // In cell units.
  const oc: V3 = [(o[0]! - lo[0]) / cs, (o[1]! - lo[1]) / cs, (o[2]! - lo[2]) / cs];
  const inv: V3 = [cs / d[0], cs / d[1], cs / d[2]];
  let t = tmin;
  let tEnd = Math.min(st.hit.t, st.unfinished);
  for (const k of [0, 1, 2] as const) {
    const a = (0 - oc[k]) * inv[k];
    const b = (D[k] - oc[k]) * inv[k];
    t = Math.max(t, Math.min(a, b));
    tEnd = Math.min(tEnd, Math.max(a, b));
  }
  if (!(t < tEnd)) return;
  const step: V3 = [Math.sign(d[0]), Math.sign(d[1]), Math.sign(d[2])];
  const c: V3 = [0, 1, 2].map((k) => Math.min(D[k]! - 1, Math.max(0, Math.floor(oc[k]! + (d[k]! / cs) * t)))) as V3;
  const side: V3 = [0, 1, 2].map((k) => (c[k]! + (d[k]! > 0 ? 1 : 0) - oc[k]!) * inv[k]!) as V3;
  const delta: V3 = [Math.abs(inv[0]), Math.abs(inv[1]), Math.abs(inv[2])];
  for (let steps = 0; steps < TRACE_STEPS.grid; steps += 1) {
    const cell = (c[2] * D[1] + c[1]) * D[0] + c[0];
    const cellExit = Math.min(side[0], side[1], side[2]);
    for (let k = u[starts + cell]!; k < u[starts + cell + 1]!; k += 1) {
      const item = u[list + k]!;
      test(s, item, items + item * stride, o, d0, tmin, st, Math.max(tmin, t), cellExit);
    }
    // A hit before this cell's far side is the nearest: later cells lie beyond it.
    if (Math.min(st.hit.t, st.unfinished) <= cellExit) return;
    const a = side[0] < side[1] && side[0] < side[2] ? 0 : side[1] < side[2] ? 1 : 2;
    t = side[a];
    side[a] += delta[a];
    c[a] += step[a];
    if (t >= tEnd || c[a] < 0 || c[a] >= D[a]) return;
  }
  st.unfinished = Math.min(st.unfinished, t);
}

/** An architecture piece: a unit box through its map, or a triangle. */
const testArchItem: ItemTest = (s, item, at, ro, rd, tmin, st) => {
  if ((s.u[at + 13]! & st.mask) === 0) return;
  const { u, f } = s;
  const best = Math.min(st.hit.t, st.unfinished);
  if (u[at] === ARCH_BOX) {
    const { o, d: dRaw } = mapRay(f, at + 1, ro, rd);
    const d = safeDir(dRaw);
    let tNear = -Infinity;
    let tFar = Infinity;
    let axis: 0 | 1 | 2 = 0;
    for (const k of [0, 1, 2] as const) {
      const a = (-1 - o[k]) / d[k];
      const b = (1 - o[k]) / d[k];
      const near = Math.min(a, b);
      if (near > tNear) {
        tNear = near;
        axis = k;
      }
      tFar = Math.min(tFar, Math.max(a, b));
    }
    if (!(tNear <= tFar) || tFar < tmin) return;
    // A ray that starts inside a wall is stopped where it starts.
    const t = Math.max(tNear, tmin);
    if (t >= best) return;
    const n: V3 = [0, 0, 0];
    n[axis] = d[axis] > 0 ? -1 : 1;
    const p: V3 = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    const [pu, pv] = axis === 0 ? [2, 1] : axis === 1 ? [0, 2] : [0, 1];
    st.hit = { kind: TRACE_ARCH, t, normal: worldNormal(f, at + 1, n), face: axis * 2 + (n[axis] > 0 ? 0 : 1), object: item, a0: 0, a1: packUnorm2((p[pu]! + 1) / 2, (p[pv]! + 1) / 2) };
    return;
  }
  const v = (k: number): V3 => [f[at + 1 + k * 3]!, f[at + 2 + k * 3]!, f[at + 3 + k * 3]!];
  const [a, b, c] = [v(0), v(1), v(2)];
  const o: V3 = [ro[0]!, ro[1]!, ro[2]!];
  const d: V3 = [rd[0]!, rd[1]!, rd[2]!];
  const t = rayTriangle(o, d, a, b, c, tmin, best);
  if (t === Infinity || t >= best) return;
  const e1: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  // Barycentric (u, v) of the hit, the triangle's own address.
  const p: V3 = [o[0] + d[0] * t - a[0], o[1] + d[1] * t - a[1], o[2] + d[2] * t - a[2]];
  const d00 = e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2];
  const d01 = e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2];
  const d11 = e2[0] * e2[0] + e2[1] * e2[1] + e2[2] * e2[2];
  const d20 = p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2];
  const d21 = p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2];
  const den = d00 * d11 - d01 * d01 || 1;
  st.hit = { kind: TRACE_ARCH, t, normal: [n[0] / l, n[1] / l, n[2] / l], face: 0, object: item, a0: 0, a1: packUnorm2((d11 * d20 - d01 * d21) / den, (d00 * d21 - d01 * d20) / den) };
};

/** A sample block's stored distance at sample (x, y, z) (metres): `o` is the block's atlas origin. */
function sampleAt(atlas: BrickAtlas, o: V3, x: number, y: number, z: number, band: number): number {
  const q = atlas.data[((o[2] + z) * atlas.size[1] + o[1] + y) * atlas.size[0] + o[0] + x]!;
  return ((q / 255) * 2 - 1) * band;
}

/** Trilinear distance at a point of a brick (cells 0–8 on each axis), as the GPU's filtered sample. */
function brickDistance(atlas: BrickAtlas, o: V3, p: V3, band: number): number {
  const q = p.map((v) => Math.min(DISTANCE_BRICK_CELLS - 1e-4, Math.max(0, v))) as V3;
  const i = q.map(Math.floor) as V3;
  const w = [q[0] - i[0], q[1] - i[1], q[2] - i[2]];
  let acc = 0;
  for (let c = 0; c < 8; c += 1) {
    const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
    const k = (dx ? w[0]! : 1 - w[0]!) * (dy ? w[1]! : 1 - w[1]!) * (dz ? w[2]! : 1 - w[2]!);
    acc += k * sampleAt(atlas, o, i[0] + dx, i[1] + dy, i[2] + dz, band);
  }
  return acc;
}

/** One model instance: a DDA over its set's bricks, sphere tracing the ones the surface passes through. */
const testInstance: ItemTest = (s, item, at, ro, rd, tmin, st, tlo, tcell) => {
  if ((s.u[at + 19]! & st.mask) === 0) return;
  const { u, f } = s;
  // Its world box first: most instances a cell lists lie off the ray. It is
  // marched whole from the cell the ray enters its box in, so an instance
  // listed in many cells costs one march.
  let bLo = tmin;
  let bHi = Math.min(st.hit.t, st.unfinished);
  const rs = safeDir([rd[0]!, rd[1]!, rd[2]!]);
  for (let k = 0; k < 3; k += 1) {
    const a = (f[at + 13 + k]! - ro[k]!) / rs[k]!;
    const b = (f[at + 16 + k]! - ro[k]!) / rs[k]!;
    bLo = Math.max(bLo, Math.min(a, b));
    bHi = Math.min(bHi, Math.max(a, b));
  }
  const eps = ENTRY_EPS * (1 + Math.abs(tlo));
  if (!(bLo <= bHi) || bLo < tlo - eps || bLo >= tcell + eps) return;
  const set = u[at + 12]!;
  const { o: ol, d: dl } = mapRay(f, at, ro, rd);
  const lo: V3 = [f[set]!, f[set + 1]!, f[set + 2]!];
  const voxel = f[set + 3]!;
  const band = f[set + 4]!;
  const D: V3 = [u[set + 5]!, u[set + 6]!, u[set + 7]!];
  const table = u[set + 8]!;
  const first = u[set + 9]!;
  const size = voxel * DISTANCE_BRICK_CELLS;
  const speed = Math.hypot(dl[0], dl[1], dl[2]);
  // In brick units.
  const ob: V3 = [(ol[0] - lo[0]) / size, (ol[1] - lo[1]) / size, (ol[2] - lo[2]) / size];
  const d = safeDir([dl[0] / size, dl[1] / size, dl[2] / size]);
  const inv: V3 = [1 / d[0], 1 / d[1], 1 / d[2]];
  let t = tmin;
  let tEnd = Math.min(st.hit.t, st.unfinished);
  let axis: 0 | 1 | 2 = 0;
  for (const k of [0, 1, 2] as const) {
    const a = (0 - ob[k]) * inv[k];
    const b = (D[k] - ob[k]) * inv[k];
    if (Math.min(a, b) > t) {
      t = Math.min(a, b);
      axis = k;
    }
    tEnd = Math.min(tEnd, Math.max(a, b));
  }
  if (!(t < tEnd)) return;
  const step: V3 = [Math.sign(d[0]), Math.sign(d[1]), Math.sign(d[2])];
  const c: V3 = [0, 1, 2].map((k) => Math.min(D[k]! - 1, Math.max(0, Math.floor(ob[k]! + d[k]! * t)))) as V3;
  const side: V3 = [0, 1, 2].map((k) => (c[k]! + (d[k]! > 0 ? 1 : 0) - ob[k]!) * inv[k]!) as V3;
  const delta: V3 = [Math.abs(inv[0]), Math.abs(inv[1]), Math.abs(inv[2])];
  const hitEps = BRICK_HIT_VOXELS * voxel;
  const minStep = (BRICK_MIN_STEP_VOXELS * voxel) / speed;
  for (;;) {
    const bExit = Math.min(side[0], side[1], side[2], tEnd);
    const blk = u[table + (c[2] * D[1] + c[1]) * D[0] + c[0]]! | 0;
    if (blk === DISTANCE_BRICK_INSIDE) {
      const n: V3 = [0, 0, 0];
      n[axis] = d[axis] > 0 ? -1 : 1;
      st.hit = { kind: TRACE_BRICKS, t, normal: worldNormal(f, at, n), face: 0, object: item, a0: localAddress(ob, d, t, D), a1: u[set + 10]! };
      return;
    }
    if (blk !== DISTANCE_BRICK_OUTSIDE) {
      let ts = t;
      while (ts < bExit) {
        st.brickSteps += 1;
        if (st.brickSteps >= TRACE_STEPS.bricks) {
          st.unfinished = Math.min(st.unfinished, ts);
          return;
        }
        const p: V3 = [(ob[0] + d[0] * ts - c[0]) * DISTANCE_BRICK_CELLS, (ob[1] + d[1] * ts - c[1]) * DISTANCE_BRICK_CELLS, (ob[2] + d[2] * ts - c[2]) * DISTANCE_BRICK_CELLS];
        const ao = brickAtlasOrigin(first + blk, s.atlas.blocksPerAxis);
        const dist = brickDistance(s.atlas, ao, p, band);
        if (dist < Math.max(hitEps, st.cone * ts * speed)) {
          const g: V3 = [0, 0, 0];
          for (const k of [0, 1, 2] as const) {
            const a: V3 = [...p];
            const b: V3 = [...p];
            a[k] += 0.5;
            b[k] -= 0.5;
            g[k] = brickDistance(s.atlas, ao, a, band) - brickDistance(s.atlas, ao, b, band);
          }
          st.hit = { kind: TRACE_BRICKS, t: ts, normal: worldNormal(f, at, g), face: 0, object: item, a0: localAddress(ob, d, ts, D), a1: u[set + 10]! };
          return;
        }
        ts += Math.max(dist / speed, minStep);
      }
    }
    st.brickSteps += 1;
    if (st.brickSteps >= TRACE_STEPS.bricks) {
      st.unfinished = Math.min(st.unfinished, bExit);
      return;
    }
    const a = side[0] < side[1] && side[0] < side[2] ? 0 : side[1] < side[2] ? 1 : 2;
    t = side[a];
    side[a] += delta[a];
    c[a] += step[a];
    axis = a;
    if (t >= tEnd || c[a] < 0 || c[a] >= D[a]) return;
  }
};

/** Where in its field a hit lies: 11, 11 and 10 bits of x, y, z over the field's extent. */
function localAddress(ob: V3, d: V3, t: number, D: V3): number {
  const q = (v: number, n: number, bits: number): number => Math.min((1 << bits) - 1, Math.max(0, Math.floor((v / n) * (1 << bits))));
  return (q(ob[0] + d[0] * t, D[0], 11) | (q(ob[1] + d[1] * t, D[1], 11) << 11) | (q(ob[2] + d[2] * t, D[2], 10) << 22)) >>> 0;
}

export function traceArchCpu(s: SceneView, o: readonly number[], d: readonly number[], tmin: number, st: TraceState): void {
  if (s.u[HEADER.arch]! > 0) walkGrid(s, s.u[HEADER.arch + 1]!, o, d, tmin, st, testArchItem);
}

export function traceBricksCpu(s: SceneView, o: readonly number[], d: readonly number[], tmin: number, st: TraceState): void {
  if (s.u[HEADER.bricks]! > 0) walkGrid(s, s.u[HEADER.bricks + 1]!, o, d, tmin, st, testInstance);
}
