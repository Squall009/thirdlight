/**
 * Walking a block layer as a graph: where something can stand, which
 * neighbouring places it can step to, a path between two places (A*) and the
 * places reachable from some (a flood by cost). `ctx.grid`'s walk queries and
 * the editor's reachability check read this one module, so a script's path
 * and the Problems line agree.
 *
 * A place to stand is the top of a block (any cell placement with a shape
 * other than `none`; a larger block's covered cells through `anchorOf`) with
 * free space above it — the headroom, up to the next block in the column — on
 * a slope no steeper than the limit. It is named by the cell whose top it is
 * (for a larger block: the column's own cell in its top row). A column can
 * hold several (a floor, and the floor above it).
 *
 * A step goes to one of the four neighbouring columns (or eight, diagonally,
 * when both orthogonal ways round the corner can be walked too). It is
 * allowed when the two tops differ by at most the step limit up (or the drop
 * limit down) where they meet — the middle of the shared side, so a ramp's
 * low end meets the floor at no height, a stair's front at half a cell, a
 * hill's sloped cells at none — when both columns are free to the higher
 * top plus the headroom, and when no edge piece that blocks passage (a wall,
 * a closed door: `edgeBlocks`) stands on the shared side in the rows the
 * walker passes through. Its cost is the distance between the two places
 * (metres, the height difference included), times what the caller's `enter`
 * gives the place stepped onto.
 *
 * What it reads is a `BlockGridReader`: a grid as its kits show it walks the
 * swapped blocks (a burnt door that fell apart lets the walker through).
 * Deterministic: the same grid and settings give the same path.
 */
import { blockTypeIsEdge, edgeBlocks, edgeOfSide, type BlockEdgeSide } from './block-edges';
import { cellKeyOf, type BlockGridReader } from './block-grid';
import { rotatedFootprint, type BlockCell, type BlockType } from './block-layers';
import { anchoredTopAt } from './block-surface';

/** How a walker moves (metres and degrees). */
export interface WalkSettings {
  /** How far a step may rise (m). */
  readonly maxStep: number;
  /** How far a step may drop (m). */
  readonly maxDrop: number;
  /** The free height a place needs above it (m). */
  readonly headroom: number;
  /** The steepest top that can be stood on (degrees). */
  readonly maxSlope: number;
  /** Steps across a cell's corner too (both ways round the corner walkable). */
  readonly diagonal: boolean;
}

/** The most places one path or reach query visits (an engine bound protecting a step's budget). */
export const WALK_QUERY_MAX_NODES = 65_536;

/** A place to stand. */
export interface WalkPlace {
  /** The cell whose top it is. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The top's height at the column's centre (layer-local metres). */
  readonly height: number;
  /** Degrees from level at the column's centre. */
  readonly slope: number;
  /** The bottom of the next block above (layer-local metres; Infinity: none). */
  readonly ceiling: number;
  /** The cell key (`cellKeyOf`). */
  readonly key: number;
}

interface Place extends WalkPlace {
  /** The top's height at a layer-local point of the column (metres). */
  topAt(lx: number, lz: number): number;
  /** The top's height at the middle of each side (`SIDES` order; NaN: not read yet). */
  readonly sides: Float64Array;
}

/** The side across from each of `SIDES`. */
const OPPOSITE = [1, 0, 3, 2] as const;

const EPS = 1e-6;
const SIDES: readonly (readonly [number, number, BlockEdgeSide])[] = [
  [1, 0, '+x'],
  [-1, 0, '-x'],
  [0, 1, '+z'],
  [0, -1, '-z'],
];

/** One step to a neighbouring place: where, and what it costs. */
export interface WalkStep {
  readonly place: WalkPlace;
  readonly cost: number;
}

export interface WalkGraphOptions {
  /** The anchor of a cell a larger block's footprint covers (none: such cells are empty). */
  readonly anchorOf?: (x: number, y: number, z: number) => readonly [number, number, number] | null;
  /** Whether a place can be stood on at all besides its shape (a game's "walkable" metadata); absent: every one. */
  readonly standable?: (x: number, y: number, z: number) => boolean;
}

