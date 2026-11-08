/**
 * The relief mesh (relief-mesh.ts) on real worlds: chunks derived through
 * the worker's path (one apron a chunk, its 16³ sections), with and without
 * relief; and the checks the relief tests and the relief bench share: no
 * new open edge, the same area, crease weights two sections agree on, and
 * what the relief costs. The meshes are kept in typed arrays with numeric
 * keys: a dense section at n = 8 holds hundreds of thousands of triangles.
 */
import {
  buildApron,
  deriveSectionsWithApron,
  encodeDerived,
  jobRadius,
  POSITION_STEPS_PER_CELL,
  RELIEF_FREE,
  SURFACE_VERTEX_BYTES,
  WORLD_RULES,
  type ChunkGrid,
  type DerivedData,
  type PaletteStore,
  type ReliefOptions,
  type SurfaceBuffer,
} from '@thirdlight/voxel';

const S = POSITION_STEPS_PER_CELL;
export const RELIEF_SECTION_EDGE = 16;

/** One section derived plain and with its relief options (null: drawn plain), and what each took. */
export interface ReliefSection {
  /** World section coordinates (16³ sections). */
  readonly s: readonly [number, number, number];
  readonly plain: DerivedData;
  readonly relief: DerivedData;
  /** µs of the relief part (undefined: none asked for), of the whole derive with it, and without. */
  readonly reliefUs: number | undefined;
  readonly deriveUs: number;
  readonly plainUs: number;
}

/**
 * The 16³ sections of chunk (cx, cy, cz), derived plain and with relief
 * from one apron each: `reliefOf` names each section's options (world
 * section coordinates; null: drawn plain).
 */
export function deriveReliefSections(store: PaletteStore, grid: ChunkGrid, cx: number, cy: number, cz: number, reliefOf: (sx: number, sy: number, sz: number) => ReliefOptions | null): ReliefSection[] {
  const n = grid.edge / RELIEF_SECTION_EDGE;
  const ids = Array.from({ length: n * n * n }, (_, i) => i);
  const R = jobRadius(WORLD_RULES);
  const exportChunk = (out: Parameters<PaletteStore['exportChunk']>[3]): boolean => store.exportChunk(cx, cy, cz, out);
  const at = (id: number): [number, number, number] => [cx * n + Math.floor(id / (n * n)), cy * n + (id % n), cz * n + (Math.floor(id / n) % n)];
  const plain = deriveSectionsWithApron(grid, WORLD_RULES, buildApron(store, cx, cy, cz, R), exportChunk, RELIEF_SECTION_EDGE, ids);
  const relief = deriveSectionsWithApron(grid, WORLD_RULES, buildApron(store, cx, cy, cz, R), exportChunk, RELIEF_SECTION_EDGE, ids, 0, undefined, (id) => reliefOf(...at(id)));
  const total = (t: { evaluateUs: number; consumersUs: number; meshUs: number; reliefUs?: number }): number => t.evaluateUs + t.consumersUs + t.meshUs + (t.reliefUs ?? 0);
  return ids.map((id) => ({ s: at(id), plain: plain[id]!.assembly!, relief: relief[id]!.assembly!, reliefUs: relief[id]!.times.reliefUs, deriveUs: total(relief[id]!.times), plainUs: total(plain[id]!.times) }));
}

/** Whether a section derived with relief gives the canonical bytes (every output but the relief) it gives without. */
export function canonicalEqual(r: ReliefSection): boolean {
  return Buffer.from(encodeDerived(r.plain)).equals(Buffer.from(encodeDerived(r.relief)));
}

/** A surface as drawn: the relief one where the section has it, else the plain one (crease weights 0). */
export function drawnSurface(d: DerivedData, kind: 'ground' | 'base'): SurfaceBuffer & { crease?: Uint8Array } {
  return d.relief?.[kind] ?? d[kind];
}

/** A mesh in world position steps: welded points, per vertex its point, normal and weight, triangles of vertices. */
export interface WorldMesh {
  /** Per point: x, y, z (steps). */
  readonly points: number[];
  /** Per vertex: its point. */
  readonly vertexPoint: Uint32Array;
  readonly normals: Int8Array;
  readonly weights: Uint8Array;
  /** Per triangle: three vertices. */
  readonly tris: Uint32Array;
}

/** Point code: steps from `origin` on each axis (each below 2^17). */
const AXIS_CODE = 0x20000;

