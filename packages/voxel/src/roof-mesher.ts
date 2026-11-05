/**
 * The roof mesher: role `roof` cells laid as a 45° stair (each a step up
 * and across from the next) are drawn as flat sloped planes instead of
 * their stair faces, as the terrain mesher draws terrain. The stair voxels
 * stay the data: light, occupancy and navigation read them as they are;
 * collision reads the planes (a roof is a ramp where it is drawn), so a
 * character stands where the roof shows.
 *
 * **Which cells.** A **plane cell** is an intact roof cell (shape 15) with
 * nothing solid above it that rises in at least one of the four horizontal
 * directions d: an intact roof cell one up and one across in d, or one
 * down and one across against d (an eave or a ridge has only one of the
 * two). A cell with no axis neighbour like that rises in two directions at
 * once when a diagonal one is (an eave corner of a hip roof). A cell rising
 * one way with a roof cell beside it on the same level on its low side is a
 * flatter stair
 * than 45° and is left out (at one cell's reach the high side of a 1:2 step
 * cannot be told from a ridge, so a 1:2 stair keeps every other cell's voxel
 * faces), and so are damaged roof cells: every cell left out keeps its
 * voxel faces, drawn by the base surface (the mandatory fallback).
 *
 * **The surface.** A cell rising in d carries the plane through the
 * stair's outer corners: its top is its voxel's top (T) on its low side and
 * T + 1 on its high side; its underside is one cell lower (through the
 * stair's inner corners), or, when a solid cell carries it (a gable or eave
 * wall under the roof), its voxel's floor, so the slab closes onto the
 * wall instead of leaving the wall's steps showing under the verge. A cell
 * rising in several directions takes the lowest of their planes (a ridge
 * along its middle, a hip, the apex of a pyramid), or the highest where its
 * two directions both continue upward or the cell sits where a valley meets
 * the ridges (a valley). Every plane cell is a
 * closed prism (top, underside, four sides); faces two prisms share are
 * left out, and where two meet on a side unequally only the difference is
 * drawn, so the roof is one closed skin and a ridge, hip or valley is
 * where two planes meet edge to edge. Single-direction cells in a row along
 * the slope's level line merge into one quad (inside a section; never
 * across a section face), and every edge takes the lattice points on it
 * where another polygon of the job has a corner (on a section face:
 * every lattice point), so polygons meet without T-junctions.
 *
 * Plane cells hide nothing: a wall beside, under or through a roof keeps
 * its faces (the planes stop at it; the wall's face closes the slab).
 * Their own voxel faces, collision boxes and kit pieces are left out.
 *
 * **Roof edges** (what kit pieces dress, a word a cell): an eave on a low
 * side open below and in front, a verge (gable edge) on a side along the
 * slope's level line open beside it, a ridge where a plane meets the other
 * slope (owned by the cell rising toward +x or +z) or along a cell's middle,
 * a hip where two planes meet convex, a valley where they meet concave.
 *
 * **Reach.** Whether a cell is a plane cell reads one cell round it
 * ({@link ROOF_PLANE_REACH}); the mesher reads the plane cells one round
 * the job's cells: {@link ROOF_MESHER_REACH} in all. The edge pass leaves
 * pieces off round plane cells, within its rule set's radius.
 */
import { OPEN_ROLE, type Neighbourhood } from './assembly';
import { POSITION_STEPS_PER_CELL, snorm8, SURFACE_ISO, SURFACE_VERTEX_BYTES, type SurfaceBuffer } from './derived-mesh';
import { ROLE_MASK, ROLE_SHIFT, SHAPE_FULL, valueShape, VOXEL_ROLE } from './record';

/** How far (Chebyshev, cells) whether a cell is a plane cell reads. */
export const ROOF_PLANE_REACH = 1;

/** Cells past the job the roof mesher reads: the plane cells round it and what decides them. */
export const ROOF_MESHER_REACH = ROOF_PLANE_REACH + 1;

/**
 * A plane cell's word: bits 0–3 the directions it rises toward (bit k:
 * {@link ROOF_DIR} k), then flags, then per side k (the side facing
 * direction k) its roof edges. 0: not a plane cell.
 */
