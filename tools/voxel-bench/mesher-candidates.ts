/**
 * Terrain mesher candidates, measured against each other on the hard cases
 * and the test worlds before one goes into the package. Every candidate
 * reads the same thing: a derive job's neighbourhood (pad = the terrain
 * rules' job radius) and its resolved classes, and writes the derive's
 * ground surface layout (12-byte vertices, chunk-local positions in
 * 1/{@link POSITION_STEPS_PER_CELL} steps from one cell below the chunk's
 * corner), so the golden harness, the heightfield check and the byte counts
 * apply to all of them unchanged.
 *
 * - `reference`: the naive surface nets the derive used before the terrain
 *   mesher (vertex at the mean of the dual cube's edge crossings), written
 *   over the same density field as the others: the "before" of the goldens.
 * - `lattice`: surface nets whose dual cubes over a height function put
 *   their vertex on the column lattice (the cube's centre x/z, a cell
 *   corner) at the height the four sample columns' fill gives; stacked
 *   cubes of one column share that vertex, so the ground there is a lattice
 *   heightfield. Cubes elsewhere place as the reference.
 * - `dc`: surface nets with dual-contouring placement (the edge crossings'
 *   planes, a QEF clamped to the cube) only in cubes that touch a cell the
 *   terrain rules call a cliff or a terrace lip; elsewhere the reference.
 * - `lattice+dc`: the rules' creases first (dual contouring), then the
 *   column lattice, then the reference.
 * - `terrain`: the package's terrain mesher (terrain-mesher.ts), the pick
 *   built: `lattice+dc` with its other vertices kept inside their cubes and
 *   off the lattice.
 * - `mc`: marching cubes over the same samples, one vertex a sign-changing
 *   sample edge, with a case table built from the cube's faces (each face's
 *   ambiguous diagonal resolved as separate inside corners, a face's own
 *   rule, so neighbouring cubes agree and the mesh closes).
 *
 * Crack-free across chunks: a vertex is a function of the samples around
 * it (all within the job's pad) quantised to whole steps, and each sample
 * edge (nets) or cube (marching cubes) belongs to one chunk.
 */
import {
  buildApron,
  chunkGrid,
  createDenseChunk,
  createNeighbourhood,
  DENSITY_FULL,
  evaluateAssembly,
  fillNeighbourhood,
  jobRadius,
  LATTICE_WINDOW,
  snorm8,
  TERRAIN_RULES,
  terrainSurface,
  type PaletteStore,
  POSITION_STEPS_PER_CELL,
  SURFACE_ISO,
  SURFACE_VERTEX_BYTES,
  TERRAIN_FEATURE,
  terrainFeatureOf,
  valueRole,
  VOXEL_ROLE,
  type Neighbourhood,
  type SurfaceBuffer,
} from '@thirdlight/voxel';

export interface MesherCandidate {
  readonly name: string;
  /** The ground surface of the neighbourhood's chunk (or section), from its resolved classes. */
  mesh(n: Neighbourhood, classes: Uint8Array): SurfaceBuffer;
}

const STEPS = POSITION_STEPS_PER_CELL;
/** Weight pulling a dual-contouring vertex toward its crossings' mean (keeps the QEF solvable along a crease). */
const QEF_PULL = 0.05;

/** A surface under construction, quantised positions and snorm8 normals in typed arrays. */
class Surface {
  pos = new Int32Array(3 * 1024);
  nrm = new Int8Array(3 * 1024);
  tris = new Uint32Array(3 * 2048);
  count = 0;
  triLen = 0;

  vertex(qx: number, qy: number, qz: number, nx: number, ny: number, nz: number): number {
    if (3 * this.count + 3 > this.pos.length) {
      const p = new Int32Array(this.pos.length * 2);
      p.set(this.pos);
      this.pos = p;
      const q = new Int8Array(this.nrm.length * 2);
      q.set(this.nrm);
      this.nrm = q;
    }
    const len = Math.hypot(nx, ny, nz) || 1;
    const o = 3 * this.count;
    this.pos[o] = qx;
    this.pos[o + 1] = qy;
    this.pos[o + 2] = qz;
    this.nrm[o] = snorm8(nx / len);
    this.nrm[o + 1] = snorm8(ny / len);
    this.nrm[o + 2] = snorm8(nz / len);
    return this.count++;
  }

