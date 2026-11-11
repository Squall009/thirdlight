/**
 * The far tree: the chunk tree (voxel-mips.ts) past the streaming load ring,
 * over the whole world, so nothing far away is cut off.
 *
 * - **Nodes.** A level-L node covers 2^L chunks a side (16 m · 2^L at the
 *   32-cell edge) and holds the voxel mip of that block: a chunk-shaped
 *   block of cells 0.5 m · 2^L, downsampled level by level from the chunks
 *   with the one downsample every level uses ({@link downsampleMip}). The
 *   far tree keeps levels {@link FAR_MIN_LEVEL} and up; the levels between
 *   the chunks and it are built on the way and not kept.
 * - **The far cache.** Nodes are derived data, kept in a cache beside the
 *   world (never committed, shipped in an export): which nodes hold anything,
 *   and their cells in the chunk codec. An edit marks every ancestor of the
 *   changed chunks at the kept levels stale ({@link farAncestors}); exactly
 *   those are built again ({@link buildFarNode} reads each one's untouched
 *   children from the cache).
 * - **Selection.** {@link FarSelection} picks which nodes are drawn by their
 *   on-screen error (a node's cell size seen from the eye, in pixels): every
 *   top-level node that holds anything is drawn or opened into its children
 *   until its error is small enough, with hysteresis so a node does not
 *   flicker at the threshold, inside a byte budget (a node that would push
 *   the drawn bytes over it stays closed). Nodes wholly inside the box the
 *   near rings draw are left to them; nodes reaching into it are opened down
 *   to the lowest kept level and marked, so only a ring of the finest far
 *   nodes meets the near field. There is no distance past which nothing is
 *   drawn: the top level covers the world.
 *
 * Uniform blocks (sky, solid rock under mountains) are most of a world: a
 * node all of whose children are one whole solid value is that value without
 * a downsample (what the downsample would give: {@link isUniformKeepable}),
 * so building the far data costs what the surface costs.
 */
import type { ChunkGrid } from './coords';
import { copyDenseChunk, createDenseChunk, type DenseChunk } from './dense-chunk';
import { fillLevel, readValue, recordValue, SHAPE_FULL, VOXEL_ROLE, type VoxelRecord } from './record';
import { downsampleMip, MIP_ROLE_PRIORITY, mipChildren, mipNodeKey, MipStaleSet, type MipNode } from './voxel-mips';

/**
 * The far cache's format; a cache of another format is built again (it is derived data). Format 2 adds the kept
 * nodes' baked bricks beside them (add-only: a format-1 cache is a format-2 cache without them, and a page reading
 * one builds its bricks itself).
 */
export const FAR_CACHE_FORMAT = 2;

/** The far cache formats a reader takes: 1 (no baked bricks) and {@link FAR_CACHE_FORMAT}. */
export const FAR_CACHE_FORMATS_READ: readonly number[] = [1, FAR_CACHE_FORMAT];

/** The lowest level the far tree keeps (2 m cells, 64 m nodes at the 32-cell edge): the near rings draw what is finer. */
export const FAR_MIN_LEVEL = 2;

/**
 * The highest level a far tree may have: a node's coordinates are chunk
 * coordinates shifted right by its level, and past 30 a 32-bit chunk
 * coordinate has no bits left to shift.
 */
export const FAR_MAX_LEVEL = 30;

/** Default on-screen error (pixels) a drawn node's cell may make before it opens into its children. */
export const FAR_ERROR_PIXELS = 2;

/** Nodes a selection step looks at before it yields ({@link FarSelection.steps}). */
export const FAR_SELECT_STEP_NODES = 256;

/** Hysteresis of the selection: an open node closes again only below (1 − this) × the error threshold. */
export const FAR_HYSTERESIS = 0.25;

/** Default byte budget of the far nodes drawn at once (their stored cache bytes). */
export const FAR_BUDGET_BYTES = 48 * 1024 * 1024;

/** A node's cells: null (all air), a voxel value (every cell that value), or its cells. */
export type FarCells = null | number | DenseChunk;

/**
 * Whether a block whose every cell is value `v` downsamples to itself: a
 * whole solid cell of a counted role (not a roof, whose downsample lays the
 * roof again, and not an opening, which may close). Such a parent of 8 such
 * children is `v` without reading a cell.
 */
