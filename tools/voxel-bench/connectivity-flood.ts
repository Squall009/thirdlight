/**
 * Connectivity culling as a measurement (the cave-culling flood), never part of a frame: from the camera's 16³ unit,
 * visibility spreads only through open space. A unit is kept when a chain of units joined face to face reaches it
 * from the camera's unit, each entered by one face and left by another its derived face connectivity joins
 * (open-regions.ts `connect`), never stepping against a direction the chain already stepped (a straight sight line
 * crosses unit faces monotonically on each axis), and only through units the frustum touches. The camera's unit is
 * left only by the faces the camera's own open component (with the portals it touches) reaches. A unit not known
 * (not derived, not loaded) is open through every face.
 *
 * Beside it: the units a sight line crosses, for a reference by rays (`segmentUnits`), and the frustum as planes.
 * Engine-owned bench code (connectivity-cli.ts); it reads derived outputs and stores nothing.
 */
import { ALL_FACE_PAIRS, ALL_REGION_FACES, facePairBit, regionLabelAt, type OpenRegionsOut } from '@thirdlight/voxel';

/** Cells a unit side, and metres a cell. */
export const UNIT_CELLS = 16;
export const CELL_M = 0.5;
const UNIT_M = UNIT_CELLS * CELL_M;

/** A unit's derived regions; null: known and every cell solid; undefined: not known (open through every face). */
export type UnitLookup = (ux: number, uy: number, uz: number) => OpenRegionsOut | null | undefined;

/** A plane n·p + d ≥ 0 inside (metres). */
export type Plane = readonly [number, number, number, number];

const OFF = 1 << 12;
const SPAN = 1 << 13;
/** One number a unit (units within ±4,096 of the origin on each axis: ±32 km). */
export function unitKey(ux: number, uy: number, uz: number): number {
  return ((ux + OFF) * SPAN + (uy + OFF)) * SPAN + (uz + OFF);
}
export function unitOfKey(k: number): [number, number, number] {
  const uz = (k % SPAN) - OFF;
  const r = Math.floor(k / SPAN);
  return [Math.floor(r / SPAN) - OFF, (r % SPAN) - OFF, uz];
}

/** The six frustum planes of a perspective camera (eye, yaw 0 looking along −z, pitch down positive; metres, degrees). */
export function frustumPlanes(eye: readonly number[], yaw: number, pitch: number, fovYDeg: number, aspect: number, near: number, far: number): { planes: Plane[]; forward: [number, number, number]; right: [number, number, number]; up: [number, number, number] } {
  const cp = Math.cos(pitch);
  const forward: [number, number, number] = [-Math.sin(yaw) * cp, -Math.sin(pitch), -Math.cos(yaw) * cp];
  const right: [number, number, number] = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up = cross(right, forward);
  const ty = Math.tan((fovYDeg * Math.PI) / 360);
  const tx = ty * aspect;
  const planes: Plane[] = [];
  const through = (n: [number, number, number]): Plane => {
    const l = Math.hypot(n[0], n[1], n[2]);
    const u: [number, number, number] = [n[0] / l, n[1] / l, n[2] / l];
    return [u[0], u[1], u[2], -(u[0] * eye[0]! + u[1] * eye[1]! + u[2] * eye[2]!)];
  };
  // Side planes through the eye, normals inward.
  planes.push(through(add(scale(right, 1), scale(forward, tx))));
  planes.push(through(add(scale(right, -1), scale(forward, tx))));
  planes.push(through(add(scale(up, 1), scale(forward, ty))));
  planes.push(through(add(scale(up, -1), scale(forward, ty))));
  const f = forward;
  planes.push([f[0], f[1], f[2], -(f[0] * eye[0]! + f[1] * eye[1]! + f[2] * eye[2]!) - near]);
  planes.push([-f[0], -f[1], -f[2], f[0] * eye[0]! + f[1] * eye[1]! + f[2] * eye[2]! + far]);
  return { planes, forward, right, up };
}

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}
function add(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
}
function scale(a: readonly number[], s: number): [number, number, number] {
  return [a[0]! * s, a[1]! * s, a[2]! * s];
}

