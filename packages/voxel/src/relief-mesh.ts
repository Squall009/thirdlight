/**
 * The relief mesh (SPIKE, no format version yet): a denser copy of a
 * level-0 derive unit's ground and base surfaces, for a vertex stage that
 * moves each vertex inward by its material's height (the GPU has no
 * tessellation stage on WebGPU or WebGL 2, so the worker emits the
 * topology). The plain surfaces stay as derived: collision, occupancy,
 * navigation and light never read the relief, so they are byte for byte
 * what they are without it.
 *
 * **Topology.** Every triangle of the source surface is split until no
 * edge spans more than 1.5 / n cells along any axis (n = 2, 4, 8 of
 * {@link RELIEF_SUBDIVISIONS}: lattice steps of 25, 12.5 and 6.25 cm): a
 * triangle all of whose edges are too long into four at their midpoints,
 * else its longest too-long edge halved. Whether and where an edge is split
 * depends on that edge alone (its two end positions), so two triangles that
 * share an edge, in one section or on either side of a section or chunk
 * face, split it at the same points bit for bit, and no T-junction appears.
 * A base face (drawn unmerged for this, base-surface.ts) becomes an n × n
 * lattice of quads; a terrain mesher triangle about 4^log2(n) triangles; a
 * roof row (merged along its level line) is split along it as well.
 * Midpoints are kept exact (positions halve in floating point) and rounded
 * to position steps only when written, so the rounding is a function of
 * the edge too.
 *
 * **Plain neighbours.** Toward each of the 26 units round it that is drawn
 * without relief (`plainNeighbours`), a unit keeps every edge the two can
 * share as it is (edges with both ends within the surface's shared reach of
 * that neighbour: on its face for the base, half a cell for the ground, a
 * cell for roofs), so the border is today's edge on both sides, and every
 * vertex within that reach takes crease weight 0. Nearness to a neighbour
 * is a matter of the point and that neighbour's box alone, so every unit
 * round a point that sees the plain neighbour fixes it alike (a point on an
 * edge between four units is shared by all four).
 *
 * **Crease weight** (a byte a vertex: 0 fixed, 255 free; the vertex stage
 * scales its displacement by it): 0 where the surface turns (a cell edge
 * where a face does not continue flat, a crease vertex of the ground, a
 * roof ridge, eave or verge), at seams a wall shares with its roof, and on
 * the shared border to a plain neighbour; 255 elsewhere. Every point of a
 * coarse edge takes the edge's weight, so two sections give a shared point
 * the same weight; points inside a coarse triangle are free. Kit edge
 * pieces sit on cell edges where faces turn or end, so they meet an
 * undisplaced line. The relief ring's fade over its last metres is the
 * vertex stage's (a distance, not a mesh property).
 */
import { ASSEMBLY_CLASS, CLASS_MASK, type Neighbourhood } from './assembly';
import { appendSurface } from './roof-mesher';
import { POSITION_STEPS_PER_CELL, SURFACE_VERTEX_BYTES, snorm8, surfaceCrackOf, surfaceOwnerOf, writeSurfaceExtras, type SurfaceBuffer } from './derived-mesh';

const S = POSITION_STEPS_PER_CELL;

/** The subdivisions a relief mesh takes: lattice steps of a cell over n (0.5 m cells: 25, 12.5, 6.25 cm). */
export const RELIEF_SUBDIVISIONS: readonly number[] = Object.freeze([2, 4, 8]);

/** A vertex's crease weight when it is free to move (0: fixed). */
export const RELIEF_FREE = 255;

/** Angle (degrees) past which a roof's two triangles meeting at an edge make it a crease. */
export const RELIEF_CREASE_DEG = 30;

const CREASE_COS = Math.cos((RELIEF_CREASE_DEG * Math.PI) / 180);

/** A relief surface: the derive's surface layout plus a crease weight a vertex. */
export interface ReliefSurface extends SurfaceBuffer {
  readonly crease: Uint8Array;
}

/** A derive unit's relief: its ground and base surfaces subdivided `n` times a cell. */
export interface ReliefPart {
  readonly n: number;
  readonly ground: ReliefSurface;
  readonly base: ReliefSurface;
}

