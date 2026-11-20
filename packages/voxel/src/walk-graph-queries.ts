/**
 * Path and reach queries over a world's walk graph (walk-graph.ts), on the
 * one search core (`@thirdlight/shared` `PathSearch`), queued and served in
 * order a slice at a time, so a script asking for many paths at once never
 * stalls the step that serves them.
 *
 * - **A path** for the default walker (2 m, no drops) is tried first by one
 *   A* over the cells ({@link FLAT_FIRST_NODES} nodes: a path within a chunk
 *   or two ends there, the cheapest); a longer one is searched in two levels:
 *   first over the exits between chunks' pieces (A*; crossing a piece from
 *   the exit it is entered by to another counts the straight line between
 *   their cells, nothing walked, or with `exitCosts: 'walk'` a walk over the
 *   piece, worked out once an exit and kept until the piece's links change),
 *   then over the cells of the pieces on that route and the pieces next to
 *   them (A*), which gives the path. The route's pieces hold a real path, so
 *   the second search always finds one; it is longer than the cheapest over
 *   every cell only where the cheapest leaves that corridor (the tests and
 *   the bench state by how much). Without the levels (`hierarchy: false`),
 *   or for another walker (a height, drops), one A* runs over the cells.
 * - **Unknown is not unreachable.** A search that runs out of graph where
 *   steps may go into chunks not known yet answers `unknown`, with the path
 *   to the place on that frontier nearest the end; `unreachable` only when
 *   every way out of where it started is known and none reaches the end.
 * - **A reach** is every cell within a cost (Dijkstra over the cells).
 * - **The graph changes under a query** (chunks arrive, edits land): a query
 *   whose search read a part since made again starts over, as does one whose
 *   route used an exit since gone.
 * - **Bounded.** A query's `maxNodes` (none by default) ends it `partial`,
 *   with the path to where it got closest.
 */
import { PathSearch, type SearchGraph } from '@thirdlight/shared';
import { NAV_CLEARANCE_CELLS } from './derived-data';
import { DEFAULT_WALK_AGENT, NO_WALK_PIECE, standableIn, WALK_CLEARANCE_MAX, WalkStepper, type WalkAgent, type WalkChunk } from './walk-graph-cells';
import type { WalkExit, WalkGraph } from './walk-graph';

/** How a query walks (cells). */
export interface WalkQueryOptions {
  /** The walker's height (cells; default {@link NAV_CLEARANCE_CELLS}). */
  readonly height?: number;
  /** The deepest drop it walks off (cells; default 0: none). */
  readonly maxDrop?: number;
  /** At most this many nodes expanded (default: no bound); past it the answer is `partial`. */
  readonly maxNodes?: number;
  /** Search over pieces first (default true; the default walker only). */
  readonly hierarchy?: boolean;
  /**
   * With the levels: nodes one A* over the cells may expand before the levels take over (default
   * {@link FLAT_FIRST_NODES}; 0: the levels at once).
   */
  readonly flatFirst?: number;
  /**
   * What the first level counts for crossing a piece from one exit to the next: `straight` (default) the straight line
   * between their cells, nothing walked; `walk` its cost by a walk over the piece (one flood of the piece an exit it is
   * entered by, kept on the exit until the piece's links change).
   */
  readonly exitCosts?: 'straight' | 'walk';
}

/**
 * Nodes one A* over the cells tries before a path query searches over pieces: the levels walk the start's and the
 * end's whole pieces (a chunk's floor is about a thousand cells), so a path within a chunk or two is found sooner by
 * the cells alone; one that is not found by then is long, and the levels bound it.
 */
export const FLAT_FIRST_NODES = 2048;

/** How a query ended. */
export type WalkStatus = 'found' | 'partial' | 'unreachable' | 'unknown';

/** What a query costs and how it ran. */
export interface WalkQueryCost {
  /** Nodes expanded: exits (the first level), cells, and cells of the pieces' walks between their exits. */
  readonly coarse: number;
  readonly cells: number;
  readonly inner: number;
  /** Slices it was served in, and their milliseconds. */
  readonly slices: number;
  readonly ms: number;
  /** Times it started over because the graph changed under it. */
  readonly restarts: number;
}

