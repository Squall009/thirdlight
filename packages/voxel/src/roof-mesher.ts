/**
 * The roof mesher: role `roof` cells laid as a 45° or a 1:2 stair are drawn
 * as flat sloped planes instead of their stair faces, as the terrain mesher
 * draws terrain. Which cells and how (slope, phases, support, roof edges)
 * is read by roof-words.ts. The stair voxels stay the data: light,
 * occupancy and navigation read them as they are; collision reads the
 * planes (a roof is a ramp where it is drawn), so a character stands where
 * the roof shows.
 *
 * **The surface.** A cell rising in d carries the plane through the
 * stair's outer corners: at 45° its top is its voxel's top (T) on its low
 * side and T + 1 on its high side; at 1:2 the pair's low cell runs from T
 * to T + ½ and its high cell from T + ½ to T + 1. Its underside is the
 * parallel plane one cell lower. A supported cell (a body under it,
 * directly or across one air cell, where the roof's kit asks for the wall
 * tops to be filled: roof-words.ts) closes down onto the body's top
 * instead: its sides reach down to it and its floor lies on the body's top
 * face, so the body's top reads as cut to the roof's underside and no step
 * shows under the roof. A cell rising in several directions takes the
 * lowest of their planes (a ridge along its middle, a hip, the apex of a
 * pyramid), or the highest where they meet concave (a valley). Every plane
 * cell is a closed prism (top, underside or floor, four sides); faces two
 * prisms share are left out, and where two meet on a side unequally only
 * the difference is drawn, so the roof is one closed skin and a ridge, hip
 * or valley is where two planes meet edge to edge. Every edge takes the
 * lattice points on it where another polygon of the job has a corner (on a
 * section face: every lattice point), so polygons meet without T-junctions. Points are
 * whole quarter cells (a 1:2 plane is half a cell up a cell's middle); a
 * cell's corners, edge middles and centre are points of the lattice.
 *
 * **Owners: wall and roof never blend.** Every polygon shows the material
 * of the cells it belongs to alone, named by the owner offsets its vertices
 * carry (derived-mesh.ts): a plane cell's top, underside and sides above its
 * underside its own cell, a supported cell's closing geometry (its floor,
 * and its sides below its underside) the body under it. So a roof keeps its
 * material up to the seam and the wall its own up to the roof, whatever the
 * two are. Polygons still merge across cells (the mesh never depends on a
 * material: material and wetness feed the shader data alone), where they
 * lie in one plane and carry one crack strength: single-direction tops and
 * undersides along their level line, supported floors along z, side pieces
 * along their plane. A merged polygon's owner is the row of its cells: its
 * offsets land every pixel in the row's cell under it (along the row the
 * offset is 0, so the pixel reads the cell it lies in; across it a quarter
 * cell inside the row, as a one-cell polygon's on every axis). So each
 * pixel shows its own cell alone, as unmerged, but for pixels exactly on a
 * row's two end edges, which may read the cell past the end (the edge is
 * where the materials meet anyway). Collision takes the same merged planes.
 *
 * **Cracks.** A cracked plane cell (damage stage 1, roof-words.ts) stays in
 * its plane; its top and underside carry the crack overlay's strength in
 * their vertices' position w, as a cracked block's faces do
 * (base-surface.ts).
 *
 * Plane cells hide nothing: a wall beside, under or through a roof keeps
 * its faces (the planes stop at it; the wall's face closes the slab).
 * Their own voxel faces, collision boxes and kit pieces are left out.
 *
 * **Reach.** Whether a cell is a plane cell reads two cells round it
 * ({@link ROOF_PLANE_REACH}); the mesher reads the plane cells one round
 * the job's cells: {@link ROOF_MESHER_REACH} in all. The edge pass leaves
 * pieces off round plane cells, within its rule set's radius.
 */
import type { Neighbourhood } from './assembly';
import { POSITION_STEPS_PER_CELL, snorm8, SURFACE_OWNER_STEPS_PER_CELL, SURFACE_VERTEX_BYTES, writeSurfaceExtras, type SurfaceBuffer } from './derived-mesh';
import { ROOF_DX, ROOF_DZ, roofAlong, roofPlaneAt, ROOF_WORD } from './roof-words';


const DX = ROOF_DX;
const DZ = ROOF_DZ;

/** The word bits that say which plane a cell's top lies on (cells of a run along the level line share them). */
const PLANE_BITS = ROOF_WORD.dirs | ROOF_WORD.concave | ROOF_WORD.shallow | (0xf << ROOF_WORD.phaseShift);

/** Per job face (2 · axis + side): a 1:2 plane cell lies at it, so its edges split at quarter points up. */
const faceShallow = [false, false, false, false, false, false];

function bits4(m: number): number {
  return (m & 1) + ((m >>> 1) & 1) + ((m >>> 2) & 1) + ((m >>> 3) & 1);
}