/** The surfaces of sections (world section coordinates) as one world mesh, positions relative to `origin` (steps). */
export function worldMesh(parts: ReadonlyArray<{ readonly s: SurfaceBuffer & { crease?: Uint8Array }; readonly at: readonly [number, number, number] }>, origin: readonly [number, number, number]): WorldMesh {
  let vertexCount = 0;
  let index = 0;
  for (const { s } of parts) {
    vertexCount += s.vertexCount;
    index += s.indices.length;
  }
  const ids = new Map<number, number>();
  const points: number[] = [];
  const vertexPoint = new Uint32Array(vertexCount);
  const normals = new Int8Array(3 * vertexCount);
  const weights = new Uint8Array(vertexCount);
  const tris = new Uint32Array(index);
  let v0 = 0;
  let i0 = 0;
  for (const { s, at } of parts) {
    const view = new DataView(s.vertices.buffer, s.vertices.byteOffset, s.vertices.byteLength);
    for (let v = 0; v < s.vertexCount; v++) {
      const o = v * SURFACE_VERTEX_BYTES;
      let code = 0;
      const p = [0, 0, 0];
      for (let a = 0; a < 3; a++) {
        p[a] = (at[a]! * RELIEF_SECTION_EDGE - 1) * S + view.getUint16(o + 2 * a, true) - origin[a]!;
        if (p[a]! < 0 || p[a]! >= AXIS_CODE) throw new RangeError(`world mesh: position ${p[a]} off the window`);
        code = code * AXIS_CODE + p[a]!;
        normals[3 * (v0 + v) + a] = view.getInt8(o + 8 + a);
      }
      let id = ids.get(code);
      if (id === undefined) {
        id = points.length / 3;
        ids.set(code, id);
        points.push(p[0]!, p[1]!, p[2]!);
      }
      vertexPoint[v0 + v] = id;
      weights[v0 + v] = s.crease?.[v] ?? 0;
    }
    for (let k = 0; k < s.indices.length; k++) tris[i0 + k] = v0 + s.indices[k]!;
    v0 += s.vertexCount;
    i0 += s.indices.length;
  }
  return { points, vertexPoint, normals, weights, tris };
}

const EDGE_KEY = 0x4000000;

