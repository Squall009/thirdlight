/**
 * The terrain mesher: the ground surface of a derive job, surface nets over
 * the terrain-role cells' density whose vertex placement follows the
 * terrain rule set's features.
 *
 * One vertex a dual cube the surface crosses, one quad a sign-changing
 * sample edge whose lower sample lies in the chunk (the derive's ground
 * layout, derived-mesh.ts). Where a vertex goes, in this order:
 * - **step** (a cube touching a cell the rules call a cliff or a terrace
 *   lip, whose four sample columns are a straight step: two a side, each a
 *   height function or wholly full or empty over the lattice window): the
 *   cube's centre x/z at the higher column top inside the cube (the step's
 *   edge or foot), see `placeStep`;
 * - **crease** (any other cube touching a cliff or terrace-lip cell):
 *   dual contouring, the point nearest the tangent planes of the
 *   cube's edge crossings (normals from the cube's own trilinear field, so
 *   a one-cell pit or wall beside the crease does not bend them), pulled a
 *   little toward their mean so a crease along one axis stays solvable,
 *   kept inside the cube;
 * - **column lattice** (the cube's four sample columns are each a height
 *   function over a window of {@link LATTICE_WINDOW} cells either side of
 *   the cube: full at its bottom, empty at its top, never filling again
 *   going up): the cube's centre x/z, a cell corner, at the four columns'
 *   mean fill height. That height does not depend on where the window
 *   starts, so every cube of one column stack gives the same vertex: they
 *   share it and the quads between them collapse. Ordinary ground is then
 *   one vertex a column on the cell-corner lattice, which a heightfield
 *   collider and a coarser lattice level can take as it is;
 * - otherwise the mean of the cube's edge crossings (plain surface nets).
 *
 * **Normals.** A column-lattice vertex takes the slope of the column heights
 * round it, over 4 × 4 columns where they are all height functions near the
 * vertex (else its cube's four): the 4-bit fill rounds a column by up to
 * 1/30 cell, which across one cell bands a gentle slope by several degrees.
 * Any other vertex takes the gradient of its cube's eight samples. A crease
 * vertex (a cube touching a cliff, terrace lip, ledge or cave-mouth lip,
 * one-cell wall or spike, whose inside corners are not one half of the cube
 * and whose crossing edges each have a whole cell or a whole air cell at one
 * end: an edge or corner of the voxels, not a smooth surface through them)
 * is split: each quad whose face turns more than {@link CREASE_SPLIT_DEG}
 * from the vertex's gradient takes a copy of it carrying the face's normal,
 * so light breaks at the crease instead of blurring across it. Gentle and
 * steep ground never split.
 *
 * **Crack-free.** A vertex is a function of samples within the job's pad,
 * quantised to whole position steps, so every chunk and section that meets
 * it computes the same bits; each sample edge belongs to one chunk. Only
 * column-lattice vertices are shared between cubes (a step vertex is its
 * cube's alone: one cube of a stack takes a given top). Every other vertex is
 * kept strictly inside its own cube and off the cube's centre line, so it
 * never lands on another cube's vertex: a vertex's normal is then the one
 * its own placement gives whichever cubes a section happens to reference, a
 * split copy's is its quad's face (a function of the quad's four placed
 * positions), and a chunk's joined sections are its whole derive triangle
 * for triangle, normals included.
 *
 * **Reach.** The lattice test reads values and shapes up to
 * {@link TERRAIN_MESHER_REACH} cells above and below the chunk, one cell
 * across (two for a lattice vertex's normal); the creases read resolved classes of the cube's cells (one cell
 * round the chunk, the consumers' reach). A job's pad must cover it.
 */
import type { Neighbourhood } from './assembly';
import { POSITION_STEPS_PER_CELL, snorm8, SURFACE_ISO, SURFACE_VERTEX_BYTES, type SurfaceBuffer } from './derived-mesh';
import { DENSITY_FULL, ROLE_MASK, ROLE_SHIFT, VOXEL_ROLE } from './record';
import { TERRAIN_FEATURE, terrainFeatureOf } from './terrain-rules';

/** Cells above and below a dual cube's two sample layers that its column-lattice height reads. */
export const LATTICE_WINDOW = 2;

/** Cells past the chunk (above and below) the mesher reads voxels of: the lattice window past the cube's samples. */
export const TERRAIN_MESHER_REACH = LATTICE_WINDOW + 1;

/** Weight pulling a crease vertex toward its crossings' mean (keeps the QEF solvable along a straight crease). */
const QEF_PULL = 0.05;

const STEPS = POSITION_STEPS_PER_CELL;
const HALF = STEPS / 2;
const R = TERRAIN_MESHER_REACH;
const W = LATTICE_WINDOW;

