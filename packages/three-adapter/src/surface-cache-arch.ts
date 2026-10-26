/**
 * The surface cache's addressing of generated architecture: one chart per
 * run of touching coplanar pieces of an object (a wall's boxes cut round its
 * openings share their face's plane; a floor's triangles share theirs),
 * laid out on the plane itself and cut into charts of at most
 * `SURFACE_CHART_METRES` a side. The pieces are the ones the tracer meets
 * (`traceArchitectureOf`: its colliders' boxes and flat triangles), so a
 * hit's box face or triangle always has a chart.
 *
 * Its render meshes' UVs are trim-sheet UVs that repeat, so they cannot say
 * where a surface's own light is; the plane charts are made from the same
 * generated pieces instead.
 *
 * Pure (no three.js).
 */
import type { ArchitectureComponent } from '@thirdlight/runtime';

import { SURFACE_CHART_METRES, type SurfaceChart } from './surface-cache-atlas';
import type { TraceArchitecture } from './tracer-objects';
import { traceArchitectureOf } from './tracer-sources';
import { invertAffine, worldToLocalOf } from './tracer-words';

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** How close (m) coplanar pieces may be and still share a chart, and how far apart two planes are told apart. */
const PLANE_TOLERANCE = 0.02;

/** A piece's face on its plane: a parallelogram (corner `o`, edges `u`, `v`) or a triangle (corner `o`, edges `u`, `v` to its other corners). */
interface PlanePiece {
  o: V3;
  u: V3;
  v: V3;
  n: V3;
}

/** One object's pieces and charts. */
export interface ArchitectureCharts {
  readonly charts: readonly SurfaceChart[];
  /** Box faces (box × 6 + face) and triangles (boxes × 6 + triangle): their chart's component. */
  readonly pieceOf: Int32Array;
  readonly components: readonly ArchComponent[];
  readonly boxes: number;
  readonly triangles: number;
  readonly min: V3;
  readonly max: V3;
}

/** Touching coplanar pieces: a rectangle on their plane (`origin` + `uAxis`, `vAxis` in metres), cut into `nu` × `nv` charts from `first`. */
interface ArchComponent {
  readonly origin: V3;
  readonly uAxis: V3;
  readonly vAxis: V3;
  readonly u0: number;
  readonly v0: number;
  readonly nu: number;
  readonly nv: number;
  readonly first: number;
}

/** The box's face (axis × 2 + 1 when it faces −axis) as a parallelogram, from its world → unit-box map. */
function boxFace(toWorld: readonly number[], face: number): PlanePiece {
  const axis = face >> 1;
  const s = face & 1 ? -1 : 1;
  const [pu, pv] = axis === 0 ? [2, 1] : axis === 1 ? [0, 2] : [0, 1];
  const at = (p: number[]): V3 => [0, 1, 2].map((r) => toWorld[r * 4]! * p[0]! + toWorld[r * 4 + 1]! * p[1]! + toWorld[r * 4 + 2]! * p[2]! + toWorld[r * 4 + 3]!) as V3;
  const corner = (cu: number, cv: number): V3 => {
    const p = [0, 0, 0];
    p[axis] = s;
    p[pu] = cu;
    p[pv] = cv;
    return at(p);
  };
  const o = corner(-1, -1);
  const u = sub(corner(1, -1), o);
  const v = sub(corner(-1, 1), o);
  const nn = [0, 0, 0];
  nn[axis] = s;
  // Normals go through the inverse transpose of the local → world map: the world → local map's rows.
  const w2l = invertAffine(toWorld);
  const n = unit([0, 1, 2].map((c) => w2l[c]! * nn[0]! + w2l[4 + c]! * nn[1]! + w2l[8 + c]! * nn[2]!) as V3);
  return { o, u, v, n };
}

