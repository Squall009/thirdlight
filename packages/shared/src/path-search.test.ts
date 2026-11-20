import { describe, expect, it } from 'vitest';

import { mulberry32 } from './random';
import { PathSearch, type SearchGraph } from './path-search';

interface Scrap {
  readonly n: number;
  readonly xy: Float64Array;
  readonly adj: Array<Array<readonly [number, number]>>;
}

/** A random directed graph with nodes in the unit square and step costs at least their straight distance (so the distance is an admissible estimate). */
function scrap(seed: number, n: number, steps: number): Scrap {
  const r = mulberry32(seed);
  const xy = new Float64Array(n * 2);
  for (let i = 0; i < n * 2; i++) xy[i] = r() * 10;
  const adj: Array<Array<readonly [number, number]>> = Array.from({ length: n }, () => []);
  for (let k = 0; k < steps; k++) {
    const a = Math.floor(r() * n);
    const b = Math.floor(r() * n);
    const d = Math.hypot(xy[a * 2]! - xy[b * 2]!, xy[a * 2 + 1]! - xy[b * 2 + 1]!);
    // Some steps cost exactly their distance (ties on straight runs), others more.
    const cost = r() < 0.3 ? d : d * (1 + r() * 2);
    adj[a]!.push([b, cost]);
  }
  return { n, xy, adj };
}

const graphOf = (s: Scrap): SearchGraph => ({ steps: (node, step) => s.adj[node]!.forEach(([to, c]) => step(to, c)) });
const dist = (s: Scrap, a: number, b: number): number => Math.hypot(s.xy[a * 2]! - s.xy[b * 2]!, s.xy[a * 2 + 1]! - s.xy[b * 2 + 1]!);