export const ROOF_WORD = Object.freeze({
  dirs: 0x0f,
  /** Its planes meet concave (a valley): the highest of them. */
  concave: 0x10,
  /** A solid cell carries it: the underside is the voxel's floor. */
  seated: 0x20,
  /** Shift of the 4 eave-side bits. */
  eaveShift: 8,
  /** Shift of the 4 verge-side bits. */
  vergeShift: 12,
  /** Shift of the 4 ridge-side bits (a ridge on that side, owned here). */
  ridgeShift: 16,
  /** A ridge along the cell's middle (rising both ways along one axis). */
  centreRidge: 0x100000,
});

/** Horizontal directions in yaw order (a quarter turn takes one to the next): +x, +z, −x, −z. */
export const ROOF_DIR = Object.freeze({ px: 0, pz: 1, nx: 2, nz: 3 });
const DX = [1, 0, -1, 0] as const;
const DZ = [0, 1, 0, -1] as const;

/** The roof-edge cases a plane cell's word names, for kit pieces (the catalogue's ids). */
export type RoofEdgeCase = 'roof-ridge' | 'roof-eave' | 'roof-gable' | 'roof-hip' | 'roof-valley';

/**
 * One roof-edge piece of a plane cell. Yaw (quarter turns about +y, +x to
 * +z) places the case's own orientation: an eave or verge open toward +z;
 * a ridge running along x on the cell's +z side; a hip or valley running to
 * the cell's +x, +z corner. A ridge along the cell's middle is `centred`
 * (moved half a cell in from the side its yaw names).
 */
export interface RoofEdge {
  readonly caseId: RoofEdgeCase;
  readonly yaw: number;
  readonly centred?: true;
}

/** The roof-edge pieces a plane cell's word names. */
export function roofEdgesOf(word: number): RoofEdge[] {
  const out: RoofEdge[] = [];
  const dirs = word & ROOF_WORD.dirs;
  if (dirs === 0) return out;
  for (let k = 0; k < 4; k++) {
    const yaw = (k + 3) & 3;
    if (((word >>> (ROOF_WORD.eaveShift + k)) & 1) !== 0) out.push({ caseId: 'roof-eave', yaw });
    if (((word >>> (ROOF_WORD.vergeShift + k)) & 1) !== 0) out.push({ caseId: 'roof-gable', yaw });
    if (((word >>> (ROOF_WORD.ridgeShift + k)) & 1) !== 0) out.push({ caseId: 'roof-ridge', yaw });
  }
  if ((word & ROOF_WORD.centreRidge) !== 0) out.push({ caseId: 'roof-ridge', yaw: (dirs & 0b0101) === 0b0101 ? 3 : 0, centred: true });
  for (let a = 0; a < 4; a++) {
    const b = (a + 1) & 3;
    if (((dirs >>> a) & 1) === 0 || ((dirs >>> b) & 1) === 0) continue;
    out.push({ caseId: (word & ROOF_WORD.concave) !== 0 ? 'roof-valley' : 'roof-hip', yaw: (a + 2) & 3 });
  }
  return out;
}

function bits4(m: number): number {
  return (m & 1) + ((m >>> 1) & 1) + ((m >>> 2) & 1) + ((m >>> 3) & 1);
}

/** Cell predicates over a neighbourhood. */
function roofIntact(n: Neighbourhood, i: number): boolean {
  const v = n.values[i]!;
  return ((v >>> ROLE_SHIFT) & ROLE_MASK) === VOXEL_ROLE.roof && valueShape(v) === SHAPE_FULL;
}

function solid(n: Neighbourhood, i: number): boolean {
  return OPEN_ROLE[(n.values[i]! >>> ROLE_SHIFT) & ROLE_MASK] !== 1 && n.shapes[i]! >= SURFACE_ISO;
}

/** Neighbourhood offsets of the four horizontal directions for a side (cached). */
const offsetsBySide = new Map<number, Int32Array>();
function offsets(s: number): Int32Array {
  let o = offsetsBySide.get(s);
  if (o === undefined) offsetsBySide.set(s, (o = Int32Array.from([0, 1, 2, 3], (k) => (DX[k]! * s + DZ[k]!) * s)));
  return o;
}