/** A path query's answer (cells: world cells, x y z flat, the standable cells walked, from start to end). */
export interface WalkPathAnswer {
  readonly status: WalkStatus;
  /** Why it found nothing: no standable place near the start or the end. */
  readonly reason?: 'from' | 'to';
  readonly cells: Int32Array;
  /** The path's cost (metres). */
  readonly cost: number;
  /** Searched over pieces (the levels ran: the query was longer than its first try over the cells). */
  readonly hierarchy: boolean;
  /** Pieces on the first level's route (0 without it). */
  readonly corridor: number;
  readonly run: WalkQueryCost;
}

/** A reach query's answer: the standable cells within the cost (their count and box, the cells when asked). */
export interface WalkReachAnswer {
  /** `found`: every way within the cost is known; `unknown`: some way may continue into chunks not known yet. */
  readonly status: 'found' | 'unreachable' | 'unknown';
  readonly reason?: 'from';
  readonly count: number;
  /** The box of the cells (world cells, inclusive; null: none). */
  readonly min: readonly [number, number, number] | null;
  readonly max: readonly [number, number, number] | null;
  /** The cells (x y z flat), when the query asked for them. */
  readonly cells: Int32Array | null;
  readonly run: WalkQueryCost;
}

/** Nodes a query expands between two readings of the clock: one unit of work in a slice. */
const SERVE_NODES = 128;

/** Cells below a query's point a standable cell is looked for (a point up to 2 m over the floor: a body's middle). */
const SNAP_DOWN = NAV_CLEARANCE_CELLS;

interface Spot {
  readonly chunk: WalkChunk;
  readonly cell: number;
}

/** Cells of the parts a search touched, as ids: each part a range, given out as the search reaches it. */
class CellSpace implements SearchGraph {
  private readonly bases = new Map<WalkChunk, number>();
  readonly list: WalkChunk[] = [];
  private readonly starts: number[] = [];
  private next = 0;
  private relay: ((to: number, cost: number) => void) | null = null;
  private readonly sink: (t: WalkChunk, j: number, cost: number) => void;
  /** Pieces it may enter (null: any cell). */
  corridor: Map<WalkChunk, Set<number>> | null = null;
  agent: WalkAgent = DEFAULT_WALK_AGENT;
  /** Where the search heads (world cells), for the frontier's nearest node. */
  end: readonly [number, number, number] = [0, 0, 0];
  /** The node nearest the end whose steps may go where nothing is known (−1: none met). */
  frontier = -1;
  private frontierD = Infinity;
  /** The most cost a frontier node counts at (a reach's limit). */
  frontierCost = Infinity;
  costOf: ((node: number) => number) | null = null;

  constructor(
    private readonly graph: WalkGraph,
    private readonly stepper: WalkStepper,
  ) {
    this.sink = (t, j, cost) => {
      const c = this.corridor;
      if (c !== null && c.get(t)?.has(t.piece[j]!) !== true) return;
      this.relay!(this.idOf(t, j), cost);
    };
  }

  reset(): void {
    this.bases.clear();
    this.list.length = 0;
    this.starts.length = 0;
    this.next = 0;
    this.corridor = null;
    this.frontier = -1;
    this.frontierD = Infinity;
    this.frontierCost = Infinity;
    this.costOf = null;
  }

  idOf(c: WalkChunk, i: number): number {
    let b = this.bases.get(c);
    if (b === undefined) {
      b = this.next;
      this.bases.set(c, b);
      this.list.push(c);
      this.starts.push(b);
      this.next += c.ys.length;
    }
    return b + i;
  }

  /** The part and cell of an id. */
  spotOf(id: number): Spot {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (this.starts[m]! <= id) lo = m;
      else hi = m - 1;
    }
    return { chunk: this.list[lo]!, cell: id - this.starts[lo]! };
  }

  steps(node: number, step: (to: number, cost: number) => void): void {
    this.relay = step;
    const { chunk, cell } = this.spotOf(node);
    this.stepper.steps(this.graph.lookup, chunk, cell, this.agent, this.sink);
    if (this.stepper.unknown && (this.costOf === null || this.costOf(node) <= this.frontierCost)) {
      const d = distCells(chunk, cell, this.end);
      if (d < this.frontierD) {
        this.frontierD = d;
        this.frontier = node;
      }
    }
  }
}

