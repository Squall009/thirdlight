/**
 * The modular base surface of a derive job's chunk (or section): the
 * exposed faces of its wall-class cells (walls, floors, roofs, stairs,
 * foundations), coplanar faces merged into rectangles (greedy, row by row
 * in each face layer), in the derive's surface layout (derived-mesh.ts).
 *
 * Which cells are bodies is read from their forms (case-forms.ts): a kept
 * whole box is a body; a cell whose case suppresses the base (a beam, a
 * banister's rail and posts) gets nothing, because its detail piece
 * replaces it, so the faces of the walls behind it are kept; at a level
 * that draws no pieces (`piecesAsBodies`) it is a body like a wall. A face
 * is exposed when its neighbour is neither a body nor ground at least half
 * full.
 *
 * **No T-junctions.** A rectangle's edge takes, besides its corners, every
 * lattice point on it where another rectangle of the job has a corner, so
 * every edge two rectangles share is split at the same points; on a
 * section's (or chunk's) faces it takes every lattice point, since the
 * neighbour merges on its own: both sides then split a shared edge cell by
 * cell. Merges never cross a section face. The ground and the detail
 * pieces are separate meshes that only overlap the base (they share no
 * edges with it), so they set no vertex on it. A rectangle with no extra
 * point on two neighbouring edges is a fan from the corner between them
 * (one triangle a point less two); otherwise a fan from its centre.
 *
 * Vertices carry no material (the shader blends by world position), so a
 * merge across materials looks the same as the faces it replaces. A cracked
 * cell's faces (damage stage 1) carry the crack overlay's strength in their
 * vertices (position w) and merge only with faces of the same strength.
 */
import { ASSEMBLY_CLASS, CLASS_MASK, type Neighbourhood } from './assembly';
import { FORM_BASE, FORM_SHAPE, formBaseOf, formShapeOf } from './case-forms';
import { POSITION_STEPS_PER_CELL, SURFACE_ISO, SURFACE_VERTEX_BYTES, type SurfaceBuffer } from './derived-mesh';

const STEPS = POSITION_STEPS_PER_CELL;

/** Per-thread working arrays, grown to the largest job seen. */
let faces = new Uint8Array(0);
/** Per cell: the crack overlay's strength on its faces (0 … 255). */
let cracks = new Uint8Array(0);
/** Per face cell of a layer: 0 none, else 1 + its crack strength (faces merge only with equal values). */
let mask = new Uint16Array(0);
/** Rectangles: direction, layer, a0, b0, a1, b1 (in-plane cells, ends exclusive), crack strength. */
const RECT = 7;
let rects = new Int32Array(RECT * 256);
let rectCount = 0;
/** Lattice points that are some rectangle's corner (stamped by call). */
let cornerStamp = new Uint32Array(0);
/** Output vertex per lattice point and direction (stamped by call). */
let vertexStamp = new Uint32Array(0);
let vertexOf = new Int32Array(0);
let call = 0;
let pos = new Int32Array(3 * 1024);
let nrm = new Int8Array(3 * 1024);
let crk = new Uint8Array(1024);
let tris = new Uint32Array(3 * 2048);
let vertexCount = 0;
let triLen = 0;
/** One rectangle's perimeter: lattice (u, v) of each point, and where each corner sits in it. */
let ring = new Int32Array(2 * 256);
const cornerAt = new Int32Array(4);
const extra = new Int32Array(4);

/** Face directions: axis (0 x, 1 y, 2 z) and sign, as bit d of a cell's face mask. */
const AXIS = [0, 0, 1, 1, 2, 2] as const;
const SIGN = [-1, 1, -1, 1, -1, 1] as const;