export function isUniformKeepable(v: number): boolean {
  const cell = readValue(v, scratchRecord);
  if (cell.material === 0 || cell.role === VOXEL_ROLE.roof) return false;
  return MIP_ROLE_PRIORITY.includes(cell.role) && cell.shape === SHAPE_FULL && fillLevel(cell.role, cell.shape) === SHAPE_FULL;
}

const scratchRecord: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };

/** A block of `grid` whose every cell is value `v`. */
export function uniformCells(grid: ChunkGrid, v: number): DenseChunk {
  const c = createDenseChunk(grid);
  const r = readValue(v, scratchRecord);
  c.material.fill(r.material);
  c.role.fill(r.role);
  c.shape.fill(r.shape);
  c.wetness.fill(r.wetness);
  return c;
}

/** The cells as a value when every cell is the same non-air voxel, else the cells as given. */
export function collapseUniform(c: DenseChunk): number | DenseChunk {
  const m = c.material[0]!, r = c.role[0]!, s = c.shape[0]!, w = c.wetness[0]!;
  if (m === 0) return c;
  const n = c.material.length;
  for (let i = 1; i < n; i++) if (c.material[i] !== m || c.role[i] !== r || c.shape[i] !== s || c.wetness[i] !== w) return c;
  return recordValue(m, r, s, w);
}

/** Where a far node's build reads from: the chunks, and the far cache's kept nodes. */
export interface FarSource {
  readonly grid: ChunkGrid;
  /** A level-0 chunk's cells. */
  chunk(cx: number, cy: number, cz: number): FarCells;
  /** A kept node's cells, or undefined to build it from below (the node is stale, or nothing is kept yet). */
  cached?(n: MipNode): FarCells | undefined;
}

/**
 * Builds a node's cells from its source: level 0 is the chunk; above it the
 * downsample of the 8 children, each read from the cache when the source
 * keeps it, else built the same way. Deterministic: the same cells whatever
 * order or process builds it. `keep` sees every node built on the way
 * (levels ≥ 1), children before parents.
 */
export function buildFarNode(src: FarSource, n: MipNode, keep?: (n: MipNode, cells: FarCells) => void): FarCells {
  if (n.level === 0) return src.chunk(n.nx, n.ny, n.nz);
  const known = src.cached?.(n);
  if (known !== undefined) return known;
  const kids = mipChildren(n).map((c) => buildFarNode(src, c, keep));
  const out = downsampleCells(src.grid, kids);
  keep?.(n, out);
  return out;
}

/** The parent of 8 children's cells, by the uniform shortcut when it holds, else by the downsample. */
export function downsampleCells(grid: ChunkGrid, kids: readonly FarCells[]): FarCells {
  if (kids.every((k) => k === null)) return null;
  const first = kids[0];
  if (typeof first === 'number' && isUniformKeepable(first) && kids.every((k) => k === first)) return first;
  const dense = kids.map((k) => (typeof k === 'number' ? uniformCells(grid, k) : k));
  const out = createDenseChunk(grid);
  if (!downsampleMip(grid, dense, out)) return null;
  return collapseUniform(out);
}

/** A node's cells as a block (a value spread to every cell; null stays null). */
export function farCellsDense(grid: ChunkGrid, c: FarCells, into?: DenseChunk): DenseChunk | null {
  if (c === null) return null;
  if (typeof c === 'number') {
    const u = uniformCells(grid, c);
    if (into === undefined) return u;
    copyDenseChunk(u, into);
    return into;
  }
  return c;
}

/**
 * The nodes an edit of `chunks` makes stale at the kept levels (`minLevel`
 * … `maxLevel`): every ancestor of every changed chunk, once, lowest level
 * first (a parent after its children), then by coordinates.
 */
export function farAncestors(chunks: Iterable<{ readonly cx: number; readonly cy: number; readonly cz: number }>, minLevel: number, maxLevel: number): MipNode[] {
  if (!Number.isInteger(minLevel) || minLevel < 1 || maxLevel < minLevel) throw new RangeError(`far levels ${minLevel} … ${maxLevel}`);
  const stale = new MipStaleSet(maxLevel);
  stale.markChanged(chunks);
  return stale.nodes().filter((n) => n.level >= minLevel);
}

/**
 * The top level of a far tree over a world spanning `spanChunks` chunks on
 * its widest horizontal axis: the lowest level at which at most two nodes
 * span it (so a handful of top nodes cover the whole world), and never
 * below `minLevel`.
 */
