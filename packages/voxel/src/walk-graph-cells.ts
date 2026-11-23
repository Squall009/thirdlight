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
 * **The walker** is a column of cells `height` tall standing on a square
 * of columns `span` cells across (its footprint): a disc of radius up to
 * `span` / 2 cells fits inside the square, so a radius r stands on
 * ceil(2r / cell) cells ({@link walkSpanOf}). It stands at a cell where its
 * own column has its height free and every other column of its footprint is
 * free from one cell over the floor to its head: a column of the footprint may
 * hold a step's cell at the floor's own height (as the walker may step onto
 * it), never more. The footprint is the cell's column and, for a wider span,
 * the columns round it: from `(span − 1) >> 1` columns back to `span >> 1`
 * forward on x and on z, so an even span's middle is the corner a half-cell
 * forward on both (where a waypoint puts it) and a 2-cell walker passes a door
 * two cells wide with its middle on the door's. That square holds the disc
 * wherever the walker's middle is on the way between two cells it steps
 * between (a straight step sweeps the two footprints' union; a diagonal needs
 * both columns beside it walked, so the four footprints' union holds its
 * sweep): the rule keeps every answer conservative, never a way through a gap
 * the disc cannot pass. Each standable cell keeps its footprint clearance for
 * spans 2 … {@link WALK_SPAN_MAX} (a byte each: the least of the footprint's
 * free runs, from columns read across the chunk's faces too), so a step reads
 * one number for any span. A column of a chunk not known yet counts as free,
 * as the chunk above does for the clearance, and the chunk is made again when
 * one beside it arrives or changes at its faces ({@link WalkChunk.bandSig}).
 *
 * **Pieces**: a chunk's cells joined by steps inside the chunk, for the
 * default walker (no drops: steps go both ways), are its pieces, the coarse
 * level of the walk graph (walk-graph.ts). A cell whose footprint
 * clearance is below the default walker's is in no piece (a shorter or
 * narrower walker reaches it through the cell level alone). The cells of a
 * shut door's opening are pieces of their own, flagged `shut`: the door's
 * edges in the levels, taken only by a walker through shut doors.
 */
import { NAV_CLEARANCE_CELLS, OCCUPANCY, type NavOut } from './derived-data';

/** Free cells a node's clearance counts up to (8 m): the most a walker's height and its drop can ask of a column. */
export const WALK_CLEARANCE_MAX = 16;

/** How far a step rises or falls (cells): one cell, a stair's rise a cell along. */
export const WALK_STEP_CELLS = 1;

/** No piece (a cell whose clearance is below the default walker's height). */
export const NO_WALK_PIECE = 0xffff;

/**
 * The widest footprint the graph keeps clearance for (cells across): 2 m, a walker up to 1 m in radius (a cart, a
 * large creature); a wider one would need a coarser graph, not more bytes a cell.
 */
export const WALK_SPAN_MAX = 4;

/** Bytes of footprint clearance a cell keeps: one a span from 2 to {@link WALK_SPAN_MAX}. */
const WIDE = WALK_SPAN_MAX - 1;

/** Columns a footprint reaches back from its cell, and forward (the widest span's). */
const FOOT_BACK = (WALK_SPAN_MAX - 1) >> 1;
const FOOT_FWD = WALK_SPAN_MAX >> 1;

/** The span (cells across) a walker of `radiusM` metres stands on: the least square of cells its disc fits in (null: wider than the graph keeps). */
export function walkSpanOf(radiusM: number, cellM: number): number | null {
  const span = Math.max(1, Math.ceil((2 * radiusM) / cellM - 1e-9));
  return span > WALK_SPAN_MAX ? null : span;
}

/** Where a walker of `span` stands from its cell's middle (cells, forward on x and on z): an even span stands on the corner. */
export function walkSpanOffset(span: number): number {
  return span % 2 === 0 ? 0.5 : 0;
}

/** A walker's shape and what it may do (cells). */
export interface WalkAgent {
  /** Height in cells (1 … {@link WALK_CLEARANCE_MAX}). */
  readonly height: number;
  /** The deepest drop it walks off (cells; below 2: none). */
  readonly maxDrop: number;
  /** Cells across its square footprint (1 … {@link WALK_SPAN_MAX}; the module comment). */
  readonly span: number;
  /** It steps into cells behind a shut door too (a game whose characters open doors); absent: it does not. */
  readonly throughShut?: boolean;
}

