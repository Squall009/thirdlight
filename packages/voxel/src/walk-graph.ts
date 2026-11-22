/**
 * The walk graph of a world where it runs: each storage chunk's part
 * (walk-graph-cells.ts: its standable cells and their pieces) made from its
 * results' navigation, and the chunks' parts joined across their faces, kept
 * up to date as chunks arrive, change and leave. Never stored.
 *
 * - **Two levels.** The cells and their steps (the path's level), and over
 *   them the pieces: a chunk's cells joined inside it. Where steps cross
 *   from one chunk's piece into another's, they are grouped into **exits**:
 *   runs of crossing steps side by side between the same two pieces, an exit
 *   at a short run's middle, at both ends and the middle of a long one (more
 *   than six cells). An exit goes one way (each crossing makes a pair). A
 *   long path is searched over exits first (walk-graph-queries.ts), then over the
 *   cells of the pieces on that route.
 * - **Rebuilt where it changed.** A chunk whose results changed is made
 *   again; one that comes out the same (a neighbour landing, a change that
 *   moved no standable cell) stands, and nothing round it is touched. A
 *   chunk made again, arrived or gone has its crossings with the chunks its
 *   steps reach recomputed; the chunk below it is made again when its
 *   clearance read into it. So a one-cell edit makes again the chunk it is in
 *   (and the one beside or below it where it changes their cells).
 * - **Unknown is not unreachable.** A chunk without results (not resident,
 *   or not derived yet) is not known: a piece whose steps may go into one is
 *   on the **frontier**, and a search that runs out of graph there answers
 *   "unknown beyond here", never "unreachable".
 * - **In slices.** Making chunks and their crossings counts against the
 *   caller's slice a chunk at a time; what is left carries over.
 */
import { chunkInWorld, chunkKeyOrNone, type CellGrid, type ChunkGrid } from './coords';
import { OCCUPANCY } from './derived-data';
import { DEFAULT_WALK_AGENT, NO_WALK_PIECE, buildWalkChunk, sameWalkChunk, walkChunkBytes, WalkStepper, type ChunkNavReader, type WalkChunk, type WalkChunkLookup } from './walk-graph-cells';
import type { DeriveOutput } from './stream-job';
import { stampedNav, type WalkStampsUse } from './walk-graph-stamp';

/** What the walk graph reads of a streamer (the open regions' view). */
export interface WalkGraphView {
  readonly grid: ChunkGrid;
  readonly sections: CellGrid;
  derivedOf(sx: number, sy: number, sz: number, drawn?: boolean): DeriveOutput | null;
}

/** A run of crossing steps from one chunk's piece into another's, as one way across. */
export interface WalkExit {
  /** Its id in the graph (stable until it goes; reused only once no search can hold it). */
  readonly id: number;
  readonly from: WalkChunk;
  readonly fromPiece: number;
  /** The cell it leaves from (in `from`) and the one it lands on (in `to`). */
  readonly a: number;
  readonly to: WalkChunk;
  readonly toPiece: number;
  readonly b: number;
  /** The step's cost (metres). */
  readonly cost: number;
  alive: boolean;
  /** Its landing piece's costs from `b` to each of that piece's exits (in {@link WalkGraph.exitsOf}'s order), once worked out. */
  dists: Float64Array | null;
  /** The landing chunk's links version the costs were worked out at. */
  distsAt: number;
}

/** The chunks a step can reach from a chunk: the four beside it, above and below, and those beside it one up or down. */
export const WALK_GRAPH_NEIGHBOURS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0],
  [1, 1, 0], [-1, -1, 0], [-1, 1, 0], [1, -1, 0], [0, 1, 1], [0, -1, -1], [0, 1, -1], [0, -1, 1],
];
/** Each neighbour's opposite (pairs side by side in the list). */
const opposite = (d: number): number => d ^ 1;

