/**
 * One search core for every graph a path or a reach is asked of: A* toward a
 * target with an estimate, or Dijkstra out to every node within a cost (the
 * same loop with no estimate and no target). It knows nothing of what the
 * nodes are: a graph names them by integers and hands over each node's steps
 * with their costs.
 *
 * - **Bounded and resumable.** `run(budget)` expands at most `budget` nodes
 *   and returns `open` when it stopped with work left; the next `run` goes
 *   on from there with nothing lost, so a long query is spread over frames
 *   and the result is the one an uncut run gives.
 * - **No allocation per node.** The state (cost so far, estimate, parent,
 *   the open list's positions) is kept in typed arrays indexed by node, reused
 *   from search to search: a generation stamp a node marks it as met by the
 *   current search, so nothing is cleared between searches. The arrays grow
 *   (doubling) when a graph names a node past them, which a graph that hands
 *   out ids as it is walked does.
 * - **The open list** is a binary heap of node ids ordered by estimated total
 *   cost, then by the estimate still to go (on open ground the search heads
 *   straight on instead of widening every way), then by id: the same graph
 *   gives the same path.
 * - **Optimal** while the estimate never exceeds the cost still to go (it is
 *   admissible); a node met again by a cheaper way after it was expanded is
 *   opened again, so an estimate that is admissible but not consistent still
 *   gives the cheapest path.
 */
import { grownArray, grownCapacity } from './grow';

/** A graph a search walks: nodes are integers from 0. */
export interface SearchGraph {
  /** Calls `step(to, cost)` once for each step out of `node` (`cost` ≥ 0 and finite; a step of another cost is skipped). */
  steps(node: number, step: (to: number, cost: number) => void): void;
}

/** What a search is asked: where it starts, what it heads for and how far it may go. */
export interface SearchRequest {
  /** The start node, or several (each at cost 0). */
  readonly from: number | readonly number[];
  /** The target: a node, or a test a node passes (absent: no target, every node within `maxCost` is settled). */
  readonly target?: number | ((node: number) => boolean);
  /** The estimate of the cost still to go from a node (absent: 0, a Dijkstra). Admissible for the cheapest path. */
  readonly estimate?: (node: number) => number;
  /** Nodes past this cost are never opened (default: none). */
  readonly maxCost?: number;
}

/**
 * Where a search stands: `open` (it stopped at its budget with nodes still to expand: run it again), `found` (the
 * target was expanded: its path is the cheapest), `done` (nothing left to expand: no target reached, or every node within
 * the cost settled).
 */
export type SearchStatus = 'open' | 'found' | 'done';

/** No node. */
const NONE = -1;
/** A node's heap position once it was expanded. */
const CLOSED = -2;
/** Costs equal to this much are the same (sums of square roots differ in their last bits by the order they were added). */
const COST_EPS = 1e-9;

/** A reusable search (the module comment). One search at a time; `start` begins the next. */
export class PathSearch {
  private cap = 0;
  private stamp = 0;
  private gen = new Uint32Array(0);
  private g = new Float64Array(0);
  private f = new Float64Array(0);
  private h = new Float64Array(0);
  private parent = new Int32Array(0);
  private pos = new Int32Array(0);
  /** A node's place in `order` (−1: not expanded by this search). */
  private at = new Int32Array(0);
  private heap = new Int32Array(0);
  private heapSize = 0;
  /** The nodes expanded, in order (−1 where a node expanded again left its earlier place). */
  private order = new Int32Array(0);
  private orderSize = 0;
  private graph: SearchGraph | null = null;
  private targetNode = NONE;
  private targetTest: ((node: number) => boolean) | null = null;
  private estimate: ((node: number) => number) | null = null;
  private maxCost = Infinity;
  private state: SearchStatus = 'done';
  private found = NONE;
  private best = NONE;
  private expandedCount = 0;
  private cur = NONE;
  private curG = 0;
  private readonly relax: (to: number, cost: number) => void;