export function farTopLevel(spanChunks: number, minLevel = FAR_MIN_LEVEL): number {
  if (!Number.isInteger(spanChunks) || spanChunks < 1) throw new RangeError(`world span ${spanChunks} chunks`);
  let l = minLevel;
  while (Math.ceil(spanChunks / 2 ** l) > 2) l++;
  if (l > FAR_MAX_LEVEL) throw new RangeError(`world span ${spanChunks} chunks needs far level ${l}, above ${FAR_MAX_LEVEL}`);
  return l;
}

/** The far tree's kept nodes that hold anything: per level, by node key, their stored bytes. */
export class FarNodeIndex {
  private readonly levels = new Map<number, Map<string, { node: MipNode; bytes: number }>>();

  constructor(
    readonly grid: ChunkGrid,
    readonly minLevel: number,
    readonly maxLevel: number,
  ) {
    if (!Number.isInteger(minLevel) || minLevel < 1 || maxLevel < minLevel || maxLevel > FAR_MAX_LEVEL) throw new RangeError(`far levels ${minLevel} … ${maxLevel}`);
    for (let l = minLevel; l <= maxLevel; l++) this.levels.set(l, new Map());
  }

  /** Records a node that holds anything (bytes: what it costs resident). */
  add(n: MipNode, bytes: number): void {
    const m = this.levels.get(n.level);
    if (m === undefined) throw new RangeError(`level ${n.level} outside the far tree's ${this.minLevel} … ${this.maxLevel}`);
    m.set(mipNodeKey(n), { node: { level: n.level, nx: n.nx, ny: n.ny, nz: n.nz }, bytes });
  }

  /** Forgets a node (it became all air). */
  remove(n: MipNode): void {
    this.levels.get(n.level)?.delete(mipNodeKey(n));
  }

  has(n: MipNode): boolean {
    return this.levels.get(n.level)?.has(mipNodeKey(n)) ?? false;
  }

  bytesOf(n: MipNode): number {
    return this.levels.get(n.level)?.get(mipNodeKey(n))?.bytes ?? 0;
  }

  /** The kept nodes of a level. */
  nodes(level: number): MipNode[] {
    return [...(this.levels.get(level)?.values() ?? [])].map((e) => e.node);
  }

  /** Nodes kept per level (index: level). */
  counts(): number[] {
    const out: number[] = [];
    for (let l = 0; l <= this.maxLevel; l++) out.push(this.levels.get(l)?.size ?? 0);
    return out;
  }

  /** A node's children the tree keeps (an absent child is air). */
  children(n: MipNode): MipNode[] {
    return n.level <= this.minLevel ? [] : mipChildren(n).filter((c) => this.has(c));
  }
}