/** One piece's cells as ids (cell indices of its chunk): what a walk between its exits searches. */
class PieceSpace implements SearchGraph {
  chunk: WalkChunk | null = null;
  piece = 0;
  private relay: ((to: number, cost: number) => void) | null = null;
  private readonly sink: (t: WalkChunk, j: number, cost: number) => void;
  private readonly only: (cx: number, cy: number, cz: number) => null = () => null;

  constructor(private readonly stepper: WalkStepper) {
    this.sink = (t, j, cost) => {
      if (t === this.chunk && t.piece[j] === this.piece) this.relay!(j, cost);
    };
  }

  steps(node: number, step: (to: number, cost: number) => void): void {
    this.relay = step;
    this.stepper.steps(this.only, this.chunk!, node, DEFAULT_WALK_AGENT, this.sink);
  }
}

/** The straight line between two cells (cells). */
const cellGap = (a: WalkChunk, i: number, b: WalkChunk, j: number): number => {
  const e = a.edge;
  const ci = a.col[i]!;
  const cj = b.col[j]!;
  return Math.hypot(a.cx * e + ((ci / e) | 0) - (b.cx * e + ((cj / e) | 0)), a.cy * e + a.ys[i]! - (b.cy * e + b.ys[j]!), a.cz * e + (ci % e) - (b.cz * e + (cj % e)));
};

const distCells = (c: WalkChunk, i: number, p: readonly number[]): number => {
  const e = c.edge;
  const colI = c.col[i]!;
  return Math.hypot(c.cx * e + ((colI / e) | 0) - p[0]!, c.cy * e + c.ys[i]! - p[1]!, c.cz * e + (colI % e) - p[2]!);
};

/** A query in the queue. */
interface Job {
  /** Goes on for up to `nodes` expansions; true once answered. */
  step(nodes: number): boolean;
  /** The graph ends (its world went): answered with what it has. */
  abandon(): void;
  /** Slices it was served in, the milliseconds of those before this one, and when this one began. */
  slices: number;
  ms: number;
  sliceStart: number;
}

/** The searches a world's queries share (one query runs at a time) and the queue that serves them. */
export class WalkQueries {
  readonly cellSearch = new PathSearch();
  readonly coarseSearch = new PathSearch();
  readonly innerSearch = new PathSearch();
  readonly endSearch = new PathSearch();
  readonly cells: CellSpace;
  readonly inner: PieceSpace;
  readonly endPiece: PieceSpace;
  private readonly queue: Job[] = [];
  private servedNodes = 0;
  private servedJobs = 0;

  constructor(readonly graph: WalkGraph) {
    this.cells = new CellSpace(graph, new WalkStepper(graph.cellM));
    this.inner = new PieceSpace(new WalkStepper(graph.cellM));
    this.endPiece = new PieceSpace(new WalkStepper(graph.cellM));
  }

  /** A path from one world cell to another, answered by `done` once served. */
  path(from: readonly [number, number, number], to: readonly [number, number, number], options: WalkQueryOptions, done: (a: WalkPathAnswer) => void): void {
    this.queue.push(new PathJob(this, from, to, options, done));
  }

  /** The standable cells within `maxCost` metres of a world cell, answered by `done` once served (`cells`: list them). */
  reach(from: readonly [number, number, number], maxCost: number, options: WalkQueryOptions & { readonly cells?: boolean }, done: (a: WalkReachAnswer) => void): void {
    this.queue.push(new ReachJob(this, from, maxCost, options, done));
  }

  /** Queries waiting (the one being served included). */
  get queued(): number {
    return this.queue.length;
  }

  /** Bytes the searches' arrays hold (they grow to the largest search made, and are kept for the next). */
  get bytes(): number {
    return this.cellSearch.bytes + this.coarseSearch.bytes + this.innerSearch.bytes + this.endSearch.bytes;
  }

  /** Nodes expanded and queries answered since the start. */
  get served(): { readonly nodes: number; readonly queries: number } {
    return { nodes: this.servedNodes, queries: this.servedJobs };
  }

  /** @internal a job's expansions, for the counters. */
  count(nodes: number): void {
    this.servedNodes += nodes;
  }