// ---------------------------------------------------------------------------
// Geometry. Points are in quarter cells from the job's corner (integers):
// a cell's corners, its edges' middles and its centre lie on the even
// points across (x, z), and a 1:2 plane's heights there are whole quarters.

/** Quarter cells a cell. */
const Q = 4;

/** Height (quarter cells) of a plane cell's top at sample (iu, iv) of 0, 2, 4 across it, its voxel at local y. */
function topAt(w: number, y: number, iu: number, iv: number): number {
  const dirs = w & ROOF_WORD.dirs;
  const shallow = (w & ROOF_WORD.shallow) !== 0;
  const concave = (w & ROOF_WORD.concave) !== 0;
  let h = concave ? -Infinity : Infinity;
  for (let k = 0; k < 4; k++) {
    if (((dirs >>> k) & 1) === 0) continue;
    const at = roofPlaneAt(shallow, (w >>> (ROOF_WORD.phaseShift + k)) & 1, roofAlong(k, iu, iv));
    h = concave ? Math.max(h, at) : Math.min(h, at);
  }
  return Q * (y + 1) + h;
}

/** The floor a supported cell closes down onto (quarter cells): its body's top. */
function floorOf(w: number, y: number): number {
  return Q * (y - ((w & ROOF_WORD.gap) !== 0 ? 1 : 0));
}

/** The prism's lower face at a sample: the underside one cell below the top, or a supported cell's floor. */
function bottomAt(w: number, y: number, iu: number, iv: number): number {
  return (w & ROOF_WORD.supported) !== 0 ? floorOf(w, y) : topAt(w, y, iu, iv) - Q;
}

const otherBot = [0, 0, 0];
const otherTop = [0, 0, 0];

/** A plane cell's side k (facing direction k) sampled at 0, ½, 1 along it: its lower face and top heights. */
function sideProfile(w: number, y: number, k: number, bot: number[], top: number[]): void {
  for (let t = 0; t < 3; t++) {
    const iu = (k & 1) === 0 ? (k === 0 ? Q : 0) : 2 * t;
    const iv = (k & 1) === 0 ? 2 * t : k === 1 ? Q : 0;
    bot[t] = bottomAt(w, y, iu, iv);
    top[t] = topAt(w, y, iu, iv);
  }
}

/** A polygon: its ring (x, y, z quarter-cell triples, corners only), which way it should face and the cells it shows. */
interface Poly {
  ring: number[];
  /** Outward hint: 0 up, 1 down, 2 + k a side facing direction k (+x, +z, −x, −z). */
  face: number;
  /** The crack overlay's strength its vertices carry (0 … 255; absent: none). */
  crack?: number;
  /** The job-local box of cells (x0, y0, z0, x1, y1, z1, ends inclusive) whose one shader entry it shows alone. */
  box: readonly number[];
}

/** A one-cell owner box. */
function cellBox(c: readonly number[]): number[] {
  return [c[0]!, c[1]!, c[2]!, c[0]!, c[1]!, c[2]!];
}

/** One side of a prism on a vertical plane, sampled at 0, ½, 1 along the plane. */
interface Strip {
  /** +1: faces the plane's positive axis, −1 the negative. */
  sign: number;
  bot: [number, number, number];
  top: [number, number, number];
  /** The cell is the job's own (only its pieces are drawn). */
  own: boolean;
  /** The plane cell (job-local). */
  cell: readonly number[];
  /** A supported cell's underside line (quarter cells, at 0, ½, 1): below it the side closes onto `body`; null: unsupported. */
  split: [number, number, number] | null;
  /** The body a supported cell closes onto (job-local). */
  body: readonly number[];
}

/** A resolved side piece on a plane: from b0 to b1 (half cells along the plane), its low and high lines (quarter cells) at both ends. */
interface Piece {
  b0: number;
  b1: number;
  lo0: number;
  lo1: number;
  hi0: number;
  hi1: number;
  sign: number;
  /** The cell whose material it shows (the first along the plane, once merged). */
  owner: readonly number[];
  /** Where along the plane the last cell it shows lies (cells; its first: the owner's): merged pieces span several. */
  ownerEnd?: number;
}

/** A strip's piece from b0 to b1 along a band between two of its lines (quarter cells at both ends), the cell it shows. */
function stripPiece(st: Strip, b: number, t0: number, t1: number, lo: readonly number[], hi: readonly number[], owner: readonly number[]): Piece {
  return { b0: 2 * b + t0, b1: 2 * b + t1, lo0: lo[t0]!, lo1: lo[t1]!, hi0: hi[t0]!, hi1: hi[t1]!, sign: st.sign, owner };
}

/** An own strip's side drawn whole on a segment: a supported one as its closing part (the body's) and its slab part (its own). */
function wholeStrip(st: Strip, b: number, t0: number, t1: number, out: Piece[]): void {
  if (st.split === null) {
    out.push(stripPiece(st, b, t0, t1, st.bot, st.top, st.cell));
    return;
  }
  out.push(stripPiece(st, b, t0, t1, st.bot, st.split, st.body));
  out.push(stripPiece(st, b, t0, t1, st.split, st.top, st.cell));
}