  tri(a: number, b: number, c: number): void {
    if (this.triLen + 3 > this.tris.length) {
      const t = new Uint32Array(this.tris.length * 2);
      t.set(this.tris);
      this.tris = t;
    }
    this.tris[this.triLen++] = a;
    this.tris[this.triLen++] = b;
    this.tris[this.triLen++] = c;
  }

  /** A quad a → c → d → f; vertices shared by collapsed cubes leave a triangle or nothing (zero area). */
  quad(a: number, c: number, d: number, f: number): void {
    if (a !== c && c !== d && d !== f && f !== a) {
      if (a === d || c === f) return;
      this.tri(a, c, d);
      this.tri(a, d, f);
      return;
    }
    const loop = [a, c, d, f].filter((v, k, all) => v !== all[(k + 3) % 4]);
    if (loop.length === 3) this.tri(loop[0]!, loop[1]!, loop[2]!);
  }

  build(): SurfaceBuffer {
    const vertices = new Uint8Array(this.count * SURFACE_VERTEX_BYTES);
    const d = new DataView(vertices.buffer);
    for (let v = 0; v < this.count; v++) {
      const at = v * SURFACE_VERTEX_BYTES;
      d.setUint16(at, this.pos[3 * v]!, true);
      d.setUint16(at + 2, this.pos[3 * v + 1]!, true);
      d.setUint16(at + 4, this.pos[3 * v + 2]!, true);
      d.setInt8(at + 8, this.nrm[3 * v]!);
      d.setInt8(at + 9, this.nrm[3 * v + 1]!);
      d.setInt8(at + 10, this.nrm[3 * v + 2]!);
    }
    const t = this.tris.subarray(0, this.triLen);
    const indices = this.count < 65536 ? Uint16Array.from(t) : Uint32Array.from(t);
    return { vertexCount: this.count, vertices, indices };
  }
}

/** Corner offsets of a cube (bit 0 x, bit 1 y, bit 2 z) and its 12 edges as corner pairs. */
const CORNERS: Array<[number, number, number]> = [];
for (let c = 0; c < 8; c++) CORNERS.push([c & 1, (c >> 1) & 1, (c >> 2) & 1]);
const EDGES: Array<[number, number]> = [];
for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) if ((a & bit) === 0) EDGES.push([a, a | bit]);

/** The ground density of every cell of a neighbourhood (terrain role: its shape's density; else 0), same indexing. */
interface Field {
  readonly n: Neighbourhood;
  readonly dens: Uint8Array;
  /** Index of local cell (x, y, z) (−pad … edge + pad − 1). */
  at(x: number, y: number, z: number): number;
  readonly SX: number;
  readonly SZ: number;
}

const fieldScratch = new Map<number, Uint8Array>();

/** The density field, or null when no sample edge of the job's surface (local −1 … edge) changes sign. */
function fieldOf(n: Neighbourhood): Field | null {
  const len = n.values.length;
  let dens = fieldScratch.get(len);
  if (dens === undefined) {
    dens = new Uint8Array(len);
    fieldScratch.set(len, dens);
  }
  const vals = n.values;
  const shapes = n.shapes;
  for (let i = 0; i < len; i++) dens[i] = valueRole(vals[i]!) === VOXEL_ROLE.terrain ? shapes[i]! : 0;
  const s = n.side;
  const p = n.pad;
  const e = n.edge;
  let inside = 0;
  for (let x = -1; x <= e; x++) for (let z = -1; z <= e; z++) {
    const col = ((x + p) * s + (z + p)) * s + p;
    for (let y = -1; y <= e; y++) if (dens[col + y]! >= SURFACE_ISO) inside++;
  }
  if (inside === 0 || inside === (e + 2) ** 3) return null;
  return { n, dens, at: (x, y, z) => ((x + p) * s + (z + p)) * s + (y + p), SX: s * s, SZ: s };
}

/** Quantised position of a point `f` (0 … 1 across the cube) from the cube's first sample at local cell `cell`. */
function q(cell: number, f: number): number {
  return (cell + 1) * STEPS + STEPS / 2 + Math.round(f * STEPS);
}