/** The walk graph of one layer as it is now (places are found lazily and kept; build a new one after the grid changes). */
export class BlockWalkGraph {
  private readonly columns = new Map<number, readonly Place[]>();
  /** Whether an edge blocks passage (`cellKeyOf` × 2 + axis), read once per graph. */
  private readonly edgeBlocked = new Map<number, boolean>();

  constructor(
    readonly grid: BlockGridReader,
    private readonly types: ReadonlyMap<string, BlockType>,
    readonly settings: WalkSettings,
    private readonly options: WalkGraphOptions = {},
  ) {}

  /** The block a column's cell (`stored`: its own, null: empty) is part of when walking meets it (its anchor's, for a covered cell): its cell and anchor. */
  private solidAt(x: number, y: number, z: number, stored: BlockCell | null): { cell: BlockCell; anchor: readonly [number, number, number] } | null {
    let cell = stored;
    let anchor: readonly [number, number, number] = [x, y, z];
    if (cell?.block === undefined) {
      const a = this.options.anchorOf?.(x, y, z) ?? null;
      if (a === null) return null;
      cell = this.grid.get(a[0], a[1], a[2]);
      anchor = a;
      if (cell?.block === undefined) return null;
    }
    const t = this.types.get(cell.block!);
    if (t === undefined || t.shape === 'none' || blockTypeIsEdge(t)) return null;
    return { cell, anchor };
  }

  /** The columns read so far. */
  get columnCount(): number {
    return this.columns.size;
  }

  /** The places of a column, lowest first. */
  placesIn(x: number, z: number): readonly WalkPlace[] {
    return this.column(x, z);
  }

  private column(x: number, z: number): readonly Place[] {
    const g = this.grid;
    if (x < g.min[0]! || x >= g.max[0]! || z < g.min[2]! || z >= g.max[2]!) return [];
    const ck = cellKeyOf(x, 0, z);
    const hit = this.columns.get(ck);
    if (hit !== undefined) return hit;
    const out: Place[] = [];
    const cs = g.cellSize;
    const s = this.settings;
    const cxm = (x + 0.5) * cs[0]!;
    const czm = (z + 0.5) * cs[2]!;
    let ceiling = Infinity;
    let aboveSolid = false;
    // The column's own cells read once (a cell read by cell costs a chunk lookup each).
    const own = new Map<number, BlockCell>();
    g.forEachInColumn(x, z, (y, index) => own.set(y, g.valueOf(index)));
    if (own.size === 0 && this.options.anchorOf === undefined) {
      this.columns.set(ck, out);
      return out;
    }
    for (let y = g.max[1]! - 1; y >= g.min[1]!; y--) {
      const stored = own.get(y) ?? null;
      if (stored === null && this.options.anchorOf === undefined) {
        aboveSolid = false;
        continue;
      }
      const solid = this.solidAt(x, y, z, stored);
      if (solid === null) {
        aboveSolid = false;
        continue;
      }
      if (!aboveSolid) {
        const { cell, anchor } = solid;
        const top = anchoredTopAt(g, this.types, anchor, cell, cxm, czm);
        if (top !== null) {
          const height = anchor[1] * cs[1]! + top.sample.height;
          const slope = (Math.atan(Math.sqrt(top.sample.gx * top.sample.gx + top.sample.gz * top.sample.gz)) * 180) / Math.PI;
          if (ceiling - height >= s.headroom - EPS && slope <= s.maxSlope + 1e-9 && (this.options.standable?.(x, y, z) ?? true)) {
            const types = this.types;
            // A flat top is the same height everywhere over its column.
            const flat = top.sample.gx === 0 && top.sample.gz === 0 && types.get(cell.block!)!.shape !== 'stairs' && types.get(cell.block!)!.shape !== 'custom';
            out.push({
              x,
              y,
              z,
              height,
              slope,
              ceiling,
              key: cellKeyOf(x, y, z),
              sides: flat ? new Float64Array(4).fill(height) : new Float64Array(4).fill(Number.NaN),
              topAt: flat
                ? () => height
                : (lx, lz) => {
                    const t = anchoredTopAt(g, types, anchor, cell, lx, lz);
                    return t === null ? height : anchor[1] * cs[1]! + t.sample.height;
                  },
            });
          }
        }
      }
      ceiling = y * cs[1]!;
      aboveSolid = true;
    }
    out.reverse();
    this.columns.set(ck, out);
    return out;
  }

