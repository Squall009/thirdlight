/**
 * A reach across a world's walk graph and its structure grids' graphs
 * (walk-graph-linked.ts): the places a walker can stand within a cost of a
 * point, whichever graph they are in.
 *
 * The reach runs in the graph of its start (a graph's own reach,
 * walk-graph-queries.ts); every place it settles that has links
 * (walk-graph-links.ts) the walker takes seeds the graph across with what is
 * left of the distance (the cost so far and the link's step), each graph's
 * reach started from all its seeds at their costs; the places those settle
 * seed back across in turn, wherever that is cheaper than what was settled
 * there. Each pass only lowers costs, and at most {@link LINKED_REACH_PASSES}
 * passes run (out of the street into a house and back out by another door is
 * two). A place's cost is the least found; the answer counts each place once.
 * Only the world's reach answers `unknown`: a structure grid's own frame past
 * its chunks is the world's, which the reach walks out into by the links.
 */
import { standableIn } from './walk-graph-cells';
import { linkedAgent, linkFits, type LinkedWalkQueries } from './walk-graph-linked';
import { WALK_QUERY_WAIT_SERVES, type WalkQueryCost, type WalkQueryOptions, type WalkReachAnswer } from './walk-graph-queries';

/** Passes of a reach across graphs: from its start's graph into the grids, back out, and in again. */
export const LINKED_REACH_PASSES = 4;

type P3 = readonly [number, number, number];

/** A reach answered across graphs (world metres). */
export interface LinkedReachAnswer {
  readonly status: 'found' | 'unreachable' | 'unknown';
  readonly reason?: 'from';
  /** Places (standing cells) in all graphs, each counted once. */
  readonly count: number;
  /** The box of the places' cells (world metres; a grid's cells turned with it), null: none. */
  readonly min: P3 | null;
  readonly max: P3 | null;
  /** Each place's floor middle (world metres, x y z flat) and its graph (0: the world grid), when asked. */
  readonly points: Float64Array | null;
  readonly grids: Int32Array | null;
  /** Graphs reached (1: the start's alone). */
  readonly graphs: number;
  readonly stale?: true;
  readonly run: WalkQueryCost;
}

interface Seed {
  readonly at: P3;
  readonly cost: number;
}

/** One reach across graphs (the module comment). */
export class LinkedReach {
  finished = false;
  /** Per graph: its places by cell key, their cells and least costs. */
  private readonly best = new Map<number, Map<string, { readonly at: P3; cost: number }>>();
  private pass = 0;
  private running = 0;
  private status: 'found' | 'unknown' = 'found';
  private stale = false;
  private run: WalkQueryCost = { coarse: 0, cells: 0, inner: 0, slices: 0, ms: 0, restarts: 0, waits: 0, waited: 0 };
  /** Seeds for the next pass, by graph. */
  private next = new Map<number, Seed[]>();

  constructor(
    private readonly q: LinkedWalkQueries,
    private readonly from: P3,
    private readonly maxCost: number,
    private readonly options: WalkQueryOptions & { readonly cells?: boolean },
    private readonly done: (a: LinkedReachAnswer) => void,
  ) {}

  /** Whether one of its passes still runs in a grid's queries. */
  holds(id: number): boolean {
    return !this.finished && this.best.has(id);
  }

  begin(): void {
    const agent = linkedAgent(this.options);
    const a = this.q.locate(this.from, agent);
    const grid = a?.grid ?? 0;
    // The start's own graph's reach snaps the point itself, as a reach in one graph does.
    this.launch(grid, grid === 0 ? this.from : a!.cell, true);
  }

  private launch(grid: number, from: P3 | Seed[], first: boolean): void {
    this.running++;
    // The passes share the query's wait: each is given what those before it left.
    const options = { ...this.options, waitServes: Math.max(0, (this.options.waitServes ?? WALK_QUERY_WAIT_SERVES) - this.run.waited) };
    const ok = this.q.reachIn(grid, from, this.maxCost, options, (w) => this.landed(grid, w, first));
    if (!ok) {
      this.running--;
      this.status = 'unknown';
    }
  }