  /**
   * Serves the queue in order within `ms`: the clock is read before each unit after the first ({@link SERVE_NODES}
   * nodes, or a piece's walk between exits), so a call passes the slice by at most one unit. Returns the queries
   * answered.
   */
  serve(ms: number): number {
    if (this.queue.length === 0) return 0;
    const t0 = performance.now();
    let units = 0;
    let answered = 0;
    let job: Job | null = null;
    while (this.queue.length > 0 && (units === 0 || performance.now() - t0 < ms)) {
      const head = this.queue[0]!;
      if (head !== job) {
        job = head;
        head.sliceStart = performance.now();
        head.slices++;
      }
      units++;
      if (head.step(SERVE_NODES)) {
        job = null;
        this.queue.shift();
        answered++;
        this.servedJobs++;
      }
    }
    if (job !== null) job.ms += performance.now() - job.sliceStart;
    if (this.queue.length === 0) this.graph.releaseIds();
    return answered;
  }

  /** The world went: every query answered with what it has (unknown). */
  clear(): void {
    for (const j of this.queue.splice(0)) j.abandon();
  }

  /**
   * The standable cell for a world cell: in its column, the cell itself or the nearest below it to {@link SNAP_DOWN},
   * else the one over it (a point just inside its floor); else the same in a column beside it.
   */
  snap(p: readonly [number, number, number], agent: WalkAgent): Spot | 'unknown' | null {
    const g = this.graph;
    const e = g.grid.edge;
    let unknown = false;
    const cols: readonly (readonly [number, number])[] = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const [ox, oz] of cols) {
      const x = p[0] + ox;
      const z = p[2] + oz;
      for (let k = 0; k <= SNAP_DOWN + 1; k++) {
        const y = k <= SNAP_DOWN ? p[1] - k : p[1] + 1;
        const c = g.lookup(Math.floor(x / e), Math.floor(y / e), Math.floor(z / e));
        if (c === undefined) {
          unknown = true;
          continue;
        }
        if (c === null) continue;
        const i = standableIn(c, x - c.cx * e, y - c.cy * e, z - c.cz * e);
        if (i >= 0 && c.clear[i]! >= agent.height) return { chunk: c, cell: i };
      }
    }
    return unknown ? 'unknown' : null;
  }
}

/** A query's walker from its options (cells, clamped to what the clearance counts). */
function agentOf(o: WalkQueryOptions): WalkAgent {
  const height = Math.min(WALK_CLEARANCE_MAX, Math.max(1, Math.round(o.height ?? DEFAULT_WALK_AGENT.height)));
  const maxDrop = Math.max(0, Math.min(WALK_CLEARANCE_MAX - height, Math.round(o.maxDrop ?? 0)));
  return height === DEFAULT_WALK_AGENT.height && maxDrop < 2 ? DEFAULT_WALK_AGENT : Object.freeze({ height, maxDrop });
}

const NO_CELLS = new Int32Array(0);

/** A job's milliseconds served, this slice's so far included (what its answer reports). */
const servedMs = (j: Job): number => j.ms + (j.slices > 0 ? performance.now() - j.sliceStart : 0);

const anyDead = (parts: Iterable<WalkChunk>): boolean => {
  for (const c of parts) if (!c.alive) return true;
  return false;
};

/** A path query (the module comment). */
class PathJob implements Job {
  slices = 0;
  ms = 0;
  sliceStart = 0;
  private phase: 'snap' | 'probe' | 'coarse' | 'refine' | 'flat' = 'snap';
  /** The levels ran. */
  private leveled = false;
  private readonly agent: WalkAgent;
  private readonly levels: boolean;
  private start: Spot | null = null;
  private end: Spot | null = null;
  private readonly endAt: readonly [number, number, number];
  private coarse: CoarseSpace | null = null;
  private status: WalkStatus = 'found';
  private aim: Spot | null = null;
  private corridorSize = 0;
  private expandedCoarse = 0;
  private expandedCells = 0;
  /** Piece walks' nodes of searches started over. */
  private innerBefore = 0;
  private restarts = 0;
  private readonly touched = new Set<WalkChunk>();

  constructor(
    private readonly q: WalkQueries,
    private readonly from: readonly [number, number, number],
    to: readonly [number, number, number],
    private readonly options: WalkQueryOptions,
    private readonly done: (a: WalkPathAnswer) => void,
  ) {
    this.agent = agentOf(options);
    this.levels = options.hierarchy !== false && this.agent === DEFAULT_WALK_AGENT;
    this.endAt = to;
  }

  private get expanded(): number {
    return this.expandedCoarse + this.expandedCells + this.innerBefore + (this.coarse?.innerExpanded ?? 0);
  }