/** A chunk's links to the chunks round it. */
interface Links {
  /** Exits toward each neighbour ({@link WALK_GRAPH_NEIGHBOURS} order). */
  readonly out: WalkExit[][];
  /** Cells whose steps may go into each neighbour not known yet. */
  readonly frontier: number[][];
  /** Bumped whenever its exits or frontier change. */
  version: number;
  /** Per piece: its exits (every neighbour's), read at `piecesAt`. */
  pieceExits: WalkExit[][] | null;
  pieceFrontier: number[][] | null;
  piecesAt: number;
}

/** Counts over the graph (what the measurements report). */
export interface WalkGraphStats {
  readonly chunks: number;
  readonly cells: number;
  readonly pieces: number;
  readonly exits: number;
  readonly frontierPieces: number;
  /** Chunks made that changed the graph, made and found the same, crossings recomputed (a chunk's), since the start. */
  readonly built: number;
  readonly kept: number;
  readonly paired: number;
  /** Milliseconds spent making chunks, and on crossings. */
  readonly buildMs: number;
  readonly pairMs: number;
}

/** Most crossing steps one exit stands for before a run is given exits at its ends (cells). */
const EXIT_RUN = 6;

/** The world's walk graph over a streamer's level-0 results (the module comment). */
export class WalkGraph {
  private readonly chunks = new Map<number, WalkChunk>();
  private readonly links = new Map<WalkChunk, Links>();
  private readonly dirty = new Map<number, readonly [number, number, number]>();
  private readonly dirtyPairs = new Set<WalkChunk>();
  private readonly exitById: (WalkExit | null)[] = [];
  private readonly freeIds: number[] = [];
  /** Ids of exits gone while a search may still hold them: free once no search runs ({@link releaseIds}). */
  private readonly retiredIds: number[] = [];
  private readonly stepper: WalkStepper;
  private exitCount = 0;
  private cellCount = 0;
  private pieceCount = 0;
  private partBytes = 0;
  private built = 0;
  private kept = 0;
  private paired = 0;
  private buildMs = 0;
  private pairMs = 0;
  private turn = 0;
  private readonly per: number;
  /** Bumped by every change of a part or an exit. */
  private changes = 0;
  /** Chunk-key reads as the stepper asks (known part, null: nothing stands / outside the world, undefined: not known). */
  readonly lookup: WalkChunkLookup;

  constructor(
    private readonly view: WalkGraphView,
    /** Metres a cell. */
    readonly cellM: number,
    /** Structure grids stamped into the world grid (prop-channel.ts `rooms`): their stops block the world's walker (walk-graph-stamp.ts). */
    private readonly stamps: WalkStampsUse | null = null,
  ) {
    this.per = view.grid.edge / view.sections.edge;
    this.stepper = new WalkStepper(cellM);
    const g = view.grid;
    this.lookup = (cx, cy, cz) => {
      const k = chunkKeyOrNone(g, cx, cy, cz);
      return k < 0 ? null : this.chunks.get(k);
    };
  }

  get grid(): ChunkGrid {
    return this.view.grid;
  }

  /** A chunk whose level-0 results changed (not shader- or relief-only), arrived or left. */
  touch(cx: number, cy: number, cz: number): void {
    const k = chunkKeyOrNone(this.view.grid, cx, cy, cz);
    if (k >= 0) this.dirty.set(k, [cx, cy, cz]);
  }

  /**
   * A chunk's structure classes changed: it is made again, and the chunk over it (a floor stamped in this one's top
   * layer supports the cells over it there). The chunk under it follows when its clearance read into this one.
   */
  touchStamp(cx: number, cy: number, cz: number): void {
    this.touch(cx, cy, cz);
    if (this.chunks.has(chunkKeyOrNone(this.view.grid, cx, cy + 1, cz))) this.touch(cx, cy + 1, cz);
  }

  /** Chunks to make or crossings to recompute wait. */
  get pending(): boolean {
    return this.dirty.size > 0 || this.dirtyPairs.size > 0;
  }

  /** Bumped by every change a search could have read (a part or an exit made or gone). */
  get version(): number {
    return this.changes;
  }