  private landed(grid: number, w: WalkReachAnswer, first: boolean): void {
    this.running--;
    const r = this.run;
    this.run = { coarse: r.coarse, cells: r.cells + w.run.cells, inner: r.inner, slices: r.slices + w.run.slices, ms: r.ms + w.run.ms, restarts: r.restarts + w.run.restarts, waits: r.waits + w.run.waits, waited: r.waited + w.run.waited };
    if (w.stale === true) this.stale = true;
    // Only the world's reach can run into what is not loaded: a structure's own frame past its chunks is the world's.
    if (w.status === 'unknown' && grid === 0) this.status = 'unknown';
    if (first && w.status === 'unreachable' && w.count === 0) {
      this.finishWith('unreachable');
      return;
    }
    const agent = linkedAgent(this.options);
    const M = this.q.world.graph.cellM;
    let mine = this.best.get(grid);
    if (mine === undefined) this.best.set(grid, (mine = new Map()));
    const links = this.q.links;
    const graph = grid === 0 ? links.world : links.grid(grid)?.graph;
    const cells = w.cells!;
    const costs = w.costs!;
    for (let k = 0; k < cells.length / 3; k++) {
      const at: P3 = [cells[k * 3]!, cells[k * 3 + 1]!, cells[k * 3 + 2]!];
      const key = `${at[0]},${at[1]},${at[2]}`;
      const cost = costs[k]!;
      const had = mine.get(key);
      if (had !== undefined && had.cost <= cost) continue;
      if (had === undefined) mine.set(key, { at, cost });
      else had.cost = cost;
      if (graph === undefined) continue;
      // The links out of this place the walker takes, with what is left of the distance.
      const e = graph.grid.edge;
      const part = graph.chunkAt(Math.floor(at[0] / e), Math.floor(at[1] / e), Math.floor(at[2] / e));
      if (part === null) continue;
      const i = standableIn(part, at[0] - part.cx * e, at[1] - part.cy * e, at[2] - part.cz * e);
      if (i < 0) continue;
      for (const l of links.linksAt(part, i)) {
        const c = cost + l.cost;
        if (c > this.maxCost) continue;
        const intoGrid = grid === 0;
        const other = intoGrid ? l.grid : 0;
        const gc = cellOf(l.part, l.g);
        const wc = cellOf(l.world, l.w);
        // The link's rise, the grid's floor over the world's (a step's rule is the same either way).
        const rise = Math.round(this.q.placeOf(l.grid, gc)[1] / M - wc[1]);
        if (!linkFits(l, agent, rise)) continue;
        const to = intoGrid ? gc : wc;
        const there = this.best.get(other)?.get(`${to[0]},${to[1]},${to[2]}`);
        if (there !== undefined && there.cost <= c) continue;
        let list = this.next.get(other);
        if (list === undefined) this.next.set(other, (list = []));
        list.push({ at: to, cost: c });
      }
    }
    if (this.running > 0) return;
    this.pass++;
    if (this.next.size === 0 || this.pass >= LINKED_REACH_PASSES) {
      this.finishWith(this.status);
      return;
    }
    const seeds = this.next;
    this.next = new Map();
    for (const [g, list] of seeds) this.launch(g, list, false);
    if (this.running === 0) this.finishWith(this.status);
  }

  private finishWith(status: 'found' | 'unreachable' | 'unknown'): void {
    if (this.finished) return;
    this.finished = true;
    this.q.waits += this.run.waits;
    this.q.restarts += this.run.restarts;
    const M = this.q.world.graph.cellM;
    let count = 0;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const points: number[] | null = this.options.cells === true ? [] : null;
    const grids: number[] | null = this.options.cells === true ? [] : null;
    for (const [grid, places] of this.best) {
      const frame = grid === 0 ? null : (this.q.links.grid(grid)?.frame ?? null);
      for (const { at } of places.values()) {
        count++;
        // The cell's box corners in world metres (a grid's turned with it).
        for (let c = 0; c < 8; c++) {
          const x = (at[0] + (c & 1)) * M;
          const y = (at[1] + ((c >> 1) & 1)) * M;
          const z = (at[2] + ((c >> 2) & 1)) * M;
          const p = frame === null ? [x, y, z] : frame.toWorld(x, y, z);
          for (let a = 0; a < 3; a++) {
            min[a] = Math.min(min[a]!, p[a]!);
            max[a] = Math.max(max[a]!, p[a]!);
          }
        }
        if (points !== null) {
          const p = this.q.placeOf(grid, at);
          points.push(p[0], p[1], p[2]);
          grids!.push(grid);
        }
      }
    }
    this.done(Object.freeze({
      status: count === 0 && status !== 'unknown' ? 'unreachable' : status,
      ...(count === 0 && status === 'unreachable' ? { reason: 'from' as const } : {}),
      count,
      min: count > 0 ? (Object.freeze([min[0]!, min[1]!, min[2]!]) as P3) : null,
      max: count > 0 ? (Object.freeze([max[0]!, max[1]!, max[2]!]) as P3) : null,
      points: points === null ? null : Float64Array.from(points),
      grids: grids === null ? null : Int32Array.from(grids),
      graphs: this.best.size,
      ...(this.stale ? { stale: true as const } : {}),
      run: this.run,
    }));
  }
}

const cellOf = (c: { readonly cx: number; readonly cy: number; readonly cz: number; readonly edge: number; readonly col: Uint16Array; readonly ys: Uint8Array }, i: number): P3 => {
  const e = c.edge;
  const colI = c.col[i]!;
  return [c.cx * e + ((colI / e) | 0), c.cy * e + c.ys[i]!, c.cz * e + (colI % e)];
};