  step(nodes: number): boolean {
    if (this.phase !== 'snap' && (anyDead(this.touched) || this.q.cells.list.some((c) => !c.alive))) this.restart();
    const max = this.options.maxNodes ?? Infinity;
    if (this.phase === 'snap') return this.begin();
    if (this.phase === 'coarse') {
      // One exit at a time, its piece walks counted as work: a unit is the nodes given plus at most one piece's walk.
      const s = this.q.coarseSearch;
      const work0 = this.expanded;
      let st = s.status;
      while (st === 'open' && this.expanded - work0 < nodes && this.expanded < max) {
        const before = s.expanded;
        st = s.run(1);
        this.expandedCoarse += s.expanded - before;
        this.q.count(s.expanded - before);
      }
      if (st === 'open' && this.expanded >= max) return this.coarseEnded('partial');
      if (st === 'open') return false;
      return this.coarseEnded(st === 'found' ? 'found' : 'none');
    }
    const s = this.q.cellSearch;
    const before = s.expanded;
    const one = this.phase === 'flat' || this.phase === 'probe';
    const first = this.options.flatFirst ?? FLAT_FIRST_NODES;
    const cap = one ? Math.max(1, max - this.expanded) : Infinity;
    const st = s.run(Math.min(nodes, cap, this.phase === 'probe' ? Math.max(1, first - s.expanded) : Infinity));
    this.expandedCells += s.expanded - before;
    this.q.count(s.expanded - before);
    if (st === 'open' && this.phase === 'probe' && s.expanded >= first && this.expanded < max) return this.startLevels();
    if (st === 'open' && (!one || this.expanded < max)) return false;
    return this.cellsEnded(st);
  }

  /** The first try over the cells did not end: the path is searched over pieces. */
  private startLevels(): false {
    const q = this.q;
    this.leveled = true;
    this.coarse = new CoarseSpace(q, this.start!, this.end, this.endAt, this.touched, this.options.exitCosts === 'walk');
    q.coarseSearch.start(this.coarse, { from: 0, target: 1, estimate: this.coarse.estimate });
    this.phase = 'coarse';
    return false;
  }

  private restart(): void {
    this.restarts++;
    this.phase = 'snap';
    this.leveled = false;
    this.innerBefore += this.coarse?.innerExpanded ?? 0;
    this.coarse = null;
    this.corridorSize = 0;
    this.touched.clear();
    this.q.cells.reset();
  }

  /** The ends placed on standable cells, and the first search started. */
  private begin(): boolean {
    const q = this.q;
    const s = q.snap(this.from, this.agent);
    if (s === 'unknown') return this.answer('unknown', null, 'from');
    if (s === null) return this.answer('unreachable', null, 'from');
    this.start = s;
    const t = q.snap(this.endAt, this.agent);
    this.end = t === 'unknown' || t === null ? null : t;
    if (t === null) return this.answer('unreachable', null, 'to');
    this.touched.add(s.chunk);
    if (this.end !== null) this.touched.add(this.end.chunk);
    if (this.end !== null && this.end.chunk === s.chunk && this.end.cell === s.cell) return this.answer('found', [s]);
    if (this.levels && (this.options.flatFirst ?? FLAT_FIRST_NODES) <= 0) return this.startLevels();
    this.startCells(null, this.end);
    this.phase = this.levels ? 'probe' : 'flat';
    return false;
  }

  private startCells(corridor: Map<WalkChunk, Set<number>> | null, to: Spot | null): void {
    const cells = this.q.cells;
    cells.reset();
    cells.corridor = corridor;
    cells.agent = this.agent;
    cells.end = this.endAt;
    const from = cells.idOf(this.start!.chunk, this.start!.cell);
    const end = to === null ? undefined : cells.idOf(to.chunk, to.cell);
    const g = this.endAt;
    const m = this.q.graph.cellM;
    const estimate = (n: number): number => {
      const sp = cells.spotOf(n);
      return distCells(sp.chunk, sp.cell, g) * m;
    };
    this.q.cellSearch.start(cells, { from, ...(end !== undefined ? { target: end } : {}), estimate });
  }