  /**
   * Makes the chunks touched and recomputes the crossings of those that changed, within `ms`: the clock is read
   * before each unit after a call's first (one chunk made, or one chunk's crossings), so a call passes the slice by at
   * most one unit; the rest waits. The first unit goes to each stage in turn. Returns the units done.
   */
  update(ms = Infinity): number {
    if (!this.pending) return 0;
    const t0 = performance.now();
    let units = 0;
    const go = (): boolean => units === 0 || performance.now() - t0 < ms;
    const start = this.turn;
    this.turn ^= 1;
    for (let k = 0; this.pending && (k < 2 || go()); k++) {
      if (((start + k) & 1) === 0) {
        for (const [key, [cx, cy, cz]] of this.dirty) {
          if (!go()) break;
          this.dirty.delete(key);
          const t = performance.now();
          this.remake(key, cx, cy, cz);
          this.buildMs += performance.now() - t;
          units++;
        }
      } else {
        for (const c of this.dirtyPairs) {
          if (!go()) break;
          this.dirtyPairs.delete(c);
          if (!c.alive) continue;
          const t = performance.now();
          // A neighbour whose own crossings are still to recompute makes this pair when its turn comes.
          for (let d = 0; d < WALK_GRAPH_NEIGHBOURS.length; d++) if (!this.pairWaits(c, d)) this.pairEither(c, d);
          this.pairMs += performance.now() - t;
          this.paired++;
          units++;
        }
      }
    }
    return units;
  }

  private pairWaits(c: WalkChunk, d: number): boolean {
    const [dx, dy, dz] = WALK_GRAPH_NEIGHBOURS[d]!;
    const n = this.chunks.get(chunkKeyOrNone(this.view.grid, c.cx + dx, c.cy + dy, c.cz + dz));
    return n !== undefined && this.dirtyPairs.has(n);
  }

  /** A chunk's part made again from its results (or dropped when it has none), its neighbours told. */
  private remake(key: number, cx: number, cy: number, cz: number): void {
    const old = this.chunks.get(key);
    const next = this.make(key, cx, cy, cz);
    if (old !== undefined && next !== null && sameWalkChunk(old, next)) {
      this.kept++;
      return;
    }
    if (old !== undefined) this.drop(old);
    this.onPart?.(cx, cy, cz);
    if (next !== null) {
      this.chunks.set(key, next);
      this.links.set(next, { out: WALK_GRAPH_NEIGHBOURS.map(() => []), frontier: WALK_GRAPH_NEIGHBOURS.map(() => []), version: 0, pieceExits: null, pieceFrontier: null, piecesAt: -1 });
      this.cellCount += next.ys.length;
      this.pieceCount += next.pieces.length;
      this.partBytes += walkChunkBytes(next);
      this.built++;
      this.changes++;
      this.dirtyPairs.add(next);
    }
    // Its neighbours' crossings into it (or their frontier toward it, once gone).
    const g = this.view.grid;
    for (const [dx, dy, dz] of WALK_GRAPH_NEIGHBOURS) {
      const n = this.chunks.get(chunkKeyOrNone(g, cx + dx, cy + dy, cz + dz));
      if (n !== undefined) this.dirtyPairs.add(n);
    }
    // The chunk below read its clearance into this one.
    const below = this.chunks.get(chunkKeyOrNone(g, cx, cy - 1, cz));
    if (below !== undefined && (below.dependsAbove || !below.aboveKnown)) this.dirty.set(below.key, [cx, cy - 1, cz]);
  }