/** Whether cell `i` is a plane cell (reads {@link ROOF_PLANE_REACH} round it): the edge pass leaves pieces off round these. */
export function isRoofPlaneCell(n: Neighbourhood, i: number): boolean {
  return planeWord(n, i, offsets(n.side)) !== 0;
}

/** The plane-cell word of cell `i` without its edge bits (reads {@link ROOF_PLANE_REACH} round it), 0 when it is none. */
function planeWord(n: Neighbourhood, i: number, off: Int32Array): number {
  if (!roofIntact(n, i) || solid(n, i + 1)) return 0;
  let dirs = 0;
  for (let k = 0; k < 4; k++) if (roofIntact(n, i + 1 + off[k]!) || roofIntact(n, i - 1 - off[k]!)) dirs |= 1 << k;
  if (dirs === 0) {
    for (let k = 0; k < 4; k++) {
      const d = off[k]! + off[(k + 1) & 3]!;
      if (roofIntact(n, i + 1 + d) || roofIntact(n, i - 1 - d)) {
        if (dirs !== 0) return 0;
        dirs = (1 << k) | (1 << ((k + 1) & 3));
      }
    }
    if (dirs === 0) return 0;
  } else if (bits4(dirs) === 1) {
    // A one-direction cell with a roof cell on the same level on its low side: a flatter stair than 45° (a valley's
    // cell has the other slope's cell there).
    for (let k = 0; k < 4; k++) if (((dirs >>> k) & 1) !== 0 && roofIntact(n, i - off[k]!)) return 0;
  }
  let w = dirs;
  if (bits4(dirs) === 2) {
    for (let k = 0; k < 4; k++) {
      const b = (k + 1) & 3;
      if (((dirs >>> k) & 1) === 0 || ((dirs >>> b) & 1) === 0) continue;
      // Concave: both slopes go on up (a valley), or, where they meet a ridge (the top of an L's corner), the two
      // corners off the low one each have the three cells round them on this level (high corners, not low).
      const ok = off[k]!;
      const ob = off[b]!;
      const up = roofIntact(n, i + 1 + ok) && roofIntact(n, i + 1 + ob);
      const level = roofIntact(n, i - ok) && roofIntact(n, i + ob) && roofIntact(n, i - ok + ob) && roofIntact(n, i + ok) && roofIntact(n, i - ob) && roofIntact(n, i + ok - ob);
      if (up || level) w |= ROOF_WORD.concave;
    }
  }
  if (solid(n, i - 1)) w |= ROOF_WORD.seated;
  return w;
}

/**
 * The plane-cell words of a job: every cell of the job and one round it
 * into `out` (neighbourhood indexing; 0: none; cells further out are left as
 * they are), the job's own cells
 * with their roof edges. The pad must be at least {@link ROOF_MESHER_REACH}.
 * Returns the job's own plane cells.
 */