/** Where a dual cube's vertex goes: quantised position and an (unnormalised) outward normal into `out`. */
type Placement = (fld: Field, classes: Uint8Array, x: number, y: number, z: number, out: Float64Array) => void;

const corner = new Float64Array(8);

function cubeCorners(fld: Field, x: number, y: number, z: number): void {
  const i = fld.at(x, y, z);
  for (let c = 0; c < 8; c++) corner[c] = fld.dens[i + (c & 1) * fld.SX + ((c >> 1) & 1) + ((c >> 2) & 1) * fld.SZ]!;
}

/** The cube's gradient normal (density rises into the ground, so outward is minus it) into out[3…5]. */
function cubeNormal(out: Float64Array): void {
  let gx = 0;
  let gy = 0;
  let gz = 0;
  for (let c = 0; c < 8; c++) {
    gx += (c & 1 ? 1 : -1) * corner[c]!;
    gy += ((c >> 1) & 1 ? 1 : -1) * corner[c]!;
    gz += ((c >> 2) & 1 ? 1 : -1) * corner[c]!;
  }
  out[3] = -gx;
  out[4] = -gy;
  out[5] = -gz;
}

/** The mean of the cube's edge crossings (cube-relative), as the reference places it; returns the crossing count. */
function meanCrossing(out: Float64Array): void {
  let fx = 0;
  let fy = 0;
  let fz = 0;
  let k = 0;
  for (const [a, c] of EDGES) {
    const da = corner[a]!;
    const dc = corner[c]!;
    if (da >= SURFACE_ISO === dc >= SURFACE_ISO) continue;
    const t = (SURFACE_ISO - 0.5 - da) / (dc - da);
    const A = CORNERS[a]!;
    const C = CORNERS[c]!;
    fx += A[0] + (C[0] - A[0]) * t;
    fy += A[1] + (C[1] - A[1]) * t;
    fz += A[2] + (C[2] - A[2]) * t;
    k++;
  }
  out[0] = fx / k;
  out[1] = fy / k;
  out[2] = fz / k;
}

const placeMean: Placement = (fld, _classes, x, y, z, out) => {
  cubeCorners(fld, x, y, z);
  meanCrossing(out);
  out[0] = q(x, out[0]!);
  out[1] = q(y, out[1]!);
  out[2] = q(z, out[2]!);
  cubeNormal(out);
};

const colSums = new Int32Array(4);

/**
 * Column-lattice placement when the cube's four sample columns are each a
 * height function over the window (full at its bottom, empty at its top,
 * never filling again going up): the vertex at the cube's centre x/z (a
 * cell corner) and the four columns' mean height, which does not depend on
 * where the window starts, so every cube of the column gives the same
 * vertex. False (nothing written) otherwise, or when that height lies more
 * than half a cell outside the cube's sample span.
 */
function placeLattice(fld: Field, x: number, y: number, z: number, out: Float64Array): boolean {
  const W = LATTICE_WINDOW;
  const d = fld.dens;
  let total = 0;
  for (let c = 0; c < 4; c++) {
    const i = fld.at(x + (c & 1), y - W, z + (c >> 1));
    if (d[i]! !== DENSITY_FULL || d[i + 2 * W + 1]! !== 0) return false;
    let sum = 0;
    let prev = DENSITY_FULL;
    for (let k = 0; k <= 2 * W + 1; k++) {
      const v = d[i + k]!;
      if (v > prev) return false;
      prev = v;
      sum += v;
    }
    colSums[c] = sum;
    total += sum;
  }
  // Height in local cells: (y − W) + total / (4 · full); kept within [y, y + 2] (the cube's samples ± half a cell).
  const rel = total - 4 * DENSITY_FULL * W;
  if (rel < 0 || rel > 2 * 4 * DENSITY_FULL) return false;
  out[0] = (x + 2) * STEPS;
  out[1] = (y - W + 1) * STEPS + Math.round((total * STEPS) / (4 * DENSITY_FULL));
  out[2] = (z + 2) * STEPS;
  const gx = (colSums[1]! + colSums[3]! - colSums[0]! - colSums[2]!) / (2 * DENSITY_FULL);
  const gz = (colSums[2]! + colSums[3]! - colSums[0]! - colSums[1]!) / (2 * DENSITY_FULL);
  out[3] = -gx;
  out[4] = 1;
  out[5] = -gz;
  return true;
}