/**
 * The walker the pieces are made for: 2 m tall, no drops, two cells (1 m) across, so a disc up to 0.5 m in radius:
 * the engine's default character (project-model `DEFAULT_CONTROLLER_CAPSULE`, 0.3 m, which the walk queries take
 * as their default radius; the runtime's tests hold the two together) stands on two cells.
 */
export const DEFAULT_WALK_AGENT: WalkAgent = Object.freeze({ height: NAV_CLEARANCE_CELLS, maxDrop: 0, span: 2 });

/** A piece of a chunk (its cells joined by steps inside it); what the stitching adds to it is walk-graph.ts's. */
export interface WalkPieceBase {
  readonly chunk: WalkChunk;
  readonly index: number;
  /** Its cells. */
  readonly cells: number;
  /** Its cells stand in a shut door's opening: a walker through shut doors alone steps into it. */
  readonly shut: boolean;
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
  /** Per cell, its footprint clearance for spans 2 … {@link WALK_SPAN_MAX} ({@link clearOf}). */
  readonly wide: Uint8Array;
  readonly piece: Uint16Array;
  readonly pieces: WalkPieceBase[];
  /**
   * A hash of the blocking of its own columns on its faces (the two first and the last on x and on z: what the
   * footprints of the chunks beside it read), 0 where all are free (as a chunk not known reads); and of its lower half
   * (what the clearance of the chunk below reads). A chunk made again whose hash changed has those chunks made again.
   */
  readonly bandSig: number;
  readonly bottomSig: number;
  /** Some cell's free run reached the chunk's top before the clearance's end: the chunk above's cells count. */
  readonly dependsAbove: boolean;
  /** Whether the chunk above was known when it was made (what its clearance read there). */
  readonly aboveKnown: boolean;
  /**
   * Per cell, 1 where it stands in a shut door's opening (a portal whose prop stops walkers while shut): a step into
   * it is taken only by a walker that goes through shut doors, and it is in no piece (null: none in the chunk).
   */
  readonly shut?: Uint8Array | null;
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

/** Column starts of a part with no cells, by edge: one array every such part shares (never written). */
const EMPTY_COLUMNS = new Map<number, Uint16Array>();
const NO_BYTES = new Uint8Array(0);
const NO_WORDS = new Uint16Array(0);

/** An empty part (a known chunk where nothing stands): most of a ring (rock below, air above), so it holds no arrays of its own. */
export function emptyWalkChunk(cx: number, cy: number, cz: number, key: number, edge: number, bandSig = 0, bottomSig = 0): WalkChunk {
  let cols = EMPTY_COLUMNS.get(edge);
  if (cols === undefined) EMPTY_COLUMNS.set(edge, (cols = new Uint16Array(edge * edge + 1)));
  return { cx, cy, cz, key, edge, colStart: cols, ys: NO_BYTES, col: NO_WORDS, clear: NO_BYTES, wide: NO_BYTES, piece: NO_WORDS, pieces: [], bandSig, bottomSig, dependsAbove: false, aboveKnown: true, alive: true };
}

/** Bits a..b−1 of a 32-bit word (0 ≤ a < b ≤ 32). */
const bitRange = (a: number, b: number): number => ((b >= 32 ? 0xffffffff : (1 << b) - 1) & ~((1 << a) - 1)) >>> 0;

/**
 * Blocking bits by column over a chunk and a band of columns round it: a column's cells from the chunk's floor up
 * through the clearance's reach over its top (`edge` + {@link WALK_CLEARANCE_MAX} bits, low word then high), one bit a
 * blocking cell; a section not known adds none (free).
 */
class ColumnBits {
  readonly lo: Uint32Array;
  readonly hi: Uint32Array;
  /** Columns along an axis: the chunk's and the band's. */
  readonly width: number;

  constructor(
    readonly edge: number,
    /** Band columns round the chunk (back, forward). */
    readonly back: number,
    readonly fwd: number,
  ) {
    this.width = edge + back + fwd;
    this.lo = new Uint32Array(this.width * this.width);
    this.hi = new Uint32Array(this.width * this.width);
  }

  /** A column's index (chunk-local x, z; the band's are negative or past the edge). */
  col(x: number, z: number): number {
    return (x + this.back) * this.width + z + this.back;
  }

