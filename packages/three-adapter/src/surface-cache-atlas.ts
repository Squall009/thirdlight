/**
 * The surface cache's atlas: pages of texels on the GPU, handed out in
 * square power-of-two blocks (a quadtree buddy allocator per page), and the
 * packing of one tile's charts into such blocks.
 *
 * A tile (a block chunk, an architecture object, a model) is packed whole at
 * one resolution level and holds its blocks until it is let go or changes
 * level, so streaming in and out never fragments other tiles' charts. Blocks
 * are as small as the tile needs (8 texels a side up to a page), so a far
 * model at a coarse level takes a few dozen texels, not a page.
 *
 * Pure (no three.js, no device).
 */

/** Metres per texel at level 0 (each level doubles it). */
export const SURFACE_TEXEL_METRES = 0.1;
/** Bytes per texel: rgba16float, the format the cache's passes read and write (read-write storage on WebGPU). */
export const SURFACE_TEXEL_BYTES = 8;
/** Texels per page side (a page is 512 KiB). */
export const SURFACE_PAGE_TEXELS = 256;
/** Texels per side of the smallest block. */
export const SURFACE_BLOCK_MIN = 8;
/** Resolution levels: 0 (10 cm texels) to `SURFACE_LEVELS − 1` (3.2 m). */
export const SURFACE_LEVELS = 6;
/** Texels around each area chart, so a filtered lookup at its edge never reads a neighbour's light. */
export const SURFACE_CHART_BORDER = 1;
/** Bytes of one page. */
export const SURFACE_PAGE_BYTES = SURFACE_PAGE_TEXELS * SURFACE_PAGE_TEXELS * SURFACE_TEXEL_BYTES;
/** The longest side (m) an area chart may have at level 0: larger surfaces are cut into charts of this size. */
export const SURFACE_CHART_METRES = (SURFACE_PAGE_TEXELS - 2 * SURFACE_CHART_BORDER) * SURFACE_TEXEL_METRES;

/** Metres per texel at `level`. */
export function texelMetres(level: number): number {
  return SURFACE_TEXEL_METRES * 2 ** level;
}

/**
 * One chart of a tile: an area in metres (a block or architecture plane, a
 * model's UV1 square) laid out with a border, or a model's surfels, one
 * texel each (`levels` as `SurfelSet.levels`, at `spacing`).
 */
export type SurfaceChart = { readonly kind: 'area'; readonly w: number; readonly h: number } | { readonly kind: 'surfels'; readonly levels: readonly number[]; readonly spacing: number };

/** Interior texels of an area side of `metres` at `level` (at most a page less its border). */
export function areaTexels(metres: number, level: number): number {
  return Math.min(SURFACE_PAGE_TEXELS - 2 * SURFACE_CHART_BORDER, Math.max(1, Math.ceil(metres / texelMetres(level) - 1e-6)));
}

/** Which of a set's surfel levels a cache level takes: the finest whose spacing is not finer than the level's texel. */
export function surfelLevelFor(chart: { readonly levels: readonly number[]; readonly spacing: number }, level: number): number {
  const want = Math.max(0, Math.floor(Math.log2(texelMetres(level) / chart.spacing) + 1e-6));
  let k = Math.min(want, chart.levels.length - 1);
  // A set too large for one page takes a coarser level.
  while (k < chart.levels.length - 1 && chart.levels[k]! > SURFACE_PAGE_TEXELS * SURFACE_PAGE_TEXELS) k += 1;
  return k;
}

/** A chart's texel rectangle at `level` (the area's border included; surfels in rows as near square as they fit). */
export function chartTexels(chart: SurfaceChart, level: number): { w: number; h: number; count?: number } {
  if (chart.kind === 'area') return { w: areaTexels(chart.w, level) + 2 * SURFACE_CHART_BORDER, h: areaTexels(chart.h, level) + 2 * SURFACE_CHART_BORDER };
  const n = chart.levels[surfelLevelFor(chart, level)] ?? 0;
  const w = Math.min(SURFACE_PAGE_TEXELS, Math.max(1, Math.ceil(Math.sqrt(n))));
  return { w, h: Math.max(1, Math.ceil(n / w)), count: n };
}

/** A block of the atlas: a page and the block's corner and side in texels. */
export interface AtlasBlock {
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly side: number;
}

const ORDERS = Math.round(Math.log2(SURFACE_PAGE_TEXELS / SURFACE_BLOCK_MIN));
const CELLS = SURFACE_PAGE_TEXELS / SURFACE_BLOCK_MIN;

function orderOf(side: number): number {
  return Math.round(Math.log2(SURFACE_PAGE_TEXELS / side));
}

/**
 * Blocks of `pages` pages: a quadtree buddy allocator. A block is split in
 * four to give a smaller one, and four free siblings join again.
 */