/** What a derive is asked for: the subdivision and which units round it are drawn without relief. */
export interface ReliefOptions {
  readonly n: number;
  /** Bit (dx + 1) · 9 + (dy + 1) · 3 + (dz + 1) of the units round it (dx, dy, dz in −1 … 1; bit 13, itself, unused): that one is drawn plain. */
  readonly plainNeighbours?: number;
}

/** The {@link ReliefOptions.plainNeighbours} bit of the unit at offset (dx, dy, dz). */
export function reliefNeighbourBit(dx: number, dy: number, dz: number): number {
  return 1 << ((dx + 1) * 9 + (dy + 1) * 3 + (dz + 1));
}

const NEIGHBOURS_ALL = (1 << 27) - 1 - (1 << 13);

/** How a source surface's creases are read (its vertex indices). */
export interface CreaseRule {
  /** Whether coarse vertex v stays fixed. */
  vertex(v: number): boolean;
  /** Whether the points coarse edge a–b is split at stay fixed. */
  edge(a: number, b: number): boolean;
  /** Position steps from a unit's face within which the unit's edges may be shared with its neighbour's. */
  readonly sharedReachSteps: number;
  /** Whether a new point (position steps, exact) stays fixed whatever edge it splits (absent: by its edge alone). */
  point?(x: number, y: number, z: number): boolean;
}

/** Throws unless `n` is one of {@link RELIEF_SUBDIVISIONS}. */
export function checkReliefOptions(o: ReliefOptions): void {
  if (!RELIEF_SUBDIVISIONS.includes(o.n)) throw new RangeError(`relief: n ${o.n} (one of ${RELIEF_SUBDIVISIONS.join(', ')})`);
  const f = o.plainNeighbours ?? 0;
  if (!Number.isInteger(f) || (f & ~NEIGHBOURS_ALL) !== 0) throw new RangeError(`relief: plain neighbours ${f}`);
}

/** Edge tags while refining: on a source edge, that edge a crease, kept whole. */
const ON_SOURCE = 1;
const CREASE = 2;
const FROZEN = 4;

/** Per-thread working arrays (vertex capacity `cap`), grown to the largest surface seen. */
let cap = 1024;
let px = new Float64Array(3 * cap);
let nx = new Float64Array(3 * cap);
let ow = new Float64Array(3 * cap);
let crk = new Uint8Array(cap);
let wt = new Uint8Array(cap);
let tris = new Uint32Array(3 * 1024);
let count = 0;
let triLen = 0;
const mids = new Map<number, number>();
let limit = 0;
let pointRule: CreaseRule['point'] = undefined;

/** Room for at least `need` vertices. */
function reserve(need: number): void {
  if (need <= cap) return;
  while (cap < need) cap *= 2;
  const g = <T extends Float64Array | Uint8Array>(a: T, k: number): T => {
    const b = new (a.constructor as new (n: number) => T)(cap * k);
    b.set(a);
    return b;
  };
  px = g(px, 3);
  nx = g(nx, 3);
  ow = g(ow, 3);
  crk = g(crk, 1);
  wt = g(wt, 1);
}

function addTri(a: number, b: number, c: number): void {
  if (triLen + 3 > tris.length) {
    const t = new Uint32Array(tris.length * 2);
    t.set(tris);
    tris = t;
  }
  tris[triLen++] = a;
  tris[triLen++] = b;
  tris[triLen++] = c;
}

/** The longest axis span of edge a–b (position steps). */
function span(a: number, b: number): number {
  return Math.max(Math.abs(px[3 * a]! - px[3 * b]!), Math.abs(px[3 * a + 1]! - px[3 * b + 1]!), Math.abs(px[3 * a + 2]! - px[3 * b + 2]!));
}

function needs(a: number, b: number, tag: number): boolean {
  return (tag & FROZEN) === 0 && span(a, b) > limit;
}