  /** Adds a section's blocking cells (`sx`, `sy`, `sz`: its offset from the chunk's first section, in sections). */
  add(n: SectionNav, sx: number, sy: number, sz: number, se: number): void {
    if (n == null || n.blocking === OCCUPANCY.empty) return;
    const y0 = sy * se;
    const top = this.edge + WALK_CLEARANCE_MAX;
    if (y0 >= top) return;
    const x0 = Math.max(sx * se, -this.back);
    const x1 = Math.min(sx * se + se, this.edge + this.fwd);
    const z0 = Math.max(sz * se, -this.back);
    const z1 = Math.min(sz * se + se, this.edge + this.fwd);
    const yEnd = Math.min(y0 + se, top);
    const solid = n.blocking === OCCUPANCY.solid;
    const words = 32 % se === 0 && yEnd - y0 === se && (y0 % 32) + se <= 32;
    for (let x = x0; x < x1; x++) for (let z = z0; z < z1; z++) {
      const c = this.col(x, z);
      if (solid) {
        this.set(c, y0, yEnd);
        continue;
      }
      const base = ((x - sx * se) * se + (z - sz * se)) * se;
      if (words) {
        // A column's cells of a section are one run of bits of its blocking words: moved in at once.
        const bits = (n.blocks![base >>> 5]! >>> (base & 31)) & (se === 32 ? 0xffffffff : (1 << se) - 1);
        if (bits === 0) continue;
        if (y0 < 32) this.lo[c] = (this.lo[c]! | (bits << y0)) >>> 0;
        else this.hi[c] = (this.hi[c]! | (bits << (y0 - 32))) >>> 0;
        continue;
      }
      for (let y = y0; y < yEnd; y++) {
        const i = base + y - y0;
        if (((n.blocks![i >>> 5]! >>> (i & 31)) & 1) === 1) this.set(c, y, y + 1);
      }
    }
  }

  private set(c: number, a: number, b: number): void {
    if (a < 32) this.lo[c] = (this.lo[c]! | bitRange(a, Math.min(b, 32))) >>> 0;
    if (b > 32) this.hi[c] = (this.hi[c]! | bitRange(Math.max(a, 32) - 32, b - 32)) >>> 0;
  }

  /** Free cells in a column from cell `s` upward (s ≤ 32), at most `cap`. */
  run(c: number, s: number, cap: number): number {
    const w = s === 0 ? this.lo[c]! : s < 32 ? (this.lo[c]! >>> s) | (this.hi[c]! << (32 - s)) : this.hi[c]! >>> (s - 32);
    if (w === 0) return cap;
    const t = 31 - Math.clz32(w & -w);
    return t < cap ? t : cap;
  }

  /**
   * The hashes {@link WalkChunk.bandSig} and {@link WalkChunk.bottomSig} of the chunk's own columns: 0 where every
   * column read is free, so a chunk not known and an all-air one agree.
   */
  sigs(): [number, number] {
    const e = this.edge;
    let band = 0;
    let bottom = 0;
    for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) {
      const w = this.lo[this.col(x, z)]!;
      if (w === 0) continue;
      const k = x * e + z;
      if (x < 2 || z < 2 || x === e - 1 || z === e - 1) band = Math.imul(band ^ Math.imul(k + 1, 0x9e3779b1) ^ w, 16777619) >>> 0 || 1;
      const low = w & 0xffff;
      if (low !== 0) bottom = Math.imul(bottom ^ Math.imul(k + 1, 0x85ebca6b) ^ low, 16777619) >>> 0 || 1;
    }
    return [band, bottom];
  }
}

/**
 * A chunk's part from its sections' navigation (`nav`): its standable cells by column with their clearance and
 * footprint clearances, and its pieces for the default walker. `se`: the section edge; the chunk has `edge / se`
 * sections an axis; `nav` is also asked for the sections beside it (offsets −1 and `edge / se`), whose columns the
 * footprints of its cells on its faces read.
 */