/** Whether a box (metres) touches every plane's inside. */
export function boxInPlanes(planes: readonly Plane[], min: readonly number[], max: readonly number[]): boolean {
  for (const p of planes) {
    const x = p[0] >= 0 ? max[0]! : min[0]!;
    const y = p[1] >= 0 ? max[1]! : min[1]!;
    const z = p[2] >= 0 ? max[2]! : min[2]!;
    if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) return false;
  }
  return true;
}

/** The faces a unit's component `label` reaches, with every component joined to it through portal contacts (as `connect` joins them). */
export function componentFaces(r: OpenRegionsOut, label: number): number {
  if (label <= 0 || label > r.count) return 0;
  const parent = Array.from({ length: r.count + 1 }, (_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]!]!;
    return a;
  };
  for (let k = 0; k < r.links.length; k += 2) parent[find(r.links[k]!)] = find(r.links[k + 1]!);
  const g = find(label);
  let faces = 0;
  for (let l = 1; l <= r.count; l++) if (find(l) === g) faces |= r.flags[l - 1]! & ALL_REGION_FACES;
  return faces;
}

/** Whether face pair (a, b) of a unit is joined through open space (unknown: yes). */
function joins(r: OpenRegionsOut | null | undefined, a: number, b: number): boolean {
  if (r === undefined) return true;
  if (r === null) return false;
  if (r.connect === ALL_FACE_PAIRS) return true;
  return (r.connect & facePairBit(a, b)) !== 0;
}

export interface FloodOptions {
  readonly eye: readonly number[];
  readonly planes: readonly Plane[];
  /** Metres from the eye past which units are not flooded (the level-0 ring's reach). */
  readonly reachM: number;
  readonly unit: UnitLookup;
}

export interface FloodResult {
  /** Units kept (the camera's included). */
  readonly kept: Set<number>;
  /** States (unit, face entered, directions stepped) taken from the queue, and states refused as already covered. */
  readonly states: number;
  readonly pruned: number;
  /** Whether the camera stood in an open cell of a known unit (else every face of its unit was opened). */
  readonly startOpen: boolean;
}