function addVertex(x: number, y: number, z: number, d: number, crack: number): number {
  if (3 * vertexCount + 3 > pos.length) {
    const p = new Int32Array(pos.length * 2);
    p.set(pos);
    pos = p;
    const q = new Int8Array(nrm.length * 2);
    q.set(nrm);
    nrm = q;
    const c = new Uint8Array(crk.length * 2);
    c.set(crk);
    crk = c;
  }
  crk[vertexCount] = crack;
  const o = 3 * vertexCount;
  pos[o] = x;
  pos[o + 1] = y;
  pos[o + 2] = z;
  nrm[o] = 0;
  nrm[o + 1] = 0;
  nrm[o + 2] = 0;
  nrm[o + AXIS[d]!] = SIGN[d]! * 127;
  return vertexCount++;
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

function addRect(d: number, layer: number, a0: number, b0: number, a1: number, b1: number, crack: number): void {
  if (RECT * rectCount + RECT > rects.length) {
    const r = new Int32Array(rects.length * 2);
    r.set(rects);
    rects = r;
  }
  const o = RECT * rectCount++;
  rects[o + 6] = crack;
  rects[o] = d;
  rects[o + 1] = layer;
  rects[o + 2] = a0;
  rects[o + 3] = b0;
  rects[o + 4] = a1;
  rects[o + 5] = b1;
}

function buildSurface(): SurfaceBuffer {
  const vertices = new Uint8Array(vertexCount * SURFACE_VERTEX_BYTES);
  const view = new DataView(vertices.buffer);
  for (let v = 0; v < vertexCount; v++) {
    const at = v * SURFACE_VERTEX_BYTES;
    view.setUint16(at, pos[3 * v]!, true);
    view.setUint16(at + 2, pos[3 * v + 1]!, true);
    view.setUint16(at + 4, pos[3 * v + 2]!, true);
    view.setUint16(at + 6, crk[v]!, true);
    view.setInt8(at + 8, nrm[3 * v]!);
    view.setInt8(at + 9, nrm[3 * v + 1]!);
    view.setInt8(at + 10, nrm[3 * v + 2]!);
  }
  const t = tris.subarray(0, triLen);
  const indices = vertexCount < 65536 ? new Uint16Array(t) : new Uint32Array(t);
  return { vertexCount, vertices, indices };
}

/** The crack overlay's strength (0 … 255) of a body cell's faces from its value (damage stage 1; piece-table.ts crackStrengthOf). */
export type CrackOf = (value: number) => number;

/** Per neighbourhood cell: non-zero for a cell another surface draws (a roof's plane cell): no faces of its own, and it hides none. */
let drawnElsewhere: Uint32Array | null = null;

/** Whether a cell's form is a body the base surface draws whole (a suppressed one only at a level without pieces). */
function isBody(form: number, piecesAsBodies: boolean): boolean {
  const base = formBaseOf(form);
  if (base === FORM_BASE.keep) return formShapeOf(form) === FORM_SHAPE.box;
  return base === FORM_BASE.suppress && piecesAsBodies;
}

/** Whether cell `i` hides the face of its neighbour looking toward it (a body, or ground at least half full). */
function hides(n: Neighbourhood, classes: Uint8Array, forms: Uint8Array, i: number, piecesAsBodies: boolean): boolean {
  if (drawnElsewhere !== null && drawnElsewhere[i] !== 0) return false;
  const f = forms[i]!;
  if (isBody(f, piecesAsBodies)) return true;
  return (classes[i]! & CLASS_MASK) === ASSEMBLY_CLASS.ground && n.shapes[i]! >= SURFACE_ISO;
}

/**
 * The base surface of a job's chunk (or section) from its neighbourhood,
 * resolved classes and forms (reads one cell round the chunk).
 * `piecesAsBodies`: cells whose pieces replace their base are drawn as
 * bodies (a level without pieces). `elsewhere` (neighbourhood indexing,
 * non-zero: drawn by another surface, a roof's planes) leaves a cell's
 * faces out and keeps its neighbours' faces toward it, so the bodies'
 * surface stays closed on its own.
 */
export function baseSurface(n: Neighbourhood, classes: Uint8Array, forms: Uint8Array, piecesAsBodies = false, elsewhere: Uint32Array | null = null, crackOf: CrackOf | null = null): SurfaceBuffer {
  drawnElsewhere = elsewhere;
  try {
    return bodySurface(n, classes, forms, piecesAsBodies, crackOf);
  } finally {
    drawnElsewhere = null;
  }
}

function bodySurface(n: Neighbourhood, classes: Uint8Array, forms: Uint8Array, piecesAsBodies: boolean, crackOf: CrackOf | null): SurfaceBuffer {
  const e = n.edge;
  const p = n.pad;
  const s = n.side;
  const stride = [s * s, 1, s];
  vertexCount = 0;
  triLen = 0;
  rectCount = 0;
  // Each cell's exposed faces (bit d: direction d), cell (x, y, z) at (x · e + y) · e + z.
  if (faces.length < e * e * e) {
    faces = new Uint8Array(e * e * e);
    cracks = new Uint8Array(e * e * e);
  }
  let any = 0;
  for (let x = 0; x < e; x++) for (let y = 0; y < e; y++) for (let z = 0; z < e; z++) {
    const i = ((x + p) * s + (z + p)) * s + (y + p);
    let f = 0;
    if (isBody(forms[i]!, piecesAsBodies) && (drawnElsewhere === null || drawnElsewhere[i] === 0)) {
      for (let d = 0; d < 6; d++) if (!hides(n, classes, forms, i + SIGN[d]! * stride[AXIS[d]!]!, piecesAsBodies)) f |= 1 << d;
    }
    faces[(x * e + y) * e + z] = f;
    cracks[(x * e + y) * e + z] = f !== 0 && crackOf !== null ? crackOf(n.values[i]!) : 0;
    any |= f;
  }
  if (any === 0) return buildSurface();

  // Rectangles a direction and layer: the face plane's axes u, v (u × v outward), cells a along u, b along v.
  if (mask.length < e * e) mask = new Uint16Array(e * e);
  const cell = [0, 0, 0];
  for (let d = 0; d < 6; d++) {
    if ((any & (1 << d)) === 0) continue;
    const axis = AXIS[d]!;
    const u = (axis + (SIGN[d]! > 0 ? 1 : 2)) % 3;
    const v = (axis + (SIGN[d]! > 0 ? 2 : 1)) % 3;
    const bit = 1 << d;
    for (let layer = 0; layer < e; layer++) {
      cell[axis] = layer;
      let set = 0;
      for (let b = 0; b < e; b++) for (let a = 0; a < e; a++) {
        cell[u] = a;
        cell[v] = b;
        const c = (cell[0]! * e + cell[1]!) * e + cell[2]!;
        const on = faces[c]! & bit;
        mask[b * e + a] = on === 0 ? 0 : 1 + cracks[c]!;
        set |= on;
      }
      if (set === 0) continue;
      for (let b = 0; b < e; b++) for (let a = 0; a < e; a++) {
        const val = mask[b * e + a]!;
        if (val === 0) continue;
        let w = 1;
        while (a + w < e && mask[b * e + a + w] === val) w++;
        let h = 1;
        grow: while (b + h < e) {
          const row = (b + h) * e + a;
          for (let k = 0; k < w; k++) if (mask[row + k] !== val) break grow;
          h++;
        }
        for (let r = b; r < b + h; r++) mask.fill(0, r * e + a, r * e + a + w);
        addRect(d, layer, a, b, a + w, b + h, val - 1);
      }
    }
  }

  // Every rectangle's corners, as lattice points (x, y, z in 0 … e) at (x · m + y) · m + z.
  const m = e + 1;
  const points = m * m * m;
  if (cornerStamp.length < points) {
    cornerStamp = new Uint32Array(points);
    vertexStamp = new Uint32Array(points * 6);
    vertexOf = new Int32Array(points * 6);
    call = 0;
  }
  call++;
  const now = call;
  const lattice = [0, 0, 0];
  /** The lattice point of a direction's plane coordinate and in-plane (a, b). */
  const pointOf = (axis: number, u: number, v: number, plane: number, a: number, b: number): number => {
    lattice[axis] = plane;
    lattice[u] = a;
    lattice[v] = b;
    return (lattice[0]! * m + lattice[1]!) * m + lattice[2]!;
  };
  for (let r = 0; r < rectCount; r++) {
    const o = RECT * r;
    const d = rects[o]!;
    const axis = AXIS[d]!;
    const u = (axis + (SIGN[d]! > 0 ? 1 : 2)) % 3;
    const v = (axis + (SIGN[d]! > 0 ? 2 : 1)) % 3;
    const plane = rects[o + 1]! + (SIGN[d]! > 0 ? 1 : 0);
    const a0 = rects[o + 2]!, b0 = rects[o + 3]!, a1 = rects[o + 4]!, b1 = rects[o + 5]!;
    cornerStamp[pointOf(axis, u, v, plane, a0, b0)] = now;
    cornerStamp[pointOf(axis, u, v, plane, a1, b0)] = now;
    cornerStamp[pointOf(axis, u, v, plane, a1, b1)] = now;
    cornerStamp[pointOf(axis, u, v, plane, a0, b1)] = now;
  }
  for (let r = 0; r < rectCount; r++) {
    const o = RECT * r;
    const d = rects[o]!;
    const axis = AXIS[d]!;
    const u = (axis + (SIGN[d]! > 0 ? 1 : 2)) % 3;
    const v = (axis + (SIGN[d]! > 0 ? 2 : 1)) % 3;
    const plane = rects[o + 1]! + (SIGN[d]! > 0 ? 1 : 0);
    const a0 = rects[o + 2]!, b0 = rects[o + 3]!, a1 = rects[o + 4]!, b1 = rects[o + 5]!;
    // The whole rectangle on a section face: every edge of it lies there.
    const onFace = plane === 0 || plane === e;
    if (ring.length < 4 * (a1 - a0 + b1 - b0)) ring = new Int32Array(8 * (a1 - a0 + b1 - b0));
    let k = 0;
    // The perimeter (a0, b0) → (a1, b0) → (a1, b1) → (a0, b1), counter-clockwise seen from outside.
    for (let side = 0; side < 4; side++) {
      const alongA = (side & 1) === 0;
      const fromA = side === 0 || side === 3 ? a0 : a1;
      const fromB = side < 2 ? b0 : b1;
      const toA = side < 2 ? a1 : a0;
      const toB = side === 0 || side === 3 ? b0 : b1;
      const fixed = alongA ? fromB : fromA;
      const all = onFace || fixed === 0 || fixed === e;
      cornerAt[side] = k;
      ring[2 * k] = fromA;
      ring[2 * k + 1] = fromB;
      k++;
      let added = 0;
      const step = alongA ? Math.sign(toA - fromA) : Math.sign(toB - fromB);
      const len = alongA ? Math.abs(toA - fromA) : Math.abs(toB - fromB);
      for (let t = 1; t < len; t++) {
        const pa = alongA ? fromA + step * t : fromA;
        const pb = alongA ? fromB : fromB + step * t;
        if (!all && cornerStamp[pointOf(axis, u, v, plane, pa, pb)] !== now) continue;
        ring[2 * k] = pa;
        ring[2 * k + 1] = pb;
        k++;
        added++;
      }
      extra[side] = added;
    }
    // Output vertices of the ring, shared by direction with the job's other rectangles.
    // A cracked rectangle's vertices are its own (they carry its strength); they sit on the same points.
    const crack = rects[o + 6]!;
    for (let j = 0; j < k; j++) {
      const key = pointOf(axis, u, v, plane, ring[2 * j]!, ring[2 * j + 1]!) * 6 + d;
      if (crack !== 0) {
        ring[2 * j] = addVertex((lattice[0]! + 1) * STEPS, (lattice[1]! + 1) * STEPS, (lattice[2]! + 1) * STEPS, d, crack);
        continue;
      }
      if (vertexStamp[key] !== now) {
        vertexStamp[key] = now;
        vertexOf[key] = addVertex((lattice[0]! + 1) * STEPS, (lattice[1]! + 1) * STEPS, (lattice[2]! + 1) * STEPS, d, 0);
      }
      ring[2 * j] = vertexOf[key]!;
    }
    // A corner between two edges with no extra point fans the ring without a sliver; else the centre fans it.
    let apex = -1;
    for (let c = 0; c < 4 && apex < 0; c++) if (extra[c] === 0 && extra[(c + 3) & 3] === 0) apex = cornerAt[c]!;
    if (apex >= 0) {
      for (let j = 1; j + 1 < k; j++) addTri(ring[2 * apex]!, ring[2 * ((apex + j) % k)]!, ring[2 * ((apex + j + 1) % k)]!);
    } else {
      // The centre: whole or half cells, so whole steps.
      lattice[axis] = (plane + 1) * STEPS;
      lattice[u] = ((a0 + a1) * STEPS) / 2 + STEPS;
      lattice[v] = ((b0 + b1) * STEPS) / 2 + STEPS;
      const c = addVertex(lattice[0]!, lattice[1]!, lattice[2]!, d, crack);
      for (let j = 0; j < k; j++) addTri(c, ring[2 * j]!, ring[2 * ((j + 1) % k)]!);
    }
  }
  return buildSurface();
}