/** Whether any of the cube's eight cells is one the terrain rules call a cliff or a terrace lip. */
function sharpCube(fld: Field, classes: Uint8Array, x: number, y: number, z: number): boolean {
  const i = fld.at(x, y, z);
  for (let c = 0; c < 8; c++) {
    const f = terrainFeatureOf(classes[i + (c & 1) * fld.SX + ((c >> 1) & 1) + ((c >> 2) & 1) * fld.SZ]!);
    if (f === TERRAIN_FEATURE.cliff || f === TERRAIN_FEATURE.terraceLip) return true;
  }
  return false;
}

/** Central-difference density gradient at a sample (index i). */
function gradAt(fld: Field, i: number, g: Float64Array, o: number): void {
  const d = fld.dens;
  g[o] = d[i + fld.SX]! - d[i - fld.SX]!;
  g[o + 1] = d[i + 1]! - d[i - 1]!;
  g[o + 2] = d[i + fld.SZ]! - d[i - fld.SZ]!;
}

/** Dual-contouring placement: the point nearest every crossing's tangent plane (pulled to their mean), clamped to the cube. */
function placeQef(fld: Field, x: number, y: number, z: number, out: Float64Array): void {
  cubeCorners(fld, x, y, z);
  let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0, b0 = 0, b1 = 0, b2 = 0;
  let mx = 0, my = 0, mz = 0, k = 0;
  for (const [a, c] of EDGES) {
    const da = corner[a]!;
    const dc = corner[c]!;
    if (da >= SURFACE_ISO === dc >= SURFACE_ISO) continue;
    const t = (SURFACE_ISO - 0.5 - da) / (dc - da);
    const A = CORNERS[a]!;
    const C = CORNERS[c]!;
    const px = A[0] + (C[0] - A[0]) * t;
    const py = A[1] + (C[1] - A[1]) * t;
    const pz = A[2] + (C[2] - A[2]) * t;
    // The normal of the cube's own trilinear field at the crossing: reads no sample outside the cube, so a
    // one-cell pit or wall next to the crease does not bend it.
    const c0 = corner[0]!, c1 = corner[1]!, c2 = corner[2]!, c3 = corner[3]!, c4 = corner[4]!, c5 = corner[5]!, c6 = corner[6]!, c7 = corner[7]!;
    let nx = (1 - py) * (1 - pz) * (c1 - c0) + py * (1 - pz) * (c3 - c2) + (1 - py) * pz * (c5 - c4) + py * pz * (c7 - c6);
    let ny = (1 - px) * (1 - pz) * (c2 - c0) + px * (1 - pz) * (c3 - c1) + (1 - px) * pz * (c6 - c4) + px * pz * (c7 - c5);
    let nz = (1 - px) * (1 - py) * (c4 - c0) + px * (1 - py) * (c5 - c1) + (1 - px) * py * (c6 - c2) + px * py * (c7 - c3);
    const len = Math.hypot(nx, ny, nz);
    mx += px;
    my += py;
    mz += pz;
    k++;
    if (len === 0) continue;
    nx /= len;
    ny /= len;
    nz /= len;
    const dot = nx * px + ny * py + nz * pz;
    a00 += nx * nx; a01 += nx * ny; a02 += nx * nz; a11 += ny * ny; a12 += ny * nz; a22 += nz * nz;
    b0 += nx * dot; b1 += ny * dot; b2 += nz * dot;
  }
  mx /= k;
  my /= k;
  mz /= k;
  // (A + λI) p = b + λ m, solved by Cramer's rule (positive definite with λ > 0).
  a00 += QEF_PULL; a11 += QEF_PULL; a22 += QEF_PULL;
  b0 += QEF_PULL * mx; b1 += QEF_PULL * my; b2 += QEF_PULL * mz;
  const det = a00 * (a11 * a22 - a12 * a12) - a01 * (a01 * a22 - a12 * a02) + a02 * (a01 * a12 - a11 * a02);
  const sx = (b0 * (a11 * a22 - a12 * a12) - a01 * (b1 * a22 - a12 * b2) + a02 * (b1 * a12 - a11 * b2)) / det;
  const sy = (a00 * (b1 * a22 - a12 * b2) - b0 * (a01 * a22 - a12 * a02) + a02 * (a01 * b2 - b1 * a02)) / det;
  const sz = (a00 * (a11 * b2 - b1 * a12) - a01 * (a01 * b2 - b1 * a02) + b0 * (a01 * a12 - a11 * a02)) / det;
  const clamp = (v: number): number => Math.max(0, Math.min(1, v));
  out[0] = q(x, clamp(sx));
  out[1] = q(y, clamp(sy));
  out[2] = q(z, clamp(sz));
  cubeNormal(out);
}

