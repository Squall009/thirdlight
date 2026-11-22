/**
 * The world's open regions where a world runs: the derive units' components
 * (open-regions.ts) stitched across unit and chunk faces into regions and
 * portals, kept up to date as chunks arrive, change and leave.
 *
 * - **A piece** is one storage chunk's components: its derive units' labels
 *   joined across the faces between them, made when every unit of the
 *   chunk has a result (the drawn one: what is drawn and collided), again
 *   on each `chunk` event that changes its occupancy, dropped when it
 *   unloads. A piece's components are the graph's nodes.
 * - **Nodes join** across a chunk face where two open cells of the same kind
 *   (region or portal) share it; a region cell against a portal cell is a
 *   link (the portal's side). A world region is a connected set of region
 *   nodes, a world portal a connected set of portal nodes.
 * - **Rebuilt where it changed.** A new or changed piece makes new nodes;
 *   a region that lost a node is searched again from the nodes beside the
 *   lost ones, only until those searches meet (so the outdoors losing a
 *   chunk at the ring's edge costs the few nodes round it, not the whole
 *   region), and the new nodes' walks absorb the regions they now touch. A
 *   region keeps its id while its nodes stay; of a region that split, the
 *   largest part keeps the id, the others take new ones.
 * - **In slices.** Stitching chunks, refreshing columns' sky heights and the
 *   searches all count against the caller's slice, a unit of work at a time
 *   (a chunk, a column, a few nodes of a search), and what is left carries
 *   over to the next call: a ring that narrows at a flight's start drops
 *   thousands of chunks at once, and their searches would otherwise run in
 *   one tick. While a region's search is not done, the region answers as not
 *   complete (so never enclosed), under the id it had.
 * - **Sky** (R98, stitched upward): a column's sky height is the highest
 *   solid cell + 1 over the pieces known in its chunk column; a cell at or
 *   above it is under open sky. Space no piece knows counts as open (the
 *   occupancy walk's rule: light passes where nothing is known).
 * - **Enclosed.** A region is *complete* when none of its nodes reaches a
 *   chunk face whose neighbour has no piece yet (inside the world): it
 *   cannot continue into space not known. It is *enclosed* when complete, no
 *   cell of it is under open sky, and it does not reach the world's edge.
 *   A region touching a chunk not loaded is never enclosed: it is unknown
 *   until that chunk arrives. Portals do not open a region: a house's room
 *   behind its door and windows is enclosed, joined to the street by them.
 * - **Structure grids** stamped into the world grid (structure-stamp.ts,
 *   the prop channel's classes) are read with each unit: a stamped stopping
 *   cell is solid, a stamped opening a portal cell, so a turned house's
 *   rooms, portals and roof (the sky heights) are the world's own; a chunk
 *   whose stamp changes is touched again.
 */
import { chunkInWorld, chunkKey, WORLD_CELL_MIN_Y, type CellGrid, type ChunkGrid } from './coords';
import { sectionIdOf } from './derive-assembly';
import type { DeriveOutput } from './stream-job';
import type { SkyColumnWire } from './sky-columns';
import { airRegions, ALL_REGION_FACES, openRegionsArrays, REGION_FACE, REGION_PORTAL, regionLabelAt, regionSkyAt, stampedRegions, type OpenRegionsOut } from './open-regions';

/** Structure grids stamped into the world grid as the stitching reads them: a resident chunk's classes (structure-stamp.ts; null: none). */
export interface RegionStamps {
  rooms(cx: number, cy: number, cz: number): Uint8Array | null;
}

/** What the stitching reads of a streamer. */
export interface RegionStreamerView {
  readonly grid: ChunkGrid;
  readonly sections: CellGrid;
  derivedOf(sx: number, sy: number, sz: number, drawn?: boolean): DeriveOutput | null;
}

/** A region or a portal as a query answers it. */
export interface OpenRegionInfo {
  /** Stable while the region's set of pieces' components does not change. */
  readonly id: number;
  /** A portal (opening cells), not a region. */
  readonly portal: boolean;
  /** Cells (0.5 m: 0.125 m³ each). */
  readonly cells: number;
  /** Some cell of it is under open sky. */
  readonly sky: boolean;
  /** It reaches no chunk face whose neighbour is not known yet, and no search of it after a loss is under way. */
  readonly complete: boolean;
  /** Complete, no cell under open sky, not reaching the world's edge (a portal: never). */
  readonly enclosed: boolean;
  /** A region: the portals on its boundary; a portal: the regions it joins. */
  readonly portals: number;
  /** The box of its cells (world cells, inclusive; over the loaded part while not complete). */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /**
   * Cell faces between its cells and solid cells (each a cell's face): its surface, as far as the chunks it reaches
   * are stitched (a face on a chunk face counts once the chunk across is).
   */
  readonly faces: number;
}

/** A portal's extent (cells, inclusive) and the regions it joins. */
export interface OpenPortalInfo {
  readonly id: number;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly cells: number;
  readonly regions: readonly number[];
}

/** Counts over what is stitched (what the measurements report). */
export interface OpenRegionStats {
  readonly pieces: number;
  readonly nodes: number;
  readonly regions: number;
  readonly enclosed: number;
  readonly portals: number;
  /** Pieces made, and nodes reached by the regions' searches or moved between regions, since the stitching began. */
  readonly built: number;
  readonly walked: number;
  /** Nodes taken off the searches' queues (searches started again after a loss inside them included), columns refreshed. */
  readonly searched: number;
  readonly columns: number;
  /** Regions whose search after a loss is still under way. */
  readonly searching: number;
  /** Region and portal summaries worked out since the stitching began (a query reads one already worked out). */
  readonly summaries: number;
}

interface Group {
  readonly id: number;
  readonly portal: boolean;
  readonly nodes: Node[];
  info: OpenRegionInfo | null;
  /** The stitching's {@link OpenRegionStitch.changes} the summary was read at (a neighbour's change can move it). */
  infoAt: number;
  /** Its portals' summaries and its nodes' boxes, read at the same change as `info` (null: not read since). */
  portalList: OpenPortalInfo[] | null;
  boxes: Box[] | null;
}

/** A box of cells (world, inclusive): min x y z, max x y z. */
export type OpenRegionBox = readonly [number, number, number, number, number, number];
type Box = OpenRegionBox;