/** Per inside-corner mask of a cube (bit c: corner c, bit 0 x, bit 1 y, bit 2 z): 1 when the inside corners are one half of the cube, a face across it. */
const HALF_CUBE = new Uint8Array(256);
for (const m of [0x55, 0xaa, 0x33, 0xcc, 0x0f, 0xf0]) HALF_CUBE[m] = 1;

/**
 * Angle (degrees) between a quad's face normal and a crease vertex's smooth
 * normal past which that corner of the quad takes its own copy of the vertex
 * with the face normal. A crease's smooth normal is the blur of both faces
 * (about 45° off each at a 90° corner), so each side takes its own.
 */
export const CREASE_SPLIT_DEG = 10;

const SPLIT_COS = Math.cos((CREASE_SPLIT_DEG * Math.PI) / 180);

/** Per class byte: 1 when the cell is a crease the mesher places sharp (cliff, terrace lip). */
const SHARP = new Uint8Array(256);
/**
 * Per class byte: 1 when a cube touching the cell may split its vertex's
 * normal (the sharp classes, a ledge's lip or cave mouth, one-cell walls
 * and spikes); never gentle or steep ground, nor a cave's ceiling.
 */
const CREASE = new Uint8Array(256);
for (let b = 0; b < 256; b++) {
  const f = terrainFeatureOf(b);
  if (f === TERRAIN_FEATURE.cliff || f === TERRAIN_FEATURE.terraceLip) SHARP[b] = 1;
  if (SHARP[b] === 1 || f === TERRAIN_FEATURE.overhang || f === TERRAIN_FEATURE.thin || f === TERRAIN_FEATURE.spike) CREASE[b] = 1;
}

/** Cube corners (bit 0 x, bit 1 y, bit 2 z) and the 12 edges as corner pairs, flat. */
const EDGE_A = new Uint8Array(12);
const EDGE_C = new Uint8Array(12);
{
  let k = 0;
  for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) if ((a & bit) === 0) {
    EDGE_A[k] = a;
    EDGE_C[k++] = a | bit;
  }
}

/** Per-thread working arrays, grown to the largest job seen. */
let field = new Uint8Array(0);
let prefixSum = new Int32Array(0);
let prefixRise = new Uint16Array(0);
/** Per column: the call whose prefix sums it holds (they are built only for columns a lattice test reads). */
let prefixStamp = new Uint32Array(0);
/** Per column: the last lattice-normal window read (call stamp, window cell, its column height or −1). */
let heightStamp = new Uint32Array(0);
let heightAt = new Int32Array(0);
let heightOf = new Int32Array(0);
let call = 0;
/** Per dual cube: its dual vertex, −1 none yet. */
let dual = new Int32Array(0);
/** Dual vertices (one a cube, or a column-lattice one shared by a stack): position, unit smooth normal, flags, output vertex. */
let dpos = new Int32Array(3 * 1024);
let dnrm = new Float32Array(3 * 1024);
let dsplit = new Uint8Array(1024);
let dout = new Int32Array(1024);
let dualCount = 0;
/** Output vertices. */
let pos = new Int32Array(3 * 1024);
let nrm = new Int8Array(3 * 1024);
let tris = new Uint32Array(3 * 2048);
let vertexCount = 0;
let triLen = 0;
const lattice = new Map<number, number>();
/**
 * A split vertex's copies, a block of {@link COPY_SLOTS} a vertex (one per
 * quad it can be a corner of): face normal key (snorm8 bytes) and output
 * vertex; the block's start and count per dual vertex.
 */
const COPY_SLOTS = 12;
let copyKey = new Int32Array(COPY_SLOTS * 256);
let copyOut = new Int32Array(COPY_SLOTS * 256);
let copyLen = 0;
let dcopyAt = new Int32Array(1024);
let dcopyN = new Uint8Array(1024);
const corner = new Float64Array(8);
const place = new Float64Array(6);
/** The cube's four column sums (at 5, 6, 9, 10: x-major 4 × 4) from the lattice placement's window. */
const ring = new Int32Array(16);
/** The 4 × 4 column sums round a lattice vertex in the window at its height. */
const wide16 = new Int32Array(16);
/** Weights of the four columns (or rows) across a lattice vertex's gradient: a tent. */
const TENT = [1, 3, 3, 1] as const;

function addVertex(qx: number, qy: number, qz: number, nx: number, ny: number, nz: number): number {
  if (3 * vertexCount + 3 > pos.length) {
    const p = new Int32Array(pos.length * 2);
    p.set(pos);
    pos = p;
    const q = new Int8Array(nrm.length * 2);
    q.set(nrm);
    nrm = q;
  }
  const o = 3 * vertexCount;
  pos[o] = qx;
  pos[o + 1] = qy;
  pos[o + 2] = qz;
  nrm[o] = snorm8(nx);
  nrm[o + 1] = snorm8(ny);
  nrm[o + 2] = snorm8(nz);
  return vertexCount++;
}