/** A box of cells, min inclusive, max exclusive. */
export interface FarBox {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** What the far selection looks from. */
export interface FarView {
  /** The eye, in world cells (fractional). */
  readonly eye: readonly [number, number, number];
  /** Pixels a radian at the screen's centre: viewport height / (2 tan(fovY / 2)). */
  readonly pixelsPerRadian: number;
  /** A drawn node's cell may look this big on screen (pixels) before the node opens ({@link FAR_ERROR_PIXELS}). */
  readonly errorPixels?: number;
  /** {@link FAR_HYSTERESIS}. */
  readonly hysteresis?: number;
  /** Stored bytes of the nodes drawn at once ({@link FAR_BUDGET_BYTES}). */
  readonly budgetBytes?: number;
  /** GPU bytes the nodes drawn at once may hold where they are drawn (absent: no such bound), by {@link gpuBytesOf}. */
  readonly gpuBudgetBytes?: number;
  /** A node's GPU bytes where it is drawn, made or foreseen from its stored bytes (absent: 0). */
  readonly gpuBytesOf?: (n: MipNode, storedBytes: number) => number;
  /** The cells the near rings draw (null: none); nodes wholly inside are not drawn here. */
  readonly near: FarBox | null;
  /**
   * Whether the eye has not met a node for a while (visibility feedback, far-seen.ts; absent: every node counts as
   * seen). Such a node opens, and takes the budget, by {@link unseenScale} of its error.
   */
  readonly unseen?: (n: MipNode) => boolean;
  /** The share of its error an unseen node is selected by (default 1: as a seen one). */
  readonly unseenScale?: number;
}

/** A drawn far node. */
export interface FarDrawn {
  readonly node: MipNode;
  /** Its on-screen error (pixels) from the eye. */
  readonly errorPixels: number;
  /** Distance (cells) from the eye to its box. */
  readonly distance: number;
  readonly bytes: number;
  /** It reaches into the near box (a lowest-level node at the near field's edge). */
  readonly nearOverlap: boolean;
}

export interface FarSelected {
  /** Drawn nodes, by level then key. */
  readonly drawn: readonly FarDrawn[];
  readonly bytes: number;
  /** Their GPU bytes ({@link FarView.gpuBytesOf}). */
  readonly gpuBytes: number;
  /** Nodes kept closed only because opening them would pass a budget. */
  readonly heldByBudget: number;
}

/** A node's box in cells. */
export function farNodeBox(grid: ChunkGrid, n: MipNode): FarBox {
  const s = grid.edge << n.level;
  return { min: [n.nx * s, n.ny * s, n.nz * s], max: [(n.nx + 1) * s, (n.ny + 1) * s, (n.nz + 1) * s] };
}

/** A node's cell (2^level cells) on screen from `distance` cells away, in pixels: what drawing it there costs in detail. */
export function farCellPixels(level: number, distance: number, pixelsPerRadian: number): number {
  const cell = 2 ** level;
  return (cell * pixelsPerRadian) / Math.max(distance, cell);
}

/** Distance (cells) from a point to a node's box (0 inside it). */
export function farNodeDistance(grid: ChunkGrid, n: MipNode, p: readonly [number, number, number]): number {
  return boxDistance(farNodeBox(grid, n), p);
}

function boxDistance(b: FarBox, p: readonly [number, number, number]): number {
  let d2 = 0;
  for (let a = 0; a < 3; a++) {
    const d = p[a]! < b.min[a]! ? b.min[a]! - p[a]! : p[a]! > b.max[a]! ? p[a]! - b.max[a]! : 0;
    d2 += d * d;
  }
  return Math.sqrt(d2);
}

function inside(b: FarBox, outer: FarBox): boolean {
  for (let a = 0; a < 3; a++) if (b.min[a]! < outer.min[a]! || b.max[a]! > outer.max[a]!) return false;
  return true;
}

function overlaps(b: FarBox, o: FarBox): boolean {
  for (let a = 0; a < 3; a++) if (b.max[a]! <= o.min[a]! || b.min[a]! >= o.max[a]!) return false;
  return true;
}

/**
 * The drawn far nodes, kept from one selection to the next for the
 * hysteresis: a node opened last time stays open until its error drops below
 * (1 − hysteresis) × the threshold.
 */
export class FarSelection {
  private open = new Set<string>();

  /** Selects the drawn nodes of `index` seen from `view`. */
  select(index: FarNodeIndex, view: FarView): FarSelected {
    const steps = this.steps(index, view);
    for (;;) {
      const r = steps.next();
      if (r.done === true) return r.value;
    }
  }