interface Node {
  readonly piece: Piece;
  readonly portal: boolean;
  readonly cells: number;
  /** Chunk faces its cells reach ({@link REGION_FACE} bits). */
  readonly faces: number;
  /** Bounds (cells, world) of its cells. */
  readonly min: [number, number, number];
  readonly max: [number, number, number];
  /** Faces between its cells and solid cells inside the piece. */
  inner: number;
  /** Per chunk face (the order of {@link FACES}): faces between its cells there and solid cells of the piece across. */
  readonly across: Int32Array;
  readonly adj: Set<Node>;
  readonly links: Set<Node>;
  group: Group | null;
  sky: boolean;
  dead: boolean;
}

interface Piece {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly key: number;
  readonly units: readonly OpenRegionsOut[];
  /** Per unit: label → component (1-based; 0: solid). */
  readonly maps: readonly Uint16Array[];
  readonly nodes: Node[];
  /** Per column (x · E + z) of the chunk: highest solid cell + 1 inside it (0: none). */
  readonly top: Uint8Array;
  /** Faces whose neighbour is known: it has a piece, or lies outside the world. */
  known: number;
  /** Faces toward outside the world. */
  readonly outside: number;
  /** Every cell's component when the chunk is uniform (0: all solid, 1: all one open region), else −1. */
  readonly uniform: number;
}

interface Column {
  readonly pieces: Map<number, Piece>;
  /** Per column: the sky height (highest solid cell + 1, world cells; {@link WORLD_CELL_MIN_Y}: none known). */
  readonly sky: Int16Array;
  /** Its heights have gone out in a {@link OpenRegionStitch.takeSky} at least once. */
  sent: boolean;
}

/**
 * A region's parts searched again after it lost nodes ({@link OpenRegionStitch.searchStep}), kept across calls: the
 * seeds (live nodes that touched a lost one) and, once started, the searches' state.
 */
interface Search {
  readonly seeds: Node[];
  state: SearchState | null;
}

interface SearchState {
  /** Node → the search that reached it. */
  readonly owner: Map<Node, number>;
  readonly queues: Node[][];
  readonly heads: number[];
  /** Searches that met, joined (union-find over search indices). */
  readonly parent: number[];
  /** The search a round has come to (0: a round starts). */
  at: number;
  /** The joined searches still growing, read at a round's start. */
  readonly growing: Set<number>;
}

/**
 * Nodes a search takes off its queues between two readings of the clock: one unit of work in a slice. A node costs
 * well under a microsecond, so a reading per node would cost more than the node.
 */
const SEARCH_NODES = 16;

/** The stages of an update, taken in turn from a stage that moves round, so each has the first unit of some call. */
const STAGES = 3;

function findSearch(parent: number[], i: number): number {
  while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
  return i;
}

/** Faces as (dx, dy, dz) and their opposite's bit. */
const FACES: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [-1, 0, 0, REGION_FACE.nx, REGION_FACE.px],
  [1, 0, 0, REGION_FACE.px, REGION_FACE.nx],
  [0, -1, 0, REGION_FACE.ny, REGION_FACE.py],
  [0, 1, 0, REGION_FACE.py, REGION_FACE.ny],
  [0, 0, -1, REGION_FACE.nz, REGION_FACE.pz],
  [0, 0, 1, REGION_FACE.pz, REGION_FACE.nz],
];

/** The label maps of a uniform chunk's units: all solid, or label 1 → component 1. */
const NO_MAP = Uint16Array.of(0);
const ONE_MAP = Uint16Array.of(0, 1);

/** Rough bytes of a node beyond its arrays (object, two sets, bounds): what the resident report counts. */
const NODE_BYTES = 320;
const CONTACT_BYTES = 24;

/** The world's open regions over a streamer's level-0 results (the module comment). */
export class OpenRegionStitch {
  private readonly pieces = new Map<number, Piece>();
  private readonly columns = new Map<number, Column>();
  private readonly groups = new Map<number, Group>();
  private readonly dirty = new Map<number, readonly [number, number, number]>();
  /**
   * Regions that lost a node, each with the live nodes that touched a lost one (where its parts are searched from)
   * and its search so far. A summary is read again after any update.
   */
  private readonly broken = new Map<Group, Search>();
  private readonly fresh = new Set<Node>();
  private readonly dirtyColumns = new Set<number>();
  /** Chunk columns whose sky heights changed or went since taken ({@link takeSky}), and who wants to know. */
  private readonly skyChanged = new Map<number, readonly [number, number]>();
  private readonly skyListeners: Array<() => void> = [];
  private readonly updateListeners: Array<() => void> = [];
  private nextId = 1;
  private built = 0;
  private walked = 0;
  private searched = 0;
  private columnsDone = 0;
  private summaries = 0;
  /** The stage the next update starts with. */
  private turn = 0;
  private nodeCount = 0;
  private contacts = 0;
  private arrayBytes = 0;
  /** Bumped whenever anything a summary reads changed. */
  private version = 0;
  private readonly air: OpenRegionsOut;
  private readonly per: number;
  /** The column tops every all-solid and every all-air chunk shares (never written). */
  private readonly topSolid: Uint8Array;
  private readonly topAir: Uint8Array;

  constructor(
    private readonly view: RegionStreamerView,
    /** Structure grids stamped into the world grid (prop-channel.ts `rooms`): their stopping cells solid, their openings portals. */
    private readonly stamps: RegionStamps | null = null,
  ) {
    this.air = airRegions(view.sections.edge);
    this.topSolid = new Uint8Array(view.grid.edge ** 2).fill(view.grid.edge);
    this.topAir = new Uint8Array(view.grid.edge ** 2);
    this.per = view.grid.edge / view.sections.edge;
  }

  /** A chunk whose level-0 results changed (a `chunk` event that is not shader- or relief-only), arrived or left. */
  touch(cx: number, cy: number, cz: number): void {
    this.dirty.set(chunkKey(this.view.grid, cx, cy, cz), [cx, cy, cz]);
  }

  /** Whether chunks, chunk columns' sky heights, or searches of regions that lost nodes wait. */
  get pending(): boolean {
    return this.dirty.size > 0 || this.dirtyColumns.size > 0 || this.broken.size > 0;
  }