  /** A chunk's part from its sections' drawn results (null: some section has none: not known). */
  private make(key: number, cx: number, cy: number, cz: number): WalkChunk | null {
    const g = this.view.grid;
    if (!chunkInWorld(g, cx, cy, cz)) return null;
    const per = this.per;
    const se = this.view.sections.edge;
    for (let sx = 0; sx < per; sx++) for (let sz = 0; sz < per; sz++) for (let sy = 0; sy < per; sy++) if (this.view.derivedOf(cx * per + sx, cy * per + sy, cz * per + sz, true) === null) return null;
    const use = this.stamps;
    const stamps = use?.stamps ?? null;
    const supports = use?.supports === true;
    const nav: ChunkNavReader = (sx, sy, sz) => {
      const r = this.view.derivedOf(cx * per + sx, cy * per + sy, cz * per + sz, true);
      if (r === null) return chunkInWorld(g, cx, cy + ((sy / per) | 0), cz) ? undefined : null;
      const own = r.assembly === null ? null : r.assembly.nav;
      if (stamps === null) return own;
      const qy = cy + ((sy / per) | 0);
      const ly = sy % per;
      return stampedNav(own, stamps.rooms(cx, qy, cz), supports && ly === 0 ? stamps.rooms(cx, qy - 1, cz) : null, sx * se, ly * se, sz * se, g.shift, se, supports);
    };
    const t = performance.now();
    const part = buildWalkChunk(cx, cy, cz, key, g.edge, se, nav);
    this.lastBuildMs = performance.now() - t;
    return part;
  }

  /** The last chunk made's own time (ms; the bench reads it a chunk at a time). */
  lastBuildMs = 0;

  /** Hears of every chunk whose part was made anew or dropped (a part that came out the same is not told): the links' cue. */
  onPart: ((cx: number, cy: number, cz: number) => void) | null = null;

  private drop(c: WalkChunk): void {
    c.alive = false;
    this.changes++;
    this.chunks.delete(c.key);
    const l = this.links.get(c)!;
    for (let d = 0; d < WALK_GRAPH_NEIGHBOURS.length; d++) {
      this.kill(l.out[d]!);
      const [dx, dy, dz] = WALK_GRAPH_NEIGHBOURS[d]!;
      const n = this.chunks.get(chunkKeyOrNone(this.view.grid, c.cx + dx, c.cy + dy, c.cz + dz));
      if (n === undefined) continue;
      const nl = this.links.get(n)!;
      this.kill(nl.out[opposite(d)]!);
      nl.out[opposite(d)] = [];
      nl.version++;
    }
    this.links.delete(c);
    this.dirtyPairs.delete(c);
    this.cellCount -= c.ys.length;
    this.pieceCount -= c.pieces.length;
    this.partBytes -= walkChunkBytes(c);
  }

  private kill(exits: readonly WalkExit[]): void {
    for (const e of exits) {
      if (!e.alive) continue;
      e.alive = false;
      this.exitById[e.id] = null;
      this.retiredIds.push(e.id);
      this.exitCount--;
    }
    if (exits.length > 0) this.changes++;
  }

  /** Exit ids gone are free again (called when no search holds one). */
  releaseIds(): void {
    if (this.retiredIds.length === 0) return;
    // One at a time: a ring streaming while queries wait retires tens of thousands, past what a spread's arguments hold.
    for (const id of this.retiredIds) this.freeIds.push(id);
    this.retiredIds.length = 0;
  }

  /**
   * A pair's crossings made from the side of the chunk with the smaller key (its runs grouped by its cells), so the
   * exits are the same whichever of the two changed and in whatever order they arrived.
   */
  private pairEither(c: WalkChunk, d: number): void {
    const [dx, dy, dz] = WALK_GRAPH_NEIGHBOURS[d]!;
    const n = this.chunks.get(chunkKeyOrNone(this.view.grid, c.cx + dx, c.cy + dy, c.cz + dz));
    if (n !== undefined && n.key < c.key && n.ys.length > 0) this.pair(n, opposite(d));
    else this.pair(c, d);
  }