/** Every node's cheapest cost from `from`, by Bellman–Ford (the brute force). */
function brute(s: Scrap, from: number): Float64Array {
  const d = new Float64Array(s.n).fill(Infinity);
  d[from] = 0;
  for (let round = 0; round < s.n; round++) {
    let changed = false;
    for (let a = 0; a < s.n; a++) {
      if (d[a] === Infinity) continue;
      for (const [b, c] of s.adj[a]!) if (d[a]! + c < d[b]! - 1e-12) {
        d[b] = d[a]! + c;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return d;
}

/** A path's cost along the graph's cheapest steps between its nodes (and that each step exists). */
function pathCost(s: Scrap, path: readonly number[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const steps = s.adj[path[i - 1]!]!.filter(([b]) => b === path[i]);
    expect(steps.length).toBeGreaterThan(0);
    total += Math.min(...steps.map(([, c]) => c));
  }
  return total;
}

describe('PathSearch', () => {
  it('finds the cheapest path on 240 random graphs, as a brute force does', () => {
    const search = new PathSearch();
    let found = 0;
    let unreachable = 0;
    for (let k = 0; k < 240; k++) {
      const n = 5 + (k % 60);
      const s = scrap(1000 + k, n, n * (1 + (k % 4)));
      const from = k % n;
      const to = (k * 7 + 3) % n;
      const truth = brute(s, from);
      search.start(graphOf(s), { from, target: to, estimate: (v) => dist(s, v, to) });
      const status = search.run();
      if (truth[to] === Infinity) {
        expect(status).toBe('done');
        expect(search.path(to)).toEqual([]);
        unreachable++;
        continue;
      }
      expect(status).toBe('found');
      const path = search.path();
      expect(path[0]).toBe(from);
      expect(path[path.length - 1]).toBe(to);
      expect(search.cost(to)).toBeCloseTo(truth[to]!, 9);
      // Ties are allowed: another path of the same cost is as good.
      expect(pathCost(s, path)).toBeCloseTo(truth[to]!, 9);
      found++;
    }
    expect(found).toBeGreaterThan(120);
    expect(unreachable).toBeGreaterThan(10);
  });

  it('settles every node within a cost and only those, as a brute force does (Dijkstra: no estimate, no target)', () => {
    const search = new PathSearch();
    for (let k = 0; k < 200; k++) {
      const n = 8 + (k % 50);
      const s = scrap(5000 + k, n, n * 3);
      const from = k % n;
      const truth = brute(s, from);
      const limit = 2 + (k % 9);
      search.start(graphOf(s), { from, maxCost: limit });
      expect(search.run()).toBe('done');
      const got = new Map<number, number>();
      search.forEachSettled((node, cost) => {
        expect(got.has(node)).toBe(false);
        got.set(node, cost);
      });
      const want = [...truth.keys()].filter((v) => truth[v]! <= limit + 1e-9);
      expect([...got.keys()].sort((a, b) => a - b)).toEqual(want);
      for (const v of want) expect(got.get(v)).toBeCloseTo(truth[v]!, 9);
    }
  });

  it('gives the same path when cut at every k expansions and resumed', () => {
    const whole = new PathSearch();
    const cut = new PathSearch();
    for (let k = 0; k < 200; k++) {
      const n = 20 + (k % 40);
      const s = scrap(9000 + k, n, n * 3);
      const from = 0;
      const to = n - 1;
      const estimate = (v: number): number => dist(s, v, to);
      whole.start(graphOf(s), { from, target: to, estimate });
      const a = whole.run();
      const every = 1 + (k % 7);
      cut.start(graphOf(s), { from, target: to, estimate });
      let runs = 0;
      let b = cut.run(every);
      while (b === 'open') {
        runs++;
        b = cut.run(every);
      }
      expect(b).toBe(a);
      expect(cut.path()).toEqual(whole.path());
      expect(cut.expanded).toBe(whole.expanded);
      // A search that expanded more than `every` nodes was cut.
      if (whole.expanded > every) expect(runs).toBeGreaterThan(0);
    }
  });

  it('answers an unreachable target with done, its closest node and every node it could reach', () => {
    // Two clusters joined one way: 0 → 1 → 2, 3 → 4; the target 4 is unreachable from 0.
    const xy = Float64Array.of(0, 0, 1, 0, 2, 0, 3, 0, 4, 0);
    const s: Scrap = { n: 5, xy, adj: [[[1, 1]], [[2, 1]], [], [[4, 1]], []] };
    const search = new PathSearch();
    search.start(graphOf(s), { from: 0, target: 4, estimate: (v) => dist(s, v, 4) });
    expect(search.run()).toBe('done');
    expect(search.target).toBe(-1);
    expect(search.closest).toBe(2);
    expect(search.path(search.closest)).toEqual([0, 1, 2]);
    expect(search.expanded).toBe(3);
    expect(search.settled(3)).toBe(false);
  });

  it('reuses its arrays across searches (generations) and grows when a graph names a node past them', () => {
    const search = new PathSearch(4);
    // A line 0 → 1 → … → n − 1, walked again with ever longer lines.
    for (const n of [3, 50, 7, 3000, 12]) {
      const g: SearchGraph = { steps: (v, step) => v + 1 < n && step(v + 1, 1) };
      search.start(g, { from: 0, target: n - 1, estimate: (v) => n - 1 - v });
      expect(search.run()).toBe('found');
      expect(search.cost(n - 1)).toBe(n - 1);
      expect(search.path().length).toBe(n);
      // Nothing of the earlier, longer search reads as met.
      expect(search.cost(n + 5)).toBe(Infinity);
    }
    expect(search.bytes).toBeGreaterThan(3000 * 40);
  });

  it('opens a node again when an admissible but inconsistent estimate expanded it too early', () => {
    // 0 → 1 (1), 0 → 2 (3), 1 → 2 (1), 2 → 3 (2). The estimate at 1 is 2.5 (admissible: 1 → 3 costs 3), so 2 is
    // expanded first at cost 3 (f 3 against 1's 3.5), then met again at 2 through 1 and expanded once more.
    const adj: Array<Array<readonly [number, number]>> = [[[1, 1], [2, 3]], [[2, 1]], [[3, 2]], []];
    const h = [0, 2.5, 0, 0];
    const search = new PathSearch();
    search.start({ steps: (v, step) => adj[v]!.forEach(([b, c]) => step(b, c)) }, { from: 0, target: 3, estimate: (v) => h[v]! });
    expect(search.run()).toBe('found');
    expect(search.cost(3)).toBe(4);
    expect(search.expanded).toBe(5);
    let listed = 0;
    search.forEachSettled(() => listed++);
    expect(listed).toBe(4);
    expect(search.path()).toEqual([0, 1, 2, 3]);
  });
});
