/**
 * The edge pass: where construction faces meet, so a kit draws a detail
 * piece there and nowhere else. Walls, floors and flat roofs are plain voxel
 * faces; a piece goes only on a 0.5 m lattice edge or a lattice corner the
 * cells round it make exposed.
 *
 * **Edges.** A lattice edge has 4 cells round it. "Solid" is any built role
 * or terrain filled to the surface; air, liquid and openings are open. One
 * solid of 4 is an outer edge (a wall's top, an outside corner, a lintel's
 * underside), three an inner edge (wall meets floor or ceiling, an inside
 * corner); two side by side are a flat face (no piece), two diagonal are two
 * outer edges, one a cell. Horizontal edges are top or bottom by gravity,
 * vertical edges are vertical: six edge cases.
 *
 * **Corners.** A lattice corner has 8 cells round it: one solid is an outer
 * corner (a box's corner), seven an inner corner, each top or bottom: four
 * corner cases. Any other count, and a corner where outer and inner edges
 * meet, gets no corner piece (the edge pieces overlap there).
 *
 * **Who owns it.** An outer edge or corner belongs to its one solid cell, an
 * inner one to the cell diagonal to the open one, so every piece has one
 * cell, whose material names its kit, and a cell owns at most its own 12
 * edges and 8 corners: a bit mask a cell. A piece is placed only where its
 * owner is a construction cell and no cell round it is terrain (where a
 * building meets the ground, the terrain material's dressing draws the
 * contact) or a cell another surface draws (a sloped roof's plane cells,
 * passed in as `excluded`).
 *
 * **Orientation.** Each case is written in its own orientation, its open
 * side toward +z (a vertical edge or a corner: toward +x and +z); the yaw
 * (0–3 quarter turns about +y, each taking +x to +z, as the case window's
 * folds) places it. No vertical flip: gravity tells a top from a bottom.
 *
 * Reads one cell round each cell ({@link EDGE_REACH}); pure and per thread.
 */
import { OPEN_ROLE, type Neighbourhood } from './assembly';
import { SURFACE_ISO } from './derived-mesh';
import { isConstructionRole, ROLE_MASK, ROLE_SHIFT, VOXEL_ROLE } from './record';

/** How far (Chebyshev, cells) the edge pass reads from a cell. */
export const EDGE_REACH = 1;

/** The edge and corner cases, in their pass order (an index here is an edge case index). */
export const EDGE_CASE_IDS = Object.freeze([
  'edge-out-top',
  'edge-out-vertical',
  'edge-out-bottom',
  'edge-in-top',
  'edge-in-vertical',
  'edge-in-bottom',
  'corner-out-top',
  'corner-out-bottom',
  'corner-in-top',
  'corner-in-bottom',
] as const);
export type EdgeCaseId = (typeof EDGE_CASE_IDS)[number];

/** Edge slots a cell owns: 12 edges (bits 0–11), then 8 corners (bits 12–19). */
export const EDGE_SLOTS = 12;
export const CORNER_SLOTS = 8;
export const PIECE_SLOTS = EDGE_SLOTS + CORNER_SLOTS;

type Offset = readonly [number, number, number];

/** One slot of a cell: the cells round it besides the cell itself. */
interface Slot {
  /** For an edge, the axis it runs along (0 x, 1 y, 2 z); a corner: −1. */
  readonly axis: number;
  /** The slot's side of the cell: −1 or +1 on each axis (0 along an edge's axis). */
  readonly side: Offset;
  /** The cells round the slot sharing a face with the cell (an edge: 2; a corner: 3). */
  readonly faces: readonly Offset[];
  /** The other cells round the slot: an edge's diagonal (1); a corner's 3 edge diagonals and its far cell (last). */
  readonly rest: readonly Offset[];
}

/**
 * The 20 slots of a cell, in bit order. Edge k: axis ⌊k / 4⌋, its two other
 * axes (in x, y, z order) at sign bit 0 and bit 1 of k (set: +). Corner c:
 * bit 0 +x, bit 1 +y, bit 2 +z.
 */
export const PIECE_SLOT_TABLE: readonly Slot[] = (() => {
  const slots: Slot[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const [u, v] = [0, 1, 2].filter((a) => a !== axis) as [number, number];
    for (let k = 0; k < 4; k++) {
      const side = [0, 0, 0];
      side[u] = k & 1 ? 1 : -1;
      side[v] = k & 2 ? 1 : -1;
      const a = [0, 0, 0];
      a[u] = side[u]!;
      const b = [0, 0, 0];
      b[v] = side[v]!;
      slots.push({ axis, side: side as unknown as Offset, faces: [a as unknown as Offset, b as unknown as Offset], rest: [side as unknown as Offset] });
    }
  }
  for (let c = 0; c < 8; c++) {
    const s: Offset = [c & 1 ? 1 : -1, c & 2 ? 1 : -1, c & 4 ? 1 : -1];
    const faces: Offset[] = [[s[0], 0, 0], [0, s[1], 0], [0, 0, s[2]]];
    const rest: Offset[] = [[s[0], s[1], 0], [s[0], 0, s[2]], [0, s[1], s[2]], s];
    slots.push({ axis: -1, side: s, faces, rest });
  }
  return Object.freeze(slots);
})();