/** The flood (module comment). */
export function connectivityFlood(o: FloodOptions): FloodResult {
  const ex = Math.floor(o.eye[0]! / CELL_M);
  const ey = Math.floor(o.eye[1]! / CELL_M);
  const ez = Math.floor(o.eye[2]! / CELL_M);
  const ux0 = Math.floor(ex / UNIT_CELLS);
  const uy0 = Math.floor(ey / UNIT_CELLS);
  const uz0 = Math.floor(ez / UNIT_CELLS);
  const kept = new Set<number>([unitKey(ux0, uy0, uz0)]);
  const start = o.unit(ux0, uy0, uz0);
  let startFaces = ALL_REGION_FACES;
  let startOpen = false;
  if (start !== undefined && start !== null) {
    const lx = ex - ux0 * UNIT_CELLS;
    const ly = ey - uy0 * UNIT_CELLS;
    const lz = ez - uz0 * UNIT_CELLS;
    const label = regionLabelAt(start, (lx * UNIT_CELLS + lz) * UNIT_CELLS + ly);
    if (label > 0) {
      startOpen = true;
      startFaces = componentFaces(start, label);
    }
  }
  // Per (unit, face entered): the direction sets it was reached with; a new set is refused when a seen one is inside it.
  const seen = new Map<number, number[]>();
  const queue: number[] = [];
  const reach2 = o.reachM * o.reachM;
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  let states = 0;
  let pruned = 0;
  const step = (ux: number, uy: number, uz: number, exit: number, mask: number): void => {
    // Never back against a direction already stepped.
    if ((mask & (1 << (exit ^ 1))) !== 0) return;
    const axis = exit >> 1;
    const d = (exit & 1) === 1 ? 1 : -1;
    const nx = ux + (axis === 0 ? d : 0);
    const ny = uy + (axis === 1 ? d : 0);
    const nz = uz + (axis === 2 ? d : 0);
    min[0] = nx * UNIT_M;
    min[1] = ny * UNIT_M;
    min[2] = nz * UNIT_M;
    max[0] = min[0] + UNIT_M;
    max[1] = min[1] + UNIT_M;
    max[2] = min[2] + UNIT_M;
    let dist2 = 0;
    for (let a = 0; a < 3; a++) {
      const v = o.eye[a]! < min[a]! ? min[a]! - o.eye[a]! : o.eye[a]! > max[a]! ? o.eye[a]! - max[a]! : 0;
      dist2 += v * v;
    }
    if (dist2 > reach2 || !boxInPlanes(o.planes, min, max)) return;
    const key = unitKey(nx, ny, nz);
    kept.add(key);
    const entry = exit ^ 1;
    const m = mask | (1 << exit);
    const sk = key * 6 + entry;
    const masks = seen.get(sk);
    if (masks !== undefined) {
      for (const s of masks) {
        if ((s & m) === s) {
          pruned++;
          return;
        }
      }
      masks.push(m);
    } else seen.set(sk, [m]);
    queue.push(nx, ny, nz, entry, m);
  };
  for (let f = 0; f < 6; f++) if ((startFaces & (1 << f)) !== 0) step(ux0, uy0, uz0, f, 0);
  for (let q = 0; q < queue.length; q += 5) {
    const ux = queue[q]!;
    const uy = queue[q + 1]!;
    const uz = queue[q + 2]!;
    const entry = queue[q + 3]!;
    const mask = queue[q + 4]!;
    states++;
    const r = o.unit(ux, uy, uz);
    if (r === null) continue;
    for (let g = 0; g < 6; g++) if (g !== entry && joins(r, entry, g)) step(ux, uy, uz, g, mask);
  }
  return { kept, states, pruned, startOpen };
}

/** The units a segment from `a` to `b` (metres) crosses, in order (3D DDA over the unit grid). */
export function segmentUnits(a: readonly number[], b: readonly number[], into: Set<number>): void {
  const d = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
  const len = Math.hypot(d[0]!, d[1]!, d[2]!);
  const u = [Math.floor(a[0]! / UNIT_M), Math.floor(a[1]! / UNIT_M), Math.floor(a[2]! / UNIT_M)];
  const end = [Math.floor(b[0]! / UNIT_M), Math.floor(b[1]! / UNIT_M), Math.floor(b[2]! / UNIT_M)];
  into.add(unitKey(u[0]!, u[1]!, u[2]!));
  if (len === 0) return;
  const step = [0, 0, 0];
  const tMax = [Infinity, Infinity, Infinity];
  const tDelta = [Infinity, Infinity, Infinity];
  for (let k = 0; k < 3; k++) {
    if (d[k] === 0) continue;
    step[k] = d[k]! > 0 ? 1 : -1;
    const next = (u[k]! + (d[k]! > 0 ? 1 : 0)) * UNIT_M;
    tMax[k] = (next - a[k]!) / d[k]!;
    tDelta[k] = UNIT_M / Math.abs(d[k]!);
  }
  for (let i = 0; i < 4096; i++) {
    if (u[0] === end[0] && u[1] === end[1] && u[2] === end[2]) return;
    const k = tMax[0]! < tMax[1]! ? (tMax[0]! < tMax[2]! ? 0 : 2) : tMax[1]! < tMax[2]! ? 1 : 2;
    if (tMax[k]! > 1) return;
    u[k]! += step[k]!;
    tMax[k]! += tDelta[k]!;
    into.add(unitKey(u[0]!, u[1]!, u[2]!));
  }
}