/** Every triangle edge by its two points, counted (degenerate edges left out). */
function edgeCounts(m: WorldMesh): Map<number, number> {
  const out = new Map<number, number>();
  for (let t = 0; t < m.tris.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = m.vertexPoint[m.tris[t + k]!]!;
    const b = m.vertexPoint[m.tris[t + ((k + 1) % 3)]!]!;
    if (a === b) continue;
    const key = a < b ? a * EDGE_KEY + b : b * EDGE_KEY + a;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

function area(m: WorldMesh): number {
  let sum = 0;
  const P = m.points;
  for (let t = 0; t < m.tris.length; t += 3) {
    const a = 3 * m.vertexPoint[m.tris[t]!]!;
    const b = 3 * m.vertexPoint[m.tris[t + 1]!]!;
    const c = 3 * m.vertexPoint[m.tris[t + 2]!]!;
    const u = [P[b]! - P[a]!, P[b + 1]! - P[a + 1]!, P[b + 2]! - P[a + 2]!];
    const v = [P[c]! - P[a]!, P[c + 1]! - P[a + 1]!, P[c + 2]! - P[a + 2]!];
    sum += Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;
  }
  return sum;
}

export interface WatertightResult {
  /** Relief edges inside the box with other than two triangles. */
  readonly openRelief: number;
  /** Those with another count of plain triangles along them (a crack or T-junction the relief made). */
  readonly unexplained: number;
  readonly firstUnexplained: string | null;
  /** Relief edges inside the box. */
  readonly inner: number;
  /** Relief area over plain area. */
  readonly areaRatio: number;
}

/**
 * Relief against plain inside the box (steps from the meshes' origin, per
 * axis): every relief edge with other than two triangles must lie along
 * plain edges with as many triangles in all (the plain mesh's own outline,
 * where a body meets the ground, or bodies touching along an edge), within
 * a step of their line (relief points are rounded to steps).
 */
export function watertight(plain: WorldMesh, relief: WorldMesh, box: { lo: readonly number[]; hi: readonly number[] }): WatertightResult {
  const inside = (P: number[], p: number): boolean => [0, 1, 2].every((a) => P[3 * p + a]! > box.lo[a]! && P[3 * p + a]! < box.hi[a]!);
  const pp = plain.points;
  const buckets = new Map<number, number[]>();
  for (const [key, n] of edgeCounts(plain)) {
    const a = Math.floor(key / EDGE_KEY);
    const b = key % EDGE_KEY;
    for (let x = Math.floor(Math.min(pp[3 * a]!, pp[3 * b]!) / S) - 1; x <= Math.floor(Math.max(pp[3 * a]!, pp[3 * b]!) / S) + 1; x++) {
      let list = buckets.get(x);
      if (list === undefined) buckets.set(x, (list = []));
      list.push(a, b, n);
    }
  }
  const rp = relief.points;
  /** Whether relief point p lies on plain edge a–b (within a step). */
  const along = (p: number, a: number, b: number): boolean => {
    const d = [0, 1, 2].map((k) => pp[3 * b + k]! - pp[3 * a + k]!);
    const q = [0, 1, 2].map((k) => rp[3 * p + k]! - pp[3 * a + k]!);
    const len = Math.hypot(d[0]!, d[1]!, d[2]!);
    const t = (d[0]! * q[0]! + d[1]! * q[1]! + d[2]! * q[2]!) / len;
    if (t < -1 || t > len + 1) return false;
    return Math.hypot(d[1]! * q[2]! - d[2]! * q[1]!, d[2]! * q[0]! - d[0]! * q[2]!, d[0]! * q[1]! - d[1]! * q[0]!) / len <= 1;
  };
  let openRelief = 0;
  let unexplained = 0;
  let inner = 0;
  let firstUnexplained: string | null = null;
  for (const [key, n] of edgeCounts(relief)) {
    const a = Math.floor(key / EDGE_KEY);
    const b = key % EDGE_KEY;
    if (!inside(rp, a) || !inside(rp, b)) continue;
    inner++;
    if (n === 2) continue;
    openRelief++;
    const list = buckets.get(Math.floor((rp[3 * a]! + rp[3 * b]!) / 2 / S)) ?? [];
    // The plain triangles along it: as many as the relief's (an outline once, a body's edge against another twice each side).
    let plainCount = 0;
    for (let k = 0; k < list.length; k += 3) if (along(a, list[k]!, list[k + 1]!) && along(b, list[k]!, list[k + 1]!)) plainCount += list[k + 2]!;
    if (plainCount !== n) {
      unexplained++;
      firstUnexplained ??= `${rp.slice(3 * a, 3 * a + 3).join(',')}|${rp.slice(3 * b, 3 * b + 3).join(',')} ×${n} (plain ×${plainCount})`;
    }
  }
  return { openRelief, unexplained, firstUnexplained, inner, areaRatio: area(relief) / area(plain) };
}

/**
 * Points where copies of a vertex (one a section, a crease's sides, the
 * ground and a body) would move apart under displacement: copies whose
 * normals differ (by more than snorm rounding) must all be fixed, and
 * copies with one normal must have one weight.
 */
export function creaseDisagreements(m: WorldMesh): { count: number; first: string | null; free: number; vertices: number } {
  const n = m.vertexPoint.length;
  const order = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => m.vertexPoint[a]! - m.vertexPoint[b]!);
  let free = 0;
  for (let v = 0; v < n; v++) if (m.weights[v] === RELIEF_FREE) free++;
  let count = 0;
  let first: string | null = null;
  const N = m.normals;
  for (let i = 0; i < n; ) {
    let j = i + 1;
    while (j < n && m.vertexPoint[order[j]!] === m.vertexPoint[order[i]!]) j++;
    if (j - i > 1) {
      const v0 = order[i]!;
      const len0 = Math.hypot(N[3 * v0]!, N[3 * v0 + 1]!, N[3 * v0 + 2]!);
      let same = true;
      let oneWeight = true;
      let allFixed = true;
      for (let k = i; k < j; k++) {
        const v = order[k]!;
        const dot = (N[3 * v]! * N[3 * v0]! + N[3 * v + 1]! * N[3 * v0 + 1]! + N[3 * v + 2]! * N[3 * v0 + 2]!) / (Math.hypot(N[3 * v]!, N[3 * v + 1]!, N[3 * v + 2]!) * len0);
        if (dot <= 0.995) same = false;
        if (m.weights[v] !== m.weights[v0]) oneWeight = false;
        if (m.weights[v] !== 0) allFixed = false;
      }
      if (!(same ? oneWeight : allFixed)) {
        count++;
        if (first === null) {
          const p = m.vertexPoint[v0]!;
          first = `${m.points.slice(3 * p, 3 * p + 3).join(',')}: ${Array.from({ length: j - i }, (_, k) => order[i + k]!).map((v) => `${N[3 * v]}/${N[3 * v + 1]}/${N[3 * v + 2]}=${m.weights[v]}`).join(' ')}`;
        }
      }
    }
    i = j;
  }
  return { count, first, free, vertices: n };
}

/** Bytes of a surface's arrays, its crease weights included. */
export function surfaceBytes(s: SurfaceBuffer & { crease?: Uint8Array }): number {
  return s.vertices.byteLength + s.indices.byteLength + (s.crease?.byteLength ?? 0);
}
