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
 * corner cases. A **mixed** corner, where outer and inner edges meet (the
 * notch of a stair's side, the inside top corner of an L of walls, a wall's
 * corner standing on a wider foundation), takes one of the same four corner
 * cases, chosen by the shape at the point: the sum of the solid cells'
 * directions from the point says where the solid lies, so fewer than five
 * solid cells read as an outer corner of the cell that way, five or more as
 * an inner corner opening the other way ({@link MIXED_CORNER}). Pure corners
 * are the same rule's ends (one solid: that cell; seven: away from the open
 * one), so a turned or mirrored pattern gives the same piece turned. Any
 * other corner (two or more cells touching only at the point, a straight run
 * of edges) gets no corner piece.
 *
 * **Where it sits.** An outer edge or corner sits on its one solid cell, an
 * inner one on the cell diagonal to the open one (a mixed corner on the cell
 * its direction names), so every piece has one anchor cell, and a cell
 * anchors at most its own 12 edges and 8 corners: a bit mask a cell. A
 * piece is placed only where its anchor is a construction cell and no cell
 * round it is terrain (where a building meets the ground, the terrain
 * material's dressing draws the contact) or a cell another surface draws (a
 * sloped roof's plane cells, passed in as `excluded`).
 *
 * **Whose piece it is** ({@link slotDressing}): an outer edge or a pure
 * outer corner is its own cell's. Where cells meet (an inner edge, an inner
 * or mixed corner) the cells whose faces show at it compete by
 * {@link PIECE_ROLE_ORDER} (roof > wall > pillar > stair > floor >
 * foundation: a wall standing on a foundation dresses the corner at its
 * foot in its own kit); when the winning role's cells there belong to two
 * kits, nothing goes there (the material blend draws the seam).
 *
 * **Openings.** An `opening` cell (a door's or window's gap) is open, so the
 * jambs, lintel and sill round it get the ordinary edge pieces, but drawn
 * **flush**: the instance names the anchor's faces toward the opening and
 * the renderer cuts the piece at those faces, so nothing stands in the
 * doorway. A piece that would lie inside the opening (a cove where the
 * opening's floor meets a jamb) is not placed. A dug or broken hole (air)
 * is an ordinary edge.
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
import { isConstructionRole, MATERIAL_ID_MAX, ROLE_MASK, ROLE_SHIFT, VOXEL_ROLE } from './record';

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

/** Per slot: the face cells' bits and the other cells' bits. */
const SLOT_FACES = Uint32Array.from(PIECE_SLOT_TABLE, (s) => bitsOf(s.faces));
const SLOT_REST = Uint32Array.from(PIECE_SLOT_TABLE, (s) => bitsOf(s.rest));

/**
 * Per pattern of the 8 cells round a lattice corner (bit o set: the cell at
 * octant o is solid; octant bit 0 +x, bit 1 +y, bit 2 +z of the point): 0
 * for no corner piece, else 1 | inner << 1 | the anchor's octant << 2. The
 * solid cells' directions from the point, summed, name the anchor's octant
 * (no piece when the sum is 0 on an axis: the shape does not say which way
 * the corner faces). Up to four solid cells are an outer corner of that
 * cell (it must be solid); five or more an inner corner on it, opening to
 * the opposite octant (which must be open). Besides one and seven solid
 * cells, a corner gets a piece only where outer and inner edges meet.
 */
export const MIXED_CORNER: Uint8Array = (() => {
  const t = new Uint8Array(256);
  const pop = (x: number): number => (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1) + ((x >> 4) & 1) + ((x >> 5) & 1) + ((x >> 6) & 1) + ((x >> 7) & 1);
  for (let p = 1; p < 255; p++) {
    const count = pop(p);
    if (count !== 1 && count !== 7) {
      // The six edge segments from the point: the 4 cells on one side of each axis.
      let outer = false;
      let inner = false;
      for (let a = 0; a < 3; a++) for (let side = 0; side < 2; side++) {
        const cells = [0, 1, 2, 3, 4, 5, 6, 7].filter((o) => ((o >> a) & 1) === side && ((p >> o) & 1) === 1);
        if (cells.length === 3) inner = true;
        else if (cells.length === 1 || (cells.length === 2 && pop((cells[0]! ^ cells[1]!) & 7) === 2)) outer = true;
      }
      if (!outer || !inner) continue;
    }
    const v = [0, 0, 0];
    for (let o = 0; o < 8; o++) if ((p >> o) & 1) for (let a = 0; a < 3; a++) v[a]! += (o >> a) & 1 ? 1 : -1;
    if (v[0] === 0 || v[1] === 0 || v[2] === 0) continue;
    const s = (v[0]! > 0 ? 1 : 0) | (v[1]! > 0 ? 2 : 0) | (v[2]! > 0 ? 4 : 0);
    const isInner = count >= 5;
    if (((p >> s) & 1) === 0) continue;
    if (isInner && ((p >> (s ^ 7)) & 1) === 1) continue;
    t[p] = 1 | (isInner ? 2 : 0) | (s << 2);
  }
  return t;
})();

/** Per corner c (0–7) and octant o: the bit, in a cell's 3³ block, of the cell at octant o of the cell's corner c. */
const CORNER_OCTANT_BITS = Uint32Array.from({ length: 64 }, (_, k) => {
  const c = k >> 3;
  const o = k & 7;
  // The cell is at octant c ^ 7 of its corner c; a cell differing from it on axis a steps toward the corner there.
  const d = [0, 1, 2].map((a) => (((o ^ c ^ 7) >> a) & 1 ? ((c >> a) & 1 ? 1 : -1) : 0)) as unknown as Offset;
  return 1 << blockIndex(d);
});

/** The 8-cell pattern ({@link MIXED_CORNER}'s bits) round a cell's corner c from its 3³ block's solid bits. */
function cornerPattern(c: number, solid: number): number {
  let p = 0;
  for (let o = 0; o < 8; o++) if ((solid & CORNER_OCTANT_BITS[c * 8 + o]!) !== 0) p |= 1 << o;
  return p;
}

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
          // Pure or mixed, the corner's shape names its anchor: this cell, or another cell round it places it.
          const c = k - EDGE_SLOTS;
          const t = MIXED_CORNER[cornerPattern(c, solid)]!;
          if (t !== 0 && t >> 2 === (c ^ 7)) {
            p |= 1 << k;
            if ((t & 2) !== 0) q |= 1 << k;
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

/**
 * Who dresses a piece where roles meet, highest first: a roof over a wall, a
 * wall over a pillar, a stair, a floor or the foundation it stands on.
 */
export const PIECE_ROLE_ORDER: readonly number[] = Object.freeze([VOXEL_ROLE.roof, VOXEL_ROLE.wall, VOXEL_ROLE.pillar, VOXEL_ROLE.stair, VOXEL_ROLE.floor, VOXEL_ROLE.foundation]);

/** Per role: its rank in {@link PIECE_ROLE_ORDER} (higher wins), 0 for a role that dresses nothing. */
const ROLE_RANK = (() => {
  const t = new Uint8Array(ROLE_MASK + 1);
  PIECE_ROLE_ORDER.forEach((r, k) => (t[r] = PIECE_ROLE_ORDER.length - k));
  return t;
})();

/** The block index of a cell's own place in its 3³ block. */
export const SELF_BLOCK = 13;

/** Shift of the flush faces in a {@link slotDressing} word (below it: the dressing cell's block index). */
export const DRESSING_FLUSH_SHIFT = 5;

/** Per slot: its cells round it (the anchor first), as 3³ block indices; for a corner, by octant of the point. */
const SLOT_BLOCKS: readonly (readonly number[])[] = PIECE_SLOT_TABLE.map((s, k) => {
  if (s.axis >= 0) return [SELF_BLOCK, ...s.faces.map(blockIndex), ...s.rest.map(blockIndex)];
  const c = k - EDGE_SLOTS;
  return Array.from({ length: 8 }, (_, o) => 31 - Math.clz32(CORNER_OCTANT_BITS[c * 8 + o]!));
});

/** The neighbourhood index of the cell at 3³ block index `block` round padded cell `i`. */
export function blockNeighbour(n: Neighbourhood, i: number, block: number): number {
  return i + blockDeltas(n.side)[block]!;
}

const blockDelta = (b: number): Offset => [Math.floor(b / 9) - 1, (Math.floor(b / 3) % 3) - 1, (b % 3) - 1];

/**
 * How the piece on slot `slot` of padded cell `i` (an anchor the edge pass
 * gave it, inner or not) is dressed, or −1 for none. The word holds the
 * cell whose material (so whose kit) the piece is drawn in, as its 3³ block
 * index round the anchor ({@link SELF_BLOCK}: its own), and above
 * {@link DRESSING_FLUSH_SHIFT} the anchor's faces the piece is cut at (bit
 * 2a for −a, 2a + 1 for +a). `kitOf` gives a material's kit (any number;
 * only equality is read).
 *
 * - An outer edge, and an outer corner of one solid cell, is the anchor's.
 * - Where cells meet (an inner edge, an inner or mixed corner), the solid
 *   cells round it showing a face there (an open cell beside them round it)
 *   compete: the highest role of {@link PIECE_ROLE_ORDER} wins; winners of
 *   two kits leave it bare.
 * - An `opening` round it: an inner piece (lying in the open cell) is not
 *   placed; an outer one is cut at each anchor face beyond which an opening
 *   lies round it.
 */
export function slotDressing(n: Neighbourhood, i: number, slot: number, inner: boolean, kitOf: ArrayLike<number>): number {
  const deltas = blockDeltas(n.side);
  const vals = n.values;
  const shapes = n.shapes;
  const blocks = SLOT_BLOCKS[slot]!;
  const s = PIECE_SLOT_TABLE[slot]!;
  const corner = s.axis < 0;
  let solid = 0;
  let openings = 0;
  for (let k = 0; k < blocks.length; k++) {
    const j = i + deltas[blocks[k]!]!;
    const role = (vals[j]! >>> ROLE_SHIFT) & ROLE_MASK;
    if (role === VOXEL_ROLE.opening) openings |= 1 << k;
    else if (OPEN_ROLE[role] !== 1 && shapes[j]! >= SURFACE_ISO) solid |= 1 << k;
  }
  let word = SELF_BLOCK;
  // Pure outer: the anchor alone is solid on a corner; an outer edge is its own cell's even beside a diagonal solid.
  const own = corner ? solid === (1 << blocks.indexOf(SELF_BLOCK)) : !inner;
  if (!own) {
    if (openings !== 0 && inner) return -1;
    let best = 0;
    let kit = -1;
    let pick = -1;
    for (let k = 0; k < blocks.length; k++) {
      if (((solid >> k) & 1) === 0) continue;
      // Shows a face at the slot: an edge's two face cells of the open one; a corner's cells beside an open octant.
      let shows: boolean;
      if (corner) shows = ((~solid >> (k ^ 1)) & 1) === 1 || ((~solid >> (k ^ 2)) & 1) === 1 || ((~solid >> (k ^ 4)) & 1) === 1;
      else shows = k === 1 || k === 2;
      if (!shows) continue;
      const v = vals[i + deltas[blocks[k]!]!]!;
      const rank = ROLE_RANK[(v >>> ROLE_SHIFT) & ROLE_MASK]!;
      const kv = kitOf[v & MATERIAL_ID_MAX] ?? -1;
      if (rank > best) {
        best = rank;
        kit = kv;
        pick = k;
      } else if (rank === best && kv !== kit) kit = -2;
    }
    if (best === 0 || kit === -2) return -1;
    word = blocks[pick]!;
  }
  if (openings === 0) return word;
  if (inner) return -1;
  // Cut at each anchor face the slot reaches across toward an opening.
  let flush = 0;
  for (let k = 0; k < blocks.length; k++) {
    if (((openings >> k) & 1) === 0) continue;
    const d = blockDelta(blocks[k]!);
    for (let a = 0; a < 3; a++) if (d[a] !== 0) flush |= 1 << (2 * a + (d[a]! > 0 ? 1 : 0));
  }
  return word | (flush << DRESSING_FLUSH_SHIFT);
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