const placeLatticeOrMean: Placement = (fld, classes, x, y, z, out) => {
  if (!placeLattice(fld, x, y, z, out)) placeMean(fld, classes, x, y, z, out);
};

const placeSharpOrMean: Placement = (fld, classes, x, y, z, out) => {
  if (sharpCube(fld, classes, x, y, z)) placeQef(fld, x, y, z, out);
  else placeMean(fld, classes, x, y, z, out);
};

const placeSharpLatticeMean: Placement = (fld, classes, x, y, z, out) => {
  if (sharpCube(fld, classes, x, y, z)) placeQef(fld, x, y, z, out);
  else if (!placeLattice(fld, x, y, z, out)) placeMean(fld, classes, x, y, z, out);
};

/**
 * Surface nets over the field with a placement: one vertex a dual cube the
 * surface crosses, one quad a sign-changing sample edge whose lower sample
 * lies in the chunk (the reference's order and winding). With `weld`,
 * cubes that land on the same quantised point share one vertex (the column
 * lattice stacks them) and the quads between them collapse.
 */
function nets(n: Neighbourhood, classes: Uint8Array, place: Placement, weld: boolean): SurfaceBuffer {
  const b = new Surface();
  const fld = fieldOf(n);
  if (fld === null) return b.build();
  const e = n.edge;
  const dual = new Int32Array((e + 1) ** 3).fill(-1);
  const welded = weld ? new Map<number, number>() : null;
  const out = new Float64Array(6);
  const vertexOf = (x: number, y: number, z: number): number => {
    const k = ((x + 1) * (e + 1) + (z + 1)) * (e + 1) + (y + 1);
    if (dual[k]! >= 0) return dual[k]!;
    place(fld, classes, x, y, z, out);
    let v: number;
    if (welded !== null) {
      const key = (out[0]! * 65536 + out[1]!) * 65536 + out[2]!;
      const had = welded.get(key);
      v = had ?? b.vertex(out[0]!, out[1]!, out[2]!, out[3]!, out[4]!, out[5]!);
      if (had === undefined) welded.set(key, v);
    } else {
      v = b.vertex(out[0]!, out[1]!, out[2]!, out[3]!, out[4]!, out[5]!);
    }
    dual[k] = v;
    return v;
  };
  const d = fld.dens;
  const { SX, SZ } = fld;
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) {
    const col = fld.at(x, 0, z);
    for (let y = 0; y < e; y++) {
      const i = col + y;
      const inside = d[i]! >= SURFACE_ISO;
      const emit = (a: number, c: number, dd: number, f: number): void => {
        if (inside) b.quad(a, c, dd, f);
        else b.quad(a, f, dd, c);
      };
      if (inside !== d[i + SX]! >= SURFACE_ISO) emit(vertexOf(x, y - 1, z - 1), vertexOf(x, y, z - 1), vertexOf(x, y, z), vertexOf(x, y - 1, z));
      if (inside !== d[i + 1]! >= SURFACE_ISO) emit(vertexOf(x - 1, y, z - 1), vertexOf(x - 1, y, z), vertexOf(x, y, z), vertexOf(x, y, z - 1));
      if (inside !== d[i + SZ]! >= SURFACE_ISO) emit(vertexOf(x - 1, y - 1, z), vertexOf(x, y - 1, z), vertexOf(x, y, z), vertexOf(x - 1, y, z));
    }
  }
  return b.build();
}

/**
 * The marching-cubes case table built from the cube's faces: on each face
 * (corners counter-clockwise seen from outside) every run of inside corners
 * is cut off by a segment from the edge where the run ends to the edge
 * where it starts; each crossing edge then has one segment leaving and one
 * arriving, so the segments chain into closed loops, fanned into
 * triangles. A face's segments depend on its corners only, so the two
 * cubes sharing a face cut it the same way and the surface closes.
 */