export function buildWalkChunk(cx: number, cy: number, cz: number, key: number, edge: number, se: number, nav: ChunkNavReader, shutAt: ((x: number, y: number, z: number) => boolean) | null = null): WalkChunk {
  const per = edge / se;
  // Own sections, then the chunk above's lowest layer (the clearance reads at most WALK_CLEARANCE_MAX cells past the top).
  const layers = per + Math.ceil(WALK_CLEARANCE_MAX / se);
  const side = per + 2;
  const navs: SectionNav[] = new Array(side * side * layers);
  const at = (sx: number, sy: number, sz: number): number => ((sx + 1) * side + (sz + 1)) * layers + sy;
  for (let sx = 0; sx < per; sx++) for (let sz = 0; sz < per; sz++) for (let sy = 0; sy < layers; sy++) navs[at(sx, sy, sz)] = nav(sx, sy, sz);
  let aboveKnown = true;
  for (let sx = 0; sx < per; sx++) for (let sz = 0; sz < per; sz++) for (let sy = per; sy < layers; sy++) if (navs[at(sx, sy, sz)] === undefined) aboveKnown = false;
  // Count each column's standable cells, then place them upward.
  const counts = new Uint16Array(edge * edge + 1);
  let total = 0;
  for (let sx = 0; sx < per; sx++) for (let sz = 0; sz < per; sz++) for (let sy = 0; sy < per; sy++) {
    const n = navs[at(sx, sy, sz)];
    if (n == null) continue;
    for (const i of n.standable) {
      const x = sx * se + ((i / (se * se)) | 0);
      const z = sz * se + (((i / se) | 0) % se);
      counts[x * edge + z]!++;
      total++;
    }
  }
  const bits = new ColumnBits(edge, total === 0 ? 0 : FOOT_BACK, total === 0 ? 0 : FOOT_FWD);
  for (let sx = 0; sx < per; sx++) for (let sz = 0; sz < per; sz++) for (let sy = 0; sy < layers; sy++) bits.add(navs[at(sx, sy, sz)], sx, sy, sz, se);
  if (total === 0) {
    const [band, bottom] = bits.sigs();
    return emptyWalkChunk(cx, cy, cz, key, edge, band, bottom);
  }
  // The band of columns beside the chunk its footprints read: only a chunk where something stands asks for them.
  for (let sx = -1; sx <= per; sx++) for (let sz = -1; sz <= per; sz++) {
    if (sx >= 0 && sx < per && sz >= 0 && sz < per) continue;
    for (let sy = 0; sy < layers; sy++) {
      const n = nav(sx, sy, sz);
      navs[at(sx, sy, sz)] = n;
      bits.add(n, sx, sy, sz, se);
    }
  }
  const [bandSig, bottomSig] = bits.sigs();
  const colStart = new Uint16Array(edge * edge + 1);
  for (let c = 0; c < edge * edge; c++) colStart[c + 1] = colStart[c]! + counts[c]!;
  const fill = colStart.slice(0, edge * edge);
  const ys = new Uint8Array(total);
  const col = new Uint16Array(total);
  const clear = new Uint8Array(total);
  const wide = new Uint8Array(total * WIDE);
  let dependsAbove = false;
  // Sections upward, so a column's cells land in rising y.
  for (let sy = 0; sy < per; sy++) for (let sx = 0; sx < per; sx++) for (let sz = 0; sz < per; sz++) {
    const n = navs[at(sx, sy, sz)];
    if (n == null) continue;
    for (const i of n.standable) {
      const x = sx * se + ((i / (se * se)) | 0);
      const z = sz * se + (((i / se) | 0) % se);
      const y = sy * se + (i % se);
      const c = x * edge + z;
      const k = fill[c]!++;
      ys[k] = y;
      col[k] = c;
      const free = bits.run(bits.col(x, z), y, WALK_CLEARANCE_MAX);
      if (free < WALK_CLEARANCE_MAX ? y + free >= edge : y + WALK_CLEARANCE_MAX > edge) dependsAbove = true;
      clear[k] = free;
      // Each wider footprint: the narrower one's least, and the free runs over the floor of the columns it adds.
      let least = free;
      for (let span = 2; span <= WALK_SPAN_MAX; span++) {
        const back = (span - 1) >> 1;
        const fwd = span >> 1;
        const pb = (span - 2) >> 1;
        const pf = (span - 1) >> 1;
        for (let ox = -back; ox <= fwd; ox++) for (let oz = -back; oz <= fwd; oz++) {
          if (ox >= -pb && ox <= pf && oz >= -pb && oz <= pf) continue;
          const r = 1 + bits.run(bits.col(x + ox, z + oz), y + 1, WALK_CLEARANCE_MAX - 1);
          if (y + r >= edge) dependsAbove = true;
          if (r < least) least = r;
        }
        wide[k * WIDE + span - 2] = least;
      }
    }
  }
  let shut: Uint8Array | null = null;
  if (shutAt !== null) {
    for (let k = 0; k < total; k++) {
      const c = col[k]!;
      if (shutAt((c / edge) | 0, ys[k]!, c % edge)) (shut ??= new Uint8Array(total))[k] = 1;
    }
  }
  const chunk: WalkChunk = { cx, cy, cz, key, edge, colStart, ys, col, clear, wide, piece: new Uint16Array(total).fill(NO_WALK_PIECE), pieces: [], bandSig, bottomSig, dependsAbove, aboveKnown, shut, alive: true };
  labelPieces(chunk);
  return chunk;
}