/** Index 0–26 of an offset in a cell's 3³ block (13: the cell). */
const blockIndex = (o: Offset): number => (o[0] + 1) * 9 + (o[1] + 1) * 3 + (o[2] + 1);
const bitsOf = (os: readonly Offset[]): number => os.reduce((m, o) => m | (1 << blockIndex(o)), 0);

/** Per slot: the face cells' bits, the other cells' bits and (corners) the far cell's bit. */
const SLOT_FACES = Uint32Array.from(PIECE_SLOT_TABLE, (s) => bitsOf(s.faces));
const SLOT_REST = Uint32Array.from(PIECE_SLOT_TABLE, (s) => bitsOf(s.rest));
const SLOT_FAR = Uint32Array.from(PIECE_SLOT_TABLE, (s) => (s.axis < 0 ? 1 << blockIndex(s.side) : bitsOf(s.rest)));

/** A horizontal direction's yaw: +z 0, −x 1, −z 2, +x 3 (each quarter turn takes +x to +z). */
function yawOfDirection(dx: number, dz: number): number {
  if (dz > 0) return 0;
  if (dx < 0) return 1;
  if (dz < 0) return 2;
  return 3;
}

/** A quadrant's yaw: (+x, +z) 0, (−x, +z) 1, (−x, −z) 2, (+x, −z) 3. */
function yawOfQuadrant(sx: number, sz: number): number {
  if (sx > 0 && sz > 0) return 0;
  if (sx < 0 && sz > 0) return 1;
  if (sx < 0) return 2;
  return 3;
}

/** The case and yaw a slot gives an outer (inner = false) or inner piece of its owner. */
function slotCase(slot: number, inner: boolean): { readonly id: EdgeCaseId; readonly yaw: number } {
  const s = PIECE_SLOT_TABLE[slot]!;
  const [sx, sy, sz] = s.side;
  if (s.axis === 1) return { id: inner ? 'edge-in-vertical' : 'edge-out-vertical', yaw: yawOfQuadrant(sx, sz) };
  if (s.axis >= 0) {
    // The owner's top edge: outer, it is the top; inner, the open cell is the one above (the foot of a wall).
    const id: EdgeCaseId = sy > 0 ? (inner ? 'edge-in-bottom' : 'edge-out-top') : inner ? 'edge-in-top' : 'edge-out-bottom';
    return { id, yaw: yawOfDirection(sx, sz) };
  }
  const id: EdgeCaseId = sy > 0 ? (inner ? 'corner-in-bottom' : 'corner-out-top') : inner ? 'corner-in-top' : 'corner-out-bottom';
  return { id, yaw: yawOfQuadrant(sx, sz) };
}

/** SLOT_CASE[slot * 2 + inner]: edge case index << 2 | yaw. */
const SLOT_CASE = Uint8Array.from({ length: PIECE_SLOTS * 2 }, (_, k) => {
  const c = slotCase(k >> 1, (k & 1) === 1);
  return (EDGE_CASE_IDS.indexOf(c.id) << 2) | c.yaw;
});

/** The edge case (index in {@link EDGE_CASE_IDS}) of a cell's slot, outer or inner. */
export function edgeCaseOf(slot: number, inner: boolean): number {
  return SLOT_CASE[slot * 2 + (inner ? 1 : 0)]! >> 2;
}

/** The yaw (0–3) of a cell's slot's piece, outer or inner. */
export function edgeYawOf(slot: number, inner: boolean): number {
  return SLOT_CASE[slot * 2 + (inner ? 1 : 0)]! & 3;
}

/** Per cell class bits the pass reads. */
const SOLID = 1;
/** A cell round which no piece goes: terrain (any fill) or an excluded cell. */
const BLOCKS = 2;
/** A cell that may own pieces: a construction cell filled to the surface, not excluded. */
const OWNS = 4;

/** What a box's cells hold for the pass (out-params of {@link extractEdges}). */
export interface EdgeMasks {
  /** Per neighbourhood cell: bit k set when the cell owns a piece on slot k ({@link PIECE_SLOT_TABLE}). */
  readonly pieces: Uint32Array;
  /** Per neighbourhood cell: bit k set when slot k's piece is inner (three of four, seven of eight solid). */
  readonly inner: Uint32Array;
}

/** Allocates masks for a neighbourhood. */
export function createEdgeMasks(n: Neighbourhood): EdgeMasks {
  return { pieces: new Uint32Array(n.values.length), inner: new Uint32Array(n.values.length) };
}

/** Per thread, by neighbourhood size: every cell's class bits. */
const classScratch = new Map<number, Uint8Array>();
const deltaCache = new Map<number, Int32Array>();

/** Neighbourhood index offsets of a cell's 3³ block for a side, in block order. */
function blockDeltas(side: number): Int32Array {
  let d = deltaCache.get(side);
  if (d === undefined) {
    d = new Int32Array(27);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) d[blockIndex([dx, dy, dz])] = (dx * side + dz) * side + dy;
    deltaCache.set(side, d);
  }
  return d;
}