export function classifyRoofs(n: Neighbourhood, out: Uint32Array): number {
  const e = n.edge;
  const p = n.pad;
  const s = n.side;
  if (p < ROOF_MESHER_REACH) throw new RangeError(`roof mesher: pad ${p}, it reads ${ROOF_MESHER_REACH} cells past the job`);
  if (out.length !== n.values.length) throw new RangeError('roof words: wrong length');
  const off = offsets(s);
  const lo = p - 1;
  const hi = p + e + 1;
  const vals = n.values;
  let any = false;
  for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) {
    const row = (x * s + z) * s;
    for (let y = lo; y < hi; y++) {
      const i = row + y;
      if (((vals[i]! >>> ROLE_SHIFT) & ROLE_MASK) !== VOXEL_ROLE.roof) {
        out[i] = 0;
        continue;
      }
      const w = planeWord(n, i, off);
      out[i] = w;
      if (w !== 0) any = true;
    }
  }
  if (!any) return 0;
  let count = 0;
  for (let x = p; x < p + e; x++) for (let z = p; z < p + e; z++) {
    const row = (x * s + z) * s;
    for (let y = p; y < p + e; y++) {
      const i = row + y;
      const w = out[i]!;
      if (w === 0) continue;
      count++;
      const dirs = w & ROOF_WORD.dirs;
      const many = bits4(dirs);
      let edges = 0;
      for (let k = 0; k < 4; k++) {
        if (((dirs >>> k) & 1) === 0) continue;
        const low = (k + 2) & 3;
        const below = i - off[k]!;
        if (!solid(n, below) && !solid(n, below - 1)) edges |= 1 << (ROOF_WORD.eaveShift + low);
        if (many === 1) {
          const a = (k + 1) & 3;
          const c = (k + 3) & 3;
          if (!solid(n, i + off[a]!)) edges |= 1 << (ROOF_WORD.vergeShift + a);
          if (!solid(n, i + off[c]!)) edges |= 1 << (ROOF_WORD.vergeShift + c);
          const other = out[i + off[k]!]!;
          if (k < 2 && other !== 0 && ((other >>> low) & 1) !== 0) edges |= 1 << (ROOF_WORD.ridgeShift + k);
        }
      }
      if (many >= 2 && many !== 4 && ((dirs & 0b0101) === 0b0101 || (dirs & 0b1010) === 0b1010)) edges |= ROOF_WORD.centreRidge;
      out[i] = w | edges;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Geometry. Points are in half cells from the job's corner (integers), so a
// cell's corners, its edges' middles and its centre are all lattice points.

/** Height (half cells) of a plane cell's top at sample (iu, iv) of 0 … 2 across it, its voxel at local y. */
function topAt(w: number, y: number, iu: number, iv: number): number {
  const dirs = w & ROOF_WORD.dirs;
  const t = 2 * (y + 1);
  const concave = (w & ROOF_WORD.concave) !== 0;
  let h = concave ? -Infinity : Infinity;
  for (let k = 0; k < 4; k++) {
    if (((dirs >>> k) & 1) === 0) continue;
    const along = k === 0 ? iu : k === 1 ? iv : k === 2 ? 2 - iu : 2 - iv;
    h = concave ? Math.max(h, t + along) : Math.min(h, t + along);
  }
  return h;
}

function bottomAt(w: number, y: number, iu: number, iv: number): number {
  return (w & ROOF_WORD.seated) !== 0 ? 2 * y : topAt(w, y, iu, iv) - 2;
}

const otherBot = [0, 0, 0];
const otherTop = [0, 0, 0];

/** A plane cell's side k (facing direction k) sampled at 0, ½, 1 along it: its underside and top heights. */
function sideProfile(w: number, y: number, k: number, bot: number[], top: number[]): void {
  for (let t = 0; t < 3; t++) {
    const iu = (k & 1) === 0 ? (k === 0 ? 2 : 0) : t;
    const iv = (k & 1) === 0 ? t : k === 1 ? 2 : 0;
    bot[t] = bottomAt(w, y, iu, iv);
    top[t] = topAt(w, y, iu, iv);
  }
}

/** A polygon: its ring (x, y, z half-cell triples, corners only) and which way it should face. */
interface Poly {
  ring: number[];
  /** Outward hint: 0 up, 1 down, 2 + k a side facing direction k (+x, +z, −x, −z). */
  face: number;
}

/** One side of a prism on a vertical plane, sampled at 0, ½, 1 along the plane. */
interface Strip {
  /** +1: faces the plane's positive axis, −1 the negative. */
  sign: number;
  bot: [number, number, number];
  top: [number, number, number];
  /** The cell is the job's own (only its pieces are drawn). */
  own: boolean;
}

/** A resolved side piece on a plane: from b0 to b1 (half cells along the plane), its low and high lines at both ends. */
interface Piece {
  b0: number;
  b1: number;
  lo0: number;
  lo1: number;
  hi0: number;
  hi1: number;
  sign: number;
}

/**
 * The pieces of one side plane cell span (strips at the same plane and the
 * same cell along it), segment by segment: the difference of the strips
 * facing either way, read in the segment's middle (where no two lines meet)
 * and each band carried to the ends along the strip lines bounding it, so a
 * band may narrow to a point at one end (a gable wall's step under a
 * slope). Where bounding lines cross inside the segment every own strip is
 * drawn whole: still closed, only less tidy.
 */
function resolveSpan(strips: readonly Strip[], b: number, out: Piece[]): void {
  if (strips.length === 1) {
    // Nothing across: the side is drawn as it is (an eave's fascia, a verge, a side against a wall).
    const st = strips[0]!;
    if (st.own) for (let t = 0; t < 2; t++) out.push({ b0: 2 * b + t, b1: 2 * b + t + 1, lo0: st.bot[t]!, lo1: st.bot[t + 1]!, hi0: st.top[t]!, hi1: st.top[t + 1]!, sign: st.sign });
    return;
  }
  for (let seg = 0; seg < 2; seg++) {
    const t0 = seg;
    const t1 = seg + 1;
    // Each strip's bottom and top lines with their signed step in coverage, ordered in the middle.
    const ev: Array<{ m: number; y0: number; y1: number; step: number; strip: Strip }> = [];
    for (const st of strips) {
      ev.push({ m: st.bot[t0]! + st.bot[t1]!, y0: st.bot[t0]!, y1: st.bot[t1]!, step: st.sign, strip: st });
      ev.push({ m: st.top[t0]! + st.top[t1]!, y0: st.top[t0]!, y1: st.top[t1]!, step: -st.sign, strip: st });
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
      if (open !== null && open.sign === sign) {
        open.hi0 = next.y0;
        open.hi1 = next.y1;
        continue;
      }
      const mid = (e.m + next.m) / 4;
      const owner = strips.find((st) => st.sign === sign && st.bot[t0]! + st.bot[t1]! <= 2 * mid && st.top[t0]! + st.top[t1]! >= 2 * mid);
      if (owner === undefined || !owner.own) {
        open = null;
        continue;
      }
      open = { b0: 2 * b + t0, b1: 2 * b + t1, lo0: e.y0, lo1: e.y1, hi0: next.y0, hi1: next.y1, sign };
      out.push(open);
    }
    if (crossed) {
      out.length = start;
      for (const st of strips) if (st.own) out.push({ b0: 2 * b + t0, b1: 2 * b + t1, lo0: st.bot[t0]!, lo1: st.bot[t1]!, hi0: st.top[t0]!, hi1: st.top[t1]!, sign: st.sign });
    }
  }
}

/** Joins pieces of one plane end to end where their lines continue straight (an eave's fascia along a row). */
function mergePieces(pieces: Piece[]): Piece[] {
  pieces.sort((p, q) => p.b0 - q.b0 || p.lo0 - q.lo0);
  const open = new Map<number, Piece>();
  // A piece's end as a key: where it ends along the plane, its two heights there, facing and slopes (half cells, small).
  const endKey = (b: number, lo: number, hi: number, sign: number, dlo: number, dhi: number): number => ((((b + 8) * 256 + lo + 8) * 256 + hi + 8) * 4 + sign + 1) * 16 + (dlo + 2) * 4 + (dhi + 2);
  const out: Piece[] = [];
  for (const p of pieces) {
    const key = endKey(p.b0, p.lo0, p.hi0, p.sign, p.lo1 - p.lo0, p.hi1 - p.hi0);
    const q = open.get(key);
    if (q !== undefined && (q.lo1 - q.lo0) / (q.b1 - q.b0) === p.lo1 - p.lo0 && (q.hi1 - q.hi0) / (q.b1 - q.b0) === p.hi1 - p.hi0) {
      open.delete(key);
      q.b1 = p.b1;
      q.lo1 = p.lo1;
      q.hi1 = p.hi1;
      open.set(endKey(q.b1, q.lo1, q.hi1, q.sign, p.lo1 - p.lo0, p.hi1 - p.hi0), q);
      continue;
    }
    out.push(p);
    open.set(endKey(p.b1, p.lo1, p.hi1, p.sign, p.lo1 - p.lo0, p.hi1 - p.hi0), p);
  }
  return out;
}

/** A cell's top (or underside) polygons, unmerged; `corner` gives a sample's point. */
function cellFacets(w: number, corner: (iu: number, iv: number) => number[], face: number, out: Poly[]): void {
  const dirs = w & ROOF_WORD.dirs;
  const ring = (pts: ReadonlyArray<readonly [number, number]>): void => {
    out.push({ ring: pts.flatMap(([u, v]) => corner(u, v)), face });
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
/** Lattice points (half cells) some polygon of the job has a corner at: a stamp per point, the job's call number. */
let stampGrid = new Uint32Array(0);
let stampSide = 0;
let stampCall = 0;
/** Half cells past the job's corner a polygon's point may lie (a prism tops out a cell above its voxel). */
const STAMP_PAD = 4;

const STEPS = POSITION_STEPS_PER_CELL;
/** Half cells to position steps (positions count from one cell below the job's corner). */
const HALF = STEPS / 2;

/** The output vertex arrays, grown as needed. */
let pos = new Int32Array(3 * 256);
let nrm = new Int8Array(3 * 256);
let tris = new Uint32Array(3 * 512);
let vertexCount = 0;
let triLen = 0;
const vertexOf = new Map<number, number>();

/** Positions are whole eighths of a cell (corners, edge middles, a fan's inside point), so a vertex keys by eighths and normal. */
const EIGHTH = STEPS / 8;

function addVertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, normal: number): number {
  const key = (((x / EIGHTH) * 512 + y / EIGHTH) * 512 + z / EIGHTH) * 32 + normal;
  const known = vertexOf.get(key);
  if (known !== undefined) return known;
  if (3 * vertexCount + 3 > pos.length) {
    const p = new Int32Array(pos.length * 2);
    p.set(pos);
    pos = p;
    const q = new Int8Array(nrm.length * 2);
    q.set(nrm);
    nrm = q;
  }
  const o = 3 * vertexCount;
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
  return ((x + STAMP_PAD) * stampSide + (y + STAMP_PAD)) * stampSide + (z + STAMP_PAD);
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
 * points on it (every whole lattice point when the edge lies on a face of the
 * job), then fanned from a corner both of whose edges are whole, else
 * from a point inside.
 */
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
    // Every lattice point along the edge (in steps of the edge's direction over the gcd of its components).
    const dx = q[0]! - p[0]!, dy = q[1]! - p[1]!, dz = q[2]! - p[2]!;
    const g = gcd(gcd(Math.abs(dx), Math.abs(dy)), Math.abs(dz));
    // On a face of the job: the job across splits it its own way, so take every lattice point (half cells: a side
    // piece may end half way along a cell).
    let onFace = false;
    for (let c = 0; c < 3; c++) if (p[c] === q[c] && (p[c] === 0 || p[c] === 2 * e)) onFace = true;
    let added = 0;
    for (let t = 1; t < g; t++) {
      const x = p[0]! + (dx / g) * t, y = p[1]! + (dy / g) * t, z = p[2]! + (dz / g) * t;
      if (!onFace && !stamped(x, y, z)) continue;
      pts.push(x, y, z);
      added++;
    }
    extra.push(added);
  }
  const m = pts.length / 3;
  const ids: number[] = [];
  const normal = normalIndex(nx, ny, nz);
  for (let a = 0; a < m; a++) ids.push(addVertex(pts[3 * a]! * HALF + STEPS, pts[3 * a + 1]! * HALF + STEPS, pts[3 * a + 2]! * HALF + STEPS, nx, ny, nz, normal));
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
  const centre = addVertex(c[0]! * HALF + STEPS, c[1]! * HALF + STEPS, c[2]! * HALF + STEPS, nx, ny, nz, normal);
  for (let j = 0; j < m; j++) addTri(centre, ids[j]!, ids[(j + 1) % m]!);
}

/**
 * The roof planes of a job's chunk (or section) from its neighbourhood and
 * the plane-cell words {@link classifyRoofs} wrote, in the derive's surface
 * layout (positions from one cell below the job's corner): drawn with the
 * base surface, and the roof's collision.
 */
export function roofSurface(n: Neighbourhood, words: Uint32Array): SurfaceBuffer {
  const e = n.edge;
  const p = n.pad;
  const s = n.side;
  vertexCount = 0;
  triLen = 0;
  vertexOf.clear();
  strips.clear();
  stampSide = 2 * e + 2 * STAMP_PAD + 1;
  if (stampGrid.length < stampSide ** 3) {
    stampGrid = new Uint32Array(stampSide ** 3);
    stampCall = 0;
  }
  stampCall++;
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
      list.push({ sign: k < 2 ? 1 : -1, bot: [bot[0]!, bot[1]!, bot[2]!], top: [top[0]!, top[1]!, top[2]!], own });
    }
  }
  if (!any) return { vertexCount: 0, vertices: new Uint8Array(0), indices: new Uint16Array(0) };

  // Tops and undersides: single-direction cells merged along their level line, the rest per cell.
  const own = (x: number, y: number, z: number): number => (x >= 0 && y >= 0 && z >= 0 && x < e && y < e && z < e ? words[at(x, y, z)]! : 0);
  const single = (w: number): number => {
    const d = w & ROOF_WORD.dirs;
    return d === 1 ? 0 : d === 2 ? 1 : d === 4 ? 2 : d === 8 ? 3 : -1;
  };
  const corner = (x: number, y: number, z: number, w: number, under: boolean) => (iu: number, iv: number): number[] => [2 * x + iu, under ? bottomAt(w, y, iu, iv) : topAt(w, y, iu, iv), 2 * z + iv];
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) for (let y = 0; y < e; y++) {
    const w = own(x, y, z);
    if (w === 0) continue;
    const seated = (w & ROOF_WORD.seated) !== 0;
    const d = single(w);
    if (d < 0) {
      cellFacets(w, corner(x, y, z, w, false), 0, polys);
      if (!seated) cellFacets(w, corner(x, y, z, w, true), 1, polys);
    } else {
      // A run along the slope's level line (z for a slope along x, x for one along z) starts at its first cell.
      const runX = d === 1 || d === 3;
      const next = (j: number): number => (runX ? own(x + j, y, z) : own(x, y, z + j));
      for (const under of [false, true]) {
        if (under && seated) continue;
        // Tops join whatever carries them; undersides only unseated ones.
        const mask = under ? ROOF_WORD.dirs | ROOF_WORD.seated : ROOF_WORD.dirs;
        if ((next(-1) & mask) === (w & mask)) continue;
        let len = 1;
        while ((runX ? x : z) + len < e && (next(len) & mask) === (w & mask)) len++;
        const c0 = corner(x, y, z, w, under);
        const c1 = runX ? corner(x + len - 1, y, z, w, under) : corner(x, y, z + len - 1, w, under);
        polys.push({ ring: runX ? [...c0(0, 0), ...c1(2, 0), ...c1(2, 2), ...c0(0, 2)] : [...c0(0, 0), ...c0(2, 0), ...c1(2, 2), ...c1(0, 2)], face: under ? 1 : 0 });
      }
    }
    // A seated underside is the voxel's floor: one quad, merged along z.
    if (seated && (own(x, y, z - 1) & ROOF_WORD.seated) === 0) {
      let len = 1;
      while (z + len < e && (own(x, y, z + len) & ROOF_WORD.seated) !== 0) len++;
      polys.push({ ring: [2 * x, 2 * y, 2 * z, 2 * x + 2, 2 * y, 2 * z, 2 * x + 2, 2 * y, 2 * (z + len), 2 * x, 2 * y, 2 * (z + len)], face: 1 });
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
    const plane = 2 * ((planeKey % W) - 2);
    for (const q of mergePieces(pieces)) {
      const pt = (b: number, h: number): number[] => (alongX ? [plane, h, b] : [b, h, plane]);
      polys.push({ ring: [...pt(q.b0, q.lo0), ...pt(q.b1, q.lo1), ...pt(q.b1, q.hi1), ...pt(q.b0, q.hi0)], face: 2 + (alongX ? (q.sign > 0 ? 0 : 2) : q.sign > 0 ? 1 : 3) });
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
  }
  const t = tris.subarray(0, triLen);
  return { vertexCount, vertices, indices: vertexCount < 65536 ? new Uint16Array(t) : new Uint32Array(t) };
}

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