/** A cell's clearance for a walker `span` cells across: its own column's for one, else its footprint's. */
export function clearOf(c: WalkChunk, i: number, span: number): number {
  return span <= 1 ? c.clear[i]! : c.wide[i * WIDE + span - 2]!;
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
    const w = agent.span;
    const ca = clearOf(c, i, w);
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
        if (j < 0 || !stepFits(ca, clearOf(t, j, w), dy, h)) continue;
        if (t.shut?.[j] === 1 && agent.throughShut !== true) {
          found = true;
          continue;
        }
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
        if (j < 0) continue;
        const cj = clearOf(c, j, w);
        if (!stepFits(ca, cj, dy, h)) continue;
        if (c.shut?.[j] === 1 && agent.throughShut !== true) break;
        // Each straight neighbour on to the diagonal's end: the same rule from where its step landed.
        const ja = this.orthoCell[oa]!;
        const jb = this.orthoCell[ob]!;
        if (!stepFits(clearOf(c, ja, w), cj, dy - this.orthoDy[oa]!, h) || !stepFits(clearOf(c, jb, w), cj, dy - this.orthoDy[ob]!, h)) break;
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
      if (t.shut?.[j] === 1 && agent.throughShut !== true) return;
      if (clearOf(t, j, agent.span) >= k + agent.height) sink(t, j, this.cellM * Math.sqrt(1 + k * k));
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

/** The default walker through shut doors: what floods a shut door's cells into their pieces and makes the door's edges. */
export const DEFAULT_WALK_AGENT_THROUGH_SHUT: WalkAgent = Object.freeze({ ...DEFAULT_WALK_AGENT, throughShut: true });

/**
 * The pieces of a chunk: its cells joined by the default walker's steps inside it (a flood a piece); then the cells
 * of shut doors' openings joined among themselves, pieces flagged `shut`.
 */
function labelPieces(c: WalkChunk): void {
  const stepper = new WalkStepper(1);
  const only: WalkChunkLookup = () => null;
  const queue = new Int32Array(c.ys.length);
  let id = 0;
  let tail = 0;
  let shutOnly = false;
  const sink: WalkStepSink = (_t, j) => {
    if (c.piece[j] !== NO_WALK_PIECE || (shutOnly && c.shut?.[j] !== 1)) return;
    c.piece[j] = id;
    queue[tail++] = j;
  };
  const pieces = c.pieces;
  const h = DEFAULT_WALK_AGENT.height;
  const w = DEFAULT_WALK_AGENT.span;
  for (const pass of [false, true]) {
    if (pass && c.shut == null) break;
    shutOnly = pass;
    const agent = pass ? DEFAULT_WALK_AGENT_THROUGH_SHUT : DEFAULT_WALK_AGENT;
    for (let seed = 0; seed < c.ys.length; seed++) {
      if (c.piece[seed] !== NO_WALK_PIECE || clearOf(c, seed, w) < h || (c.shut?.[seed] === 1) !== pass) continue;
      id = pieces.length;
      c.piece[seed] = id;
      let head = 0;
      tail = 0;
      queue[tail++] = seed;
      while (head < tail) stepper.steps(only, c, queue[head++]!, agent, sink);
      pieces.push({ chunk: c, index: id, cells: tail, shut: pass });
    }
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
  return c.colStart.byteLength + c.ys.byteLength + c.col.byteLength + c.clear.byteLength + c.wide.byteLength + c.piece.byteLength + c.pieces.length * 64;
}

/** Whether two parts hold the same cells, clearances and pieces (a chunk made again with no change stands). */
export function sameWalkChunk(a: WalkChunk, b: WalkChunk): boolean {
  if (a.ys.length !== b.ys.length || a.pieces.length !== b.pieces.length) return false;
  for (let k = 0; k < a.colStart.length; k++) if (a.colStart[k] !== b.colStart[k]) return false;
  for (let k = 0; k < a.ys.length; k++) if (a.ys[k] !== b.ys[k] || a.clear[k] !== b.clear[k] || a.piece[k] !== b.piece[k] || (a.shut?.[k] ?? 0) !== (b.shut?.[k] ?? 0)) return false;
  for (let k = 0; k < a.wide.length; k++) if (a.wide[k] !== b.wide[k]) return false;
  return true;
}