/** The point halfway along edge a–b, one for both triangles that share it. */
function mid(a: number, b: number, tag: number): number {
  const key = a < b ? a * 0x4000000 + b : b * 0x4000000 + a;
  const known = mids.get(key);
  if (known !== undefined) return known;
  reserve(count + 1);
  const m = count++;
  for (let k = 0; k < 3; k++) {
    px[3 * m + k] = (px[3 * a + k]! + px[3 * b + k]!) / 2;
    nx[3 * m + k] = nx[3 * a + k]! + nx[3 * b + k]!;
    ow[3 * m + k] = (ow[3 * a + k]! + ow[3 * b + k]!) / 2;
  }
  crk[m] = crk[a]!;
  wt[m] = ((tag & ON_SOURCE) !== 0 && (tag & CREASE) !== 0) || pointRule?.(px[3 * m]!, px[3 * m + 1]!, px[3 * m + 2]!) === true ? 0 : RELIEF_FREE;
  mids.set(key, m);
  return m;
}

/** Splits triangle a, b, c (edge tags ab, bc, ca) until no edge needs it. */
function refine(a: number, b: number, c: number, tab: number, tbc: number, tca: number): void {
  const sab = needs(a, b, tab);
  const sbc = needs(b, c, tbc);
  const sca = needs(c, a, tca);
  if (!sab && !sbc && !sca) {
    addTri(a, b, c);
    return;
  }
  if (((tab | tbc | tca) & FROZEN) !== 0) {
    fanFrozen(a, b, c, tab, tbc, tca);
    return;
  }
  if (sab && sbc && sca) {
    const mab = mid(a, b, tab);
    const mbc = mid(b, c, tbc);
    const mca = mid(c, a, tca);
    refine(a, mab, mca, tab, 0, tca);
    refine(mab, b, mbc, tab, tbc, 0);
    refine(mca, mbc, c, 0, tbc, tca);
    refine(mab, mbc, mca, 0, 0, 0);
    return;
  }
  // The longest edge that needs it (ties in the order ab, bc, ca), halved.
  const lab = sab ? span(a, b) : -1;
  const lbc = sbc ? span(b, c) : -1;
  const lca = sca ? span(c, a) : -1;
  if (lab >= lbc && lab >= lca) {
    const m = mid(a, b, tab);
    refine(a, m, c, tab, 0, tca);
    refine(m, b, c, tab, tbc, 0);
  } else if (lbc >= lca) {
    const m = mid(b, c, tbc);
    refine(a, b, m, tab, tbc, 0);
    refine(a, m, c, 0, tbc, tca);
  } else {
    const m = mid(c, a, tca);
    refine(a, b, m, tab, 0, tca);
    refine(m, b, c, 0, tbc, tca);
  }
}

/** The points edge a–b is split at, from a to b (both left out): the same as a triangle's refinement splits it at. */
function chain(a: number, b: number, tag: number, out: number[]): void {
  if (!needs(a, b, tag)) return;
  const m = mid(a, b, tag);
  chain(a, m, tag, out);
  out.push(m);
  chain(m, b, tag, out);
}

const ring: number[] = [];

/**
 * A triangle with an edge kept whole (toward a plain neighbour) and another
 * to split: its outline, with every split point its other edges take, fanned
 * from a point inside it (a point no other triangle shares), since halving
 * toward the whole edge would never end.
 */
function fanFrozen(a: number, b: number, c: number, tab: number, tbc: number, tca: number): void {
  ring.length = 0;
  ring.push(a);
  chain(a, b, tab, ring);
  ring.push(b);
  chain(b, c, tbc, ring);
  ring.push(c);
  chain(c, a, tca, ring);
  reserve(count + 1);
  const m = count++;
  for (let k = 0; k < 3; k++) {
    px[3 * m + k] = (px[3 * a + k]! + px[3 * b + k]! + px[3 * c + k]!) / 3;
    nx[3 * m + k] = nx[3 * a + k]! + nx[3 * b + k]! + nx[3 * c + k]!;
    ow[3 * m + k] = (ow[3 * a + k]! + ow[3 * b + k]! + ow[3 * c + k]!) / 3;
  }
  crk[m] = crk[a]!;
  wt[m] = pointRule?.(px[3 * m]!, px[3 * m + 1]!, px[3 * m + 2]!) === true ? 0 : RELIEF_FREE;
  const pts = ring.slice();
  for (let j = 0; j < pts.length; j++) addTri(m, pts[j]!, pts[(j + 1) % pts.length]!);
}

/** The empty relief surface. */
export function emptyReliefSurface(): ReliefSurface {
  return { vertexCount: 0, vertices: new Uint8Array(0), indices: new Uint16Array(0), crease: new Uint8Array(0) };
}