  /** The place named by a cell: the column's place on that cell, else the highest one below it (a walker's own cell names the top it stands on); null: none. */
  placeAt(x: number, y: number, z: number): WalkPlace | null {
    let best: Place | null = null;
    for (const p of this.column(x, z)) if (p.y <= y) best = p;
    return best;
  }

  /** Whether an edge piece blocks passage across side `side` of column (x, z) between the heights lo and hi (m). */
  private sideBlocked(x: number, z: number, side: BlockEdgeSide, lo: number, hi: number): boolean {
    const g = this.grid;
    if (g.edgeCount === 0) return false;
    const h = g.cellSize[1]!;
    const r0 = Math.max(g.min[1]!, Math.floor((lo + EPS) / h));
    const r1 = Math.min(g.max[1]! - 1, Math.floor((hi - EPS) / h));
    for (let r = r0; r <= r1; r++) {
      const [ex, ey, ez, axis] = edgeOfSide(x, r, z, side);
      const k = cellKeyOf(ex, ey, ez) * 2 + axis;
      let blocked = this.edgeBlocked.get(k);
      if (blocked === undefined) {
        const e = g.edgeAt(ex, ey, ez, axis);
        const t = e !== null ? this.types.get(e.block) : undefined;
        blocked = e !== null && t !== undefined && edgeBlocks(t, e);
        this.edgeBlocked.set(k, blocked);
      }
      if (blocked) return true;
    }
    return false;
  }

  /** A place's top at the middle of one of its sides (read once). */
  private sideTop(p: Place, d: number): number {
    let h = p.sides[d]!;
    if (Number.isNaN(h)) {
      const cs = this.grid.cellSize;
      const [dx, dz] = SIDES[d]!;
      h = p.topAt((p.x + 0.5 + dx * 0.5) * cs[0]!, (p.z + 0.5 + dz * 0.5) * cs[2]!);
      p.sides[d] = h;
    }
    return h;
  }

  /** The places of the next column across side `d` (`SIDES`) one step from `a` reaches (orthogonal steps only). */
  private straight(a: Place, d: number): Place[] {
    const s = this.settings;
    const [dx, dz, side] = SIDES[d]!;
    // Where the two tops meet: the middle of the shared side.
    const ha = this.sideTop(a, d);
    const out: Place[] = [];
    for (const b of this.column(a.x + dx, a.z + dz)) {
      const hb = this.sideTop(b, OPPOSITE[d]!);
      const rise = hb - ha;
      if (rise > s.maxStep + EPS || -rise > s.maxDrop + EPS) continue;
      const top = Math.max(a.height, b.height, ha, hb) + s.headroom;
      if (a.ceiling < top - EPS || b.ceiling < top - EPS) continue;
      if (this.sideBlocked(a.x, a.z, side, Math.min(ha, hb), top)) continue;
      out.push(b);
    }
    return out;
  }