function buildMarchingTable(): number[][] {
  const edgeOf = new Map<number, number>();
  EDGES.forEach(([a, c], k) => {
    edgeOf.set(a * 8 + c, k);
    edgeOf.set(c * 8 + a, k);
  });
  const faces: number[][] = [];
  for (let axis = 0; axis < 3; axis++) for (const side of [0, 1]) {
    const cs = [0, 1, 2, 3, 4, 5, 6, 7].filter((c) => CORNERS[c]![axis] === side);
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    // Counter-clockwise seen from outside: by angle in the (u, v) plane, reversed on the −axis side (u × v = +axis).
    const ang = (c: number): number => Math.atan2(CORNERS[c]![v]! - 0.5, CORNERS[c]![u]! - 0.5);
    cs.sort((a, b) => ang(a) - ang(b));
    if (side === 0) cs.reverse();
    faces.push(cs);
  }
  const table: number[][] = [];
  for (let cfg = 0; cfg < 256; cfg++) {
    const inside = (c: number): boolean => ((cfg >> c) & 1) === 1;
    const next = new Map<number, number>();
    for (const f of faces) {
      for (let k = 0; k < 4; k++) {
        // A run of inside corners ends at f[k] when the next corner is outside; walk back to where it starts.
        if (!inside(f[k]!) || inside(f[(k + 1) % 4]!)) continue;
        let s = k;
        while (inside(f[(s + 3) % 4]!) && (s + 3) % 4 !== k) s = (s + 3) % 4;
        const end = edgeOf.get(f[k]! * 8 + f[(k + 1) % 4]!)!;
        const start = edgeOf.get(f[(s + 3) % 4]! * 8 + f[s]!)!;
        next.set(end, start);
      }
    }
    const tris: number[] = [];
    const used = new Set<number>();
    for (const first of next.keys()) {
      if (used.has(first)) continue;
      const loop: number[] = [];
      for (let e = first; !used.has(e); e = next.get(e)!) {
        used.add(e);
        loop.push(e);
      }
      for (let k = 1; k + 1 < loop.length; k++) tris.push(loop[0]!, loop[k]!, loop[k + 1]!);
    }
    table.push(tris);
  }
  // Wind outward: with corner 0 alone inside, the triangle must face away from it.
  const t = table[1]!;
  const mid = (k: number): number[] => {
    const [a, c] = EDGES[k]!;
    return [0, 1, 2].map((j) => (CORNERS[a]![j]! + CORNERS[c]![j]!) / 2);
  };
  const [p0, p1, p2] = [mid(t[0]!), mid(t[1]!), mid(t[2]!)];
  const e1 = [p1![0]! - p0![0]!, p1![1]! - p0![1]!, p1![2]! - p0![2]!];
  const e2 = [p2![0]! - p0![0]!, p2![1]! - p0![1]!, p2![2]! - p0![2]!];
  const nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
  const ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
  const nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
  if (nx + ny + nz < 0) for (const tri of table) for (let k = 0; k < tri.length; k += 3) [tri[k + 1], tri[k + 2]] = [tri[k + 2]!, tri[k + 1]!];
  return table;
}

const MARCHING_TABLE = buildMarchingTable();