/**
 * The relief mesh of one source surface of a derive unit of `edge` cells
 * (positions from one cell below its corner), `n` lattice steps a cell, its
 * creases read by `rule`, kept whole toward `plainNeighbours`.
 */
export function subdivideSurface(src: SurfaceBuffer, edge: number, n: number, plainNeighbours: number, rule: CreaseRule): ReliefSurface {
  if (src.vertexCount === 0) return emptyReliefSurface();
  checkReliefOptions({ n, plainNeighbours });
  limit = (1.5 * S) / n;
  pointRule = rule.point;
  count = src.vertexCount;
  triLen = 0;
  mids.clear();
  reserve(count);
  const view = new DataView(src.vertices.buffer, src.vertices.byteOffset, src.vertices.byteLength);
  const reach = rule.sharedReachSteps;
  // Per plain neighbour: its offset; a point is near it when on every axis it points along, the point is within reach of the face toward it.
  const plain: number[] = [];
  for (let k = 0; k < 27; k++) if ((plainNeighbours & (1 << k)) !== 0) plain.push(Math.floor(k / 9) - 1, (Math.floor(k / 3) % 3) - 1, (k % 3) - 1);
  const lo = S + reach;
  const hi = (edge + 1) * S - reach;
  const nearPlain = (v: number, f: number): boolean => {
    for (let a = 0; a < 3; a++) {
      const d = plain[f + a]!;
      const q = px[3 * v + a]!;
      if ((d < 0 && q > lo) || (d > 0 && q < hi)) return false;
    }
    return true;
  };
  for (let v = 0; v < count; v++) {
    const o = v * SURFACE_VERTEX_BYTES;
    for (let k = 0; k < 3; k++) {
      px[3 * v + k] = view.getUint16(o + 2 * k, true);
      nx[3 * v + k] = view.getInt8(o + 8 + k) / 127;
    }
    const owner = surfaceOwnerOf(view, o);
    for (let k = 0; k < 3; k++) ow[3 * v + k] = owner === null ? Number.NaN : owner[k]!;
    crk[v] = surfaceCrackOf(view, o);
    let fixed = rule.vertex(v);
    for (let f = 0; f < plain.length && !fixed; f += 3) if (nearPlain(v, f)) fixed = true;
    wt[v] = fixed ? 0 : RELIEF_FREE;
  }
  const tag = (a: number, b: number): number => {
    let t = ON_SOURCE | (rule.edge(a, b) ? CREASE : 0);
    for (let f = 0; f < plain.length; f += 3) if (nearPlain(a, f) && nearPlain(b, f)) t |= FROZEN;
    return t;
  };
  const idx = src.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]!, b = idx[t + 1]!, c = idx[t + 2]!;
    refine(a, b, c, tag(a, b), tag(b, c), tag(c, a));
  }
  mids.clear();
  pointRule = undefined;
  return writeRelief();
}

const ownerScratch = [0, 0, 0];

function writeRelief(): ReliefSurface {
  const vertices = new Uint8Array(count * SURFACE_VERTEX_BYTES);
  const view = new DataView(vertices.buffer);
  for (let v = 0; v < count; v++) {
    const o = v * SURFACE_VERTEX_BYTES;
    for (let k = 0; k < 3; k++) view.setUint16(o + 2 * k, Math.round(px[3 * v + k]!), true);
    const x = nx[3 * v]!, y = nx[3 * v + 1]!, z = nx[3 * v + 2]!;
    const len = Math.hypot(x, y, z) || 1;
    view.setInt8(o + 8, snorm8(x / len));
    view.setInt8(o + 9, snorm8(y / len));
    view.setInt8(o + 10, snorm8(z / len));
    const owned = !Number.isNaN(ow[3 * v]!);
    if (owned) for (let k = 0; k < 3; k++) ownerScratch[k] = Math.round(ow[3 * v + k]!);
    writeSurfaceExtras(view, v, crk[v]!, owned ? ownerScratch : null);
  }
  const t = tris.subarray(0, triLen);
  const indices = count < 65536 ? new Uint16Array(t) : new Uint32Array(t);
  return { vertexCount: count, vertices, indices, crease: wt.slice(0, count) };
}