/**
 * The pieces of one side plane cell span (strips at the same plane and the
 * same cell along it), segment by segment: the difference of the strips
 * facing either way, read in the segment's middle (where no two lines meet)
 * and each band carried to the ends along the strip lines bounding it, so a
 * band may narrow to a point at one end (a gable wall's step under a
 * slope). A band is drawn by the job owning the strip it lies in and shows
 * that strip's cell, or below a supported strip's underside the body under
 * it. Where bounding lines cross inside the segment every own strip is
 * drawn whole: still closed, only less tidy.
 */
function resolveSpan(strips: readonly Strip[], b: number, out: Piece[]): void {
  if (strips.length === 1) {
    // Nothing across: the side is drawn as it is (an eave's fascia, a verge, a side against a wall).
    const st = strips[0]!;
    if (st.own) for (let t = 0; t < 2; t++) wholeStrip(st, b, t, t + 1, out);
    return;
  }
  for (let seg = 0; seg < 2; seg++) {
    const t0 = seg;
    const t1 = seg + 1;
    // Each strip's bottom and top lines with their signed step in coverage, a supported own strip's underside (no
    // step: where its band changes owner), ordered in the middle.
    const ev: Array<{ m: number; y0: number; y1: number; step: number }> = [];
    for (const st of strips) {
      ev.push({ m: st.bot[t0]! + st.bot[t1]!, y0: st.bot[t0]!, y1: st.bot[t1]!, step: st.sign });
      ev.push({ m: st.top[t0]! + st.top[t1]!, y0: st.top[t0]!, y1: st.top[t1]!, step: -st.sign });
      if (st.own && st.split !== null) ev.push({ m: st.split[t0]! + st.split[t1]!, y0: st.split[t0]!, y1: st.split[t1]!, step: 0 });
    }
    ev.sort((p, q) => p.m - q.m);
    const start = out.length;
    let net = 0;
    let crossed = false;
    let open: Piece | null = null;
    for (let k = 0; k < ev.length; k++) {
      const e = ev[k]!;
      net += e.step;
      const next = ev[k + 1];
      if (next === undefined || next.m === e.m) continue;
      if (next.y0 < e.y0 || next.y1 < e.y1) crossed = true;
      const sign = net > 0 ? 1 : net < 0 ? -1 : 0;
      if (sign === 0) {
        open = null;
        continue;
      }
      const mid2 = (e.m + next.m) / 2;
      const strip = strips.find((st) => st.sign === sign && st.bot[t0]! + st.bot[t1]! <= mid2 && st.top[t0]! + st.top[t1]! >= mid2);
      if (strip === undefined || !strip.own) {
        open = null;
        continue;
      }
      const owner = strip.split !== null && strip.split[t0]! + strip.split[t1]! >= mid2 ? strip.body : strip.cell;
      if (open !== null && open.sign === sign && open.owner === owner) {
        open.hi0 = next.y0;
        open.hi1 = next.y1;
        continue;
      }
      open = { b0: 2 * b + t0, b1: 2 * b + t1, lo0: e.y0, lo1: e.y1, hi0: next.y0, hi1: next.y1, sign, owner };
      out.push(open);
    }
    if (crossed) {
      out.length = start;
      for (const st of strips) if (st.own) wholeStrip(st, b, t0, t1, out);
    }
  }
}

/**
 * Joins pieces of one plane end to end where their lines continue straight
 * and they show cells of one height (a cell's two halves, an eave's fascia
 * along a row). A piece shows cells of one column across the plane (its
 * sign picks it), so only its row along the plane grows.
 */
function mergePieces(pieces: Piece[], alongX: boolean): Piece[] {
  pieces.sort((p, q) => p.b0 - q.b0 || p.lo0 - q.lo0);
  const open = mergeOpen;
  open.clear();
  // A piece's end as a key: where it ends along the plane (half cells), its two heights there (quarter cells),
  // facing and slopes (−2 … 2 quarter cells a half cell: 45° or 1:2, up or down), and the height of the cells it shows.
  const endKey = (b: number, lo: number, hi: number, sign: number, dlo: number, dhi: number, what: number): number =>
    (((((b + 8) * 512 + lo + 16) * 512 + hi + 16) * 4 + sign + 1) * 25 + (dlo + 2) * 5 + (dhi + 2)) * 128 + what;
  const along = alongX ? 2 : 0;
  const out: Piece[] = [];
  for (const p of pieces) {
    const what = p.owner[1]! + 16;
    const key = endKey(p.b0, p.lo0, p.hi0, p.sign, p.lo1 - p.lo0, p.hi1 - p.hi0, what);
    const q = open.get(key);
    if (q !== undefined && (q.lo1 - q.lo0) / (q.b1 - q.b0) === p.lo1 - p.lo0 && (q.hi1 - q.hi0) / (q.b1 - q.b0) === p.hi1 - p.hi0) {
      open.delete(key);
      q.b1 = p.b1;
      q.lo1 = p.lo1;
      q.hi1 = p.hi1;
      q.ownerEnd = p.owner[along]!;
      open.set(endKey(q.b1, q.lo1, q.hi1, q.sign, p.lo1 - p.lo0, p.hi1 - p.hi0, what), q);
      continue;
    }
    out.push(p);
    open.set(endKey(p.b1, p.lo1, p.hi1, p.sign, p.lo1 - p.lo0, p.hi1 - p.hi0, what), p);
  }
  return out;
}