  /** The first level ended: refine along its route (to the end, the frontier, or where it got closest). */
  private coarseEnded(how: 'found' | 'none' | 'partial'): boolean {
    const c = this.coarse!;
    const s = this.q.coarseSearch;
    let end: number;
    if (how === 'found') {
      end = 1;
      this.status = 'found';
      this.aim = this.end;
    } else if (how === 'partial') {
      end = s.closest;
      this.status = 'partial';
      this.aim = c.spotOfNode(end);
    } else if (c.frontierNode >= 0) {
      end = c.frontierNode;
      this.status = 'unknown';
      this.aim = c.frontierSpot;
    } else return this.answer('unreachable', [this.start!]);
    const route = s.path(end);
    // An exit gone since the route was found: the route is not there any more.
    if (route.some((n) => n >= 2 && this.q.graph.exit(n - 2) === null)) {
      this.restart();
      return false;
    }
    const corridor = new Map<WalkChunk, Set<number>>();
    const add = (ch: WalkChunk, p: number): void => {
      let set = corridor.get(ch);
      if (set === undefined) corridor.set(ch, (set = new Set()));
      if (!set.has(p)) this.corridorSize++;
      set.add(p);
    };
    const onRoute: Array<[WalkChunk, number]> = [];
    for (const n of route) {
      const sp = c.pieceOfNode(n);
      if (sp !== null) onRoute.push(sp);
    }
    if (this.aim !== null && this.aim.chunk.piece[this.aim.cell] !== NO_WALK_PIECE) onRoute.push([this.aim.chunk, this.aim.chunk.piece[this.aim.cell]!]);
    for (const [ch, p] of onRoute) add(ch, p);
    // With straight costs the route only guesses each piece's crossing: the pieces next to it come too, so the cells'
    // search can go round what the guess missed (a wall across a piece the straight line ran through).
    if (this.options.exitCosts !== 'walk') for (const [ch, p] of onRoute) for (const x of this.q.graph.exitsOf(ch, p)) add(x.to, x.toPiece);
    this.startCells(corridor, this.aim);
    this.phase = 'refine';
    return false;
  }

  /** The cell level ended. */
  private cellsEnded(st: 'open' | 'found' | 'done'): boolean {
    const s = this.q.cellSearch;
    const cells = this.q.cells;
    if (this.phase === 'refine') {
      if (st !== 'found') {
        // The corridor lost its way (a part changed under it): search again.
        this.restart();
        return false;
      }
      return this.answer(this.status, s.path().map((n) => cells.spotOf(n)), undefined, s.cost(s.target));
    }
    if (st === 'found') return this.answer('found', s.path().map((n) => cells.spotOf(n)), undefined, s.cost(s.target));
    if (st === 'open') {
      const n = s.closest;
      return this.answer('partial', s.path(n).map((m) => cells.spotOf(m)), undefined, s.cost(n));
    }
    if (cells.frontier >= 0) return this.answer('unknown', s.path(cells.frontier).map((m) => cells.spotOf(m)), undefined, s.cost(cells.frontier));
    return this.answer('unreachable', [this.start!]);
  }

  private answer(status: WalkStatus, path: Spot[] | null, reason?: 'from' | 'to', cost = 0): true {
    const cells = path === null ? NO_CELLS : new Int32Array(path.length * 3);
    if (path !== null) {
      path.forEach((sp, k) => {
        const e = sp.chunk.edge;
        const colI = sp.chunk.col[sp.cell]!;
        cells[k * 3] = sp.chunk.cx * e + ((colI / e) | 0);
        cells[k * 3 + 1] = sp.chunk.cy * e + sp.chunk.ys[sp.cell]!;
        cells[k * 3 + 2] = sp.chunk.cz * e + (colI % e);
      });
    }
    this.done(Object.freeze({
      status,
      ...(reason !== undefined ? { reason } : {}),
      cells,
      cost,
      hierarchy: this.leveled,
      corridor: this.corridorSize,
      run: Object.freeze({ coarse: this.expandedCoarse, cells: this.expandedCells, inner: this.innerBefore + (this.coarse?.innerExpanded ?? 0), slices: this.slices, ms: servedMs(this), restarts: this.restarts }),
    }));
    return true;
  }

  abandon(): void {
    this.answer('unknown', null);
  }
}

/**
 * The first level as a search graph: node 0 the start, 1 the end, an exit `id + 2` (standing at its cell, about to
 * cross). From the start: the start piece's exits at their walk's cost; from an exit: its step across, then the
 * landing piece's walk to each of that piece's exits (and to the end in the end's piece).
 */