  /**
   * Stitches the chunks touched since the last call, refreshes the sky
   * heights of the chunk columns they changed and searches again the
   * regions that lost nodes, all within `ms`: the clock is read before each
   * unit of work after a call's first (a chunk, a column, or
   * {@link SEARCH_NODES} nodes of a search), so a call passes the slice by
   * at most one unit, and what is left waits for the next call. The first
   * unit goes to each stage in turn, so all three catch up behind a stream
   * of arrivals. Returns the chunks stitched.
   */
  update(ms = Infinity): number {
    if (!this.pending) return 0;
    const t0 = performance.now();
    let units = 0;
    const go = (): boolean => units === 0 || performance.now() - t0 < ms;
    let n = 0;
    const start = this.turn;
    this.turn = (this.turn + 1) % STAGES;
    // Round the stages again while time is left: a stage's work makes another's (drops leave searches, chunks columns).
    for (let k = 0; this.pending && (k < STAGES || go()); k++) {
      const stage = (start + k) % STAGES;
      if (stage === 0) {
        for (const [key, [cx, cy, cz]] of this.dirty) {
          if (!go()) break;
          this.dirty.delete(key);
          this.restitch(key, cx, cy, cz);
          n++;
          units++;
        }
        // New nodes join what they touch at once (a few set reads each): a chunk is not stitched until it has.
        this.placeFresh();
      } else if (stage === 1) {
        // A column's refresh reads every piece of it, so it runs once for all the chunks of it stitched so far.
        for (const col of this.dirtyColumns) {
          if (!go()) break;
          this.dirtyColumns.delete(col);
          this.refreshColumn(col);
          this.columnsDone++;
          units++;
        }
      } else {
        while (this.broken.size > 0 && go()) {
          const [g, search] = this.broken.entries().next().value!;
          this.searchStep(g, search);
          units++;
        }
      }
    }
    this.version++;
    if (this.skyChanged.size > 0) for (const f of this.skyListeners) f();
    for (const f of this.updateListeners) f();
    return n;
  }

  private restitch(key: number, cx: number, cy: number, cz: number): void {
    const old = this.pieces.get(key);
    // A chunk derived again with the same regions (a neighbour landing, a change that moved no open cell) stands.
    if (old !== undefined && this.sameUnits(old, cx, cy, cz)) return;
    if (old !== undefined) this.dropPiece(old);
    const piece = this.makePiece(key, cx, cy, cz);
    if (piece !== null) this.addPiece(piece);
  }

  /** Whether every unit of a chunk has the same regions as a piece was made from. */
  private sameUnits(p: Piece, cx: number, cy: number, cz: number): boolean {
    const per = this.per;
    for (let sx = 0; sx < per; sx++) for (let sz = 0; sz < per; sz++) for (let sy = 0; sy < per; sy++) {
      const r = this.view.derivedOf(cx * per + sx, cy * per + sy, cz * per + sz, true);
      if (r === null) return false;
      const now = this.unitOf(r, cx, cy, cz, sx, sy, sz);
      if (now == null || !sameRegions(now, p.units[sectionIdOf(per, sx, sy, sz)]!)) return false;
    }
    return true;
  }

  /** A unit's regions as derived, with the structures stamped over its chunk (undefined: its result has none). */
  private unitOf(r: DeriveOutput, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): OpenRegionsOut | undefined {
    const own = r.assembly === null ? this.air : r.assembly.regions;
    const classes = own == null || this.stamps === null ? null : this.stamps.rooms(cx, cy, cz);
    if (classes === null) return own ?? undefined;
    const se = this.view.sections.edge;
    return stampedRegions(own!, classes, sx * se, sy * se, sz * se, this.view.grid.shift);
  }

  private columnKey(cx: number, cz: number): number {
    return chunkKey(this.view.grid, cx, 0, cz);
  }

  private dropPiece(p: Piece): void {
    this.pieces.delete(p.key);
    for (const node of p.nodes) {
      node.dead = true;
      const g = node.group;
      let search = g === null ? undefined : this.broken.get(g);
      if (g !== null && search === undefined) this.broken.set(g, (search = { seeds: [], state: null }));
      // A node a search had reached may have held its part together: that search starts again from all the seeds.
      if (search?.state?.owner.has(node) === true) this.restartSearch(search);
      for (const o of node.adj) {
        o.adj.delete(node);
        // Every part the region may fall into holds a node that touched a lost one: its search starts there.
        if (search !== undefined && !o.dead && o.group === g) this.addSeed(g!, search, o);
      }
      for (const o of node.links) o.links.delete(node);
      this.contacts -= node.adj.size + node.links.size;
      this.fresh.delete(node);
    }
    this.nodeCount -= p.nodes.length;
    this.arrayBytes -= pieceBytes(p);
    for (let f = 0; f < FACES.length; f++) {
      const [dx, dy, dz, , opp] = FACES[f]!;
      const q = this.pieces.get(chunkKey(this.view.grid, p.cx + dx, p.cy + dy, p.cz + dz));
      if (q === undefined) continue;
      q.known &= ~opp;
      // Its faces against the piece that went are not known until a piece comes there again.
      for (const n of q.nodes) n.across[f ^ 1] = 0;
    }
    const ck = this.columnKey(p.cx, p.cz);
    const col = this.columns.get(ck);
    if (col !== undefined) {
      col.pieces.delete(p.cy);
      if (col.pieces.size === 0) {
        this.columns.delete(ck);
        this.arrayBytes -= col.sky.byteLength;
        this.dirtyColumns.delete(ck);
        this.skyChanged.set(ck, [p.cx, p.cz]);
      } else this.dirtyColumns.add(ck);
    }
  }