export class PageAtlas {
  private readonly free: Set<number>[] = Array.from({ length: ORDERS + 1 }, () => new Set<number>());
  private used = 0;
  constructor(readonly pages: number) {
    for (let p = 0; p < pages; p += 1) this.free[0]!.add(this.code(p, 0, 0));
  }
  private code(page: number, x: number, y: number): number {
    return (page * CELLS + x / SURFACE_BLOCK_MIN) * CELLS + y / SURFACE_BLOCK_MIN;
  }
  private decode(code: number, side: number): AtlasBlock {
    const y = (code % CELLS) * SURFACE_BLOCK_MIN;
    const rest = Math.floor(code / CELLS);
    return { page: Math.floor(rest / CELLS), x: (rest % CELLS) * SURFACE_BLOCK_MIN, y, side };
  }
  /** Texels handed out. */
  get usedTexels(): number {
    return this.used;
  }
  /** A free block of `side` texels (a power of two from `SURFACE_BLOCK_MIN` to a page), or null when none is left. */
  alloc(side: number): AtlasBlock | null {
    const k = orderOf(side);
    const got = this.take(k);
    if (got === null) return null;
    this.used += side * side;
    return this.decode(got, side);
  }
  private take(k: number): number | null {
    const list = this.free[k]!;
    for (const c of list) {
      list.delete(c);
      return c;
    }
    if (k === 0) return null;
    const parent = this.take(k - 1);
    if (parent === null) return null;
    const side = SURFACE_PAGE_TEXELS >> k;
    const b = this.decode(parent, side * 2);
    list.add(this.code(b.page, b.x + side, b.y));
    list.add(this.code(b.page, b.x, b.y + side));
    list.add(this.code(b.page, b.x + side, b.y + side));
    return this.code(b.page, b.x, b.y);
  }
  release(b: AtlasBlock): void {
    this.used -= b.side * b.side;
    let k = orderOf(b.side);
    let { x, y } = b;
    for (;;) {
      const side = SURFACE_PAGE_TEXELS >> k;
      if (k === 0) {
        this.free[0]!.add(this.code(b.page, 0, 0));
        return;
      }
      const px = x & ~(side * 2 - 1);
      const py = y & ~(side * 2 - 1);
      const siblings = [this.code(b.page, px, py), this.code(b.page, px + side, py), this.code(b.page, px, py + side), this.code(b.page, px + side, py + side)];
      const self = this.code(b.page, x, y);
      if (!siblings.every((c) => c === self || this.free[k]!.has(c))) {
        this.free[k]!.add(self);
        return;
      }
      for (const c of siblings) this.free[k]!.delete(c);
      x = px;
      y = py;
      k -= 1;
    }
  }
}

/** Where one chart lies in a tile's blocks. */
export interface ChartPlace {
  /** Index into the packing's blocks. */
  readonly block: number;
  /** Corner within the block (texels). */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A tile's charts packed at a level: the block sides it needs and each chart's place. */
export interface TilePacking {
  readonly level: number;
  readonly blocks: readonly number[];
  readonly places: readonly ChartPlace[];
  /** Bytes of its blocks. */
  readonly bytes: number;
}

function nextPow2(v: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, v)));
}

/** Shelf-packs `order`'s rectangles into a square of `side`, as many as fit in turn; the rest are returned. */
function shelves(rects: readonly { w: number; h: number }[], order: readonly number[], side: number, block: number, out: ChartPlace[]): number[] {
  let x = 0;
  let y = 0;
  let shelf = 0;
  const rest: number[] = [];
  for (const i of order) {
    const r = rects[i]!;
    if (x + r.w > side) {
      x = 0;
      y += shelf;
      shelf = 0;
    }
    if (r.w > side || y + r.h > side) {
      rest.push(i);
      continue;
    }
    out[i] = { block, x, y, w: r.w, h: r.h };
    x += r.w;
    shelf = Math.max(shelf, r.h);
  }
  return rest;
}

/**
 * A tile's charts at `level` packed into blocks: the smallest square that
 * holds them all, else whole pages and a last block as small as the rest
 * allows.
 */
export function packTile(charts: readonly SurfaceChart[], level: number): TilePacking {
  const rects = charts.map((c) => chartTexels(c, level));
  // Tallest first, so each shelf wastes little.
  let todo = rects.map((_, i) => i).sort((a, b) => rects[b]!.h - rects[a]!.h || rects[b]!.w - rects[a]!.w || a - b);
  const places: ChartPlace[] = new Array<ChartPlace>(rects.length);
  const blocks: number[] = [];
  while (todo.length > 0) {
    let area = 0;
    let largest = 0;
    for (const i of todo) {
      area += rects[i]!.w * rects[i]!.h;
      largest = Math.max(largest, rects[i]!.w, rects[i]!.h);
    }
    let side = Math.min(SURFACE_PAGE_TEXELS, Math.max(SURFACE_BLOCK_MIN, nextPow2(largest), nextPow2(Math.ceil(Math.sqrt(area)))));
    for (;;) {
      const trial: ChartPlace[] = [];
      const rest = shelves(rects, todo, side, blocks.length, trial);
      if (rest.length === todo.length && side === SURFACE_PAGE_TEXELS) throw new Error('surface cache: a chart is larger than a page');
      if (rest.length === 0 || side === SURFACE_PAGE_TEXELS) {
        for (const i of todo) if (trial[i] !== undefined) places[i] = trial[i]!;
        blocks.push(side);
        todo = rest;
        break;
      }
      side *= 2;
    }
  }
  const bytes = blocks.reduce((s, b) => s + b * b * SURFACE_TEXEL_BYTES, 0);
  return { level, blocks, places, bytes };
}