class CoarseSpace implements SearchGraph {
  /** The node nearest the end (by its frontier cell) whose piece may lead where nothing is known (−1: none). */
  frontierNode = -1;
  frontierSpot: Spot | null = null;
  private frontierD = Infinity;
  innerExpanded = 0;
  private readonly startExits: readonly WalkExit[];
  private readonly startCosts: Float64Array;
  readonly estimate: (n: number) => number;
  private readonly startPiece: number;
  private readonly endPieceOf: number;

  constructor(
    private readonly q: WalkQueries,
    private readonly start: Spot,
    private readonly end: Spot | null,
    private readonly endAt: readonly [number, number, number],
    private readonly touched: Set<WalkChunk>,
    /** Crossing a piece costs its walk (else the straight line between the cells). */
    private readonly walked: boolean,
  ) {
    const g = q.graph;
    const m = g.cellM;
    this.startPiece = start.chunk.piece[start.cell]!;
    this.endPieceOf = end === null ? -1 : end.chunk.piece[end.cell]!;
    // The end piece's walk from the end (its steps go both ways: the cost from any of its cells to the end).
    if (end !== null && walked) {
      q.endPiece.chunk = end.chunk;
      q.endPiece.piece = this.endPieceOf;
      q.endSearch.start(q.endPiece, { from: end.cell });
      q.endSearch.run();
      this.innerExpanded += q.endSearch.expanded;
    }
    this.startExits = g.exitsOf(start.chunk, this.startPiece);
    this.startCosts = walked ? this.walk(start.chunk, this.startPiece, start.cell, this.startExits) : Float64Array.from(this.startExits, (x) => cellGap(start.chunk, start.cell, x.from, x.a) * m);
    this.estimate = (n: number): number => {
      if (n === 1) return 0;
      if (n === 0) return distCells(start.chunk, start.cell, endAt) * m;
      const x = g.exit(n - 2);
      return x === null ? 0 : distCells(x.from, x.a, endAt) * m;
    };
  }

  /** A piece's walk from a cell: the cost to each of `exits`' cells (Infinity where it does not reach). */
  private walk(c: WalkChunk, piece: number, from: number, exits: readonly WalkExit[]): Float64Array {
    const q = this.q;
    q.inner.chunk = c;
    q.inner.piece = piece;
    q.innerSearch.start(q.inner, { from });
    q.innerSearch.run();
    this.innerExpanded += q.innerSearch.expanded;
    q.count(q.innerSearch.expanded);
    return Float64Array.from(exits, (x) => q.innerSearch.cost(x.a));
  }

  private toEnd(c: WalkChunk, piece: number, cell: number): number {
    if (this.end === null || c !== this.end.chunk || piece !== this.endPieceOf) return Infinity;
    return this.walked ? this.q.endSearch.cost(cell) : cellGap(c, cell, this.end.chunk, this.end.cell) * this.q.graph.cellM;
  }

  /** The piece a node stands in once across (the start's for 0; null for the end or a gone exit). */
  pieceOfNode(n: number): [WalkChunk, number] | null {
    if (n === 0) return [this.start.chunk, this.startPiece];
    if (n === 1) return this.end === null ? null : [this.end.chunk, this.endPieceOf];
    const x = this.q.graph.exit(n - 2);
    return x === null ? null : [x.to, x.toPiece];
  }

  /** Where a node stands (its exit's cell; the start's; the end's). */
  spotOfNode(n: number): Spot | null {
    if (n === 0) return this.start;
    if (n === 1) return this.end;
    const x = this.q.graph.exit(n - 2);
    return x === null ? null : { chunk: x.from, cell: x.a };
  }

  steps(node: number, step: (to: number, cost: number) => void): void {
    const g = this.q.graph;
    if (node === 1) return;
    if (node === 0) {
      this.frontierOf(0, this.start.chunk, this.startPiece);
      this.startExits.forEach((x, k) => step(x.id + 2, this.startCosts[k]!));
      const d = this.toEnd(this.start.chunk, this.startPiece, this.start.cell);
      if (d < Infinity) step(1, d);
      return;
    }
    const x = g.exit(node - 2);
    if (x === null) return;
    this.touched.add(x.to);
    this.frontierOf(node, x.to, x.toPiece);
    const exits = g.exitsOf(x.to, x.toPiece);
    if (this.walked) {
      const at = g.linksVersion(x.to);
      if (x.dists === null || x.distsAt !== at || x.dists.length !== exits.length) {
        x.dists = this.walk(x.to, x.toPiece, x.b, exits);
        x.distsAt = at;
      }
      const dists = x.dists;
      for (let k = 0; k < exits.length; k++) {
        const d = dists[k]!;
        if (d < Infinity) step(exits[k]!.id + 2, x.cost + d);
      }
    } else {
      const m = g.cellM;
      for (const e of exits) step(e.id + 2, x.cost + cellGap(x.to, x.b, e.from, e.a) * m);
    }
    const d = this.toEnd(x.to, x.toPiece, x.b);
    if (d < Infinity) step(1, x.cost + d);
  }