  /**
   * The crossings between a chunk and its neighbour `d`: its exits into it and the neighbour's back, made again from
   * the chunk's border cells' steps; with the neighbour not known, the chunk's cells whose steps may go there.
   */
  private pair(c: WalkChunk, d: number): void {
    const l = this.links.get(c)!;
    const [dx, dy, dz] = WALK_GRAPH_NEIGHBOURS[d]!;
    const g = this.view.grid;
    const nk = chunkKeyOrNone(g, c.cx + dx, c.cy + dy, c.cz + dz);
    const n = nk < 0 ? null : this.chunks.get(nk);
    this.kill(l.out[d]!);
    l.out[d] = [];
    l.frontier[d] = [];
    l.version++;
    if (c.ys.length === 0) return;
    const nl = n != null ? this.links.get(n)! : null;
    if (nl !== null) {
      this.kill(nl.out[opposite(d)]!);
      nl.out[opposite(d)] = [];
      nl.frontier[opposite(d)] = [];
      nl.version++;
    }
    // Outside the world, or a known chunk where nothing stands: no step lands there.
    if (n === null || (n !== undefined && n.ys.length === 0)) return;
    const e = c.edge;
    const ly0 = dy > 0 ? e - 1 : 0;
    // Only cells on the faces the neighbour lies across can step into it: the columns of that side (or every column for
    // the chunk above or below), and of them the top or bottom layer for a neighbour above or below.
    const cols: number[] = [];
    if (dx !== 0 && dz === 0) for (let z = 0; z < e; z++) cols.push((dx > 0 ? e - 1 : 0) * e + z);
    else if (dz !== 0 && dx === 0) for (let x = 0; x < e; x++) cols.push(x * e + (dz > 0 ? e - 1 : 0));
    else for (let k = 0; k < e * e; k++) cols.push(k);
    const each = (f: (i: number) => void): void => {
      for (const col of cols) {
        const end = c.colStart[col + 1]!;
        for (let i = c.colStart[col]!; i < end; i++) if (c.piece[i] !== NO_WALK_PIECE && (dy === 0 || c.ys[i] === ly0)) f(i);
      }
    };
    if (n === undefined) {
      // Not known: the cells that may step there.
      const look: WalkChunkLookup = (x, y, z) => (x === c.cx + dx && y === c.cy + dy && z === c.cz + dz ? undefined : null);
      const cells: number[] = [];
      const none = (): void => undefined;
      each((i) => {
        this.stepper.steps(look, c, i, DEFAULT_WALK_AGENT, none);
        if (this.stepper.unknown) cells.push(i);
      });
      l.frontier[d] = cells;
      return;
    }
    const look: WalkChunkLookup = (x, y, z) => (x === n.cx && y === n.cy && z === n.cz ? n : null);
    const from: number[] = [];
    const to: number[] = [];
    const cost: number[] = [];
    let at = 0;
    const sink = (t: WalkChunk, j: number, k: number): void => {
      if (t !== n) return;
      from.push(at);
      to.push(j);
      cost.push(k);
    };
    each((i) => {
      at = i;
      this.stepper.steps(look, c, i, DEFAULT_WALK_AGENT, sink);
    });
    if (from.length === 0) return;
    const [outs, backs] = this.exitsOfCrossings(c, n, from, to, cost);
    l.out[d] = outs;
    nl!.out[opposite(d)] = backs;
  }