  /**
   * The selection in steps: it yields after every {@link FAR_SELECT_STEP_NODES} nodes looked at and returns the
   * selection, so a host spreads it over several updates (a frame's time apiece) instead of holding its thread for
   * the whole of it. Its open set is taken only when it returns; another selection meanwhile starts from the last
   * one's.
   */
  *steps(index: FarNodeIndex, view: FarView): Generator<void, FarSelected, void> {
    const threshold = view.errorPixels ?? FAR_ERROR_PIXELS;
    const h = view.hysteresis ?? FAR_HYSTERESIS;
    const budget = view.budgetBytes ?? FAR_BUDGET_BYTES;
    const gpuBudget = view.gpuBudgetBytes ?? Infinity;
    const unseenScale = view.unseenScale ?? 1;
    if (!(threshold > 0) || !(h >= 0 && h < 1) || !(budget >= 0) || !(gpuBudget >= 0) || !(view.pixelsPerRadian > 0) || !(unseenScale > 0 && unseenScale <= 1)) throw new RangeError('far view: error, hysteresis, budget, projection or unseen scale out of range');
    const gpuOf = view.gpuBytesOf;
    const unseen = unseenScale < 1 ? view.unseen : undefined;
    const grid = index.grid;
    const info = (n: MipNode) => {
      const box = farNodeBox(grid, n);
      const distance = boxDistance(box, view.eye);
      const bytes = index.bytesOf(n);
      const errorPixels = farCellPixels(n.level, distance, view.pixelsPerRadian);
      // What it is opened and ranked by: an unseen node's error counts for less, so the seen ones refine and take the budget first.
      const rank = unseen?.(n) === true ? errorPixels * unseenScale : errorPixels;
      return { node: n, box, distance, errorPixels, rank, bytes, gpu: gpuOf === undefined ? 0 : gpuOf(n, bytes), nearOverlap: view.near !== null && overlaps(box, view.near) };
    };
    type Info = ReturnType<typeof info>;
    const visible = (i: Info): boolean => view.near === null || !inside(i.box, view.near);
    const drawn = new Map<string, Info>();
    let bytes = 0;
    let gpu = 0;
    for (const n of index.nodes(index.maxLevel)) {
      const i = info(n);
      if (!visible(i)) continue;
      drawn.set(mipNodeKey(n), i);
      bytes += i.bytes;
      gpu += i.gpu;
    }
    // Largest error first (an unseen node's scaled), so a tight budget is spent where it shows most; ties by key (deterministic).
    const before = (a: Info & { key: string }, b: Info & { key: string }): boolean => a.rank > b.rank || (a.rank === b.rank && a.key < b.key);
    const heap: Array<Info & { key: string }> = [];
    const push = (i: Info): void => {
      heap.push({ ...i, key: mipNodeKey(i.node) });
      let k = heap.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (!before(heap[k]!, heap[p]!)) break;
        [heap[k], heap[p]] = [heap[p]!, heap[k]!];
        k = p;
      }
    };
    const pop = (): Info & { key: string } => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1, r = l + 1;
          let m = k;
          if (l < heap.length && before(heap[l]!, heap[m]!)) m = l;
          if (r < heap.length && before(heap[r]!, heap[m]!)) m = r;
          if (m === k) break;
          [heap[k], heap[m]] = [heap[m]!, heap[k]!];
          k = m;
        }
      }
      return top;
    };
    for (const i of drawn.values()) push(i);
    const nextOpen = new Set<string>();
    let held = 0;
    let looked = 0;
    while (heap.length > 0) {
      if (++looked % FAR_SELECT_STEP_NODES === 0) yield;
      const i = pop();
      const key = i.key;
      if (i.node.level <= index.minLevel) continue;
      const wasOpen = this.open.has(key);
      const wants = i.nearOverlap || i.rank > threshold * (wasOpen ? 1 - h : 1);
      if (!wants) continue;
      const kids = index.children(i.node).map(info).filter(visible);
      const cost = kids.reduce((s, k) => s + k.bytes, 0) - i.bytes;
      const gpuCost = kids.reduce((s, k) => s + k.gpu, 0) - i.gpu;
      // The near field's edge opens whatever the budget: a coarse node there would cover what the near rings draw.
      if (!i.nearOverlap && (bytes + cost > budget || gpu + gpuCost > gpuBudget)) {
        held++;
        continue;
      }
      drawn.delete(key);
      nextOpen.add(key);
      bytes += cost;
      gpu += gpuCost;
      for (const k of kids) {
        drawn.set(mipNodeKey(k.node), k);
        push(k);
      }
    }
    this.open = nextOpen;
    const list = [...drawn.entries()].sort((a, b) => a[1].node.level - b[1].node.level || (a[0] < b[0] ? -1 : 1)).map((e) => e[1]);
    return {
      drawn: list.map((i) => ({ node: i.node, errorPixels: i.errorPixels, distance: i.distance, bytes: i.bytes, nearOverlap: i.nearOverlap })),
      bytes,
      gpuBytes: gpu,
      heldByBudget: held,
    };
  }
}

/** What changes between two selections: nodes to load and nodes to drop. */
export function farSelectionDiff(prev: readonly FarDrawn[], next: readonly FarDrawn[]): { load: MipNode[]; unload: MipNode[] } {
  const was = new Set(prev.map((d) => mipNodeKey(d.node)));
  const now = new Set(next.map((d) => mipNodeKey(d.node)));
  return { load: next.filter((d) => !was.has(mipNodeKey(d.node))).map((d) => d.node), unload: prev.filter((d) => !now.has(mipNodeKey(d.node))).map((d) => d.node) };
}