/**
 * Marks (bit 1 of `flags`) every ground vertex within half a cell of a
 * modular body's cell (a wall, beam or rail: drawn by the base surface).
 * The ground meets a body along a line the body's faces stop at, so the
 * ground there must not move away from it. A function of the vertex's
 * position and the cells' classes, so every section meeting a vertex marks
 * it alike; reads one cell round the unit.
 */
export function markGroundNearBodies(n: Neighbourhood, classes: Uint8Array, ground: SurfaceBuffer, flags: Uint8Array): void {
  const s = n.side;
  const p = n.pad;
  const view = new DataView(ground.vertices.buffer, ground.vertices.byteOffset, ground.vertices.byteLength);
  const lo = [0, 0, 0];
  for (let v = 0; v < ground.vertexCount; v++) {
    for (let k = 0; k < 3; k++) lo[k] = Math.floor((view.getUint16(v * SURFACE_VERTEX_BYTES + 2 * k, true) - S / 2) / S) - 1;
    let near = false;
    for (let x = lo[0]!; x <= lo[0]! + 1 && !near; x++) for (let z = lo[2]!; z <= lo[2]! + 1 && !near; z++) for (let y = lo[1]!; y <= lo[1]! + 1; y++) {
      const c = classes[((x + p) * s + (z + p)) * s + (y + p)]! & CLASS_MASK;
      if (c === ASSEMBLY_CLASS.wall || c === ASSEMBLY_CLASS.beam || c === ASSEMBLY_CLASS.rail) {
        near = true;
        break;
      }
    }
    if (near) flags[v]! |= 2;
  }
}

/** The ground's crease rule from the terrain mesher's crease flags (terrain-mesher.ts `TerrainCreases`) and {@link markGroundNearBodies}. */
export function groundCreaseRule(flags: Uint8Array): CreaseRule {
  return {
    // A crease vertex's copies carry different normals on either side of the crease: an edge touching one stays.
    vertex: (v) => flags[v] !== 0,
    edge: (a, b) => flags[a] !== 0 || flags[b] !== 0,
    sharedReachSteps: S / 2,
  };
}

/**
 * A roof surface's crease rule from its own triangles: an edge whose two
 * triangles turn more than {@link RELIEF_CREASE_DEG}, or that has not
 * exactly two, is a crease, and so are its ends; so is every vertex and
 * edge within a cell of the unit's faces, where a neighbouring unit's
 * roof polygons may reach (an underside one cell lower), since this unit
 * cannot see those. A vertex touching a body cell that is no plane cell
 * (`elsewhere` 0: a wall the roof rests on or grazes) is fixed too: the
 * roof meets it there without sharing an edge with it; so is every point
 * the split adds that touches one (a merged row's points along a wall
 * top), read at the point.
 */
