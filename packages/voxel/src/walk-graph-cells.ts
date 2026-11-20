/**
 * The walk graph's cells: where a walker can stand in one storage chunk and
 * the steps between such places, read from the navigation part every derive
 * already makes (derived-data.ts: a blocking bit a cell, and the standable
 * cells: free, on a cell that supports). Nothing here is stored; a chunk's
 * part is made where the world runs from the results it holds.
 *
 * **A node** is a standable cell. Its clearance is the free cells upward
 * from it, counted to {@link WALK_CLEARANCE_MAX} (on into the chunk above;
 * where that chunk is not known its cells count as free, and the chunk is
 * made again when it arrives).
 *
 * **A step** goes from a cell to a standable cell of one of the eight
 * columns round it, on the same level or one cell up or down (0.5 m: a
 * stair's rise is one cell a cell, so a stair is walked as steps up), with:
 * - room for the walker's height at both ends, and one cell more at the
 *   lower end of a step up or down (the head rises or falls with the step
 *   over the lower column);
 * - a diagonal only when both columns beside it can be walked the same way
 *   (from the start to the column beside, and on from there to the end):
 *   no corner is cut. Diagonals are taken inside a chunk only: across a chunk
 *   face a path steps straight, so a step's cells are always in at most two
 *   chunks (what the stitching across faces relies on);
 * - a drop (walking off a ledge onto a floor 2 cells or more below) only
 *   when the walker allows drops, straight only, as far as its `maxDrop`,
 *   onto the first standable cell below with the column free from it to the
 *   walker's head over the ledge. A drop goes one way.
 * The cost of a step is the distance between the cells' centres (metres).
 *
 * **The walker** is a column of cells: a height in cells (default
 * {@link NAV_CLEARANCE_CELLS}, 2 m) and a footprint inside one cell, so a
 * radius up to half a cell (0.25 m): a diagonal passes the corner of four
 * free columns, which a disc that wide stays inside. A wider walker would
 * need clearance over several columns, which this graph does not keep.
 *
 * **Pieces**: a chunk's cells joined by steps inside the chunk, for the
 * default walker (no drops: steps go both ways), are its pieces, the coarse
 * level of the walk graph (walk-graph.ts). A cell whose clearance is below
 * the default height is in no piece (a shorter walker reaches it through the
 * cell level alone).
 */
import { NAV_CLEARANCE_CELLS, OCCUPANCY, type NavOut } from './derived-data';

/** Free cells a node's clearance counts up to (8 m): the most a walker's height and its drop can ask of a column. */
export const WALK_CLEARANCE_MAX = 16;

/** How far a step rises or falls (cells): one cell, a stair's rise a cell along. */
export const WALK_STEP_CELLS = 1;

/** No piece (a cell whose clearance is below the default walker's height). */
export const NO_WALK_PIECE = 0xffff;

/** A walker's shape and what it may do (cells). */
export interface WalkAgent {
  /** Height in cells (1 … {@link WALK_CLEARANCE_MAX}). */
  readonly height: number;
  /** The deepest drop it walks off (cells; below 2: none). */
  readonly maxDrop: number;
}

/** The walker the pieces are made for: 2 m tall, no drops. */
export const DEFAULT_WALK_AGENT: WalkAgent = Object.freeze({ height: NAV_CLEARANCE_CELLS, maxDrop: 0 });

/** A piece of a chunk (its cells joined by steps inside it); what the stitching adds to it is walk-graph.ts's. */
export interface WalkPieceBase {
  readonly chunk: WalkChunk;
  readonly index: number;
  /** Its cells. */
  readonly cells: number;
}

/** One chunk's part of the walk graph. */
export interface WalkChunk {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly key: number;
  /** Cells along the chunk's edge. */
  readonly edge: number;
  /** Per column (x · edge + z): its first cell; one more entry at the end. */
  readonly colStart: Uint16Array;
  /** Per cell, in column order then upward: its local y, its column, its clearance and its piece. */
  readonly ys: Uint8Array;
  readonly col: Uint16Array;
  readonly clear: Uint8Array;
  readonly piece: Uint16Array;
  readonly pieces: WalkPieceBase[];
  /** Some cell's free run reached the chunk's top before the clearance's end: the chunk above's cells count. */
  readonly dependsAbove: boolean;
  /** Whether the chunk above was known when it was made (what its clearance read there). */
  readonly aboveKnown: boolean;
  /** False once the chunk was made again or left. */
  alive: boolean;
}

/** A section's navigation (null: the section is air with air all round; undefined: not known). */
export type SectionNav = NavOut | null | undefined;

/**
 * What a chunk's part is made from: its sections' navigation by section offset (sy 0 … per − 1), and the chunk
 * above's lowest sections (sy = per … ) for the clearance over its top.
 */