  /** The chunk's units' results joined into its components (null: a unit has no result yet). */
  private makePiece(key: number, cx: number, cy: number, cz: number): Piece | null {
    const g = this.view.grid;
    if (!chunkInWorld(g, cx, cy, cz)) return null;
    const per = this.per;
    const se = this.view.sections.edge;
    const units: OpenRegionsOut[] = [];
    for (let sx = 0; sx < per; sx++) for (let sz = 0; sz < per; sz++) for (let sy = 0; sy < per; sy++) {
      const r = this.view.derivedOf(cx * per + sx, cy * per + sy, cz * per + sz, true);
      if (r === null) return null;
      const regions = this.unitOf(r, cx, cy, cz, sx, sy, sz);
      if (regions == null) return null;
      units[sectionIdOf(per, sx, sy, sz)] = regions;
    }
    let outside = 0;
    for (const [dx, dy, dz, bit] of FACES) if (!chunkInWorld(g, cx + dx, cy + dy, cz + dz)) outside |= bit;
    // A chunk all solid or all open air (most of a ring: rock below, sky above) is one value, nothing to join.
    const uniform = units.every((u) => u.labels === null && u.count === 0) ? 0 : units.every((u) => u.labels === null && u.count === 1 && (u.flags[0]! & REGION_PORTAL) === 0) ? 1 : -1;
    if (uniform >= 0) {
      const piece: Piece = { cx, cy, cz, key, units, maps: units.map((u) => (u.count === 0 ? NO_MAP : ONE_MAP)), nodes: [], top: uniform === 0 ? this.topSolid : this.topAir, known: 0, outside, uniform };
      const [x0, y0, z0] = [cx * g.edge, cy * g.edge, cz * g.edge];
      if (uniform === 1) piece.nodes.push({ piece, portal: false, cells: g.edge ** 3, faces: ALL_REGION_FACES, min: [x0, y0, z0], max: [x0 + g.edge - 1, y0 + g.edge - 1, z0 + g.edge - 1], inner: 0, across: new Int32Array(6), adj: new Set(), links: new Set(), group: null, sky: false, dead: false });
      return piece;
    }
    // Union-find over every unit's labels.
    const offsets: number[] = [];
    let total = 0;
    for (const u of units) {
      offsets.push(total);
      total += u.count;
    }
    const parent = new Int32Array(total + 1);
    for (let i = 0; i <= total; i++) parent[i] = i;
    const find = (a: number): number => {
      while (parent[a] !== a) a = parent[a] = parent[parent[a]!]!;
      return a;
    };
    const portalOf = (u: number, l: number): boolean => (units[u]!.flags[l - 1]! & REGION_PORTAL) !== 0;
    const linkPairs: Array<[number, number]> = [];
    for (let u = 0; u < units.length; u++) {
      const L = units[u]!.links;
      for (let k = 0; k < L.length; k += 2) linkPairs.push([offsets[u]! + L[k]!, offsets[u]! + L[k + 1]!]);
    }
    const local = (x: number, y: number, z: number): number => ((x * se + z) * se) + y;
    // Faces between the chunk's own units.
    for (let sx = 0; sx < per; sx++) for (let sz = 0; sz < per; sz++) for (let sy = 0; sy < per; sy++) {
      const a = sectionIdOf(per, sx, sy, sz);
      for (const [dx, dy, dz] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const) {
        if (sx + dx >= per || sy + dy >= per || sz + dz >= per) continue;
        const b = sectionIdOf(per, sx + dx, sy + dy, sz + dz);
        const ua = units[a]!;
        const ub = units[b]!;
        if (ua.count === 0 || ub.count === 0) continue;
        // Two uniform units meet in one label each: one cell pair says it all.
        const span = ua.labels === null && ub.labels === null ? 1 : se;
        for (let i = 0; i < span; i++) for (let j = 0; j < span; j++) {
          const ca = dx ? local(se - 1, i, j) : dy ? local(i, se - 1, j) : local(i, j, se - 1);
          const cb = dx ? local(0, i, j) : dy ? local(i, 0, j) : local(i, j, 0);
          const la = regionLabelAt(ua, ca);
          const lb = regionLabelAt(ub, cb);
          if (la === 0 || lb === 0) continue;
          const pa = portalOf(a, la);
          if (pa === portalOf(b, lb)) parent[find(offsets[a]! + la)] = find(offsets[b]! + lb);
          else linkPairs.push(pa ? [offsets[b]! + lb, offsets[a]! + la] : [offsets[a]! + la, offsets[b]! + lb]);
        }
      }
    }
    // Components: their cells, the chunk faces they reach, a portal's extent.
    const compOf = new Int32Array(total + 1);
    const nodes: Node[] = [];
    const ox = cx * g.edge;
    const oy = cy * g.edge;
    const oz = cz * g.edge;
    const piece: Piece = { cx, cy, cz, key, units, maps: units.map((u) => new Uint16Array(u.count + 1)), nodes, top: new Uint8Array(g.edge * g.edge), known: 0, outside, uniform: -1 };
    for (let u = 0; u < units.length; u++) {
      const un = units[u]!;
      const sy = u % per;
      const sz = Math.floor(u / per) % per;
      const sx = Math.floor(u / (per * per));
      const keep = (sx === 0 ? REGION_FACE.nx : 0) | (sx === per - 1 ? REGION_FACE.px : 0) | (sy === 0 ? REGION_FACE.ny : 0) | (sy === per - 1 ? REGION_FACE.py : 0) | (sz === 0 ? REGION_FACE.nz : 0) | (sz === per - 1 ? REGION_FACE.pz : 0);
      for (let l = 1; l <= un.count; l++) {
        const root = find(offsets[u]! + l);
        let c = compOf[root]!;
        if (c === 0) {
          const portal = portalOf(u, l);
          nodes.push({ piece, portal, cells: 0, faces: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], inner: 0, across: new Int32Array(6), adj: new Set(), links: new Set(), group: null, sky: false, dead: false });
          c = compOf[root] = nodes.length;
        }
        piece.maps[u]![l] = c;
        const node = nodes[c - 1]! as { cells: number; faces: number };
        node.cells += un.volume[l - 1]!;
        node.faces |= un.flags[l - 1]! & keep;
      }
    }
    // Each node's box and the faces between its cells and solid cells inside the chunk, from the chunk's cells' components.
    const E = g.edge;
    const comp = compScratch(E * E * E);
    for (let u = 0; u < units.length; u++) {
      const un = units[u]!;
      const map = piece.maps[u]!;
      const sy = u % per;
      const sz = Math.floor(u / per) % per;
      const sx = Math.floor(u / (per * per));
      const all = un.labels === null ? (un.count === 0 ? 0 : map[un.count]!) : -1;
      for (let i = 0; i < se * se * se; i++) {
        const x = sx * se + Math.floor(i / (se * se));
        const z = sz * se + (Math.floor(i / se) % se);
        const y = sy * se + (i % se);
        comp[(x * E + z) * E + y] = all >= 0 ? all : map[un.labels![i]!]!;
      }
    }
    for (let x = 0; x < E; x++) for (let z = 0; z < E; z++) {
      const row = (x * E + z) * E;
      for (let y = 0; y < E; y++) {
        const i = row + y;
        const c = comp[i]!;
        if (c !== 0) {
          const nd = nodes[c - 1]!;
          if (ox + x < nd.min[0]) nd.min[0] = ox + x;
          if (oy + y < nd.min[1]) nd.min[1] = oy + y;
          if (oz + z < nd.min[2]) nd.min[2] = oz + z;
          if (ox + x > nd.max[0]) nd.max[0] = ox + x;
          if (oy + y > nd.max[1]) nd.max[1] = oy + y;
          if (oz + z > nd.max[2]) nd.max[2] = oz + z;
        }
        // The faces toward +x, +z and +y inside the chunk: one open side and one solid is a face of the open one's.
        if (x + 1 < E) countFace(nodes, c, comp[i + E * E]!);
        if (z + 1 < E) countFace(nodes, c, comp[i + E]!);
        if (y + 1 < E) countFace(nodes, c, comp[i + 1]!);
      }
    }
    for (const [a, b] of linkPairs) {
      const na = nodes[compOf[find(a)]! - 1]!;
      const nb = nodes[compOf[find(b)]! - 1]!;
      if (!na.links.has(nb)) {
        na.links.add(nb);
        nb.links.add(na);
        this.contacts += 2;
      }
    }
    // The highest solid cell of each column inside the chunk.
    for (let x = 0; x < g.edge; x++) for (let z = 0; z < g.edge; z++) {
      for (let sy = per - 1; sy >= 0; sy--) {
        const h = regionSkyAt(units[sectionIdOf(per, x / se | 0, sy, z / se | 0)]!, (x % se) * se + (z % se));
        if (h > 0) {
          piece.top[x * g.edge + z] = sy * se + h;
          break;
        }
      }
    }
    return piece;
  }

  /** The component of a chunk's cell (local, 0 … edge − 1): 0 when solid. */
  private compAt(p: Piece, x: number, y: number, z: number): number {
    if (p.uniform >= 0) return p.uniform;
    const se = this.view.sections.edge;
    const u = sectionIdOf(this.per, (x / se) | 0, (y / se) | 0, (z / se) | 0);
    const l = regionLabelAt(p.units[u]!, ((x % se) * se + (z % se)) * se + (y % se));
    return l === 0 ? 0 : p.maps[u]![l]!;
  }

  private addPiece(p: Piece): void {
    const g = this.view.grid;
    const E = g.edge;
    this.pieces.set(p.key, p);
    this.built++;
    this.nodeCount += p.nodes.length;
    this.arrayBytes += pieceBytes(p);
    for (const nd of p.nodes) this.fresh.add(nd);
    p.known = p.outside;
    for (let f = 0; f < FACES.length; f++) {
      const [dx, dy, dz, bit, opp] = FACES[f]!;
      const q = this.pieces.get(chunkKey(g, p.cx + dx, p.cy + dy, p.cz + dz));
      if (q === undefined) continue;
      p.known |= bit;
      q.known |= opp;
      // Two uniform chunks meet in one value each: one cell pair says it all (for E² faces).
      const span = p.uniform >= 0 && q.uniform >= 0 ? 1 : E;
      const per = span === 1 ? E * E : 1;
      for (let i = 0; i < span; i++) for (let j = 0; j < span; j++) {
        // The cell of p on the face, and the cell of q against it.
        const [ax, ay, az] = dx < 0 ? [0, i, j] : dx > 0 ? [E - 1, i, j] : dy < 0 ? [i, 0, j] : dy > 0 ? [i, E - 1, j] : dz < 0 ? [i, j, 0] : [i, j, E - 1];
        const ca = this.compAt(p, ax, ay, az);
        const cb = this.compAt(q, dx === 0 ? ax : E - 1 - ax, dy === 0 ? ay : E - 1 - ay, dz === 0 ? az : E - 1 - az);
        // An open cell against a solid one across the chunk face: a face of the open one's surface.
        if (ca === 0 || cb === 0) {
          if (ca !== 0) p.nodes[ca - 1]!.across[f]! += per;
          else if (cb !== 0) q.nodes[cb - 1]!.across[f ^ 1]! += per;
          continue;
        }
        const na = p.nodes[ca - 1]!;
        const nb = q.nodes[cb - 1]!;
        const set = na.portal === nb.portal ? na.adj : na.links;
        if (set.has(nb)) continue;
        set.add(nb);
        (na.portal === nb.portal ? nb.adj : nb.links).add(na);
        this.contacts += 2;
      }
    }
    const ck = this.columnKey(p.cx, p.cz);
    let col = this.columns.get(ck);
    if (col === undefined) {
      this.columns.set(ck, (col = { pieces: new Map(), sky: new Int16Array(E * E).fill(WORLD_CELL_MIN_Y), sent: false }));
      this.arrayBytes += col.sky.byteLength;
    }
    col.pieces.set(p.cy, p);
    this.dirtyColumns.add(ck);
  }

  /** A chunk column's sky heights again, and which of its pieces' nodes see the sky. */
  private refreshColumn(ck: number): void {
    const col = this.columns.get(ck);
    if (col === undefined) return;
    const E = this.view.grid.edge;
    const before = col.sky.slice();
    col.sky.fill(WORLD_CELL_MIN_Y);
    let any: Piece | null = null;
    for (const p of col.pieces.values()) {
      any = p;
      for (let c = 0; c < E * E; c++) {
        const t = p.top[c]!;
        if (t > 0) col.sky[c] = Math.max(col.sky[c]!, p.cy * E + t);
      }
    }
    if (any !== null && (!col.sent || col.sky.some((h, i) => h !== before[i]))) this.skyChanged.set(ck, [any.cx, any.cz]);
    const se = this.view.sections.edge;
    const per = this.per;
    for (const p of col.pieces.values()) {
      const yb = p.cy * E;
      const seen = new Uint8Array(p.nodes.length + 1);
      if (p.nodes.length === 1) {
        // One component: it sees the sky when any column is open above some cell of the chunk.
        for (let c = 0; c < E * E && seen[1] === 0; c++) if (col.sky[c]! - yb < E) seen[1] = 1;
      } else {
        for (let x = 0; x < E; x++) for (let z = 0; z < E; z++) {
          let y = Math.max(col.sky[x * E + z]! - yb, 0);
          // Read the open run above the sky height unit by unit, straight from the labels.
          while (y < E) {
            const u = sectionIdOf(per, (x / se) | 0, (y / se) | 0, (z / se) | 0);
            const un = p.units[u]!;
            const map = p.maps[u]!;
            const end = (((y / se) | 0) + 1) * se;
            if (un.labels === null) seen[map[un.count]!] = 1;
            else {
              const base = ((x % se) * se + (z % se)) * se - ((y / se) | 0) * se;
              for (; y < end; y++) seen[map[un.labels[base + y]!]!] = 1;
            }
            y = end;
          }
        }
      }
      for (let i = 0; i < p.nodes.length; i++) {
        const nd = p.nodes[i]!;
        const sky = seen[i + 1] === 1;
        nd.sky = sky;
      }
    }
  }

  /**
   * New nodes placed: each joins the regions it touches, the largest of
   * them taking in the others (their nodes move to it, it keeps its id), or
   * starts a region of its own. So a region growing as chunks arrive (the
   * street) is never walked whole. A region whose search after a loss is
   * under way takes the node into the part it touches ({@link attach}); a
   * region taken in with a search of its own hands its seeds over, and the
   * search starts again on the merged region (each part of it still holds a
   * seed: the region it joined was whole, and touches a part of the other).
   */
  private placeFresh(): void {
    for (const n of this.fresh) {
      if (n.dead || n.group !== null) continue;
      let into: Group | null = null;
      const others = new Set<Group>();
      for (const o of n.adj) {
        const og = o.group;
        if (og === null) continue;
        others.add(og);
        if (into === null || og.nodes.length > into.nodes.length) into = og;
      }
      if (into === null) {
        this.place({ id: this.nextId++, portal: n.portal, nodes: [n], info: null, infoAt: -1, portalList: null, boxes: null });
        continue;
      }
      into.nodes.push(n);
      n.group = into;
      let search = this.broken.get(into);
      for (const og of others) {
        if (og === into) continue;
        this.walked += og.nodes.length;
        for (const m of og.nodes) {
          if (m.dead) continue;
          m.group = into;
          into.nodes.push(m);
        }
        if (this.groups.get(og.id) === og) this.groups.delete(og.id);
        const theirs = this.broken.get(og);
        if (theirs !== undefined) {
          this.broken.delete(og);
          if (theirs.state !== null) this.restartSearch(theirs);
          if (search === undefined) this.broken.set(into, (search = { seeds: [], state: null }));
          else this.restartSearch(search);
          search.seeds.push(...theirs.seeds);
        }
      }
      if (search?.state != null) this.attach(search.state, n);
    }
    this.fresh.clear();
  }

  /**
   * A new node of a region whose search is under way, taken by a search that reached a node it touches (it is in
   * that part, and its own neighbours join through it). Touching only nodes not reached yet it waits: the search
   * that reaches them reaches it, or it is in the part still growing. Not a seed: a seed far from the losses (a
   * ring's leading row) would search its way across the region to meet the others.
   */
  private attach(st: SearchState, n: Node): void {
    for (const o of n.adj) {
      const i = st.owner.get(o);
      if (i === undefined) continue;
      st.owner.set(n, i);
      st.queues[i]!.push(n);
      return;
    }
  }

  /** A seed for a region's search: kept, and a search of its own at once if the search is under way. */
  private addSeed(g: Group, search: Search, n: Node): void {
    search.seeds.push(n);
    const st = search.state;
    if (st === null || n.dead || n.group !== g || st.owner.has(n)) return;
    st.owner.set(n, st.queues.length);
    st.parent.push(st.queues.length);
    st.queues.push([n]);
    st.heads.push(0);
  }

  /** A search under way dropped (its work counted as reached): it starts again from every seed still live. */
  private restartSearch(search: Search): void {
    if (search.state === null) return;
    this.walked += search.state.owner.size;
    search.state = null;
  }

  /**
   * A region that lost nodes, split into its parts again. Every part holds a
   * node that touched a lost one (the region was connected before), so one
   * search starts from each such node, and the searches take a node each in
   * turn; two that reach each other's nodes join. A search with nothing left
   * to reach holds a whole part. Once no more than one search can still
   * grow, every node not yet reached is in its part (each part holds a
   * seed): the searches stop there, so a region that did not split costs
   * the nodes round its losses until their searches meet, not a walk of it
   * all. The largest part keeps the id (ties: the part whose first node
   * comes first in the region's list, as a walk of it in order would find
   * them), the others take new ones in that order.
   *
   * One step takes up to {@link SEARCH_NODES} nodes (a unit of the slice);
   * the state carries over between calls. Returns whether the search ended.
   */
  private searchStep(g: Group, search: Search): boolean {
    let st = search.state;
    if (st === null) {
      st = search.state = { owner: new Map(), queues: [], heads: [], parent: [], at: 0, growing: new Set() };
      const live: Node[] = [];
      for (const s of search.seeds) {
        if (s.dead || s.group !== g || st.owner.has(s)) continue;
        live.push(s);
        st.owner.set(s, st.queues.length);
        st.parent.push(st.queues.length);
        st.queues.push([s]);
        st.heads.push(0);
      }
      // Seeds lost since are dropped, so a region losing nodes call after call keeps a short list.
      search.seeds.length = 0;
      search.seeds.push(...live);
    }
    const { owner, queues, heads, parent, growing } = st;
    for (let taken = 0; taken < SEARCH_NODES; ) {
      if (st.at === 0) {
        growing.clear();
        for (let i = 0; i < queues.length; i++) if (heads[i]! < queues[i]!.length) growing.add(findSearch(parent, i));
        if (growing.size <= 1) {
          this.endSearch(g, st);
          return true;
        }
      }
      const i = st.at;
      st.at = i + 1 >= queues.length ? 0 : i + 1;
      if (heads[i]! >= queues[i]!.length) continue;
      const n = queues[i]![heads[i]!++]!;
      taken++;
      this.searched++;
      for (const o of n.adj) {
        if (o.dead || o.group !== g) continue;
        const j = owner.get(o);
        if (j === undefined) {
          owner.set(o, i);
          queues[i]!.push(o);
          continue;
        }
        const a = findSearch(parent, i);
        const b = findSearch(parent, j);
        if (a !== b) parent[b] = a;
      }
    }
    return false;
  }

  /** A search that ended: the region's parts placed (the comment above {@link searchStep}). */
  private endSearch(g: Group, st: SearchState): void {
    this.broken.delete(g);
    const { owner, queues, parent, growing } = st;
    const find = (i: number): number => findSearch(parent, i);
    this.walked += owner.size;
    // The part still growing (if any) holds every node not reached; the others are whole.
    const left = growing.size === 1 ? [...growing][0]! : -1;
    const whole = new Set<number>();
    for (let i = 0; i < queues.length; i++) if (find(i) !== left) whole.add(find(i));
    if (whole.size === 0) {
      // Not split: the lost nodes go, the region keeps its id and its nodes.
      let w = 0;
      for (const n of g.nodes) if (!n.dead) g.nodes[w++] = n;
      g.nodes.length = w;
      g.info = null;
      if (w === 0 && this.groups.get(g.id) === g) this.groups.delete(g.id);
      return;
    }
    // Split: the parts in the order a walk of the region's list would find them, the largest first.
    const parts = new Map<number, { nodes: Node[]; first: number }>();
    let k = 0;
    for (const n of g.nodes) {
      if (n.dead) continue;
      const o = owner.get(n);
      const r = o === undefined ? left : find(o);
      const key = whole.has(r) ? r : left;
      let p = parts.get(key);
      if (p === undefined) parts.set(key, (p = { nodes: [], first: k }));
      p.nodes.push(n);
      k++;
    }
    const order = [...parts.values()].sort((a, b) => b.nodes.length - a.nodes.length || a.first - b.first);
    if (this.groups.get(g.id) === g) this.groups.delete(g.id);
    order.forEach((p, i) => this.place({ id: i === 0 ? g.id : this.nextId++, portal: g.portal, nodes: p.nodes, info: null, infoAt: -1, portalList: null, boxes: null }));
  }

  private place(g: Group): void {
    for (const m of g.nodes) m.group = g;
    this.groups.set(g.id, g);
  }

  private summary(g: Group): OpenRegionInfo {
    if (g.info !== null && g.infoAt === this.version) return g.info;
    let cells = 0;
    let faces = 0;
    let sky = false;
    let unknown = false;
    let edge = false;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const other = new Set<number>();
    this.summaries++;
    for (const n of g.nodes) {
      // A region under search still lists the nodes it lost until the search ends.
      if (n.dead) continue;
      cells += n.cells;
      faces += n.inner + n.across[0]! + n.across[1]! + n.across[2]! + n.across[3]! + n.across[4]! + n.across[5]!;
      for (let k = 0; k < 3; k++) {
        if (n.min[k]! < min[k]!) min[k] = n.min[k]!;
        if (n.max[k]! > max[k]!) max[k] = n.max[k]!;
      }
      sky ||= n.sky;
      unknown ||= (n.faces & ~n.piece.known) !== 0;
      edge ||= (n.faces & n.piece.outside) !== 0;
      for (const o of n.links) if (o.group !== null) other.add(o.group.id);
    }
    // A region whose search is under way may be in parts already: not known whole, so never complete or enclosed yet.
    if (this.broken.has(g)) unknown = true;
    const info: OpenRegionInfo = Object.freeze({ id: g.id, portal: g.portal, cells, sky, complete: !unknown, enclosed: !g.portal && !unknown && !sky && !edge, portals: other.size, min: Object.freeze(min), max: Object.freeze(max), faces });
    g.info = info;
    g.infoAt = this.version;
    g.portalList = null;
    g.boxes = null;
    return info;
  }

  private nodeAt(x: number, y: number, z: number): Node | null {
    const g = this.view.grid;
    const p = this.pieces.get(chunkKey(g, x >> g.shift, y >> g.shift, z >> g.shift));
    if (p === undefined) return null;
    const c = this.compAt(p, x & g.mask, y & g.mask, z & g.mask);
    return c === 0 ? null : p.nodes[c - 1]!;
  }

  /** The region or portal holding cell (x, y, z) (null: a solid cell, or its chunk not stitched yet). */
  regionAt(x: number, y: number, z: number): OpenRegionInfo | null {
    const n = this.nodeAt(x, y, z);
    return n === null || n.group === null ? null : this.summary(n.group);
  }

  /** The id of the region or portal holding a cell (0: solid or not known): what a light store compares to stop leaks. */
  regionIdAt(x: number, y: number, z: number): number {
    return this.nodeAt(x, y, z)?.group?.id ?? 0;
  }

  /** A region or portal by id (null: no longer there). */
  region(id: number): OpenRegionInfo | null {
    const g = this.groups.get(id);
    return g === undefined ? null : this.summary(g);
  }

  /**
   * The portals on a region's boundary, or a portal itself, with their extents and the regions they join: read once
   * after each change that moved anything (with the region's summary), then as kept.
   */
  portalsOf(id: number): readonly OpenPortalInfo[] {
    const g = this.groups.get(id);
    if (g === undefined) return [];
    this.summary(g);
    return (g.portalList ??= this.readPortals(g));
  }

  /**
   * The boxes of a region's parts (world cells, inclusive), one a chunk it reaches: what a view cutting or thinning a
   * room's shell reads, read once after each change that moved anything, then as kept.
   */
  boxesOf(id: number): readonly OpenRegionBox[] {
    const g = this.groups.get(id);
    if (g === undefined) return [];
    this.summary(g);
    return (g.boxes ??= g.nodes.filter((n) => !n.dead).map((n) => Object.freeze([n.min[0], n.min[1], n.min[2], n.max[0], n.max[1], n.max[2]] as const)));
  }

  private readPortals(g: Group): OpenPortalInfo[] {
    const portals = new Set<Group>();
    if (g.portal) portals.add(g);
    else for (const n of g.nodes) if (!n.dead) for (const o of n.links) if (o.group !== null) portals.add(o.group);
    return [...portals].map((p) => {
      const min: [number, number, number] = [Infinity, Infinity, Infinity];
      const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      const regions = new Set<number>();
      let cells = 0;
      for (const n of p.nodes) {
        if (n.dead) continue;
        cells += n.cells;
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k]!, n.min[k]!);
          max[k] = Math.max(max[k]!, n.max[k]!);
        }
        for (const o of n.links) if (o.group !== null) regions.add(o.group.id);
      }
      return Object.freeze({ id: p.id, min: Object.freeze(min), max: Object.freeze(max), cells, regions: Object.freeze([...regions].sort((a, b) => a - b)) });
    });
  }

  /**
   * The sky height of world column (x, z): the highest solid cell + 1 over
   * the stitched chunks (WORLD_CELL_MIN_Y when none is solid); null when no
   * chunk of the column is stitched.
   */
  skyHeight(x: number, z: number): number | null {
    const g = this.view.grid;
    const col = this.columns.get(this.columnKey(x >> g.shift, z >> g.shift));
    return col === undefined ? null : col.sky[(x & g.mask) * g.edge + (z & g.mask)]!;
  }

  /** Whether cell (x, y, z) is under open sky (null: its column is not known). */
  skyAt(x: number, y: number, z: number): boolean | null {
    const h = this.skyHeight(x, z);
    return h === null ? null : y >= h;
  }

  /** A chunk column's sky heights (E² values, x · E + z), or null: what a page's sky texture is made of. */
  columnSky(cx: number, cz: number): Int16Array | null {
    return this.columns.get(this.columnKey(cx, cz))?.sky ?? null;
  }

  /**
   * The faces an overlay tints in chunks `min`–`max` (inclusive): each face between a cell of an enclosed region
   * (`enclosed`), of a region not complete and not under sky (`unknown`), or of a portal (`portal`), and a cell
   * outside it: a solid cell for a region (its surfaces), anything but the portal for a portal. `face` is the
   * neighbour's direction (0 −x, 1 +x, 2 −y, 3 +y, 4 −z, 5 +z); cells are world cells.
   */
  tintFaces(min: readonly [number, number, number], max: readonly [number, number, number], emit: (x: number, y: number, z: number, face: number, id: number, kind: 'enclosed' | 'unknown' | 'portal') => void): void {
    const g = this.view.grid;
    const E = g.edge;
    for (const p of this.pieces.values()) {
      if (p.cx < min[0] || p.cy < min[1] || p.cz < min[2] || p.cx > max[0] || p.cy > max[1] || p.cz > max[2]) continue;
      const kinds = p.nodes.map((n) => {
        if (n.group === null) return null;
        const r = this.summary(n.group);
        return r.portal ? 'portal' : r.enclosed ? 'enclosed' : !r.complete && !r.sky ? 'unknown' : null;
      });
      if (kinds.every((k) => k === null)) continue;
      const ox = p.cx * E;
      const oy = p.cy * E;
      const oz = p.cz * E;
      for (let x = 0; x < E; x++) for (let z = 0; z < E; z++) for (let y = 0; y < E; y++) {
        const c = this.compAt(p, x, y, z);
        if (c === 0) continue;
        const kind = kinds[c - 1]!;
        if (kind === null) continue;
        const node = p.nodes[c - 1]!;
        for (let f = 0; f < 6; f++) {
          const [dx, dy, dz] = FACES[f]!;
          const nx = x + dx;
          const ny = y + dy;
          const nz = z + dz;
          const inside = nx >= 0 && ny >= 0 && nz >= 0 && nx < E && ny < E && nz < E;
          const other = inside ? (this.compAt(p, nx, ny, nz) === 0 ? null : p.nodes[this.compAt(p, nx, ny, nz) - 1]!) : this.nodeAt(ox + nx, oy + ny, oz + nz);
          const solid = inside ? other === null : other === null && this.pieces.has(chunkKey(g, (ox + nx) >> g.shift, (oy + ny) >> g.shift, (oz + nz) >> g.shift));
          if (kind === 'portal' ? other?.group !== node.group : solid) emit(ox + x, oy + y, oz + z, f, node.group!.id, kind);
        }
      }
    }
  }

  /** Calls `f` after every update that had work to do (regions may have changed: a reader of the summaries reads them again). */
  onUpdate(f: () => void): void {
    this.updateListeners.push(f);
  }

  /** Calls `f` after an update that changed some chunk column's sky heights ({@link takeSky} has them). */
  onSky(f: () => void): void {
    this.skyListeners.push(f);
  }

  /** The chunk columns whose sky heights changed or went since the last call, as wires (copies of the heights). */
  takeSky(): SkyColumnWire[] {
    const out: SkyColumnWire[] = [];
    for (const [ck, [cx, cz]] of this.skyChanged) {
      const col = this.columns.get(ck);
      if (col !== undefined) col.sent = true;
      out.push(col === undefined ? { cx, cz } : { cx, cz, heights: col.sky.slice() });
    }
    this.skyChanged.clear();
    return out;
  }

  /** Every region and portal (summaries), for reports and overlays. */
  *all(): IterableIterator<OpenRegionInfo> {
    for (const g of this.groups.values()) yield this.summary(g);
  }

  stats(): OpenRegionStats {
    let regions = 0;
    let enclosed = 0;
    let portals = 0;
    for (const r of this.all()) {
      if (r.portal) portals++;
      else {
        regions++;
        if (r.enclosed) enclosed++;
      }
    }
    return { pieces: this.pieces.size, nodes: this.nodeCount, regions, enclosed, portals, built: this.built, walked: this.walked, searched: this.searched, columns: this.columnsDone, searching: this.broken.size, summaries: this.summaries };
  }

  /** Bytes held (the pieces' maps and tops, the columns' sky heights, and an estimate per node and contact). */
  get bytes(): number {
    return this.arrayBytes + this.nodeCount * NODE_BYTES + this.contacts * CONTACT_BYTES;
  }

  /** Changes so far (a reader compares it to see whether anything moved). */
  get changes(): number {
    return this.version;
  }

  clear(): void {
    this.pieces.clear();
    this.columns.clear();
    this.groups.clear();
    this.dirty.clear();
    this.broken.clear();
    this.fresh.clear();
    this.dirtyColumns.clear();
    this.skyChanged.clear();
    this.nodeCount = 0;
    this.contacts = 0;
    this.arrayBytes = 0;
    this.version++;
  }
}