  /** Crossing steps grouped by the pieces they join and into runs of cells side by side, each run's exits both ways. */
  private exitsOfCrossings(c: WalkChunk, n: WalkChunk, from: number[], to: number[], cost: number[]): [WalkExit[], WalkExit[]] {
    const groups = new Map<number, number[]>();
    for (let k = 0; k < from.length; k++) {
      const key = c.piece[from[k]!]! * 65536 + n.piece[to[k]!]!;
      let list = groups.get(key);
      if (list === undefined) groups.set(key, (list = []));
      list.push(k);
    }
    const outs: WalkExit[] = [];
    const backs: WalkExit[] = [];
    const e = c.edge;
    for (const list of groups.values()) {
      // Runs: crossings whose starting cells touch (by a face, an edge or a corner) are one run.
      const at = new Map<number, number>();
      const pos = list.map((k) => {
        const i = from[k]!;
        const colI = c.col[i]!;
        return [(colI / e) | 0, c.ys[i]!, colI % e] as const;
      });
      pos.forEach((p, m) => at.set((p[0] * e + p[2]) * e + p[1], m));
      const parent = list.map((_, m) => m);
      const find = (m: number): number => {
        while (parent[m] !== m) m = parent[m] = parent[parent[m]!]!;
        return m;
      };
      pos.forEach(([x, y, z], m) => {
        for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) {
          if (x + ox < 0 || x + ox >= e || y + oy < 0 || y + oy >= e || z + oz < 0 || z + oz >= e) continue;
          const o = at.get(((x + ox) * e + z + oz) * e + y + oy);
          if (o !== undefined) parent[find(o)] = find(m);
        }
      });
      const runs = new Map<number, number[]>();
      for (let m = 0; m < list.length; m++) {
        const r = find(m);
        let run = runs.get(r);
        if (run === undefined) runs.set(r, (run = []));
        run.push(m);
      }
      for (const run of runs.values()) {
        for (const m of repsOfRun(run, pos)) {
          const k = list[m]!;
          outs.push(this.newExit(c, from[k]!, n, to[k]!, cost[k]!));
          backs.push(this.newExit(n, to[k]!, c, from[k]!, cost[k]!));
        }
      }
    }
    return [outs, backs];
  }

  private newExit(from: WalkChunk, a: number, to: WalkChunk, b: number, cost: number): WalkExit {
    const id = this.freeIds.pop() ?? this.exitById.length;
    const x: WalkExit = { id, from, fromPiece: from.piece[a]!, a, to, toPiece: to.piece[b]!, b, cost, alive: true, dists: null, distsAt: -1 };
    this.exitById[id] = x;
    this.exitCount++;
    this.changes++;
    return x;
  }

  /** Whether a cell (its grid's cells) blocks a walker by its derived navigation, as the parts are made (undefined: not known). */
  blocks(x: number, y: number, z: number): boolean | undefined {
    const se = this.view.sections;
    const e = se.edge;
    const r = this.view.derivedOf(Math.floor(x / e), Math.floor(y / e), Math.floor(z / e), true);
    if (r === null) return undefined;
    const nav = r.assembly?.nav ?? null;
    if (nav === null || nav.blocking === OCCUPANCY.empty) return false;
    if (nav.blocking === OCCUPANCY.solid) return true;
    const lx = x - Math.floor(x / e) * e;
    const ly = y - Math.floor(y / e) * e;
    const lz = z - Math.floor(z / e) * e;
    const i = (lx * e + lz) * e + ly;
    return ((nav.blocks![i >>> 5]! >>> (i & 31)) & 1) === 1;
  }

  /** A known chunk's part (null: not known). */
  chunkAt(cx: number, cy: number, cz: number): WalkChunk | null {
    return this.chunks.get(chunkKeyOrNone(this.view.grid, cx, cy, cz)) ?? null;
  }

  /** Whether a chunk is known (its part made), or outside the world. */
  known(cx: number, cy: number, cz: number): boolean {
    return !chunkInWorld(this.view.grid, cx, cy, cz) || this.chunks.has(chunkKeyOrNone(this.view.grid, cx, cy, cz));
  }

  /** An exit by id (null: gone). */
  exit(id: number): WalkExit | null {
    return this.exitById[id] ?? null;
  }

  /** One more than the largest exit id given out. */
  get exitIds(): number {
    return this.exitById.length;
  }

  /** A piece's exits into every neighbour, in a stable order while its chunk's links do not change. */
  exitsOf(c: WalkChunk, piece: number): readonly WalkExit[] {
    return this.pieceLists(c)?.[0][piece] ?? [];
  }

  /** A piece's cells whose steps may go where nothing is known (the frontier). */
  frontierOf(c: WalkChunk, piece: number): readonly number[] {
    return this.pieceLists(c)?.[1][piece] ?? [];
  }

  /** A chunk's links version (bumped when its exits or frontier change). */
  linksVersion(c: WalkChunk): number {
    return this.links.get(c)?.version ?? -1;
  }

  private pieceLists(c: WalkChunk): [WalkExit[][], number[][]] | null {
    const l = this.links.get(c);
    if (l === undefined) return null;
    if (l.piecesAt !== l.version || l.pieceExits === null || l.pieceFrontier === null) {
      const ex: WalkExit[][] = c.pieces.map(() => []);
      const fr: number[][] = c.pieces.map(() => []);
      for (const list of l.out) for (const x of list) ex[x.fromPiece]!.push(x);
      for (const list of l.frontier) for (const i of list) fr[c.piece[i]!]!.push(i);
      l.pieceExits = ex;
      l.pieceFrontier = fr;
      l.piecesAt = l.version;
    }
    return [l.pieceExits, l.pieceFrontier];
  }

  /** Every known chunk's part. */
  parts(): IterableIterator<WalkChunk> {
    return this.chunks.values();
  }

  /** The graph's sizes and times without walking its links (what a summary over many graphs reads each frame). */
  counts(): Omit<WalkGraphStats, 'frontierPieces'> {
    return { chunks: this.chunks.size, cells: this.cellCount, pieces: this.pieceCount, exits: this.exitCount, built: this.built, kept: this.kept, paired: this.paired, buildMs: this.buildMs, pairMs: this.pairMs };
  }

  stats(): WalkGraphStats {
    let frontierPieces = 0;
    for (const c of this.chunks.values()) {
      const fr = this.pieceLists(c)?.[1];
      if (fr !== undefined) for (const f of fr) if (f.length > 0) frontierPieces++;
    }
    return { chunks: this.chunks.size, cells: this.cellCount, pieces: this.pieceCount, exits: this.exitCount, frontierPieces, built: this.built, kept: this.kept, paired: this.paired, buildMs: this.buildMs, pairMs: this.pairMs };
  }

  /** Bytes held: the parts' arrays, the exits (about 120 bytes each with their worked-out costs) and the links. */
  get bytes(): number {
    let dists = 0;
    for (const x of this.exitById) if (x !== null && x.dists !== null) dists += x.dists.byteLength;
    return this.partBytes + this.exitCount * 120 + dists + this.links.size * (WALK_GRAPH_NEIGHBOURS.length * 2 * 16 + 64) + this.exitById.length * 8;
  }

  clear(): void {
    for (const c of this.chunks.values()) {
      c.alive = false;
      this.onPart?.(c.cx, c.cy, c.cz);
    }
    this.chunks.clear();
    this.links.clear();
    this.dirty.clear();
    this.dirtyPairs.clear();
    this.exitById.length = 0;
    this.freeIds.length = 0;
    this.retiredIds.length = 0;
    this.exitCount = 0;
    this.cellCount = 0;
    this.pieceCount = 0;
    this.partBytes = 0;
    this.changes++;
  }
}

/** The exits a run of crossings gets: its middle one; with more than {@link EXIT_RUN}, its two ends as well. */
function repsOfRun(run: readonly number[], pos: readonly (readonly [number, number, number])[]): number[] {
  const mean = [0, 0, 0];
  for (const m of run) for (let a = 0; a < 3; a++) mean[a]! += pos[m]![a]! / run.length;
  const d2 = (m: number, p: readonly number[]): number => (pos[m]![0] - p[0]!) ** 2 + (pos[m]![1] - p[1]!) ** 2 + (pos[m]![2] - p[2]!) ** 2;
  const nearest = (p: readonly number[]): number => run.reduce((b, m) => (d2(m, p) < d2(b, p) ? m : b), run[0]!);
  const farthest = (p: readonly number[]): number => run.reduce((b, m) => (d2(m, p) > d2(b, p) ? m : b), run[0]!);
  const mid = nearest(mean);
  if (run.length <= EXIT_RUN) return [mid];
  const end1 = farthest(mean);
  const end2 = farthest(pos[end1]!);
  return [...new Set([end1, mid, end2])];
}