/** Every slot's bit of the 3³ block but the cell's own. */
const AROUND = ((1 << 27) - 1) & ~(1 << 13);

/**
 * The edge and corner pieces every cell of the box [lo, hi) (padded
 * coordinates, the same bounds on all three axes) owns, into `out`
 * (neighbourhood indexing; cells outside the box are left as they are).
 * `excluded` (neighbourhood indexing, non-zero: excluded) names cells
 * another surface draws: no piece goes round them. Reads one cell round the
 * box, so the box must sit {@link EDGE_REACH} inside the neighbourhood.
 * Returns the cells owning at least one piece.
 */
export function extractEdges(n: Neighbourhood, lo: number, hi: number, out: EdgeMasks, excluded: Uint8Array | null = null): number {
  const s = n.side;
  const len = n.values.length;
  if (lo < EDGE_REACH || hi + EDGE_REACH > s || out.pieces.length !== len || out.inner.length !== len || (excluded !== null && excluded.length !== len)) {
    throw new RangeError(`edge extraction: box ${lo}…${hi} in a side of ${s} (reach ${EDGE_REACH})`);
  }
  const vals = n.values;
  const shapes = n.shapes;
  let cls = classScratch.get(len);
  if (cls === undefined) {
    cls = new Uint8Array(len);
    classScratch.set(len, cls);
  }
  let any = false;
  const a = lo - EDGE_REACH;
  const b = hi + EDGE_REACH;
  for (let x = a; x < b; x++) for (let z = a; z < b; z++) {
    const row = (x * s + z) * s;
    for (let y = a; y < b; y++) {
      const i = row + y;
      const role = (vals[i]! >>> ROLE_SHIFT) & ROLE_MASK;
      const d = shapes[i]!;
      let c = 0;
      if (OPEN_ROLE[role] !== 1 && d >= SURFACE_ISO) c |= SOLID;
      if (role === VOXEL_ROLE.terrain && d > 0) c |= BLOCKS;
      if (excluded !== null && excluded[i] !== 0) c |= BLOCKS;
      else if ((c & SOLID) !== 0 && isConstructionRole(role)) {
        c |= OWNS;
        any = true;
      }
      cls[i] = c;
    }
  }
  const pieces = out.pieces;
  const inner = out.inner;
  for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) {
    const row = (x * s + z) * s;
    pieces.fill(0, row + lo, row + hi);
    inner.fill(0, row + lo, row + hi);
  }
  if (!any) return 0;
  const deltas = blockDeltas(s);
  let count = 0;
  for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) {
    const row = (x * s + z) * s;
    for (let y = lo; y < hi; y++) {
      const i = row + y;
      if ((cls[i]! & OWNS) === 0) continue;
      let solid = 0;
      let blocks = 0;
      for (let k = 0; k < 27; k++) {
        const c = cls[i + deltas[k]!]!;
        if ((c & SOLID) !== 0) solid |= 1 << k;
        if ((c & BLOCKS) !== 0) blocks |= 1 << k;
      }
      // Buried: nothing round it is open, so no edge of it shows.
      if ((solid & AROUND) === AROUND) continue;
      let p = 0;
      let q = 0;
      for (let k = 0; k < PIECE_SLOTS; k++) {
        const faces = SLOT_FACES[k]!;
        const rest = SLOT_REST[k]!;
        if (((faces | rest) & blocks) !== 0) continue;
        if (k < EDGE_SLOTS) {
          // Outer: both face cells open (the diagonal may be solid: two diagonal cells, one outer edge each).
          if ((solid & faces) === 0) p |= 1 << k;
          else if ((solid & faces) === faces && (solid & rest) === 0) {
            p |= 1 << k;
            q |= 1 << k;
          }
        } else {
          const far = SLOT_FAR[k]!;
          const others = (faces | rest) & ~far;
          if ((solid & (faces | rest)) === 0) p |= 1 << k;
          else if ((solid & others) === others && (solid & far) === 0) {
            p |= 1 << k;
            q |= 1 << k;
          }
        }
      }
      pieces[i] = p;
      inner[i] = q;
      if (p !== 0) count++;
    }
  }
  return count;
}

/** One piece the pass places, for tests and tools. */
export interface EdgePiece {
  /** The owning cell's neighbourhood index. */
  readonly cell: number;
  /** The slot ({@link PIECE_SLOT_TABLE}). */
  readonly slot: number;
  readonly inner: boolean;
  readonly caseId: EdgeCaseId;
  readonly yaw: number;
}

/** The pieces a cell's masks name, slot by slot. */
export function edgePiecesOf(masks: EdgeMasks, cell: number): EdgePiece[] {
  const out: EdgePiece[] = [];
  const p = masks.pieces[cell]!;
  for (let k = 0; k < PIECE_SLOTS; k++) {
    if (((p >>> k) & 1) === 0) continue;
    const inner = ((masks.inner[cell]! >>> k) & 1) === 1;
    out.push({ cell, slot: k, inner, caseId: EDGE_CASE_IDS[edgeCaseOf(k, inner)]!, yaw: edgeYawOf(k, inner) });
  }
  return out;
}