/** Whether two units' regions are the same (labels, facts, contacts, sky). */
function sameRegions(a: OpenRegionsOut, b: OpenRegionsOut): boolean {
  if (a === b) return true;
  if (a.count !== b.count || a.connect !== b.connect || a.skyUniform !== b.skyUniform || (a.labels === null) !== (b.labels === null) || (a.sky === null) !== (b.sky === null)) return false;
  const x = openRegionsArrays(a);
  const y = openRegionsArrays(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    const p = x[i]!;
    const q = y[i]!;
    if (p.byteLength !== q.byteLength || p.constructor !== q.constructor) return false;
    const u = new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
    const v = new Uint8Array(q.buffer, q.byteOffset, q.byteLength);
    for (let k = 0; k < u.length; k++) if (u[k] !== v[k]) return false;
  }
  return true;
}

/** Per thread: the chunk's cells' components while a piece is made (a chunk's cells, reused). */
let compCells = new Uint16Array(0);

function compScratch(n: number): Uint16Array {
  if (compCells.length < n) compCells = new Uint16Array(n);
  return compCells;
}

/** One cell face between components `a` and `b` (0: solid): a face of the open one's when the other is solid. */
function countFace(nodes: readonly Node[], a: number, b: number): void {
  if (a === 0 && b !== 0) nodes[b - 1]!.inner++;
  else if (b === 0 && a !== 0) nodes[a - 1]!.inner++;
}

function pieceBytes(p: Piece): number {
  if (p.uniform >= 0) return 0;
  let n = p.top.byteLength;
  for (const m of p.maps) n += m.byteLength;
  return n;
}