/** An object's charts from the pieces the tracer meets. */
export function architectureCharts(arch: TraceArchitecture): ArchitectureCharts {
  const pieces: PlanePiece[] = [];
  const maps = arch.boxes.map((b) => invertAffine(worldToLocalOf(b.center, b.rotation, b.half)));
  for (const m of maps) for (let f = 0; f < 6; f += 1) pieces.push(boxFace(m, f));
  const nt = Math.floor(arch.triangles.length / 9);
  for (let i = 0; i < nt; i += 1) {
    const t = arch.triangles;
    const a: V3 = [t[i * 9]!, t[i * 9 + 1]!, t[i * 9 + 2]!];
    const u = sub([t[i * 9 + 3]!, t[i * 9 + 4]!, t[i * 9 + 5]!], a);
    const v = sub([t[i * 9 + 6]!, t[i * 9 + 7]!, t[i * 9 + 8]!], a);
    pieces.push({ o: a, u, v, n: unit(cross(u, v)) });
  }
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  // Planes by facing and offset; the first piece's edge gives the plane its axes.
  const planes = new Map<string, { origin: V3; uAxis: V3; vAxis: V3; members: { i: number; lo: [number, number]; hi: [number, number] }[] }>();
  pieces.forEach((p, i) => {
    const area = Math.hypot(...cross(p.u, p.v));
    if (!(area > 1e-10)) return;
    const key = `${Math.round(p.n[0] * 1000)},${Math.round(p.n[1] * 1000)},${Math.round(p.n[2] * 1000)},${Math.round(dot(p.n, p.o) / PLANE_TOLERANCE)}`;
    let pl = planes.get(key);
    if (pl === undefined) {
      const uAxis = unit(p.u);
      planes.set(key, (pl = { origin: p.o, uAxis, vAxis: cross(p.n, uAxis), members: [] }));
    }
    const isTri = i >= maps.length * 6;
    const corners: V3[] = isTri ? [p.o, [p.o[0] + p.u[0], p.o[1] + p.u[1], p.o[2] + p.u[2]], [p.o[0] + p.v[0], p.o[1] + p.v[1], p.o[2] + p.v[2]]] : [p.o, [p.o[0] + p.u[0], p.o[1] + p.u[1], p.o[2] + p.u[2]], [p.o[0] + p.v[0], p.o[1] + p.v[1], p.o[2] + p.v[2]], [p.o[0] + p.u[0] + p.v[0], p.o[1] + p.u[1] + p.v[1], p.o[2] + p.u[2] + p.v[2]]];
    const lo: [number, number] = [Infinity, Infinity];
    const hi: [number, number] = [-Infinity, -Infinity];
    for (const c of corners) {
      const d = sub(c, pl.origin);
      const cu = dot(d, pl.uAxis);
      const cv = dot(d, pl.vAxis);
      lo[0] = Math.min(lo[0], cu);
      lo[1] = Math.min(lo[1], cv);
      hi[0] = Math.max(hi[0], cu);
      hi[1] = Math.max(hi[1], cv);
      for (let k = 0; k < 3; k += 1) {
        min[k] = Math.min(min[k]!, c[k]!);
        max[k] = Math.max(max[k]!, c[k]!);
      }
    }
    pl.members.push({ i, lo, hi });
  });
  const pieceOf = new Int32Array(pieces.length).fill(-1);
  const components: ArchComponent[] = [];
  const charts: SurfaceChart[] = [];
  for (const pl of planes.values()) {
    // Touching pieces join (union-find over their rectangles on the plane).
    const m = pl.members;
    const parent = m.map((_, i) => i);
    const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i]!)));
    const order = m.map((_, i) => i).sort((a, b) => m[a]!.lo[0] - m[b]!.lo[0]);
    for (let a = 0; a < order.length; a += 1) {
      const A = m[order[a]!]!;
      for (let b = a + 1; b < order.length; b += 1) {
        const B = m[order[b]!]!;
        if (B.lo[0] > A.hi[0] + PLANE_TOLERANCE) break;
        if (B.lo[1] <= A.hi[1] + PLANE_TOLERANCE && A.lo[1] <= B.hi[1] + PLANE_TOLERANCE) parent[root(order[a]!)] = root(order[b]!);
      }
    }
    const groups = new Map<number, number[]>();
    m.forEach((_, i) => {
      const r = root(i);
      const g = groups.get(r) ?? [];
      g.push(i);
      groups.set(r, g);
    });
    for (const g of groups.values()) {
      let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
      for (const i of g) {
        u0 = Math.min(u0, m[i]!.lo[0]);
        v0 = Math.min(v0, m[i]!.lo[1]);
        u1 = Math.max(u1, m[i]!.hi[0]);
        v1 = Math.max(v1, m[i]!.hi[1]);
      }
      const nu = Math.max(1, Math.ceil((u1 - u0) / SURFACE_CHART_METRES - 1e-9));
      const nv = Math.max(1, Math.ceil((v1 - v0) / SURFACE_CHART_METRES - 1e-9));
      const c = components.length;
      components.push({ origin: pl.origin, uAxis: pl.uAxis, vAxis: pl.vAxis, u0, v0, nu, nv, first: charts.length });
      for (let j = 0; j < nv; j += 1) for (let i = 0; i < nu; i += 1) charts.push({ kind: 'area', w: Math.min(SURFACE_CHART_METRES, u1 - u0 - i * SURFACE_CHART_METRES), h: Math.min(SURFACE_CHART_METRES, v1 - v0 - j * SURFACE_CHART_METRES) });
      for (const i of g) pieceOf[m[i]!.i] = c;
    }
  }
  return { charts, pieceOf, components, boxes: maps.length, triangles: nt, min, max };
}

