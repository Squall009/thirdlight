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
 * Not searched: a way between two points of one graph that is shorter through
 * a grid (in at one door, out at another); a structure grid's walkers other
 * than the default (another height or drops search the world's graph alone).
 */
import type { GridFrame } from './grid-place';
import type { WalkGraph } from './walk-graph';
import { walkCellOf, DEFAULT_WALK_AGENT } from './walk-graph-cells';
import type { WalkGraphLinks, WalkLink } from './walk-graph-links';
import { WalkQueries, type WalkPathAnswer, type WalkQueryCost, type WalkQueryOptions, type WalkStatus } from './walk-graph-queries';

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
  readonly run: WalkQueryCost;
}

/** A structure grid as the queries read it. */
interface QueryGrid {
  readonly id: number;
  readonly frame: GridFrame;
  readonly graph: WalkGraph;
  readonly queries: WalkQueries;
}

interface Located {
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

/** The world's queries and its grids', and the queries between them (the module comment). */
export class LinkedWalkQueries {
  private readonly grids = new Map<number, QueryGrid>();
  private readonly jobs: LinkedJob[] = [];

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

  /** Queries waiting: the joined ones, and every graph's own legs. */
  get queued(): number {
    let n = this.jobs.length + this.world.queued;
    for (const g of this.grids.values()) n += g.queries.queued;
    return n;
  }

  /** Serves the world's queue and the grids' within `ms` (the world's first); returns the legs answered. */
  serve(ms: number): number {
    const t0 = performance.now();
    let n = this.world.serve(ms);
    for (const g of this.grids.values()) {
      if (g.queries.queued === 0) continue;
      const left = ms - (performance.now() - t0);
      if (left <= 0 && n > 0) break;
      n += g.queries.serve(Math.max(0, left));
    }
    for (let i = 0; i < this.jobs.length; ) if (this.jobs[i]!.finished) this.jobs.splice(i, 1);
    else i++;
    // A grid's searches are let go once its legs are answered: a town holds many grids, few searched at once.
    for (const [id, g] of this.grids) if (g.queries.queued === 0) this.grids.delete(id);
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

  /** @internal where a world cell is: the nearest standable cell of the world's graph or a grid's at or under it. */
  locate(p: P3): Located | null {
    const M = this.world.graph.cellM;
    let best: Located | null = null;
    let bestD = Infinity;
    const w = this.world.snap(p, DEFAULT_WALK_AGENT);
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
      if (g.graph.chunkAt(Math.floor(gc[0] / e), Math.floor(gc[1] / e), Math.floor(gc[2] / e)) === null) continue;
      const s = this.gridQueries(g.id)!.queries.snap(gc, DEFAULT_WALK_AGENT);
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

  /** @internal a cell of a graph at its floor's middle in world metres. */
  placeOf(grid: number, c: P3): P3 {
    const M = this.world.graph.cellM;
    if (grid === 0) return [(c[0] + 0.5) * M, c[1] * M, (c[2] + 0.5) * M];
    return this.gridQueries(grid)!.frame.toWorld((c[0] + 0.5) * M, c[1] * M, (c[2] + 0.5) * M);
  }

  /** @internal a leg queued in its graph's queries. */
  leg(l: Leg, options: WalkQueryOptions, done: (a: WalkPathAnswer) => void): void {
    const q = l.grid === 0 ? this.world : this.gridQueries(l.grid)?.queries;
    if (q === undefined) {
      done({ status: 'unknown', cells: new Int32Array(0), cost: 0, hierarchy: false, corridor: 0, run: { coarse: 0, cells: 0, inner: 0, slices: 0, ms: 0, restarts: 0 } });
      return;
    }
    q.path(l.from, l.to, options, done);
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
  private run = { coarse: 0, cells: 0, inner: 0, slices: 0, ms: 0, restarts: 0 };
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

  begin(): void {
    const a = this.q.locate(this.from);
    const b = this.q.locate(this.to);
    // Not a default walker, or both ends in one graph: that graph's own query.
    const plain = this.options.height !== undefined || (this.options.maxDrop ?? 0) >= 2;
    if (a === null || b === null || plain || a.grid === b.grid) {
      const grid = a !== null && b !== null && a.grid === b.grid ? a.grid : 0;
      const from = grid === 0 ? this.from : a!.cell;
      const to = grid === 0 ? this.to : b!.cell;
      this.q.leg({ grid, from, to }, this.options, (w) => this.finish(w.status, [{ grid, from, to }], [w], w.cost, w.reason));
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
    const gAt = (l: WalkLink): P3 => q.placeOf(l.grid, gridCell(l));
    const wAt = (l: WalkLink): P3 => [(worldCell(l)[0] + 0.5) * M, worldCell(l)[1] * M, (worldCell(l)[2] + 0.5) * M];
    const doors = (list: WalkLink[], est: (l: WalkLink) => number): WalkLink[] => {
      const sorted = list.map((l) => [est(l), l] as const).sort((x, y) => x[0] - y[0]);
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
      this.q.leg(c.legs[i]!, this.options, (w) => {
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
    this.run = { coarse: r.coarse + w.run.coarse, cells: r.cells + w.run.cells, inner: r.inner + w.run.inner, slices: r.slices + w.run.slices, ms: r.ms + w.run.ms, restarts: r.restarts + w.run.restarts };
  }

  private finish(status: WalkStatus, legs: readonly Leg[], answers: readonly WalkPathAnswer[], cost: number, reason?: 'from' | 'to'): void {
    if (legs.length === 1 && answers.length === 1) this.count(answers[0]!);
    let n = 0;
    for (const a of answers) n += a.cells.length / 3;
    const points = new Float64Array(n * 3);
    const grids = new Int32Array(n);
    let k = 0;
    answers.forEach((a, i) => {
      const grid = legs[i]!.grid;
      for (let j = 0; j < a.cells.length; j += 3, k++) {
        const p = this.q.placeOf(grid, [a.cells[j]!, a.cells[j + 1]!, a.cells[j + 2]!]);
        points[k * 3] = p[0];
        points[k * 3 + 1] = p[1];
        points[k * 3 + 2] = p[2];
        grids[k] = grid;
      }
    });
    this.finished = true;
    this.done(Object.freeze({ status, ...(reason !== undefined ? { reason } : {}), points, grids, cost, legs: answers.length, tried: this.tried, run: this.run }));
  }
}