/** Per-thread scratch of {@link mergePieces}. */
const mergeOpen = new Map<number, Piece>();

/** A cell's top (or underside) polygons, unmerged; `corner` gives the point of sample (iu, iv) of 0, 1, 2 across the cell. */
function cellFacets(w: number, corner: (iu: number, iv: number) => number[], face: number, out: Poly[], crack: number, box: readonly number[]): void {
  const dirs = w & ROOF_WORD.dirs;
  const ring = (pts: ReadonlyArray<readonly [number, number]>): void => {
    out.push({ ring: pts.flatMap(([u, v]) => corner(u, v)), face, crack, box });
  };
  const n = bits4(dirs);
  if (n === 2 && (dirs === 0b0101 || dirs === 0b1010)) {
    if (dirs === 0b0101) {
      ring([[0, 0], [1, 0], [1, 2], [0, 2]]);
      ring([[1, 0], [2, 0], [2, 2], [1, 2]]);
    } else {
      ring([[0, 0], [2, 0], [2, 1], [0, 1]]);
      ring([[0, 1], [2, 1], [2, 2], [0, 2]]);
    }
    return;
  }
  if (n === 2) {
    // The hip or valley runs along the diagonal whose two corners the planes share.
    const along00 = topDiff(dirs, 0, 0) === 0 && topDiff(dirs, 2, 2) === 0;
    if (along00) {
      ring([[0, 0], [2, 0], [2, 2]]);
      ring([[0, 0], [2, 2], [0, 2]]);
    } else {
      ring([[0, 0], [2, 0], [0, 2]]);
      ring([[2, 0], [2, 2], [0, 2]]);
    }
    return;
  }
  // Three or four directions: a fan from the middle over the corners and edge middles (each triangle one plane).
  const rim: Array<[number, number]> = [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]];
  for (let k = 0; k < 8; k++) ring([[1, 1], rim[k]!, rim[(k + 1) & 7]!]);
}

/** For a two-direction cell: the difference of its two planes' rise at a sample (0 on the hip or valley line). */
function topDiff(dirs: number, iu: number, iv: number): number {
  const along: number[] = [];
  for (let k = 0; k < 4; k++) if (((dirs >>> k) & 1) !== 0) along.push(k === 0 ? iu : k === 1 ? iv : k === 2 ? 2 - iu : 2 - iv);
  return along[0]! - along[1]!;
}

/** Per-thread scratch. */
const strips = new Map<number, Strip[]>();
/**
 * Lattice points some polygon of the job has a corner at: a stamp per point, the job's call number. Corners lie on
 * even quarters across (x and z, stored halved), any quarter up.
 */
let stampGrid = new Uint16Array(0);
let stampAcross = 0;
let stampUp = 0;
let stampCall = 0;
/** Half cells past the job's corner a corner may lie across (the cells one round the job). */
const STAMP_PAD_ACROSS = 4;
/** Quarter cells below the job's corner a corner may lie (a supported floor a cell under a cell one below the job). */
const STAMP_PAD_UP = 12;

const STEPS = POSITION_STEPS_PER_CELL;
/** Owner offsets' steps a quarter cell. */
const TO_OWNER = SURFACE_OWNER_STEPS_PER_CELL / Q;
/** How far inside a one-cell side of its owner box (quarter cells) a vertex's offset lands it: one step, so rounding keeps it inside. */
const OWNER_INSET = 1;
/** Quarter cells to position steps (positions count from one cell below the job's corner). */
const QUARTER = STEPS / Q;

/** The output vertex arrays, grown as needed. */
let pos = new Int32Array(3 * 256);
let nrm = new Int8Array(3 * 256);
let crk = new Uint8Array(256);
/** Per vertex: its owner offset (quarter cells, x, y, z from the vertex to where it lands inside its owner box). */
let owners = new Int8Array(3 * 256);
let tris = new Uint32Array(3 * 512);
let vertexCount = 0;
let triLen = 0;
const vertexOf = new Map<number, number>();

/** Positions are whole sixteenths of a cell (corners, edge middles, a fan's inside point), so a vertex keys by sixteenths and normal. */
const SIXTEENTH = STEPS / 16;

/**
 * Keys below this are a position and normal (sixteenths under 1,024 each way, 32 normals); the owner offset counts
 * above (it names the owner box, and a box's faces of one normal carry one crack strength).
 */
const OWNER_KEY = 1024 * 1024 * 1024 * 32;

function addVertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, normal: number, crack: number, ox: number, oy: number, oz: number): number {
  const key = ((((x / SIXTEENTH) * 1024 + y / SIXTEENTH) * 1024 + z / SIXTEENTH) * 32 + normal) + (((ox + 8) * 16 + oz + 8) * 128 + oy + 64) * OWNER_KEY;
  const known = vertexOf.get(key);
  if (known !== undefined) return known;
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
    const w = new Int8Array(owners.length * 2);
    w.set(owners);
    owners = w;
  }
  crk[vertexCount] = crack;
  const o = 3 * vertexCount;
  owners[o] = ox;
  owners[o + 1] = oy;
  owners[o + 2] = oz;
  pos[o] = x;
  pos[o + 1] = y;
  pos[o + 2] = z;
  nrm[o] = nx;
  nrm[o + 1] = ny;
  nrm[o + 2] = nz;
  vertexOf.set(key, vertexCount);
  return vertexCount++;
}

/** The roof's normals are a small set (four slopes up and down, four sides, flat): an index of the snorm8 triple seen. */
const normalKeys = new Map<number, number>();
function normalIndex(nx: number, ny: number, nz: number): number {
  const k = ((nx + 128) << 16) | ((ny + 128) << 8) | (nz + 128);
  let i = normalKeys.get(k);
  if (i === undefined) {
    i = normalKeys.size & 31;
    normalKeys.set(k, i);
  }
  return i;
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

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function stampKey(x: number, y: number, z: number): number {
  return ((x / 2 + STAMP_PAD_ACROSS) * stampUp + (y + STAMP_PAD_UP)) * stampAcross + (z / 2 + STAMP_PAD_ACROSS);
}

function stamped(x: number, y: number, z: number): boolean {
  return stampGrid[stampKey(x, y, z)] === stampCall;
}

/** Outward normal of a ring (Newell), unnormalised. */
function newell(r: readonly number[]): [number, number, number] {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const k = r.length / 3;
  for (let a = 0; a < k; a++) {
    const b = (a + 1) % k;
    const ay = r[3 * a + 1]!, az = r[3 * a + 2]!, ax = r[3 * a]!;
    const by = r[3 * b + 1]!, bz = r[3 * b + 2]!, bx = r[3 * b]!;
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
  }
  return [nx, ny, nz];
}

const FACE_AXIS = [1, 1, 0, 2, 0, 2] as const;
const FACE_SIGN = [1, -1, 1, 1, -1, -1] as const;

/**
 * Emits a polygon: wound to face its hint, every edge split at the stamped
 * points on it (on a face of the job every lattice point a corner of the
 * job across could have: whole half cells, and quarters up where a 1:2
 * roof meets that face, {@link faceShallow}), then fanned from a corner
 * both of whose edges are whole, else from a point inside.
 */
/**
 * The owner offset (steps) along axis `a` of a point `p` (quarter cells) of a polygon owned by `box`: to the nearest
 * point an inset inside a one-cell side, nothing along a row (the pixel reads the cell it lies in).
 */
function ownerOffset(box: readonly number[], p: number, a: number): number {
  const inset = box[a] === box[a + 3] ? OWNER_INSET : 0;
  const lo = Q * box[a]! + inset;
  const hi = Q * (box[a + 3]! + 1) - inset;
  return Math.round(((p < lo ? lo : p > hi ? hi : p) - p) * TO_OWNER);
}

function emit(poly: Poly, e: number): void {
  let r: number[] = [];
  // A band that narrows to a point at one end: drop the repeated corner.
  const src = poly.ring;
  const n0 = src.length / 3;
  for (let a = 0; a < n0; a++) {
    const b = (a + 1) % n0;
    if (src[3 * a] === src[3 * b] && src[3 * a + 1] === src[3 * b + 1] && src[3 * a + 2] === src[3 * b + 2]) continue;
    r.push(src[3 * a]!, src[3 * a + 1]!, src[3 * a + 2]!);
  }
  const k = r.length / 3;
  if (k < 3) return;
  const nv = newell(r);
  if (nv[FACE_AXIS[poly.face]!]! * FACE_SIGN[poly.face]! < 0) {
    const rev: number[] = [];
    for (let a = k - 1; a >= 0; a--) rev.push(r[3 * a]!, r[3 * a + 1]!, r[3 * a + 2]!);
    r = rev;
    nv[0] = -nv[0];
    nv[1] = -nv[1];
    nv[2] = -nv[2];
  }
  const len = Math.hypot(nv[0], nv[1], nv[2]);
  if (len === 0) return;
  const nx = snorm8(nv[0] / len);
  const ny = snorm8(nv[1] / len);
  const nz = snorm8(nv[2] / len);
  const pts: number[] = [];
  const cornerAt: number[] = [];
  const extra: number[] = [];
  for (let a = 0; a < k; a++) {
    const b = (a + 1) % k;
    const p = [r[3 * a]!, r[3 * a + 1]!, r[3 * a + 2]!];
    const q = [r[3 * b]!, r[3 * b + 1]!, r[3 * b + 2]!];
    cornerAt.push(pts.length / 3);
    pts.push(p[0]!, p[1]!, p[2]!);
    // Every lattice point along the edge (even quarters across, any quarter up), in steps of its direction.
    const dx = q[0]! - p[0]!, dy = q[1]! - p[1]!, dz = q[2]! - p[2]!;
    const g = gcd(gcd(Math.abs(dx) / 2, Math.abs(dy)), Math.abs(dz) / 2);
    // On a face of the job: the job across splits it its own way, so take every point a corner there could have
    // (half cells: a side piece may end half way along a cell; quarters up where a 1:2 roof meets the face).
    let face = -1;
    for (let c = 0; c < 3; c++) if (p[c] === q[c] && (p[c] === 0 || p[c] === Q * e)) face = 2 * c + (p[c] === 0 ? 0 : 1);
    let added = 0;
    for (let t = 1; t < g; t++) {
      const x = p[0]! + (dx / g) * t, y = p[1]! + (dy / g) * t, z = p[2]! + (dz / g) * t;
      if (!stamped(x, y, z) && (face < 0 || ((y & 1) !== 0 && !faceShallow[face]))) continue;
      pts.push(x, y, z);
      added++;
    }
    extra.push(added);
  }
  const m = pts.length / 3;
  const ids: number[] = [];
  const normal = normalIndex(nx, ny, nz);
  const crack = poly.crack ?? 0;
  // Each vertex carries the offset to the nearest point an inset inside its owner box's one-cell sides (quarter cells;
  // a fan's inside point rounded to whole steps, which keeps it inside by half the inset).
  const box = poly.box;
  const off = (p: number, a: number): number => ownerOffset(box, p, a);
  const vertex = (x: number, y: number, z: number): number =>
    addVertex(x * QUARTER + STEPS, y * QUARTER + STEPS, z * QUARTER + STEPS, nx, ny, nz, normal, crack, off(x, 0), off(y, 1), off(z, 2));
  for (let a = 0; a < m; a++) ids.push(vertex(pts[3 * a]!, pts[3 * a + 1]!, pts[3 * a + 2]!));
  let apex = -1;
  for (let c = 0; c < k && apex < 0; c++) if (extra[c] === 0 && extra[(c + k - 1) % k] === 0) apex = cornerAt[c]!;
  if (apex >= 0) {
    for (let j = 1; j + 1 < m; j++) addTri(ids[apex]!, ids[(apex + j) % m]!, ids[(apex + j + 1) % m]!);
    return;
  }
  // A point inside: a triangle's median (a quarter of the way from a corner's opposite edge), else a diagonal's middle.
  const c = [0, 0, 0];
  if (k === 3) for (let a = 0; a < 3; a++) c[a] = (2 * r[a]! + r[3 + a]! + r[6 + a]!) / 4;
  else for (let a = 0; a < 3; a++) c[a] = (r[a]! + r[6 + a]!) / 2;
  const centre = vertex(c[0]!, c[1]!, c[2]!);
  for (let j = 0; j < m; j++) addTri(centre, ids[j]!, ids[(j + 1) % m]!);
}

/**
 * The roof planes of a job's chunk (or section) from its neighbourhood and
 * the plane-cell words {@link classifyRoofs} wrote, in the derive's surface
 * layout (positions from one cell below the job's corner): drawn with the
 * base surface, and the roof's collision. `crackOf` gives a cell value's
 * crack strength (null: no cracks drawn).
 */
export function roofSurface(n: Neighbourhood, words: Uint32Array, crackOf: ((v: number) => number) | null = null): SurfaceBuffer {
  const e = n.edge;
  const p = n.pad;
  const s = n.side;
  vertexCount = 0;
  triLen = 0;
  vertexOf.clear();
  strips.clear();
  stampAcross = 2 * e + 2 * STAMP_PAD_ACROSS + 1;
  stampUp = Q * e + 2 * STAMP_PAD_UP + 1;
  if (stampGrid.length < stampAcross * stampAcross * stampUp) {
    stampGrid = new Uint16Array(stampAcross * stampAcross * stampUp);
    stampCall = 0;
  }
  if (++stampCall > 0xffff) {
    stampGrid.fill(0);
    stampCall = 1;
  }
  // Which faces of the job a 1:2 roof meets (a plane cell on either side of it): their quarter points are split.
  faceShallow.fill(false);
  const polys: Poly[] = [];
  const at = (x: number, y: number, z: number): number => ((x + p) * s + (z + p)) * s + (y + p);
  let any = false;
  // Prisms of the job's cells and one round them: their sides, keyed by plane and cell along it. A side that the
  // prism across meets exactly (most of them: along a slope, a ridge, a row) is left out on both sides first.
  const W = e + 4;
  const bot = [0, 0, 0];
  const top = [0, 0, 0];
  for (let x = -1; x <= e; x++) for (let z = -1; z <= e; z++) for (let y = -1; y <= e; y++) {
    const i = at(x, y, z);
    const w = words[i]!;
    if (w === 0) continue;
    const own = x >= 0 && y >= 0 && z >= 0 && x < e && y < e && z < e;
    if (own) any = true;
    if ((w & ROOF_WORD.shallow) !== 0) {
      const c = [x, y, z];
      for (let a = 0; a < 3; a++) {
        if (c[a]! <= 0) faceShallow[2 * a] = true;
        if (c[a]! >= e - 1) faceShallow[2 * a + 1] = true;
      }
    }
    for (let k = 0; k < 4; k++) {
      sideProfile(w, y, k, bot, top);
      const across = i + (DX[k]! * s + DZ[k]!) * s;
      // Only cells the words cover (the job and one round it) are read across.
      const ax = x + DX[k]!;
      const az = z + DZ[k]!;
      const inBox = ax >= -1 && ax <= e && az >= -1 && az <= e;
      let met = false;
      for (let dy = -1; dy <= 1 && !met && inBox; dy++) {
        if (y + dy < -1 || y + dy > e) continue;
        const wj = words[across + dy]!;
        if (wj === 0) continue;
        sideProfile(wj, y + dy, (k + 2) & 3, otherBot, otherTop);
        met = bot[0] === otherBot[0] && bot[1] === otherBot[1] && bot[2] === otherBot[2] && top[0] === otherTop[0] && top[1] === otherTop[1] && top[2] === otherTop[2];
      }
      if (met) continue;
      const alongX = (k & 1) === 0;
      const plane = alongX ? x + (k === 0 ? 1 : 0) : z + (k === 1 ? 1 : 0);
      const b = alongX ? z : x;
      const key = ((alongX ? 0 : 1) * W + plane + 2) * W + b + 2;
      let list = strips.get(key);
      if (list === undefined) strips.set(key, (list = []));
      const split: [number, number, number] | null = (w & ROOF_WORD.supported) !== 0 ? [top[0]! - Q, top[1]! - Q, top[2]! - Q] : null;
      list.push({ sign: k < 2 ? 1 : -1, bot: [bot[0]!, bot[1]!, bot[2]!], top: [top[0]!, top[1]!, top[2]!], own, cell: [x, y, z], split, body: [x, floorOf(w, y) / Q - 1, z] });
    }
  }
  if (!any) return { vertexCount: 0, vertices: new Uint8Array(0), indices: new Uint16Array(0) };

  // Tops and undersides: single-direction cells merged along their level line where they carry one crack strength
  // (inside a job; never across a section face), the rest per cell.
  const own = (x: number, y: number, z: number): number => (x >= 0 && y >= 0 && z >= 0 && x < e && y < e && z < e ? words[at(x, y, z)]! : 0);
  const crackAt = (x: number, y: number, z: number): number => (crackOf === null ? 0 : crackOf(n.values[at(x, y, z)]!));
  const single = (w: number): number => {
    const d = w & ROOF_WORD.dirs;
    return d === 1 ? 0 : d === 2 ? 1 : d === 4 ? 2 : d === 8 ? 3 : -1;
  };
  // A sample (iu, iv of 0, 1, 2 across the cell) of a cell's top or underside, in quarter cells.
  const corner = (x: number, y: number, z: number, w: number, under: boolean) => (iu: number, iv: number): number[] => [Q * x + 2 * iu, (under ? -Q : 0) + topAt(w, y, 2 * iu, 2 * iv), Q * z + 2 * iv];
  const SUPPORT = ROOF_WORD.supported | ROOF_WORD.gap;
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) for (let y = 0; y < e; y++) {
    const w = own(x, y, z);
    if (w === 0) continue;
    const supported = (w & ROOF_WORD.supported) !== 0;
    const d = single(w);
    const crack = crackAt(x, y, z);
    if (d < 0) {
      const box = cellBox([x, y, z]);
      cellFacets(w, corner(x, y, z, w, false), 0, polys, crack, box);
      if (!supported) cellFacets(w, corner(x, y, z, w, true), 1, polys, crack, box);
    } else {
      // A run along the slope's level line (z for a slope along x, x for one along z) starts at its first cell.
      const runX = d === 1 || d === 3;
      const next = (j: number): number => (runX ? own(x + j, y, z) : own(x, y, z + j));
      const same = (j: number): boolean => (runX ? crackAt(x + j, y, z) : crackAt(x, y, z + j)) === crack;
      const startX = runX ? x : z;
      for (const under of [false, true]) {
        if (under && supported) continue;
        // Tops join where they are one plane; undersides only unsupported ones.
        const mask = under ? PLANE_BITS | ROOF_WORD.supported : PLANE_BITS;
        if ((next(-1) & mask) === (w & mask) && same(-1)) continue;
        let len = 1;
        while (startX + len < e && (next(len) & mask) === (w & mask) && same(len)) len++;
        const c0 = corner(x, y, z, w, under);
        const c1 = runX ? corner(x + len - 1, y, z, w, under) : corner(x, y, z + len - 1, w, under);
        const box = runX ? [x, y, z, x + len - 1, y, z] : [x, y, z, x, y, z + len - 1];
        polys.push({ ring: runX ? [...c0(0, 0), ...c1(2, 0), ...c1(2, 2), ...c0(0, 2)] : [...c0(0, 0), ...c0(2, 0), ...c1(2, 2), ...c1(0, 2)], face: under ? 1 : 0, crack, box });
      }
    }
    // A supported cell's floor lies on its body's top face (so the slab and the body each stay closed) and shows the
    // body: one quad, merged along z with cells on the same floor.
    if (supported) {
      const f = floorOf(w, y);
      const by = f / Q - 1;
      const joins = (j: number): boolean => (own(x, y, z + j) & SUPPORT) === (w & SUPPORT);
      if (joins(-1)) continue;
      let len = 1;
      while (z + len < e && joins(len)) len++;
      polys.push({ ring: [Q * x, f, Q * z, Q * x + Q, f, Q * z, Q * x + Q, f, Q * (z + len), Q * x, f, Q * (z + len)], face: 1, box: [x, by, z, x, by, z + len - 1] });
    }
  }

  // Sides: per plane, the strips' difference, then joined end to end.
  const byPlane = new Map<number, Piece[]>();
  for (const [key, list] of strips) {
    if (!list.some((st) => st.own)) continue;
    const b = (key % W) - 2;
    const planeKey = Math.floor(key / W);
    let pieces = byPlane.get(planeKey);
    if (pieces === undefined) byPlane.set(planeKey, (pieces = []));
    resolveSpan(list, b, pieces);
  }
  for (const [planeKey, pieces] of byPlane) {
    const alongX = Math.floor(planeKey / W) === 0;
    const plane = Q * ((planeKey % W) - 2);
    for (const q of mergePieces(pieces, alongX)) {
      // b along the plane in half cells, h in quarter cells.
      const pt = (b: number, h: number): number[] => (alongX ? [plane, h, 2 * b] : [2 * b, h, plane]);
      const box = cellBox(q.owner);
      if (q.ownerEnd !== undefined) box[alongX ? 5 : 3] = q.ownerEnd;
      polys.push({ ring: [...pt(q.b0, q.lo0), ...pt(q.b1, q.lo1), ...pt(q.b1, q.hi1), ...pt(q.b0, q.hi0)], face: 2 + (alongX ? (q.sign > 0 ? 0 : 2) : q.sign > 0 ? 1 : 3), box });
    }
  }

  for (const poly of polys) {
    const r = poly.ring;
    for (let a = 0; a < r.length; a += 3) stampGrid[stampKey(r[a]!, r[a + 1]!, r[a + 2]!)] = stampCall;
  }
  for (const poly of polys) emit(poly, e);

  const vertices = new Uint8Array(vertexCount * SURFACE_VERTEX_BYTES);
  const view = new DataView(vertices.buffer);
  for (let v = 0; v < vertexCount; v++) {
    const o = v * SURFACE_VERTEX_BYTES;
    view.setUint16(o, pos[3 * v]!, true);
    view.setUint16(o + 2, pos[3 * v + 1]!, true);
    view.setUint16(o + 4, pos[3 * v + 2]!, true);
    view.setInt8(o + 8, nrm[3 * v]!);
    view.setInt8(o + 9, nrm[3 * v + 1]!);
    view.setInt8(o + 10, nrm[3 * v + 2]!);
    ownScratch[0] = owners[3 * v]!;
    ownScratch[1] = owners[3 * v + 1]!;
    ownScratch[2] = owners[3 * v + 2]!;
    writeSurfaceExtras(view, v, crk[v]!, ownScratch);
  }
  const t = tris.subarray(0, triLen);
  return { vertexCount, vertices, indices: vertexCount < 65536 ? new Uint16Array(t) : new Uint32Array(t) };
}

const ownScratch = [0, 0, 0];

/** Two surfaces in one buffer (the base surface with the roof's planes after it). */
export function appendSurface(a: SurfaceBuffer, b: SurfaceBuffer): SurfaceBuffer {
  if (b.vertexCount === 0) return a;
  if (a.vertexCount === 0) return b;
  const vertexCount = a.vertexCount + b.vertexCount;
  const vertices = new Uint8Array(vertexCount * SURFACE_VERTEX_BYTES);
  vertices.set(a.vertices.subarray(0, a.vertexCount * SURFACE_VERTEX_BYTES));
  vertices.set(b.vertices.subarray(0, b.vertexCount * SURFACE_VERTEX_BYTES), a.vertexCount * SURFACE_VERTEX_BYTES);
  const indices = vertexCount < 65536 ? new Uint16Array(a.indices.length + b.indices.length) : new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices);
  for (let k = 0; k < b.indices.length; k++) indices[a.indices.length + k] = b.indices[k]! + a.vertexCount;
  return { vertexCount, vertices, indices };
}
