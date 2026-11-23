/**
 * Path queries across a world's walk graph and its structure grids' own
 * graphs (walk-graph-links.ts): a way from the street into a turned house's
 * room runs over world cells to a link at its door, then over the grid's
 * cells in its own frame, each part searched by its own graph's queries
 * (walk-graph-queries.ts: one A* over the cells first, the pieces' exits for a
 * long way) and joined at the link.
 *
 * - **Where a point is.** A point is in a grid when that grid's graph has a
 *   standable cell at or under it (its own snap) nearer than the world's;
 *   else in the world grid. A path whose ends are in the same graph is that
 *   graph's own query, unchanged.
 * - **Which link.** Between graphs, the links are the exits: each candidate
 *   is ranked by the straight lines from the start to it and from it to the end
 *   (as the exits level ranks a piece's crossing) plus its step; the best
 *   {@link LINKED_PATH_DOORS} links more than {@link LINKED_DOOR_APART_M}
 *   apart (a door each, as a rule) have their legs searched, and the cheapest
 *   whole way is the answer. Between two grids a candidate is a pair of
 *   links, the world's leg between them.
 * - **Answers** are in world metres: each cell walked at its floor's middle,
 *   a grid's cells placed by its frame. `unknown` when no candidate was found
 *   and a leg ran into chunks not known; `unreachable` when every leg was known.
 *
 * - **Other walkers.** A walker of another height, width or with drops
 *   crosses at the links too, each leg searched with its options; it takes a
 *   link made for its footprint's span (walk-graph-links.ts), and a taller one
 *   only where both its ends have room for it (their clearance, as a step
 *   between them needs).
 * - **It waits for the links.** A query whose ends lie in a grid, or near a
 *   grid whose graph is not current where they lie, waits (as a graph's own
 *   query does: `WALK_QUERY_WAIT_SERVES` in all) until those grids' graphs,
 *   their links and the world's chunks under them are made, so a path asked
 *   before a house's links exist is not answered `unreachable` from a graph
 *   half made.
 * - **A reach** (walk-graph-linked-reach.ts) runs in the graph of its start,
 *   then from the links its places meet into each grid's graph (and back out)
 *   with what is left of the distance.
 *
 * Not searched: a way between two points of one graph that is shorter through
 * a grid (in at one door, out at another).
 */
import type { GridFrame } from './grid-place';
import type { WalkGraph } from './walk-graph';
import { clearOf, walkCellOf, DEFAULT_WALK_AGENT, stepFits, walkSpanOffset, WALK_CLEARANCE_MAX, WALK_SPAN_MAX, type WalkAgent } from './walk-graph-cells';
import type { WalkGraphLinks, WalkLink } from './walk-graph-links';
import { LinkedReach, type LinkedReachAnswer } from './walk-graph-linked-reach';
import { WALK_QUERY_WAIT_SERVES, WalkQueries, type WalkPathAnswer, type WalkQueryCost, type WalkQueryOptions, type WalkReachAnswer, type WalkStatus } from './walk-graph-queries';

/** Links (doors, as a rule) whose legs a query between graphs searches before it takes the cheapest found. */
export const LINKED_PATH_DOORS = 3;

/** Metres between two links' grid cells for them to count as two ways in (a door is 1–2 m wide). */
export const LINKED_DOOR_APART_M = 2;

type P3 = readonly [number, number, number];

/** A path answer across graphs (world metres). */
export interface LinkedPathAnswer {
  readonly status: WalkStatus;
  readonly reason?: 'from' | 'to';
  /** The cells walked, each its floor's middle in world metres (x y z flat), start to end. */
  readonly points: Float64Array;
  /** Per point: the grid its cell is in (0: the world grid). */
  readonly grids: Int32Array;
  readonly cost: number;
  /** Graphs walked (1: one graph's own query) and the links whose legs were searched. */
  readonly legs: number;
  readonly tried: number;
  /** It waited its bound out with a graph or a link not made: the answer is the graphs' as they were. */
  readonly stale?: true;
  readonly run: WalkQueryCost;
}

/** A structure grid as the queries read it. */
export interface QueryGrid {
  readonly id: number;
  readonly frame: GridFrame;
  readonly graph: WalkGraph;
  readonly queries: WalkQueries;
}

export interface Located {
  /** 0: the world grid. */
  readonly grid: number;
  /** Its standable cell (that graph's cells) and its floor's middle in world metres. */
  readonly cell: P3;
  readonly at: P3;
}

interface Leg {
  readonly grid: number;
  readonly from: P3;
  readonly to: P3;
}