/** A dual vertex with its smooth normal (any length); `split`: it may take copies at a crease. */
function addDual(qx: number, qy: number, qz: number, nx: number, ny: number, nz: number, split: boolean): number {
  if (dualCount === dsplit.length) {
    const n = dsplit.length * 2;
    const p = new Int32Array(3 * n);
    p.set(dpos);
    dpos = p;
    const q = new Float32Array(3 * n);
    q.set(dnrm);
    dnrm = q;
    const f = new Uint8Array(n);
    f.set(dsplit);
    dsplit = f;
    const o = new Int32Array(n);
    o.set(dout);
    dout = o;
    const ca = new Int32Array(n);
    ca.set(dcopyAt);
    dcopyAt = ca;
    const cn = new Uint8Array(n);
    cn.set(dcopyN);
    dcopyN = cn;
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  const o = 3 * dualCount;
  dpos[o] = qx;
  dpos[o + 1] = qy;
  dpos[o + 2] = qz;
  dnrm[o] = nx / len;
  dnrm[o + 1] = ny / len;
  dnrm[o + 2] = nz / len;
  dsplit[dualCount] = split ? 1 : 0;
  dout[dualCount] = -1;
  dcopyAt[dualCount] = -1;
  dcopyN[dualCount] = 0;
  return dualCount++;
}

/** The output vertex of a dual vertex with its smooth normal. */
function smoothOut(dv: number): number {
  let v = dout[dv]!;
  if (v < 0) {
    const o = 3 * dv;
    v = addVertex(dpos[o]!, dpos[o + 1]!, dpos[o + 2]!, dnrm[o]!, dnrm[o + 1]!, dnrm[o + 2]!);
    dout[dv] = v;
  }
  return v;
}

/** Face normal of the quad being emitted (unit; zero when it has no area). */
const face = new Float64Array(3);

/** The output vertex for one corner of the quad whose unit normal is in `face`. */
function cornerOut(dv: number): number {
  if (dsplit[dv] === 0) return smoothOut(dv);
  const o = 3 * dv;
  const fx = face[0]!, fy = face[1]!, fz = face[2]!;
  if (fx * dnrm[o]! + fy * dnrm[o + 1]! + fz * dnrm[o + 2]! >= SPLIT_COS || (fx === 0 && fy === 0 && fz === 0)) return smoothOut(dv);
  const bx = snorm8(fx), by = snorm8(fy), bz = snorm8(fz);
  const key = ((bx & 255) << 16) | ((by & 255) << 8) | (bz & 255);
  let at = dcopyAt[dv]!;
  if (at < 0) {
    if (copyLen + COPY_SLOTS > copyKey.length) {
      const k = new Int32Array(copyKey.length * 2);
      k.set(copyKey);
      copyKey = k;
      const c = new Int32Array(copyOut.length * 2);
      c.set(copyOut);
      copyOut = c;
    }
    at = copyLen;
    copyLen += COPY_SLOTS;
    dcopyAt[dv] = at;
  }
  const n = dcopyN[dv]!;
  for (let i = at; i < at + n; i++) if (copyKey[i] === key) return copyOut[i]!;
  const v = addVertex(dpos[o]!, dpos[o + 1]!, dpos[o + 2]!, fx, fy, fz);
  copyKey[at + n] = key;
  copyOut[at + n] = v;
  dcopyN[dv] = n + 1;
  return v;
}

/** A triangle of output vertices. */
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

/**
 * The quad's face normal into `face` (Newell's, so a quad with two corners
 * shared still gets its triangle's normal): a function of the four placed
 * positions only, so every section and chunk emitting the quad's corners
 * gets the same copies.
 */
function faceNormal(a: number, c: number, d: number, f: number): void {
  let nx = 0, ny = 0, nz = 0;
  for (let k = 0; k < 4; k++) {
    const i = 3 * (k === 0 ? a : k === 1 ? c : k === 2 ? d : f);
    const j = 3 * (k === 0 ? c : k === 1 ? d : k === 2 ? f : a);
    nx += (dpos[i + 1]! - dpos[j + 1]!) * (dpos[i + 2]! + dpos[j + 2]!);
    ny += (dpos[i + 2]! - dpos[j + 2]!) * (dpos[i]! + dpos[j]!);
    nz += (dpos[i]! - dpos[j]!) * (dpos[i + 1]! + dpos[j + 1]!);
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  face[0] = len === 0 ? 0 : nx / len;
  face[1] = len === 0 ? 0 : ny / len;
  face[2] = len === 0 ? 0 : nz / len;
}

/** A quad a → c → d → f of dual vertices; vertices shared by collapsed lattice cubes leave one triangle or nothing (zero area). */
function addQuad(a: number, c: number, d: number, f: number): void {
  const whole = a !== c && c !== d && d !== f && f !== a;
  if (whole ? a === d || c === f : (a === f ? 0 : 1) + (c === a ? 0 : 1) + (d === c ? 0 : 1) + (f === d ? 0 : 1) !== 3) return;
  let oa: number, oc: number, od: number, of: number;
  if ((dsplit[a]! | dsplit[c]! | dsplit[d]! | dsplit[f]!) === 0) {
    oa = dout[a]! >= 0 ? dout[a]! : smoothOut(a);
    oc = dout[c]! >= 0 ? dout[c]! : smoothOut(c);
    od = dout[d]! >= 0 ? dout[d]! : smoothOut(d);
    of = dout[f]! >= 0 ? dout[f]! : smoothOut(f);
  } else {
    faceNormal(a, c, d, f);
    oa = cornerOut(a);
    oc = cornerOut(c);
    od = cornerOut(d);
    of = cornerOut(f);
  }
  if (whole) {
    addTri(oa, oc, od);
    addTri(oa, od, of);
    return;
  }
  // Two neighbours equal (one shared vertex, the same output for both): the other three corners are the triangle left.
  if (a === f) addTri(oc, od, of);
  else if (c === a) addTri(oa, od, of);
  else if (d === c) addTri(oa, oc, of);
  else addTri(oa, oc, od);
}

function buildSurface(): SurfaceBuffer {
  const vertices = new Uint8Array(vertexCount * SURFACE_VERTEX_BYTES);
  const d = new DataView(vertices.buffer);
  for (let v = 0; v < vertexCount; v++) {
    const at = v * SURFACE_VERTEX_BYTES;
    d.setUint16(at, pos[3 * v]!, true);
    d.setUint16(at + 2, pos[3 * v + 1]!, true);
    d.setUint16(at + 4, pos[3 * v + 2]!, true);
    d.setInt8(at + 8, nrm[3 * v]!);
    d.setInt8(at + 9, nrm[3 * v + 1]!);
    d.setInt8(at + 10, nrm[3 * v + 2]!);
  }
  const t = tris.subarray(0, triLen);
  const indices = vertexCount < 65536 ? new Uint16Array(t) : new Uint32Array(t);
  return { vertexCount, vertices, indices };
}

/**
 * Quantised position along one axis of a vertex at `f` (0 … 1 across the
 * cube) from the cube's first sample at local cell `cell`, kept one step
 * inside the cube.
 */
function inside(cell: number, f: number): number {
  return (cell + 1) * STEPS + HALF + Math.max(1, Math.min(STEPS - 1, Math.round(f * STEPS)));
}

/**
 * The ground surface of a job's chunk (or section) from its neighbourhood
 * (pad at least {@link TERRAIN_MESHER_REACH}) and resolved classes; with
 * rules that set no terrain features, the creases are placed as plain nets.
 */
export function terrainSurface(n: Neighbourhood, classes: Uint8Array): SurfaceBuffer {
  const e = n.edge;
  const p = n.pad;
  const s = n.side;
  if (p < R) throw new RangeError(`terrain mesher: pad ${p}, it reads ${R} cells past the chunk`);
  vertexCount = 0;
  triLen = 0;
  dualCount = 0;
  // The field: columns x, z in −2 … e + 1 (the samples −1 … e and one more each side for the lattice normals),
  // cells y in −R … e + R − 1; index ((x + 2) · m + z + 2) · ny + y + R.
  const m = e + 4;
  const ny = e + 2 * R;
  const FSX = m * ny;
  const FSZ = ny;
  const cells = m * m * ny;
  if (field.length < cells) {
    field = new Uint8Array(cells);
    prefixSum = new Int32Array(m * m * (ny + 1));
    prefixRise = new Uint16Array(m * m * (ny + 1));
    prefixStamp = new Uint32Array(m * m);
    heightStamp = new Uint32Array(m * m);
    heightAt = new Int32Array(m * m);
    heightOf = new Int32Array(m * m);
    call = 0;
  }
  call++;
  const F = field;
  // Read as int32: values past 2^31 would be heap numbers in the loop; the role bits are the same either way.
  const vals = new Int32Array(n.values.buffer, n.values.byteOffset, n.values.length);
  const shapes = n.shapes;
  let inside0 = 0;
  for (let cx = 0; cx < m; cx++) for (let cz = 0; cz < m; cz++) {
    const src = ((cx - 2 + p) * s + (cz - 2 + p)) * s + (p - R);
    const dst = (cx * m + cz) * ny;
    const sample = cx >= 1 && cx <= e + 2 && cz >= 1 && cz <= e + 2;
    for (let k = 0; k < ny; k++) {
      const d = ((vals[src + k]! >> ROLE_SHIFT) & ROLE_MASK) === VOXEL_ROLE.terrain ? shapes[src + k]! : 0;
      F[dst + k] = d;
      if (sample && d >= SURFACE_ISO && k >= R - 1 && k <= R + e) inside0++;
    }
  }
  // All outside or all inside over the samples −1 … e: no sample edge changes sign.
  const samples = e + 2;
  if (inside0 === 0 || inside0 === samples * samples * samples) return buildSurface();
  // Per column, built when a lattice test first reads it: prefix sums of the fill and of the places it rises going
  // up, so every window's test on that column is O(1).
  const PS = prefixSum;
  const PR = prefixRise;
  const stamp = prefixStamp;
  const now = call;
  const prefixes = (col: number): void => {
    stamp[col] = now;
    const f0 = col * ny;
    const p0 = col * (ny + 1);
    PS[p0] = 0;
    PR[p0] = 0;
    let sum = 0;
    let rises = 0;
    let prev = 256;
    for (let k = 0; k < ny; k++) {
      const v = F[f0 + k]!;
      sum += v;
      if (v > prev) rises++;
      prev = v;
      PS[p0 + k + 1] = sum;
      PR[p0 + k + 1] = rises;
    }
  };
  /** Field cells ka … kb of the column summed when it is a height function over them (full at ka, empty at kb, never rising), else −1. */
  const columnHeight = (col: number, ka: number, kb: number): number => {
    const f0 = col * ny;
    if (F[f0 + ka]! !== DENSITY_FULL || F[f0 + kb]! !== 0) return -1;
    if (stamp[col] !== now) prefixes(col);
    const p0 = col * (ny + 1);
    // A rise between cells ka … kb (at k when F[k] > F[k − 1], k in ka + 1 … kb).
    if (PR[p0 + kb + 1]! !== PR[p0 + ka + 1]!) return -1;
    return PS[p0 + kb + 1]! - PS[p0 + ka]!;
  };
  const d1 = e + 1;
  if (dual.length < d1 * d1 * d1) dual = new Int32Array(d1 * d1 * d1);
  dual.fill(-1, 0, d1 * d1 * d1);
  lattice.clear();
  copyLen = 0;
  const ps = p;
  const cls = classes;
  const fi = (x: number, y: number, z: number): number => ((x + 2) * m + (z + 2)) * ny + (y + R);
  const colOf = (x: number, z: number): number => (x + 2) * m + (z + 2);

  /** Column-lattice placement into place[0…2] (its four column sums into ring 5, 6, 9, 10), or false. */
  const placeLattice = (x: number, y: number, z: number): boolean => {
    // Window cells y − W … y + W + 1 of each sample column: field index ka … kb.
    const ka = y - W + R;
    const kb = ka + 2 * W + 1;
    let total = 0;
    for (let c = 0; c < 4; c++) {
      const sum = columnHeight(colOf(x + (c & 1), z + (c >> 1)), ka, kb);
      if (sum < 0) return false;
      ring[(1 + (c & 1)) * 4 + 1 + (c >> 1)] = sum;
      total += sum;
    }
    // Height in local cells: (y − W) + total / (4 · full); kept within [y, y + 2] (the cube's samples ± half a cell).
    const rel = total - 4 * DENSITY_FULL * W;
    if (rel < 0 || rel > 2 * 4 * DENSITY_FULL) return false;
    place[0] = (x + 2) * STEPS;
    place[1] = (y - W + 1) * STEPS + Math.round((total * STEPS) / (4 * DENSITY_FULL));
    place[2] = (z + 2) * STEPS;
    return true;
  };

  /**
   * Crease placement on the column lattice into place[0…2], or false: when
   * the cube's four sample columns are each a height function over the
   * lattice window (or wholly full or wholly empty there) and not all the
   * same, the crease is a step between columns. The 4-bit fill is a height,
   * so a step's face stands on the cell boundary (the cube's centre x/z) and
   * its edge lies at a column's top: the highest top between the cube's two
   * sample centres (a lip, or a step's foot when only the lower top lies
   * there). Interpolating the density across the step instead puts the edge
   * up to a third of a cell low and in front of the face. The span is half
   * open, so one cube of a stack takes a given top; a plain lattice vertex
   * (the four columns' mean) never lands there, as the tops differ.
   */
  const placeStep = (x: number, y: number, z: number): boolean => {
    const ka = y - W + R;
    const kb = ka + 2 * W + 1;
    const lo = (y + 1) * STEPS + HALF;
    const hi = lo + STEPS;
    let first = 0;
    let other = 0;
    /** Columns whose top differs from the first column's. */
    let highs = 0;
    let best = -1;
    for (let c = 0; c < 4; c++) {
      const col = colOf(x + (c & 1), z + (c >> 1));
      if (stamp[col] !== now) prefixes(col);
      const p0 = col * (ny + 1);
      // Filling again going up inside the window: not a height here (an overhang, a cave).
      if (PR[p0 + kb + 1]! !== PR[p0 + ka + 1]!) return false;
      const f0 = col * ny;
      // A top below the window reads as −1, above it as 2^30: never inside the cube's span.
      let h: number;
      if (F[f0 + ka]! !== DENSITY_FULL) h = -1;
      else if (F[f0 + kb]! !== 0) h = 1 << 30;
      else h = (y - W + 1) * STEPS + Math.round(((PS[p0 + kb + 1]! - PS[p0 + ka]!) * STEPS) / DENSITY_FULL);
      if (c === 0) first = h;
      else if (h !== first) {
        if (highs > 0 && h !== other) return false;
        other = h;
        highs++;
      }
      if (h >= lo && h < hi && h > best) best = h;
    }
    // Two columns a side: a straight step along x or z. One column against three is a lone column's corner or a
    // notch, which on rounded ground (a bump's rim the rules call steep enough) is not an edge; those keep the QEF.
    // With two tops only, the plain lattice height (the four tops' mean) never equals the one picked.
    if (highs !== 2 || best < 0) return false;
    place[0] = (x + 2) * STEPS;
    place[1] = best;
    place[2] = (z + 2) * STEPS;
    return true;
  };

  /**
   * A lattice vertex's normal into place[3…5] (its position in place[0…2]),
   * from the column heights round it: over the 4 × 4 columns (tent-weighted,
   * a gradient across two to three cells) when each is a height function
   * over the two cells either side of the cell boundary nearest the
   * vertex's height, so the 4-bit fill's rounding (up to 1/30 cell a column)
   * does not band a gentle slope; else across the cube's own four columns.
   * The window follows the vertex's height, not the cube's, so every cube of
   * a stack, in any section or chunk, gives the vertex the same normal.
   */
  const latticeNormal = (x: number, z: number): void => {
    // The cell boundary nearest the vertex's height (positions count from one cell below the chunk): the window, cells
    // fh − 2 … fh + 1, keeps half a cell or more either side of the vertex and stays inside the field (heights −1 … e + 1).
    const fh = Math.round(place[1]! / STEPS) - 1;
    const ka = fh - 2 + R;
    const kb = fh + 1 + R;
    let wide = true;
    for (let k = 0; k < 16; k++) {
      const col = colOf(x - 1 + (k >> 2), z - 1 + (k & 3));
      // Neighbouring vertices mostly share a window: each column keeps its last answer.
      let h: number;
      if (heightStamp[col] === now && heightAt[col] === ka) {
        h = heightOf[col]!;
      } else {
        h = columnHeight(col, ka, kb);
        heightStamp[col] = now;
        heightAt[col] = ka;
        heightOf[col] = h;
      }
      if (h < 0) {
        wide = false;
        break;
      }
      wide16[k] = h;
    }
    let gx = 0, gz = 0;
    if (wide) {
      // Per row: (h₂ + h₃ − h₀ − h₁) / 4, the least-squares slope of four columns weighted 1, 3, 3, 1; the rows
      // weighted the same way (summing to 8).
      for (let k = 0; k < 4; k++) {
        const w = TENT[k]!;
        gx += w * (wide16[8 + k]! + wide16[12 + k]! - wide16[k]! - wide16[4 + k]!);
        gz += w * (wide16[4 * k + 2]! + wide16[4 * k + 3]! - wide16[4 * k]! - wide16[4 * k + 1]!);
      }
      gx /= 32 * DENSITY_FULL;
      gz /= 32 * DENSITY_FULL;
    } else {
      gx = (ring[9]! + ring[10]! - ring[5]! - ring[6]!) / (2 * DENSITY_FULL);
      gz = (ring[6]! + ring[10]! - ring[5]! - ring[9]!) / (2 * DENSITY_FULL);
    }
    place[3] = -gx;
    place[4] = 1;
    place[5] = -gz;
  };

  /** The cube's corners into `corner` and its gradient normal (outward: density rises into the ground) into place[3…5]. */
  const cubeCorners = (i: number): void => {
    let gx = 0, gy = 0, gz = 0;
    for (let c = 0; c < 8; c++) {
      const v = F[i + (c & 1) * FSX + ((c >> 1) & 1) + ((c >> 2) & 1) * FSZ]!;
      corner[c] = v;
      gx += c & 1 ? v : -v;
      gy += (c >> 1) & 1 ? v : -v;
      gz += (c >> 2) & 1 ? v : -v;
    }
    place[3] = -gx;
    place[4] = -gy;
    place[5] = -gz;
  };
  /** Mean of the edge crossings, cube-relative, into place[0…2]. */
  const placeMean = (): void => {
    let fx = 0, fy = 0, fz = 0, k = 0;
    for (let ed = 0; ed < 12; ed++) {
      const a = EDGE_A[ed]!;
      const c = EDGE_C[ed]!;
      const da = corner[a]!;
      const dc = corner[c]!;
      if (da >= SURFACE_ISO === dc >= SURFACE_ISO) continue;
      const t = (SURFACE_ISO - 0.5 - da) / (dc - da);
      const bit = a ^ c;
      fx += bit === 1 ? t : a & 1;
      fy += bit === 2 ? t : (a >> 1) & 1;
      fz += bit === 4 ? t : (a >> 2) & 1;
      k++;
    }
    place[0] = fx / k;
    place[1] = fy / k;
    place[2] = fz / k;
  };

  /** Dual-contouring placement, cube-relative, into place[0…2] (corners read). */
  const placeQef = (): void => {
    let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0, b0 = 0, b1 = 0, b2 = 0;
    let mx = 0, my = 0, mz = 0, k = 0;
    const c0 = corner[0]!, c1 = corner[1]!, c2 = corner[2]!, c3 = corner[3]!, c4 = corner[4]!, c5 = corner[5]!, c6 = corner[6]!, c7 = corner[7]!;
    for (let ed = 0; ed < 12; ed++) {
      const a = EDGE_A[ed]!;
      const c = EDGE_C[ed]!;
      const da = corner[a]!;
      const dc = corner[c]!;
      if (da >= SURFACE_ISO === dc >= SURFACE_ISO) continue;
      const t = (SURFACE_ISO - 0.5 - da) / (dc - da);
      const bit = a ^ c;
      const px = bit === 1 ? t : a & 1;
      const py = bit === 2 ? t : (a >> 1) & 1;
      const pz = bit === 4 ? t : (a >> 2) & 1;
      let nx = (1 - py) * (1 - pz) * (c1 - c0) + py * (1 - pz) * (c3 - c2) + (1 - py) * pz * (c5 - c4) + py * pz * (c7 - c6);
      let nyv = (1 - px) * (1 - pz) * (c2 - c0) + px * (1 - pz) * (c3 - c1) + (1 - px) * pz * (c6 - c4) + px * pz * (c7 - c5);
      let nz = (1 - px) * (1 - py) * (c4 - c0) + px * (1 - py) * (c5 - c1) + (1 - px) * py * (c6 - c2) + px * py * (c7 - c3);
      mx += px;
      my += py;
      mz += pz;
      k++;
      const len = Math.sqrt(nx * nx + nyv * nyv + nz * nz);
      if (len === 0) continue;
      nx /= len;
      nyv /= len;
      nz /= len;
      const dot = nx * px + nyv * py + nz * pz;
      a00 += nx * nx; a01 += nx * nyv; a02 += nx * nz; a11 += nyv * nyv; a12 += nyv * nz; a22 += nz * nz;
      b0 += nx * dot; b1 += nyv * dot; b2 += nz * dot;
    }
    mx /= k;
    my /= k;
    mz /= k;
    // (A + λI) p = b + λ m by Cramer's rule (positive definite with λ > 0).
    a00 += QEF_PULL; a11 += QEF_PULL; a22 += QEF_PULL;
    b0 += QEF_PULL * mx; b1 += QEF_PULL * my; b2 += QEF_PULL * mz;
    const det = a00 * (a11 * a22 - a12 * a12) - a01 * (a01 * a22 - a12 * a02) + a02 * (a01 * a12 - a11 * a02);
    place[0] = (b0 * (a11 * a22 - a12 * a12) - a01 * (b1 * a22 - a12 * b2) + a02 * (b1 * a12 - a11 * b2)) / det;
    place[1] = (a00 * (b1 * a22 - a12 * b2) - b0 * (a01 * a22 - a12 * a02) + a02 * (a01 * b2 - b1 * a02)) / det;
    place[2] = (a00 * (a11 * b2 - b1 * a12) - a01 * (a01 * b2 - b1 * a02) + b0 * (a01 * a12 - a11 * a02)) / det;
  };

  /**
   * Whether the cube's vertex sits on an edge or corner of the voxels: its
   * inside corners are not one half of the cube, and every crossing edge has
   * a whole cell or a whole air cell at one end (a smooth density surface
   * slanting through the cube leaves both ends of some edge partly full).
   */
  const creaseVertex = (): boolean => {
    let mask = 0;
    for (let c = 0; c < 8; c++) if (corner[c]! >= SURFACE_ISO) mask |= 1 << c;
    if (HALF_CUBE[mask] !== 0) return false;
    for (let ed = 0; ed < 12; ed++) {
      const da = corner[EDGE_A[ed]!]!;
      const dc = corner[EDGE_C[ed]!]!;
      if (da >= SURFACE_ISO === dc >= SURFACE_ISO) continue;
      if (da !== DENSITY_FULL && dc !== DENSITY_FULL && da !== 0 && dc !== 0) return false;
    }
    return true;
  };

  /** Whether any of the cube's eight cells is a crease (cube corners are cells −1 … e: resolved). */
  const anyOf = (table: Uint8Array, x: number, y: number, z: number): boolean => {
    const j = ((x + ps) * s + (z + ps)) * s + (y + ps);
    return (table[cls[j]!]! | table[cls[j + 1]!]! | table[cls[j + s]!]! | table[cls[j + s + 1]!]! | table[cls[j + s * s]!]! | table[cls[j + s * s + 1]!]! | table[cls[j + s * s + s]!]! | table[cls[j + s * s + s + 1]!]!) === 1;
  };

  const vertexOf = (x: number, y: number, z: number): number => {
    const key = ((x + 1) * d1 + (z + 1)) * d1 + (y + 1);
    const had = dual[key]!;
    if (had >= 0) return had;
    let v: number;
    const crease = anyOf(SHARP, x, y, z);
    if (!crease && placeLattice(x, y, z)) {
      // Cubes of one stack at one height share the vertex (its normal does not depend on which cube found it).
      const lk = ((x + 1) * d1 + (z + 1)) * 0x20000 + place[1]!;
      const shared = lattice.get(lk);
      if (shared === undefined) {
        latticeNormal(x, z);
        v = addDual(place[0]!, place[1]!, place[2]!, place[3]!, place[4]!, place[5]!, false);
        lattice.set(lk, v);
      } else {
        v = shared;
      }
    } else if (crease && placeStep(x, y, z)) {
      // One cube of the stack takes this top (see placeStep): nothing to share.
      cubeCorners(fi(x, y, z));
      v = addDual(place[0]!, place[1]!, place[2]!, place[3]!, place[4]!, place[5]!, creaseVertex());
    } else {
      cubeCorners(fi(x, y, z));
      if (crease) placeQef();
      else placeMean();
      const qx0 = inside(x, place[0]!);
      const qz = inside(z, place[2]!);
      // Off the cube's centre line, where only a column-lattice vertex may sit.
      const qx = qx0 === (x + 2) * STEPS && qz === (z + 2) * STEPS ? qx0 + 1 : qx0;
      const split = (crease || anyOf(CREASE, x, y, z)) && creaseVertex();
      v = addDual(qx, inside(y, place[1]!), qz, place[3]!, place[4]!, place[5]!, split);
    }
    dual[key] = v;
    return v;
  };

  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) {
    const col = fi(x, 0, z);
    for (let y = 0; y < e; y++) {
      const i = col + y;
      const isIn = F[i]! >= SURFACE_ISO;
      // Along +x: the quad joins the dual cubes at (x, y−1…y, z−1…z), ordered round +x (y, then z).
      if (isIn !== F[i + FSX]! >= SURFACE_ISO) {
        const a = vertexOf(x, y - 1, z - 1), c = vertexOf(x, y, z - 1), d = vertexOf(x, y, z), f = vertexOf(x, y - 1, z);
        if (isIn) addQuad(a, c, d, f);
        else addQuad(a, f, d, c);
      }
      // Along +y: round +y is z, then x.
      if (isIn !== F[i + 1]! >= SURFACE_ISO) {
        const a = vertexOf(x - 1, y, z - 1), c = vertexOf(x - 1, y, z), d = vertexOf(x, y, z), f = vertexOf(x, y, z - 1);
        if (isIn) addQuad(a, c, d, f);
        else addQuad(a, f, d, c);
      }
      // Along +z: round +z is x, then y.
      if (isIn !== F[i + FSZ]! >= SURFACE_ISO) {
        const a = vertexOf(x - 1, y - 1, z), c = vertexOf(x, y - 1, z), d = vertexOf(x, y, z), f = vertexOf(x - 1, y, z);
        if (isIn) addQuad(a, c, d, f);
        else addQuad(a, f, d, c);
      }
    }
  }
  return buildSurface();
}