  constructor(initialNodes = 0) {
    if (initialNodes > 0) this.fit(initialNodes - 1);
    this.relax = (to: number, cost: number): void => {
      if (!(cost >= 0) || cost === Infinity || !(to >= 0)) return;
      const ng = this.curG + cost;
      if (ng > this.maxCost + COST_EPS) return;
      if (to >= this.cap) this.fit(to);
      if (this.gen[to] !== this.stamp) {
        this.meet(to, ng, this.cur);
        return;
      }
      if (ng >= this.g[to]! - COST_EPS) return;
      this.g[to] = ng;
      this.f[to] = ng + this.h[to]!;
      this.parent[to] = this.cur;
      const p = this.pos[to]!;
      if (p >= 0) this.up(p);
      else this.push(to);
    };
  }

  /** Begins a search over `graph` (the last one's state is dropped, nothing is cleared). */
  start(graph: SearchGraph, request: SearchRequest): void {
    this.graph = graph;
    this.stamp = (this.stamp + 1) >>> 0;
    if (this.stamp === 0) {
      this.gen.fill(0);
      this.stamp = 1;
    }
    this.heapSize = 0;
    this.orderSize = 0;
    this.expandedCount = 0;
    this.found = NONE;
    this.best = NONE;
    const target = request.target;
    this.targetNode = typeof target === 'number' ? target : NONE;
    this.targetTest = typeof target === 'function' ? target : null;
    this.estimate = request.estimate ?? null;
    this.maxCost = request.maxCost ?? Infinity;
    this.state = 'open';
    const from = typeof request.from === 'number' ? [request.from] : request.from;
    for (const s of from) {
      if (!(s >= 0) || !Number.isInteger(s)) continue;
      if (s >= this.cap) this.fit(s);
      if (this.gen[s] !== this.stamp) this.meet(s, 0, NONE);
    }
    if (this.heapSize === 0) this.state = 'done';
  }

  /**
   * Expands up to `budget` nodes (at least one while any is open) and says where the search stands: `open` means run
   * it again to go on. A search that is `found` or `done` stays so.
   */
  run(budget = Infinity): SearchStatus {
    if (this.state !== 'open') return this.state;
    const graph = this.graph!;
    let left = Math.max(1, budget);
    while (this.heapSize > 0) {
      if (left <= 0) return this.state;
      const n = this.pop();
      this.pos[n] = CLOSED;
      if (this.orderSize >= this.order.length) this.order = grownArray(this.order, grownCapacity(this.order.length, this.orderSize + 1, 64));
      // A node expanded again (met by a cheaper way after it was expanded) keeps only its last place in the order.
      if (this.at[n]! >= 0) this.order[this.at[n]!] = NONE;
      this.at[n] = this.orderSize;
      this.order[this.orderSize++] = n;
      this.expandedCount++;
      left--;
      const b = this.best;
      if (b === NONE || this.h[n]! < this.h[b]! - COST_EPS || (Math.abs(this.h[n]! - this.h[b]!) <= COST_EPS && this.g[n]! < this.g[b]!)) this.best = n;
      if (n === this.targetNode || (this.targetTest !== null && this.targetTest(n))) {
        this.found = n;
        this.state = 'found';
        return this.state;
      }
      this.cur = n;
      this.curG = this.g[n]!;
      graph.steps(n, this.relax);
    }
    this.state = 'done';
    return this.state;
  }

  /** Where the search stands (as `run` last said). */
  get status(): SearchStatus {
    return this.state;
  }

  /** Nodes expanded so far by this search. */
  get expanded(): number {
    return this.expandedCount;
  }

  /** The target node expanded (−1: none yet). */
  get target(): number {
    return this.found;
  }

  /** The node expanded so far with the least estimate still to go (ties: the cheaper): where a search that ends without its target got closest (−1: none). */
  get closest(): number {
    return this.best;
  }

  /** Nodes open now (met, not expanded). */
  get openCount(): number {
    return this.heapSize;
  }

  /** The cheapest cost found to a node so far (Infinity: not met). Final once the node is expanded. */
  cost(node: number): number {
    return node >= 0 && node < this.cap && this.gen[node] === this.stamp ? this.g[node]! : Infinity;
  }

