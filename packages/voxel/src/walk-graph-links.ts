/**
 * Structure grids' walk graphs stitched to their world's: each structure
 * grid keeps a walk graph of its own, made in its own frame from its own
 * derived navigation (walk-graph.ts, exact floors, stairs and doors), and a
 * **link** joins a standable cell of a grid to a standable cell of the world
 * grid a walker can step between: at a doorstep, along a foundation's edge.
 *
 * A link is made where a grid cell (its floor's middle, placed in the world
 * by the grid's frame) has a world cell whose floor's middle lies within
 * {@link WALK_LINK_REACH_CELLS} horizontally and one cell up or down, with
 * room for the walker at both ends (one cell more at the lower end, as a
 * step up has), and the grid's own cells leave the walker room along the way
 * between them (it cuts no jamb's corner): the nearest such world cell, one
 * link a grid cell. Both cells must be in a
 * piece (the default walker's). The world's graph must not
 * walk the footprint itself: its walker is blocked by the grid's stamp and
 * stands nowhere inside it (walk-graph-stamp.ts without `supports`), so a
 * link is the one way between the two.
 *
 * Links are derived and never stored. A grid's chunk's links are made again
 * when its part is made again or dropped, or when a world chunk under the
 * grid's chunk is (each graph's `onPart`), within the caller's slice a grid
 * chunk at a time.
 */
import { chunkKeyOrNone } from './coords';
import type { GridFrame } from './grid-place';
import { DEFAULT_WALK_AGENT, NO_WALK_PIECE, standableIn, stepFits, walkCellOf, type WalkChunk } from './walk-graph-cells';
import type { WalkGraph } from './walk-graph';

/**
 * How far (cells, horizontally between floor middles) a link reaches: a diagonal step. A world cell beside a turned
 * wall stands only where its middle lies outside the wall's face (the stamp's share rule), so a doorway's middle, half
 * a cell in from that face, may have its nearest such world cell most of a diagonal away; a room's cell behind a
 * one-cell wall is a cell and a half from the face and never this near one outside.
 */
export const WALK_LINK_REACH_CELLS = Math.SQRT2;

/** Points along a link's step at which the grid's own cells must leave the walker room (no corner cut at a jamb). */
const LINK_CHECKS = [0.25, 0.5, 0.75] as const;

/** A link between a grid cell and a world cell (both standable, in pieces): one way across, either way. */
export interface WalkLink {
  readonly grid: number;
  /** The grid's part and cell. */
  readonly part: WalkChunk;
  readonly g: number;
  /** The world grid's part and cell. */
  readonly world: WalkChunk;
  readonly w: number;
  /** The step's cost (metres, between the floor middles). */
  readonly cost: number;
}

/** A structure grid as the links read it: its id, where it stands and its own walk graph. */
export interface LinkedGrid {
  readonly id: number;
  readonly frame: GridFrame;
  readonly graph: WalkGraph;
}

interface GridLinks {
  readonly grid: LinkedGrid;
  /** Grid chunk key → its links. */
  readonly byChunk: Map<number, WalkLink[]>;
  /** Grid chunk key → the world chunks under it (keys) and its own coordinates, as last made. */
  readonly under: Map<number, { readonly keys: number[]; readonly at: readonly [number, number, number] }>;
}

/** Counts over the links (what the measurements report). */
export interface WalkLinkStats {
  readonly grids: number;
  readonly links: number;
  /** Grid chunks whose links were made, and their milliseconds, since the start. */
  readonly made: number;
  readonly ms: number;
}

/** The links of a world's grids to its world graph (the module comment). */
export class WalkGraphLinks {
  private readonly grids = new Map<number, GridLinks>();
  /** World chunk key → grid id → grid chunks over it (keys). */
  private readonly over = new Map<number, Map<number, Set<number>>>();
  /** Grid chunks to make again: grid id → chunk key → its coordinates. */
  private readonly dirty = new Map<number, Map<number, readonly [number, number, number]>>();
  /** Links by the cell they leave from: a part → its cell → links (grid cells and world cells alike). */
  private readonly byCell = new Map<WalkChunk, Map<number, WalkLink[]>>();
  private linkCount = 0;
  private made = 0;
  private ms = 0;
  /** Bumped by every change of a link (a search that read one starts over). */
  version = 0;