/** Marching cubes: cubes whose first sample lies in the chunk; one vertex a crossed sample edge, interpolated, gradient normal. */
function marchingCubes(n: Neighbourhood): SurfaceBuffer {
  const b = new Surface();
  const fld = fieldOf(n);
  if (fld === null) return b.build();
  const e = n.edge;
  const d = fld.dens;
  const { SX, SZ } = fld;
  const m = e + 1;
  const edgeVertex = new Int32Array(m * m * m * 3).fill(-1);
  const g = new Float64Array(6);
  const steps = [SX, 1, SZ];
  const vertexOn = (x: number, y: number, z: number, axis: number): number => {
    const k = ((x * m + z) * m + y) * 3 + axis;
    if (edgeVertex[k]! >= 0) return edgeVertex[k]!;
    const i = fld.at(x, y, z);
    const j = i + steps[axis]!;
    const da = d[i]!;
    const t = (SURFACE_ISO - 0.5 - da) / (d[j]! - da);
    gradAt(fld, i, g, 0);
    gradAt(fld, j, g, 3);
    const o = [0, 0, 0];
    o[axis] = Math.round(t * STEPS);
    const v = b.vertex(q(x, 0) + o[0]!, q(y, 0) + o[1]!, q(z, 0) + o[2]!, -(g[0]! + (g[3]! - g[0]!) * t), -(g[1]! + (g[4]! - g[1]!) * t), -(g[2]! + (g[5]! - g[2]!) * t));
    edgeVertex[k] = v;
    return v;
  };
  const ids = new Int32Array(12);
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) for (let y = 0; y < e; y++) {
    const i = fld.at(x, y, z);
    let cfg = 0;
    for (let c = 0; c < 8; c++) if (d[i + (c & 1) * SX + ((c >> 1) & 1) + ((c >> 2) & 1) * SZ]! >= SURFACE_ISO) cfg |= 1 << c;
    if (cfg === 0 || cfg === 255) continue;
    const tris = MARCHING_TABLE[cfg]!;
    ids.fill(-1);
    for (let k = 0; k < tris.length; k += 3) {
      for (let j = 0; j < 3; j++) {
        const edge = tris[k + j]!;
        if (ids[edge]! < 0) {
          const [a, c] = EDGES[edge]!;
          const A = CORNERS[a]!;
          const axis = (c ^ a) === 1 ? 0 : (c ^ a) === 2 ? 1 : 2;
          ids[edge] = vertexOn(x + A[0], y + A[1], z + A[2], axis);
        }
      }
      b.tri(ids[tris[k]!]!, ids[tris[k + 1]!]!, ids[tris[k + 2]!]!);
    }
  }
  return b.build();
}

export const MESHER_CANDIDATES: readonly MesherCandidate[] = [
  { name: 'reference', mesh: (n, c) => nets(n, c, placeMean, false) },
  { name: 'lattice', mesh: (n, c) => nets(n, c, placeLatticeOrMean, true) },
  { name: 'dc', mesh: (n, c) => nets(n, c, placeSharpOrMean, false) },
  { name: 'lattice+dc', mesh: (n, c) => nets(n, c, placeSharpLatticeMean, true) },
  { name: 'mc', mesh: (n) => marchingCubes(n) },
  // The package's terrain mesher (the pick, built): lattice+dc, its placements kept inside their cubes.
  { name: 'terrain', mesh: (n, c) => terrainSurface(n, c) },
];

const grid = chunkGrid(32);
const jobPad = jobRadius(TERRAIN_RULES);
let job: { n: Neighbourhood; classes: Uint8Array; dense: ReturnType<typeof createDenseChunk> } | null = null;

/**
 * Fills the job's neighbourhood of 32³ chunk (cx, cy, cz) from a store and
 * evaluates the terrain rules over it (what the derive does before its
 * consumers); the arrays are reused by the next call.
 */
export function terrainJob(store: PaletteStore, cx: number, cy: number, cz: number): { n: Neighbourhood; classes: Uint8Array } {
  if (job === null) {
    const n = createNeighbourhood(grid.edge, jobPad);
    job = { n, classes: new Uint8Array(n.values.length), dense: createDenseChunk(grid) };
  }
  const apron = buildApron(store, cx, cy, cz, jobPad);
  fillNeighbourhood(job.n, grid, store.exportChunk(cx, cy, cz, job.dense) ? job.dense : null, apron);
  evaluateAssembly(job.n, TERRAIN_RULES, job.classes);
  return job;
}

/** A candidate as the golden harness's chunk mesher (32³ chunks of a store, terrain rules evaluated). */
export function chunkMesherOf(c: MesherCandidate): (store: PaletteStore, cx: number, cy: number, cz: number) => SurfaceBuffer {
  return (store, cx, cy, cz) => {
    const { n, classes } = terrainJob(store, cx, cy, cz);
    return c.mesh(n, classes);
  };
}

/** A candidate by name. */
export function mesherCandidate(name: string): MesherCandidate {
  const c = MESHER_CANDIDATES.find((m) => m.name === name);
  if (c === undefined) throw new RangeError(`no mesher candidate ${name}`);
  return c;
}