const dist = (a: P3, b: P3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The walker a query's options describe (cells; what the links and the snaps read), as the graphs' queries clamp it. */
export function linkedAgent(o: WalkQueryOptions): WalkAgent {
  const height = Math.min(WALK_CLEARANCE_MAX, Math.max(1, Math.round(o.height ?? DEFAULT_WALK_AGENT.height)));
  const span = Math.min(WALK_SPAN_MAX, Math.max(1, Math.round(o.span ?? DEFAULT_WALK_AGENT.span)));
  return { height, maxDrop: 0, span, ...(o.doors === 'shut-too' ? { throughShut: true } : {}) };
}

/** Whether a walker takes a link: made for its span, room for its height at both ends, and not into a shut door unless it goes through them. */
export function linkFits(l: WalkLink, a: WalkAgent, rise: number): boolean {
  if (((l.spans >>> (a.span - 1)) & 1) === 0) return false;
  if (a.throughShut !== true && l.part.shut?.[l.g] === 1) return false;
  return a.height <= DEFAULT_WALK_AGENT.height || stepFits(clearOf(l.world, l.w, a.span), clearOf(l.part, l.g, a.span), rise, a.height);
}

/** The world's queries and its grids', and the queries between them (the module comment). */
export class LinkedWalkQueries {
  private readonly grids = new Map<number, QueryGrid>();
  private readonly jobs: LinkedJob[] = [];
  private readonly reaches: LinkedReach[] = [];
  /** Waits and restarts of the queries across graphs, their legs' included (the world's own queries count theirs too). */
  waits = 0;
  restarts = 0;

  constructor(
    readonly world: WalkQueries,
    readonly links: WalkGraphLinks,
  ) {}

  /** A grid's queries (made when a leg or a point needs them, let go once its legs are answered). */
  gridQueries(id: number): QueryGrid | null {
    let q = this.grids.get(id);
    if (q !== undefined) return q;
    const g = this.links.grid(id);
    if (g === null) return null;
    q = { id, frame: g.frame, graph: g.graph, queries: new WalkQueries(g.graph) };
    this.grids.set(id, q);
    return q;
  }

  /** A grid left: its queries answer what they have. */
  drop(id: number): void {
    this.grids.get(id)?.queries.clear();
    this.grids.delete(id);
  }

  /** A path between two world cells, either end in the world grid or a structure grid; answered by `done` once served. */
  path(from: P3, to: P3, options: WalkQueryOptions, done: (a: LinkedPathAnswer) => void): void {
    const job = new LinkedJob(this, from, to, options, done);
    this.jobs.push(job);
    job.begin();
  }

  /** The places within a cost of a world cell, in its graph and through the links in the others; answered by `done` once served. */
  reach(from: P3, maxCost: number, options: WalkQueryOptions & { readonly cells?: boolean }, done: (a: LinkedReachAnswer) => void): void {
    const r = new LinkedReach(this, from, maxCost, options, done);
    this.reaches.push(r);
    r.begin();
  }

  /** Queries waiting: the joined ones, and every graph's own legs. */
  get queued(): number {
    let n = this.jobs.length + this.reaches.length + this.world.queued;
    for (const g of this.grids.values()) n += g.queries.queued;
    return n;
  }

  /** Serves the world's queue and the grids' within `ms` (the world's first); returns the legs answered. */
  serve(ms: number): number {
    const t0 = performance.now();
    // Joined queries waiting for grids' graphs and links try again (each serve counts towards their bound).
    for (const j of this.jobs) if (j.waitingForGrids) j.retry();
    let n = this.world.serve(ms);
    for (const g of this.grids.values()) {
      if (g.queries.queued === 0) continue;
      const left = ms - (performance.now() - t0);
      if (left <= 0 && n > 0) break;
      n += g.queries.serve(Math.max(0, left));
    }
    for (let i = 0; i < this.jobs.length; ) if (this.jobs[i]!.finished) this.jobs.splice(i, 1);
    else i++;
    for (let i = 0; i < this.reaches.length; ) if (this.reaches[i]!.finished) this.reaches.splice(i, 1);
    else i++;
    // A grid's searches are let go once its legs are answered: a town holds many grids, few searched at once.
    for (const [id, g] of this.grids) if (g.queries.queued === 0 && !this.held(id)) this.grids.delete(id);
    return n;
  }

  /** Bytes the grids' searches hold. */
  get bytes(): number {
    let b = 0;
    for (const g of this.grids.values()) b += g.queries.bytes;
    return b;
  }

  /** The world went: every query answered with what it has. */
  clear(): void {
    this.world.clear();
    for (const g of this.grids.values()) g.queries.clear();
    this.grids.clear();
  }

  /** Whether a waiting joined query or a reach still holds a grid's queries. */
  private held(id: number): boolean {
    return this.reaches.some((r) => r.holds(id));
  }

  /**
   * @internal whether the grids a query reads are current: each one's graph, its links and the world's chunks under it
   * made (a grid's links are made after both sides' parts).
   */
  gridsCurrent(ids: Iterable<number>): boolean {
    for (const id of ids) {
      if (id === 0) continue;
      const g = this.links.grid(id);
      if (g === null) continue;
      if (g.graph.anyStale || this.links.pendingFor(id) || this.links.worldUnder(id).some((k) => this.world.graph.staleKey(k))) return false;
    }
    return true;
  }

  /**
   * @internal where a world cell is: the nearest standable cell of the world's graph or a grid's at or under it, for
   * a walker `agent`. `stale` collects the grids whose graph is not current where the point lies.
   */
  locate(p: P3, agent: WalkAgent = DEFAULT_WALK_AGENT, stale: Set<number> | null = null): Located | null {
    const M = this.world.graph.cellM;
    let best: Located | null = null;
    let bestD = Infinity;
    const w = this.world.snap(p, agent);
    if (w !== null && w !== 'unknown') {
      const c = walkCellOf(w.chunk, w.cell);
      const at: P3 = [(c[0] + 0.5) * M, c[1] * M, (c[2] + 0.5) * M];
      best = { grid: 0, cell: c, at };
      bestD = dist(at, [(p[0] + 0.5) * M, p[1] * M, (p[2] + 0.5) * M]);
    }
    const pm: P3 = [(p[0] + 0.5) * M, (p[1] + 0.5) * M, (p[2] + 0.5) * M];
    for (const g of this.links.linked()) {
      const e = g.graph.grid.edge;
      const q = g.frame.toGrid(pm[0], pm[1], pm[2]);
      const gc: P3 = [Math.floor(q[0] / M), Math.floor(q[1] / M), Math.floor(q[2] / M)];
      const gcx = Math.floor(gc[0] / e);
      const gcy = Math.floor(gc[1] / e);
      const gcz = Math.floor(gc[2] / e);
      if (g.graph.stale(gcx, gcy, gcz)) stale?.add(g.id);
      if (g.graph.chunkAt(gcx, gcy, gcz) === null) continue;
      const s = this.gridQueries(g.id)!.queries.snap(gc, agent);
      if (s === null || s === 'unknown') continue;
      const c = walkCellOf(s.chunk, s.cell);
      const at = g.frame.toWorld((c[0] + 0.5) * M, c[1] * M, (c[2] + 0.5) * M);
      const d = dist(at, [pm[0], p[1] * M, pm[2]]);
      if (d < bestD) {
        bestD = d;
        best = { grid: g.id, cell: c, at };
      }
    }
    return best;
  }

  /** @internal where a walker `span` cells across stands on a cell of a graph, at its floor, in world metres (one cell: the cell's middle). */
  placeOf(grid: number, c: P3, span = 1): P3 {
    const M = this.world.graph.cellM;
    const o = 0.5 + walkSpanOffset(span);
    if (grid === 0) return [(c[0] + o) * M, c[1] * M, (c[2] + o) * M];
    return this.gridQueries(grid)!.frame.toWorld((c[0] + o) * M, c[1] * M, (c[2] + o) * M);
  }

  /** @internal a leg queued in its graph's queries. */
  leg(l: Leg, options: WalkQueryOptions, done: (a: WalkPathAnswer) => void): void {
    const q = l.grid === 0 ? this.world : this.gridQueries(l.grid)?.queries;
    if (q === undefined) {
      done({ status: 'unknown', cells: new Int32Array(0), cost: 0, hierarchy: false, corridor: 0, span: linkedAgent(options).span, run: { coarse: 0, cells: 0, inner: 0, slices: 0, ms: 0, restarts: 0, waits: 0, waited: 0 } });
      return;
    }
    q.path(l.from, l.to, options, done);
  }

  /** @internal a reach queued in a graph's queries, from seeds (its cells at their costs). */
  reachIn(grid: number, seeds: readonly { readonly at: P3; readonly cost: number }[] | P3, maxCost: number, options: WalkQueryOptions, done: (a: WalkReachAnswer) => void): boolean {
    const q = grid === 0 ? this.world : this.gridQueries(grid)?.queries;
    if (q === undefined) return false;
    q.reach(seeds, maxCost, { ...options, cells: true }, done);
    return true;
  }
}

/** A candidate way between graphs: its legs (each graph's) and the links' steps between them. */
interface Candidate {
  readonly legs: Leg[];
  readonly linkCost: number;
  readonly estimate: number;
}

class LinkedJob {
  finished = false;
  /** It waits for grids' graphs and links to be made before its legs (served again by {@link retry}). */
  waitingForGrids = false;
  private waitServes = 0;
  private waits = 0;
  private stale = false;
  private run: WalkQueryCost = { coarse: 0, cells: 0, inner: 0, slices: 0, ms: 0, restarts: 0, waits: 0, waited: 0 };
  private tried = 0;
  private best: { cost: number; legs: Leg[]; answers: WalkPathAnswer[] } | null = null;
  private anyUnknown = false;

  constructor(
    private readonly q: LinkedWalkQueries,
    private readonly from: P3,
    private readonly to: P3,
    private readonly options: WalkQueryOptions,
    private readonly done: (a: LinkedPathAnswer) => void,
  ) {}

  /** A leg's options: what is left of the query's wait goes to it (its legs before it and its own wait for the grids spent the rest). */
  private legOptions(): WalkQueryOptions {
    return { ...this.options, waitServes: Math.max(0, (this.options.waitServes ?? WALK_QUERY_WAIT_SERVES) - this.waitServes - this.run.waited) };
  }

  /** A serve while it waits: it tries again, and past its bound goes on with what is made. */
  retry(): void {
    this.waitServes++;
    this.begin();
  }

  begin(): void {
    const agent = linkedAgent(this.options);
    const stale = new Set<number>();
    const a = this.q.locate(this.from, agent, stale);
    const b = this.q.locate(this.to, agent, stale);
    for (const g of [a?.grid ?? 0, b?.grid ?? 0]) if (g !== 0) stale.add(g);
    if (!this.q.gridsCurrent(stale)) {
      if (this.waitServes < (this.options.waitServes ?? WALK_QUERY_WAIT_SERVES)) {
        if (!this.waitingForGrids) this.waits++;
        this.waitingForGrids = true;
        return;
      }
      this.stale = true;
    }
    this.waitingForGrids = false;
    // Both ends in one graph: that graph's own query.
    if (a === null || b === null || a.grid === b.grid) {
      const grid = a !== null && b !== null && a.grid === b.grid ? a.grid : 0;
      const from = grid === 0 ? this.from : a!.cell;
      const to = grid === 0 ? this.to : b!.cell;
      this.q.leg({ grid, from, to }, this.legOptions(), (w) => this.finish(w.status, [{ grid, from, to }], [w], w.cost, w.reason));
      return;
    }
    const cands = this.candidates(a, b);
    if (cands.length === 0) {
      this.finish('unreachable', [], [], 0);
      return;
    }
    this.next(cands, 0);
  }

  private candidates(a: Located, b: Located): Candidate[] {
    const q = this.q;
    const M = q.world.graph.cellM;
    const gridCell = (l: WalkLink): P3 => walkCellOf(l.part, l.g);
    const worldCell = (l: WalkLink): P3 => walkCellOf(l.world, l.w);
    const agent = linkedAgent(this.options);
    const gAt = (l: WalkLink): P3 => q.placeOf(l.grid, gridCell(l), agent.span);
    const o = 0.5 + walkSpanOffset(agent.span);
    const wAt = (l: WalkLink): P3 => [(worldCell(l)[0] + o) * M, worldCell(l)[1] * M, (worldCell(l)[2] + o) * M];
    // A link made for the walker's span, room for its height, not into a shut door unless it goes through them.
    const fits = (l: WalkLink): boolean => linkFits(l, agent, Math.round((gAt(l)[1] - wAt(l)[1]) / M));
    const doors = (list: WalkLink[], est: (l: WalkLink) => number): WalkLink[] => {
      const sorted = list.filter(fits).map((l) => [est(l), l] as const).sort((x, y) => x[0] - y[0]);
      const out: WalkLink[] = [];
      for (const [, l] of sorted) {
        if (out.length >= LINKED_PATH_DOORS) break;
        if (out.every((o) => dist(gAt(o), gAt(l)) > LINKED_DOOR_APART_M)) out.push(l);
      }
      return out;
    };
    if (a.grid !== 0 && b.grid !== 0) {
      const la = doors(q.links.linksOf(a.grid), (l) => dist(a.at, gAt(l)) + l.cost + dist(wAt(l), b.at));
      const lb = doors(q.links.linksOf(b.grid), (l) => dist(a.at, wAt(l)) + l.cost + dist(gAt(l), b.at));
      const out: Candidate[] = [];
      for (const x of la) for (const y of lb) out.push({ legs: [{ grid: a.grid, from: a.cell, to: gridCell(x) }, { grid: 0, from: worldCell(x), to: worldCell(y) }, { grid: b.grid, from: gridCell(y), to: b.cell }], linkCost: x.cost + y.cost, estimate: dist(a.at, gAt(x)) + x.cost + dist(wAt(x), wAt(y)) + y.cost + dist(gAt(y), b.at) });
      return out.sort((x, y) => x.estimate - y.estimate).slice(0, LINKED_PATH_DOORS);
    }
    if (a.grid !== 0) return doors(q.links.linksOf(a.grid), (l) => dist(a.at, gAt(l)) + l.cost + dist(wAt(l), b.at)).map((l) => ({ legs: [{ grid: a.grid, from: a.cell, to: gridCell(l) }, { grid: 0, from: worldCell(l), to: b.cell }], linkCost: l.cost, estimate: 0 }));
    return doors(q.links.linksOf(b.grid), (l) => dist(a.at, wAt(l)) + l.cost + dist(gAt(l), b.at)).map((l) => ({ legs: [{ grid: 0, from: a.cell, to: worldCell(l) }, { grid: b.grid, from: gridCell(l), to: b.cell }], linkCost: l.cost, estimate: 0 }));
  }

  /** Candidate `k`'s legs in turn; then the next candidate; then the answer. */
  private next(cands: Candidate[], k: number): void {
    if (k >= cands.length) {
      const b = this.best;
      if (b !== null) this.finish('found', b.legs, b.answers, b.cost);
      else this.finish(this.anyUnknown ? 'unknown' : 'unreachable', [], [], 0);
      return;
    }
    const c = cands[k]!;
    this.tried++;
    const answers: WalkPathAnswer[] = [];
    const go = (i: number): void => {
      if (i >= c.legs.length) {
        const cost = answers.reduce((n, a) => n + a.cost, c.linkCost);
        if (this.best === null || cost < this.best.cost) this.best = { cost, legs: c.legs, answers };
        this.next(cands, k + 1);
        return;
      }
      this.q.leg(c.legs[i]!, this.legOptions(), (w) => {
        this.count(w);
        if (w.status !== 'found') {
          if (w.status === 'unknown' || w.status === 'partial') this.anyUnknown = true;
          this.next(cands, k + 1);
          return;
        }
        answers.push(w);
        go(i + 1);
      });
    };
    go(0);
  }

  private count(w: WalkPathAnswer): void {
    const r = this.run;
    this.run = { coarse: r.coarse + w.run.coarse, cells: r.cells + w.run.cells, inner: r.inner + w.run.inner, slices: r.slices + w.run.slices, ms: r.ms + w.run.ms, restarts: r.restarts + w.run.restarts, waits: r.waits + w.run.waits, waited: r.waited + w.run.waited };
  }

  private finish(status: WalkStatus, legs: readonly Leg[], answers: readonly WalkPathAnswer[], cost: number, reason?: 'from' | 'to'): void {
    if (legs.length === 1 && answers.length === 1) this.count(answers[0]!);
    let n = 0;
    for (const a of answers) n += a.cells.length / 3;
    const points = new Float64Array(n * 3);
    const grids = new Int32Array(n);
    let k = 0;
    let stale = this.stale;
    answers.forEach((a, i) => {
      const grid = legs[i]!.grid;
      if (a.stale === true) stale = true;
      for (let j = 0; j < a.cells.length; j += 3, k++) {
        const p = this.q.placeOf(grid, [a.cells[j]!, a.cells[j + 1]!, a.cells[j + 2]!], a.span);
        points[k * 3] = p[0];
        points[k * 3 + 1] = p[1];
        points[k * 3 + 2] = p[2];
        grids[k] = grid;
      }
    });
    this.finished = true;
    const run = { ...this.run, waits: this.run.waits + this.waits, waited: this.run.waited + this.waitServes };
    this.q.waits += run.waits;
    this.q.restarts += run.restarts;
    this.done(Object.freeze({ status, ...(reason !== undefined ? { reason } : {}), points, grids, cost, legs: answers.length, tried: this.tried, ...(stale ? { stale: true as const } : {}), run }));
  }
}