export type ChunkNavReader = (sx: number, sy: number, sz: number) => SectionNav;

function navBlocksAt(nav: SectionNav, i: number): boolean {
  if (nav == null) return false;
  if (nav.blocking === OCCUPANCY.empty) return false;
  if (nav.blocking === OCCUPANCY.solid) return true;
  return ((nav.blocks![i >>> 5]! >>> (i & 31)) & 1) === 1;
}

/** Column starts of a part with no cells, by edge: one array every such part shares (never written). */
const EMPTY_COLUMNS = new Map<number, Uint16Array>();
const NO_BYTES = new Uint8Array(0);
const NO_WORDS = new Uint16Array(0);

/** An empty part (a known chunk where nothing stands): most of a ring (rock below, air above), so it holds no arrays of its own. */
export function emptyWalkChunk(cx: number, cy: number, cz: number, key: number, edge: number): WalkChunk {
  let cols = EMPTY_COLUMNS.get(edge);
  if (cols === undefined) EMPTY_COLUMNS.set(edge, (cols = new Uint16Array(edge * edge + 1)));
  return { cx, cy, cz, key, edge, colStart: cols, ys: NO_BYTES, col: NO_WORDS, clear: NO_BYTES, piece: NO_WORDS, pieces: [], dependsAbove: false, aboveKnown: true, alive: true };
}

/**
 * A chunk's part from its sections' navigation (`nav`): its standable cells by column with their clearance, and its
 * pieces for the default walker. `se`: the section edge; the chunk has `edge / se` sections an axis.
 */
export function buildWalkChunk(cx: number, cy: number, cz: number, key: number, edge: number, se: number, nav: ChunkNavReader): WalkChunk {
  const per = edge / se;
  const navs: SectionNav[] = [];
  // Own sections, then the chunk above's lowest layer (the clearance reads at most WALK_CLEARANCE_MAX cells past the top).
  const layers = per + Math.ceil(WALK_CLEARANCE_MAX / se);
  for (let sx = 0; sx < per; sx++) for (let sz = 0; sz < per; sz++) for (let sy = 0; sy < layers; sy++) navs[(sx * per + sz) * layers + sy] = nav(sx, sy, sz);
  let aboveKnown = true;
  for (let sx = 0; sx < per; sx++) for (let sz = 0; sz < per; sz++) for (let sy = per; sy < layers; sy++) if (navs[(sx * per + sz) * layers + sy] === undefined) aboveKnown = false;
  const navAt = (x: number, y: number, z: number): SectionNav => navs[(((x / se) | 0) * per + ((z / se) | 0)) * layers + ((y / se) | 0)];
  const local = (x: number, y: number, z: number): number => ((x % se) * se + (z % se)) * se + (y % se);
  // Count each column's standable cells, then place them upward.
  const counts = new Uint16Array(edge * edge + 1);
  let total = 0;
  for (let sx = 0; sx < per; sx++) for (let sz = 0; sz < per; sz++) for (let sy = 0; sy < per; sy++) {
    const n = navs[(sx * per + sz) * layers + sy];
    if (n == null) continue;
    for (const i of n.standable) {
      const x = sx * se + ((i / (se * se)) | 0);
      const z = sz * se + (((i / se) | 0) % se);
      counts[x * edge + z]!++;
      total++;
    }
  }
  if (total === 0) return emptyWalkChunk(cx, cy, cz, key, edge);
  const colStart = new Uint16Array(edge * edge + 1);
  for (let c = 0; c < edge * edge; c++) colStart[c + 1] = colStart[c]! + counts[c]!;
  const fill = colStart.slice(0, edge * edge);
  const ys = new Uint8Array(total);
  const col = new Uint16Array(total);
  const clear = new Uint8Array(total);
  let dependsAbove = false;
  // Sections upward, so a column's cells land in rising y.
  for (let sy = 0; sy < per; sy++) for (let sx = 0; sx < per; sx++) for (let sz = 0; sz < per; sz++) {
    const n = navs[(sx * per + sz) * layers + sy];
    if (n == null) continue;
    for (const i of n.standable) {
      const x = sx * se + ((i / (se * se)) | 0);
      const z = sz * se + (((i / se) | 0) % se);
      const y = sy * se + (i % se);
      const c = x * edge + z;
      const k = fill[c]!++;
      ys[k] = y;
      col[k] = c;
      let free = 0;
      while (free < WALK_CLEARANCE_MAX && !navBlocksAt(navAt(x, y + free, z), local(x, y + free, z))) free++;
      if (free < WALK_CLEARANCE_MAX ? y + free >= edge : y + WALK_CLEARANCE_MAX > edge) dependsAbove = true;
      clear[k] = free;
    }
  }
  const chunk: WalkChunk = { cx, cy, cz, key, edge, colStart, ys, col, clear, piece: new Uint16Array(total).fill(NO_WALK_PIECE), pieces: [], dependsAbove, aboveKnown, alive: true };
  labelPieces(chunk);
  return chunk;
}