  constructor(readonly world: WalkGraph) {
    world.onPart = (cx, cy, cz) => this.worldChanged(cx, cy, cz);
  }

  /** A grid joins: its graph's changes make its links again. */
  add(grid: LinkedGrid): void {
    this.grids.set(grid.id, { grid, byChunk: new Map(), under: new Map() });
    grid.graph.onPart = (cx, cy, cz) => this.mark(grid.id, cx, cy, cz);
    for (const c of grid.graph.parts()) this.mark(grid.id, c.cx, c.cy, c.cz);
  }

  /** A grid leaves with its links. */
  remove(id: number): void {
    const gl = this.grids.get(id);
    if (gl === undefined) return;
    gl.grid.graph.onPart = null;
    for (const key of [...gl.byChunk.keys()]) this.setLinks(gl, key, []);
    for (const [key, under] of gl.under) this.unindex(id, key, under.keys);
    this.grids.delete(id);
    this.dirty.delete(id);
  }

  /** The grids linked. */
  linked(): LinkedGrid[] {
    return [...this.grids.values()].map((g) => g.grid);
  }

  grid(id: number): LinkedGrid | null {
    return this.grids.get(id)?.grid ?? null;
  }

  /** Links to make again wait. */
  get pending(): boolean {
    return this.dirty.size > 0;
  }

  private mark(id: number, cx: number, cy: number, cz: number): void {
    const gl = this.grids.get(id);
    if (gl === undefined) return;
    const k = chunkKeyOrNone(gl.grid.graph.grid, cx, cy, cz);
    if (k < 0) return;
    let m = this.dirty.get(id);
    if (m === undefined) this.dirty.set(id, (m = new Map()));
    m.set(k, [cx, cy, cz]);
  }

  private worldChanged(cx: number, cy: number, cz: number): void {
    const by = this.over.get(chunkKeyOrNone(this.world.grid, cx, cy, cz));
    if (by === undefined) return;
    for (const [id, keys] of by) {
      const gl = this.grids.get(id);
      if (gl === undefined) continue;
      for (const k of keys) {
        const at = gl.under.get(k)?.at;
        if (at !== undefined) this.mark(id, at[0], at[1], at[2]);
      }
    }
  }

  /** Makes the dirty grid chunks' links again within `ms` (at least one grid chunk a call). Returns the chunks made. */
  update(ms = Infinity): number {
    if (this.dirty.size === 0) return 0;
    const t0 = performance.now();
    let n = 0;
    for (const [id, m] of this.dirty) {
      for (const [key, [cx, cy, cz]] of m) {
        if (n > 0 && performance.now() - t0 >= ms) return n;
        m.delete(key);
        const t = performance.now();
        this.makeChunk(id, key, cx, cy, cz);
        this.ms += performance.now() - t;
        this.made++;
        n++;
      }
      this.dirty.delete(id);
    }
    return n;
  }