/** The chart and place (metres along it) of world point `p` on piece `piece` (null: a piece with no area). */
export function locateArchitecturePoint(a: ArchitectureCharts, piece: number, p: readonly number[]): { chart: number; u: number; v: number } | null {
  const c = a.pieceOf[piece] ?? -1;
  if (c < 0) return null;
  const comp = a.components[c]!;
  const d = sub([p[0]!, p[1]!, p[2]!], comp.origin);
  const u = dot(d, comp.uAxis) - comp.u0;
  const v = dot(d, comp.vAxis) - comp.v0;
  const i = Math.min(comp.nu - 1, Math.max(0, Math.floor(u / SURFACE_CHART_METRES)));
  const j = Math.min(comp.nv - 1, Math.max(0, Math.floor(v / SURFACE_CHART_METRES)));
  return { chart: comp.first + j * comp.nu + i, u: Math.max(0, u - i * SURFACE_CHART_METRES), v: Math.max(0, v - j * SURFACE_CHART_METRES) };
}

/** The world point of a tracer hit on box `box`'s `face` at its face fractions (fu, fv) (`a1` of an architecture hit). */
export function boxFacePoint(arch: TraceArchitecture, box: number, face: number, fu: number, fv: number): V3 {
  const b = arch.boxes[box]!;
  const m = invertAffine(worldToLocalOf(b.center, b.rotation, b.half));
  const f = boxFace(m, face);
  return [f.o[0] + f.u[0] * fu + f.v[0] * fv, f.o[1] + f.u[1] * fu + f.v[1] * fv, f.o[2] + f.u[2] * fu + f.v[2] * fv];
}

/** The world point of a tracer hit on triangle `tri` at its barycentrics (`a1`: the weights of its second and third corners). */
export function trianglePoint(arch: TraceArchitecture, tri: number, b1: number, b2: number): V3 {
  const t = arch.triangles;
  const at = (k: number): number => t[tri * 9 + k]!;
  return [0, 1, 2].map((k) => at(k) + (at(3 + k) - at(k)) * b1 + (at(6 + k) - at(k)) * b2) as V3;
}

/** An architecture object as the cache and tracer take it: its own pieces (in world space). */
export function architecturePiecesOf(component: ArchitectureComponent, origin: readonly number[]): TraceArchitecture {
  return traceArchitectureOf([{ component, origin }]);
}