/** The cell of a chunk at local (x, y, z) that is standable (−1: none). */
export function standableIn(c: WalkChunk, x: number, y: number, z: number): number {
  const col = x * c.edge + z;
  const end = c.colStart[col + 1]!;
  for (let k = c.colStart[col]!; k < end; k++) {
    const ky = c.ys[k]!;
    if (ky === y) return k;
    if (ky > y) return -1;
  }
  return -1;
}

/** Whether a step of `dy` cells between cells of clearance `ca` (from) and `cb` (to) has room for a walker `h` tall. */
export function stepFits(ca: number, cb: number, dy: number, h: number): boolean {
  if (dy === 0) return ca >= h && cb >= h;
  if (dy === 1) return ca >= h + 1 && cb >= h;
  if (dy === -1) return ca >= h && cb >= h + 1;
  return false;
}

/**
 * The parts a step may land in, by chunk: a part (known), null (known, nothing stands there, or a chunk the caller
 * leaves out) or undefined (not known yet: the step may continue there).
 */
export type WalkChunkLookup = (cx: number, cy: number, cz: number) => WalkChunk | null | undefined;

/** Where each step out of a cell goes: called with the part, its cell and the step's cost (metres). */
export type WalkStepSink = (to: WalkChunk, cell: number, cost: number) => void;

const ORTHO: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAG: readonly (readonly [number, number, number, number])[] = [
  // dx, dz, and the two straight neighbours' indices in ORTHO.
  [1, 1, 0, 2],
  [1, -1, 0, 3],
  [-1, 1, 1, 2],
  [-1, -1, 1, 3],
];

/** Walks the steps out of cells (the module comment's rule), reusing its scratch: one per thread of use. */
export class WalkStepper {
  /** Per straight direction: where its step landed (part, cell, dy; part null: none). */
  private readonly orthoTo: (WalkChunk | null)[] = [null, null, null, null];
  private readonly orthoCell = new Int32Array(4);
  private readonly orthoDy = new Int8Array(4);
  /** A step met a chunk not known yet during the last `steps` call. */
  unknown = false;

  constructor(private readonly cellM: number) {}

  /** Calls `sink` for each step from cell `i` of part `c` the walker can take; sets `unknown` when a step may go where nothing is known. */
  steps(look: WalkChunkLookup, c: WalkChunk, i: number, agent: WalkAgent, sink: WalkStepSink): void {
    this.unknown = false;
    const h = agent.height;
    const ca = c.clear[i]!;
    if (ca < h) return;
    const e = c.edge;
    const colI = c.col[i]!;
    const lx = (colI / e) | 0;
    const lz = colI % e;
    const ly = c.ys[i]!;
    const x = c.cx * e + lx;
    const y = c.cy * e + ly;
    const z = c.cz * e + lz;
    const s = this.cellM;
    for (let d = 0; d < 4; d++) {
      const o = ORTHO[d]!;
      const dx = o[0];
      const dz = o[1];
      this.orthoTo[d] = null;
      let found = false;
      for (let k = 0; k < 3 && !found; k++) {
        const dy = k === 0 ? 0 : k === 1 ? 1 : -1;
        const tx = x + dx;
        const ty = y + dy;
        const tz = z + dz;
        const t = this.chunkOf(look, c, tx, ty, tz);
        if (t === undefined) {
          this.unknown = true;
          continue;
        }
        if (t === null) continue;
        const j = standableIn(t, tx - t.cx * e, ty - t.cy * e, tz - t.cz * e);
        if (j < 0 || !stepFits(ca, t.clear[j]!, dy, h)) continue;
        this.orthoTo[d] = t;
        this.orthoCell[d] = j;
        this.orthoDy[d] = dy;
        sink(t, j, dy === 0 ? s : s * Math.SQRT2);
        found = true;
      }
      if (!found && agent.maxDrop >= 2) this.drop(look, c, x, y, z, dx, dz, agent, sink);
    }
    // Diagonals inside the chunk only, with both straight neighbours walked the same way.
    for (let q = 0; q < 4; q++) {
      const dd = DIAG[q]!;
      const dx = dd[0];
      const dz = dd[1];
      const oa = dd[2];
      const ob = dd[3];
      if (lx + dx < 0 || lx + dx >= e || lz + dz < 0 || lz + dz >= e) continue;
      const pa = this.orthoTo[oa];
      const pb = this.orthoTo[ob];
      if (pa !== c || pb !== c) continue;
      for (let k = 0; k < 3; k++) {
        const dy = k === 0 ? 0 : k === 1 ? 1 : -1;
        if (ly + dy < 0 || ly + dy >= e) continue;
        const j = standableIn(c, lx + dx, ly + dy, lz + dz);
        if (j < 0 || !stepFits(ca, c.clear[j]!, dy, h)) continue;
        // Each straight neighbour on to the diagonal's end: the same rule from where its step landed.
        const ja = this.orthoCell[oa]!;
        const jb = this.orthoCell[ob]!;
        if (!stepFits(c.clear[ja]!, c.clear[j]!, dy - this.orthoDy[oa]!, h) || !stepFits(c.clear[jb]!, c.clear[j]!, dy - this.orthoDy[ob]!, h)) break;
        sink(c, j, s * Math.sqrt(2 + dy * dy));
        break;
      }
    }
  }