  /** A grid chunk's links made again from its part and the world's parts under it now. */
  private makeChunk(id: number, key: number, cx: number, cy: number, cz: number): void {
    const gl = this.grids.get(id);
    if (gl === undefined) return;
    const graph = gl.grid.graph;
    const part = graph.chunkAt(cx, cy, cz);
    const f = gl.grid.frame;
    const M = graph.cellM;
    const wg = this.world.grid;
    const we = wg.edge;
    const links: WalkLink[] = [];
    const under = new Set<number>();
    // The world chunks under the grid chunk's turned box (what a change there makes these links again for).
    if (part !== null && part.ys.length > 0) {
      const e = graph.grid.edge;
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < 8; k++) {
        const w = f.toWorld((cx * e + (k & 1 ? e : 0)) * M, (cy * e + (k & 2 ? e : 0)) * M, (cz * e + (k & 4 ? e : 0)) * M);
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a]!, w[a]!);
          max[a] = Math.max(max[a]!, w[a]!);
        }
      }
      const lo = min.map((v) => Math.floor(v / M / we - 1 / we));
      const hi = max.map((v) => Math.floor(v / M / we + 1 / we));
      for (let x = lo[0]!; x <= hi[0]!; x++) for (let y = lo[1]!; y <= hi[1]!; y++) for (let z = lo[2]!; z <= hi[2]!; z++) {
        const k = chunkKeyOrNone(wg, x, y, z);
        if (k >= 0) under.add(k);
      }
    }
    if (part !== null && part.ys.length > 0) {
      const h = DEFAULT_WALK_AGENT.height;
      const reach = WALK_LINK_REACH_CELLS * M;
      for (let i = 0; i < part.ys.length; i++) {
        // A shut door's cells are in no piece but still link (a walker through shut doors steps onto them; the
        // queries leave such a link to that walker alone).
        if ((part.piece[i] === NO_WALK_PIECE && part.shut?.[i] !== 1) || part.clear[i]! < h) continue;
        const [gx, gy, gz] = walkCellOf(part, i);
        // A cell with its grid's floor on all four sides is inside: no world cell is a step from it.
        if (inside(graph, gx, gy, gz)) continue;
        const p = f.toWorld((gx + 0.5) * M, gy * M, (gz + 0.5) * M);
        const fx = p[0] / M;
        const fy = p[1] / M;
        const fz = p[2] / M;
        const wx0 = Math.floor(fx);
        const wz0 = Math.floor(fz);
        const wy0 = Math.round(fy);
        let best: WalkLink | null = null;
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
          const wx = wx0 + dx;
          const wz = wz0 + dz;
          const horiz = Math.hypot((wx + 0.5 - fx) * M, (wz + 0.5 - fz) * M);
          if (horiz > reach + 1e-9) continue;
          for (let dy = -1; dy <= 1; dy++) {
            const wy = wy0 + dy;
            const c = this.world.lookup(Math.floor(wx / we), Math.floor(wy / we), Math.floor(wz / we));
            if (c == null) continue;
            const j = standableIn(c, wx - c.cx * we, wy - c.cy * we, wz - c.cz * we);
            if (j < 0 || c.piece[j] === NO_WALK_PIECE) continue;
            // The step from the world cell to the grid's, by whole cells up or down.
            const rise = Math.round(fy - wy);
            if (rise < -1 || rise > 1 || !stepFits(c.clear[j]!, part.clear[i]!, rise, h)) continue;
            const cost = Math.hypot(horiz, (fy - wy) * M);
            if (best !== null && cost >= best.cost) continue;
            if (!this.clearWay(graph, f, p, [(wx + 0.5) * M, wy * M, (wz + 0.5) * M], gy, rise, h)) continue;
            best = { grid: id, part, g: i, world: c, w: j, cost };
          }
        }
        if (best !== null) links.push(best);
      }
    }
    const was = gl.under.get(key);
    if (was !== undefined) this.unindex(id, key, was.keys);
    this.setLinks(gl, key, links);
    // A grid chunk where nothing stands links to nothing whatever the world does: it hears of no world chunk.
    if (part === null || part.ys.length === 0) {
      gl.under.delete(key);
      return;
    }
    const list = [...under];
    gl.under.set(key, { keys: list, at: [cx, cy, cz] });
    for (const k of list) {
      let by = this.over.get(k);
      if (by === undefined) this.over.set(k, (by = new Map()));
      let set = by.get(id);
      if (set === undefined) by.set(id, (set = new Set()));
      set.add(key);
    }
  }

  /**
   * Whether the grid's own cells leave a walker `h` tall room at each check along the way from its floor middle `a`
   * (feet at its cell `gy`) to a world floor middle `b` (world metres), from the higher of the two feet up: what the
   * world sees of the grid there is its stamp, a cell off; the grid's derived navigation is exact.
   */
  private clearWay(graph: WalkGraph, f: GridFrame, a: readonly number[], b: readonly number[], gy: number, rise: number, h: number): boolean {
    const M = graph.cellM;
    const feet = Math.max(gy, gy - rise);
    for (const t of LINK_CHECKS) {
      const q = f.toGrid(a[0]! + (b[0]! - a[0]!) * t, 0, a[2]! + (b[2]! - a[2]!) * t);
      const x = Math.floor(q[0] / M);
      const z = Math.floor(q[2] / M);
      for (let y = feet; y < feet + h; y++) if (graph.blocks(x, y, z) === true) return false;
    }
    return true;
  }

  private unindex(id: number, key: number, under: readonly number[]): void {
    for (const k of under) {
      const by = this.over.get(k);
      const set = by?.get(id);
      set?.delete(key);
      if (set?.size === 0) by!.delete(id);
      if (by?.size === 0) this.over.delete(k);
    }
  }

  private setLinks(gl: GridLinks, key: number, links: WalkLink[]): void {
    const old = gl.byChunk.get(key);
    if (old !== undefined) {
      for (const l of old) {
        this.unlinkCell(l.part, l.g, l);
        this.unlinkCell(l.world, l.w, l);
      }
      this.linkCount -= old.length;
    }
    if (links.length === 0) gl.byChunk.delete(key);
    else gl.byChunk.set(key, links);
    for (const l of links) {
      this.linkCell(l.part, l.g, l);
      this.linkCell(l.world, l.w, l);
    }
    this.linkCount += links.length;
    if ((old?.length ?? 0) > 0 || links.length > 0) this.version++;
  }

  private linkCell(c: WalkChunk, i: number, l: WalkLink): void {
    let m = this.byCell.get(c);
    if (m === undefined) this.byCell.set(c, (m = new Map()));
    const list = m.get(i);
    if (list === undefined) m.set(i, [l]);
    else list.push(l);
  }

  private unlinkCell(c: WalkChunk, i: number, l: WalkLink): void {
    const m = this.byCell.get(c);
    const list = m?.get(i);
    if (list === undefined) return;
    const k = list.indexOf(l);
    if (k >= 0) list.splice(k, 1);
    if (list.length === 0) m!.delete(i);
    if (m!.size === 0) this.byCell.delete(c);
  }

  /** The links leaving a cell of a part (a grid's or the world's; empty: none). */
  linksAt(c: WalkChunk, i: number): readonly WalkLink[] {
    return this.byCell.get(c)?.get(i) ?? NO_LINKS;
  }

  /** A grid's links (every chunk's), whose parts are alive. */
  linksOf(id: number): WalkLink[] {
    const gl = this.grids.get(id);
    if (gl === undefined) return [];
    const out: WalkLink[] = [];
    for (const list of gl.byChunk.values()) for (const l of list) if (l.part.alive && l.world.alive) out.push(l);
    return out;
  }

  stats(): WalkLinkStats {
    return { grids: this.grids.size, links: this.linkCount, made: this.made, ms: this.ms };
  }

  /** Bytes held: about 64 a link (its object, and its places in the two cell indexes) and the indexes' maps. */
  get bytes(): number {
    let under = 0;
    for (const g of this.grids.values()) for (const u of g.under.values()) under += u.keys.length * 8 + 48;
    return this.linkCount * 96 + under + this.over.size * 64;
  }
}

const NO_LINKS: readonly WalkLink[] = Object.freeze([]);

/** Whether a grid cell's four straight neighbours each have a standable cell of the grid within a step up or down. */
function inside(g: WalkGraph, x: number, y: number, z: number): boolean {
  const e = g.grid.edge;
  for (const [dx, dz] of SIDES) {
    let any = false;
    for (let dy = -1; dy <= 1 && !any; dy++) {
      const c = g.lookup(Math.floor((x + dx) / e), Math.floor((y + dy) / e), Math.floor((z + dz) / e));
      if (c == null) continue;
      any = standableIn(c, x + dx - c.cx * e, y + dy - c.cy * e, z + dz - c.cz * e) >= 0;
    }
    if (!any) return false;
  }
  return true;
}

const SIDES: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