  /** Whether a node was expanded (its cost is final). */
  settled(node: number): boolean {
    return node >= 0 && node < this.cap && this.gen[node] === this.stamp && this.pos[node] === CLOSED;
  }

  /** The nodes from a start to `node` (default: the target) by the cheapest way found; empty when it was not met. */
  path(node = this.found): number[] {
    if (!(node >= 0) || node >= this.cap || this.gen[node] !== this.stamp) return [];
    const out: number[] = [];
    for (let n = node; n !== NONE; n = this.parent[n]!) out.push(n);
    return out.reverse();
  }

  /** Each expanded node with its cost, in the order expanded, once each (a node opened again is given at its last cost). */
  forEachSettled(f: (node: number, cost: number) => void): void {
    for (let i = 0; i < this.orderSize; i++) {
      const n = this.order[i]!;
      if (n !== NONE && this.pos[n] === CLOSED) f(n, this.g[n]!);
    }
  }

  /** Nodes expanded and not open again (what `forEachSettled` visits, at most). */
  get settledCount(): number {
    return this.orderSize;
  }

  /** Bytes the search's arrays hold. */
  get bytes(): number {
    return this.cap * (4 + 8 * 3 + 4 * 4) + this.order.byteLength;
  }

  private meet(n: number, g: number, parent: number): void {
    this.gen[n] = this.stamp;
    const h = this.estimate === null ? 0 : this.estimate(n);
    this.g[n] = g;
    this.h[n] = h;
    this.f[n] = g + h;
    this.parent[n] = parent;
    this.at[n] = NONE;
    this.push(n);
  }

  /** The arrays hold node `n`. */
  private fit(n: number): void {
    const cap = grownCapacity(this.cap, n + 1, 256);
    if (cap === this.cap) return;
    this.gen = grownArray(this.gen, cap);
    this.g = grownArray(this.g, cap);
    this.f = grownArray(this.f, cap);
    this.h = grownArray(this.h, cap);
    this.parent = grownArray(this.parent, cap);
    this.pos = grownArray(this.pos, cap);
    this.at = grownArray(this.at, cap);
    this.heap = grownArray(this.heap, cap);
    this.cap = cap;
  }

  private less(a: number, b: number): boolean {
    const fa = this.f[a]!;
    const fb = this.f[b]!;
    if (fa < fb - COST_EPS) return true;
    if (fa > fb + COST_EPS) return false;
    const ha = this.h[a]!;
    const hb = this.h[b]!;
    if (ha < hb - COST_EPS) return true;
    if (ha > hb + COST_EPS) return false;
    return a < b;
  }

  private push(n: number): void {
    // A node opened again after it was expanded is in the heap once more: the heap is as long as the nodes.
    if (this.heapSize >= this.heap.length) this.heap = grownArray(this.heap, grownCapacity(this.heap.length, this.heapSize + 1, 256));
    this.heap[this.heapSize] = n;
    this.pos[n] = this.heapSize;
    this.heapSize++;
    this.up(this.heapSize - 1);
  }

  private pop(): number {
    const heap = this.heap;
    const top = heap[0]!;
    this.heapSize--;
    if (this.heapSize > 0) {
      const last = heap[this.heapSize]!;
      heap[0] = last;
      this.pos[last] = 0;
      this.down(0);
    }
    return top;
  }

  private up(i: number): void {
    const heap = this.heap;
    const n = heap[i]!;
    while (i > 0) {
      const j = (i - 1) >> 1;
      const p = heap[j]!;
      if (!this.less(n, p)) break;
      heap[i] = p;
      this.pos[p] = i;
      i = j;
    }
    heap[i] = n;
    this.pos[n] = i;
  }

  private down(i: number): void {
    const heap = this.heap;
    const size = this.heapSize;
    const n = heap[i]!;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= size) break;
      const r = l + 1;
      const c = r < size && this.less(heap[r]!, heap[l]!) ? r : l;
      if (!this.less(heap[c]!, n)) break;
      heap[i] = heap[c]!;
      this.pos[heap[i]!] = i;
      i = c;
    }
    heap[i] = n;
    this.pos[n] = i;
  }
}