  /** A drop off a ledge straight ahead: onto the first standable cell below within the walker's `maxDrop`. */
  private drop(look: WalkChunkLookup, c: WalkChunk, x: number, y: number, z: number, dx: number, dz: number, agent: WalkAgent, sink: WalkStepSink): void {
    const e = c.edge;
    const deepest = Math.min(agent.maxDrop, WALK_CLEARANCE_MAX - agent.height);
    for (let k = 2; k <= deepest; k++) {
      const tx = x + dx;
      const ty = y - k;
      const tz = z + dz;
      const t = this.chunkOf(look, c, tx, ty, tz);
      if (t === undefined) {
        this.unknown = true;
        return;
      }
      if (t === null) continue;
      const j = standableIn(t, tx - t.cx * e, ty - t.cy * e, tz - t.cz * e);
      if (j < 0) continue;
      // The first floor below decides: the column must be free from it to the walker's head over the ledge.
      if (t.clear[j]! >= k + agent.height) sink(t, j, this.cellM * Math.sqrt(1 + k * k));
      return;
    }
  }

  private chunkOf(look: WalkChunkLookup, c: WalkChunk, x: number, y: number, z: number): WalkChunk | null | undefined {
    const e = c.edge;
    const qx = Math.floor(x / e);
    const qy = Math.floor(y / e);
    const qz = Math.floor(z / e);
    if (qx === c.cx && qy === c.cy && qz === c.cz) return c;
    return look(qx, qy, qz);
  }
}

/** The pieces of a chunk: its cells joined by the default walker's steps inside it (a flood a piece). */
function labelPieces(c: WalkChunk): void {
  const stepper = new WalkStepper(1);
  const only: WalkChunkLookup = () => null;
  const queue = new Int32Array(c.ys.length);
  let id = 0;
  let tail = 0;
  const sink: WalkStepSink = (_t, j) => {
    if (c.piece[j] !== NO_WALK_PIECE) return;
    c.piece[j] = id;
    queue[tail++] = j;
  };
  const pieces = c.pieces;
  for (let seed = 0; seed < c.ys.length; seed++) {
    if (c.piece[seed] !== NO_WALK_PIECE || c.clear[seed]! < DEFAULT_WALK_AGENT.height) continue;
    id = pieces.length;
    c.piece[seed] = id;
    let head = 0;
    tail = 0;
    queue[tail++] = seed;
    while (head < tail) stepper.steps(only, c, queue[head++]!, DEFAULT_WALK_AGENT, sink);
    pieces.push({ chunk: c, index: id, cells: tail });
  }
}

/** A cell's world position (cells). */
export function walkCellOf(c: WalkChunk, i: number): [number, number, number] {
  const e = c.edge;
  const colI = c.col[i]!;
  return [c.cx * e + ((colI / e) | 0), c.cy * e + c.ys[i]!, c.cz * e + (colI % e)];
}

/** Bytes a part holds (its arrays; the pieces' objects at a rough 64 bytes each; an empty part its object alone). */
export function walkChunkBytes(c: WalkChunk): number {
  if (c.ys.length === 0) return 96;
  return c.colStart.byteLength + c.ys.byteLength + c.col.byteLength + c.clear.byteLength + c.piece.byteLength + c.pieces.length * 64;
}

/** Whether two parts hold the same cells, clearances and pieces (a chunk made again with no change stands). */
export function sameWalkChunk(a: WalkChunk, b: WalkChunk): boolean {
  if (a.ys.length !== b.ys.length || a.pieces.length !== b.pieces.length) return false;
  for (let k = 0; k < a.colStart.length; k++) if (a.colStart[k] !== b.colStart[k]) return false;
  for (let k = 0; k < a.ys.length; k++) if (a.ys[k] !== b.ys[k] || a.clear[k] !== b.clear[k] || a.piece[k] !== b.piece[k]) return false;
  return true;
}