  /** A piece reached that may lead where nothing is known: its frontier cell nearest the end, if nearer than any so far. */
  private frontierOf(node: number, c: WalkChunk, piece: number): void {
    const cells = this.q.graph.frontierOf(c, piece);
    for (const i of cells) {
      const d = distCells(c, i, this.endAt);
      if (d < this.frontierD) {
        this.frontierD = d;
        this.frontierNode = node;
        this.frontierSpot = { chunk: c, cell: i };
      }
    }
  }
}

/** A reach query: a Dijkstra over the cells within the cost. */
class ReachJob implements Job {
  slices = 0;
  ms = 0;
  sliceStart = 0;
  private started = false;
  private readonly agent: WalkAgent;
  private restarts = 0;

  constructor(
    private readonly q: WalkQueries,
    private readonly from: readonly [number, number, number],
    private readonly maxCost: number,
    private readonly options: WalkQueryOptions & { readonly cells?: boolean },
    private readonly done: (a: WalkReachAnswer) => void,
  ) {
    this.agent = agentOf(options);
  }

  step(nodes: number): boolean {
    const q = this.q;
    if (this.started && q.cells.list.some((c) => !c.alive)) {
      this.restarts++;
      this.started = false;
    }
    if (!this.started) {
      const s = q.snap(this.from, this.agent);
      if (s === 'unknown' || s === null) return this.answer(s === null ? 'unreachable' : 'unknown', true);
      const cells = q.cells;
      cells.reset();
      cells.agent = this.agent;
      cells.end = this.from;
      cells.frontierCost = this.maxCost;
      cells.costOf = (n) => q.cellSearch.cost(n);
      q.cellSearch.start(cells, { from: cells.idOf(s.chunk, s.cell), maxCost: this.maxCost });
      this.started = true;
      return false;
    }
    const s = q.cellSearch;
    const before = s.expanded;
    const st = s.run(nodes);
    q.count(s.expanded - before);
    if (st === 'open' && s.expanded < (this.options.maxNodes ?? Infinity)) return false;
    return this.answer(q.cells.frontier >= 0 || st === 'open' ? 'unknown' : 'found', false);
  }

  private answer(status: 'found' | 'unreachable' | 'unknown', none: boolean): true {
    const q = this.q;
    let count = 0;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const list: number[] | null = this.options.cells === true ? [] : null;
    if (!none) {
      q.cellSearch.forEachSettled((n) => {
        const sp = q.cells.spotOf(n);
        const e = sp.chunk.edge;
        const colI = sp.chunk.col[sp.cell]!;
        const p = [sp.chunk.cx * e + ((colI / e) | 0), sp.chunk.cy * e + sp.chunk.ys[sp.cell]!, sp.chunk.cz * e + (colI % e)];
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a]!, p[a]!);
          max[a] = Math.max(max[a]!, p[a]!);
        }
        list?.push(p[0]!, p[1]!, p[2]!);
        count++;
      });
    }
    this.done(Object.freeze({
      status,
      ...(none && status === 'unreachable' ? { reason: 'from' as const } : {}),
      count,
      min: count > 0 ? (Object.freeze([min[0]!, min[1]!, min[2]!]) as readonly [number, number, number]) : null,
      max: count > 0 ? (Object.freeze([max[0]!, max[1]!, max[2]!]) as readonly [number, number, number]) : null,
      cells: list === null ? null : Int32Array.from(list),
      run: Object.freeze({ coarse: 0, cells: none ? 0 : q.cellSearch.expanded, inner: 0, slices: this.slices, ms: servedMs(this), restarts: this.restarts }),
    }));
    return true;
  }

  abandon(): void {
    this.answer('unknown', true);
  }
}