  /** Every step from a place (orthogonal first, then diagonal), each with its distance (m). */
  steps(from: WalkPlace): WalkStep[] {
    const a = this.column(from.x, from.z).find((p) => p.key === from.key);
    if (a === undefined) return [];
    const cs = this.grid.cellSize;
    const dist = (b: WalkPlace, dx: number, dz: number): number => {
      const x = dx * cs[0]!;
      const y = b.height - a.height;
      const z = dz * cs[2]!;
      return Math.sqrt(x * x + y * y + z * z);
    };
    const out: WalkStep[] = [];
    const byDir: Place[][] = [];
    SIDES.forEach(([dx, dz], d) => {
      const list = this.straight(a, d);
      byDir.push(list);
      for (const b of list) out.push({ place: b, cost: dist(b, dx, dz) });
    });
    if (this.settings.diagonal) {
      // Across a corner: both ways round it walk (no cutting a wall's end or a ledge's corner).
      for (const [ix, iz] of [[0, 2], [0, 3], [1, 2], [1, 3]] as const) {
        const [dx] = SIDES[ix]!;
        const [, dz] = SIDES[iz]!;
        const viaX = byDir[ix]!.flatMap((m) => this.straight(m, iz));
        const viaZ = byDir[iz]!.flatMap((m) => this.straight(m, ix));
        const keys = new Set(viaZ.map((p) => p.key));
        const seen = new Set<number>();
        for (const b of viaX) {
          if (!keys.has(b.key) || seen.has(b.key)) continue;
          seen.add(b.key);
          out.push({ place: b, cost: dist(b, dx, dz) });
        }
      }
    }
    return out;
  }
}

/** What a path or reach query may add: the cost of entering a place (a multiplier of the distance; 0 or less, or not finite: it cannot be entered), the bound on places visited. */
export interface WalkSearchOptions {
  readonly enter?: (p: WalkPlace) => number;
  /** At most this many places are expanded (default `WALK_QUERY_MAX_NODES`). */
  readonly maxNodes?: number;
}

/**
 * A binary min-heap of (priority, then a second key, then push order, value):
 * deterministic. A* breaks ties of the estimate by the distance still to go,
 * so on open ground it heads straight on instead of widening every way.
 */
class Heap<T> {
  private readonly items: { p: number; q: number; o: number; v: T }[] = [];
  private order = 0;
  get size(): number {
    return this.items.length;
  }
  push(p: number, v: T, q = 0): void {
    const a = this.items;
    a.push({ p, q, o: this.order++, v });
    let i = a.length - 1;
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (!less(a[i]!, a[j]!)) break;
      [a[i], a[j]] = [a[j]!, a[i]!];
      i = j;
    }
  }
  pop(): T | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0]!.v;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && less(a[l]!, a[m]!)) m = l;
        if (r < a.length && less(a[r]!, a[m]!)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m]!, a[i]!];
        i = m;
      }
    }
    return top;
  }
}
const less = (a: { p: number; q: number; o: number }, b: { p: number; q: number; o: number }): boolean => a.p < b.p || (a.p === b.p && (a.q < b.q || (a.q === b.q && a.o < b.o)));

/** A path's result: the places from start to end and its cost; or why there is none. */
export type WalkPathResult = { readonly ok: true; readonly places: readonly WalkPlace[]; readonly cost: number; readonly visited: number } | { readonly ok: false; readonly reason: 'unreachable' | 'limit'; readonly visited: number };

/**
 * The cheapest path between two places (A*). It is guided by the least
 * distance the steps can cover — along the grid without diagonal steps, the
 * octile distance with them, the height difference if larger — so it is the
 * cheapest while `enter` gives at least 1 (below 1 a path is still found, not
 * always the cheapest).
 */