export function roofCreaseRule(src: SurfaceBuffer, edge: number, n: Neighbourhood, classes: Uint8Array, elsewhere: Uint32Array): CreaseRule {
  const view = new DataView(src.vertices.buffer, src.vertices.byteOffset, src.vertices.byteLength);
  const p = (v: number, k: number): number => view.getUint16(v * SURFACE_VERTEX_BYTES + 2 * k, true);
  const key = (v: number): string => `${p(v, 0)},${p(v, 1)},${p(v, 2)}`;
  const weld = new Map<string, number>();
  const id = new Int32Array(src.vertexCount);
  for (let v = 0; v < src.vertexCount; v++) {
    const k = key(v);
    let w = weld.get(k);
    if (w === undefined) weld.set(k, (w = weld.size));
    id[v] = w;
  }
  const edgeKey = (a: number, b: number): number => {
    const x = id[a]!, y = id[b]!;
    return x < y ? x * 0x4000000 + y : y * 0x4000000 + x;
  };
  const faces = new Map<number, number[]>();
  const idx = src.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]!, b = idx[t + 1]!, c = idx[t + 2]!;
    const ux = p(b, 0) - p(a, 0), uy = p(b, 1) - p(a, 1), uz = p(b, 2) - p(a, 2);
    const vx = p(c, 0) - p(a, 0), vy = p(c, 1) - p(a, 1), vz = p(c, 2) - p(a, 2);
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const len = Math.hypot(fx, fy, fz) || 1;
    for (const [i, j] of [[a, b], [b, c], [c, a]] as const) {
      const k = edgeKey(i, j);
      let list = faces.get(k);
      if (list === undefined) faces.set(k, (list = []));
      list.push(fx / len, fy / len, fz / len);
    }
  }
  const creaseEdge = (a: number, b: number): boolean => {
    const list = faces.get(edgeKey(a, b));
    if (list === undefined || list.length !== 6) return true;
    return list[0]! * list[3]! + list[1]! * list[4]! + list[2]! * list[5]! < CREASE_COS;
  };
  const creaseAt = new Uint8Array(weld.size);
  for (let t = 0; t < idx.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t + k]!, b = idx[t + ((k + 1) % 3)]!;
      if (creaseEdge(a, b)) {
        creaseAt[id[a]!] = 1;
        creaseAt[id[b]!] = 1;
      }
    }
  }
  /** Whether vertex v lies within a cell of face f of the unit (2 · axis + side). */
  const near = (v: number, f: number): boolean => Math.abs(p(v, f >> 1) - ((f & 1) === 1 ? edge + 1 : 1) * S) <= S;
  const side = n.side;
  const pad = n.pad;
  /** Whether a body cell that is no plane cell holds the point (steps; in its closed box). Read only more than a cell inside the unit. */
  const lo = [0, 0, 0];
  const hi = [0, 0, 0];
  const bodyAt = (qx: number, qy: number, qz: number): boolean => {
    const q = [qx, qy, qz];
    for (let k = 0; k < 3; k++) {
      const c = q[k]! / S - 1;
      lo[k] = Number.isInteger(c) ? c - 1 : Math.floor(c);
      hi[k] = Math.floor(c);
    }
    for (let x = lo[0]!; x <= hi[0]!; x++) for (let z = lo[2]!; z <= hi[2]!; z++) for (let y = lo[1]!; y <= hi[1]!; y++) {
      const i = ((x + pad) * side + (z + pad)) * side + (y + pad);
      const c = classes[i]! & CLASS_MASK;
      if (elsewhere[i] === 0 && (c === ASSEMBLY_CLASS.wall || c === ASSEMBLY_CLASS.beam || c === ASSEMBLY_CLASS.rail)) return true;
    }
    return false;
  };
  const nearAt = (qx: number, qy: number, qz: number): boolean => {
    const q = [qx, qy, qz];
    for (let k = 0; k < 3; k++) if (Math.abs(q[k]! - S) <= S || Math.abs(q[k]! - (edge + 1) * S) <= S) return true;
    return false;
  };
  const onBody = (v: number): boolean => bodyAt(p(v, 0), p(v, 1), p(v, 2));
  return {
    vertex: (v) => creaseAt[id[v]!] === 1 || [0, 1, 2, 3, 4, 5].some((f) => near(v, f)) || onBody(v),
    edge: (a, b) => creaseEdge(a, b) || [0, 1, 2, 3, 4, 5].some((f) => near(a, f) && near(b, f)),
    sharedReachSteps: S,
    // A point along a merged row: fixed where it touches a body or lies within a cell of the unit's faces.
    point: (x, y, z) => nearAt(x, y, z) || bodyAt(x, y, z),
  };
}

/** Two relief surfaces as one (b's vertices after a's). */
export function appendRelief(a: ReliefSurface, b: ReliefSurface): ReliefSurface {
  if (b.vertexCount === 0) return a;
  if (a.vertexCount === 0) return b;
  const crease = new Uint8Array(a.vertexCount + b.vertexCount);
  crease.set(a.crease);
  crease.set(b.crease, a.vertexCount);
  return { ...appendSurface(a, b), crease };
}

/** Bytes a relief part holds (its arrays). */
export function reliefBytes(r: ReliefPart): number {
  let n = 0;
  for (const s of [r.ground, r.base]) n += s.vertices.byteLength + s.indices.byteLength + s.crease.byteLength;
  return n;
}

/** A relief part's buffers, for a transfer list. */
export function reliefTransfer(r: ReliefPart, out: ArrayBuffer[]): void {
  for (const s of [r.ground, r.base]) for (const a of [s.vertices, s.indices, s.crease]) if (a.buffer instanceof ArrayBuffer && !out.includes(a.buffer)) out.push(a.buffer);
}