export function findWalkPath(graph: BlockWalkGraph, from: WalkPlace, to: WalkPlace, options: WalkSearchOptions = {}): WalkPathResult {
  const max = options.maxNodes ?? WALK_QUERY_MAX_NODES;
  const cs = graph.grid.cellSize;
  const diagonal = graph.settings.diagonal;
  const h = (p: WalkPlace): number => {
    const dx = Math.abs(p.x - to.x) * cs[0]!;
    const dz = Math.abs(p.z - to.z) * cs[2]!;
    const flat = diagonal ? Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz) : dx + dz;
    return Math.max(flat, Math.abs(p.height - to.height));
  };
  const g = new Map<number, number>([[from.key, 0]]);
  const prev = new Map<number, WalkPlace>();
  const closed = new Set<number>();
  const open = new Heap<WalkPlace>();
  open.push(h(from), from, h(from));
  let visited = 0;
  while (open.size > 0) {
    const cur = open.pop()!;
    if (closed.has(cur.key)) continue;
    if (cur.key === to.key) {
      const places: WalkPlace[] = [cur];
      for (let p = prev.get(cur.key); p !== undefined; p = prev.get(p.key)) places.push(p);
      return { ok: true, places: places.reverse(), cost: g.get(cur.key)!, visited };
    }
    if (visited >= max) return { ok: false, reason: 'limit', visited };
    closed.add(cur.key);
    visited += 1;
    const gc = g.get(cur.key)!;
    for (const st of graph.steps(cur)) {
      if (closed.has(st.place.key)) continue;
      const m = options.enter?.(st.place) ?? 1;
      if (!(m > 0) || !Number.isFinite(m)) continue;
      const ng = gc + st.cost * m;
      const old = g.get(st.place.key);
      if (old !== undefined && old <= ng) continue;
      g.set(st.place.key, ng);
      prev.set(st.place.key, cur);
      const hn = h(st.place);
      open.push(ng + hn, st.place, hn);
    }
  }
  return { ok: false, reason: 'unreachable', visited };
}

/** The places reachable from some starts within a cost (Dijkstra), each with its cheapest cost, in the order reached. */
export function walkReach(graph: BlockWalkGraph, starts: readonly WalkPlace[], options: WalkSearchOptions & { readonly maxCost?: number } = {}): { readonly places: readonly { readonly place: WalkPlace; readonly cost: number }[]; readonly truncated: boolean } {
  const max = options.maxNodes ?? WALK_QUERY_MAX_NODES;
  const limit = options.maxCost ?? Infinity;
  const g = new Map<number, number>();
  const open = new Heap<WalkPlace>();
  for (const s of starts) {
    if (g.has(s.key)) continue;
    g.set(s.key, 0);
    open.push(0, s);
  }
  const done = new Set<number>();
  const out: { place: WalkPlace; cost: number }[] = [];
  while (open.size > 0) {
    const cur = open.pop()!;
    if (done.has(cur.key)) continue;
    if (out.length >= max) return { places: out, truncated: true };
    done.add(cur.key);
    const gc = g.get(cur.key)!;
    out.push({ place: cur, cost: gc });
    for (const st of graph.steps(cur)) {
      if (done.has(st.place.key)) continue;
      const m = options.enter?.(st.place) ?? 1;
      if (!(m > 0) || !Number.isFinite(m)) continue;
      const ng = gc + st.cost * m;
      if (ng > limit + 1e-9) continue;
      const old = g.get(st.place.key);
      if (old !== undefined && old <= ng) continue;
      g.set(st.place.key, ng);
      open.push(ng, st.place);
    }
  }
  return { places: out, truncated: false };
}

/** The anchor lookup of a grid's larger blocks (covered cell → anchor), for a graph made outside the running game. */
export function footprintAnchors(grid: BlockGridReader, types: ReadonlyMap<string, BlockType>): (x: number, y: number, z: number) => readonly [number, number, number] | null {
  const covers = new Map<number, readonly [number, number, number]>();
  grid.forEach((x, y, z, idx) => {
    const cell = grid.valueOf(idx);
    const t = cell.block !== undefined ? types.get(cell.block) : undefined;
    if (t?.footprint === undefined) return;
    const f = rotatedFootprint(t, cell.rot);
    const anchor = [x, y, z] as const;
    for (let dx = 0; dx < f[0]; dx++) for (let dy = 0; dy < f[1]; dy++) for (let dz = 0; dz < f[2]; dz++) if (dx !== 0 || dy !== 0 || dz !== 0) covers.set(cellKeyOf(x + dx, y + dy, z + dz), anchor);
  });
  return covers.size === 0 ? () => null : (x, y, z) => covers.get(cellKeyOf(x, y, z)) ?? null;
}
