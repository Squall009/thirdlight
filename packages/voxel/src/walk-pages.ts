/**
 * The occupancy walk's blocks as flat words: what the GPU walk reads
 * (three-adapter voxel-walk-gpu.ts uploads them as they are) and what the
 * page's CPU walk reads beside it, so the two walk the same blocks.
 *
 * - **A block** is 32³ cells of one level ({@link WALK_BLOCK_SHIFT}): a
 *   storage chunk at level 0 (its derive sections together), a mip node at
 *   level 1 and up. For each stop (`solid`, `light`) it is empty, solid or
 *   mixed; a mixed block has a page.
 * - **A page** ({@link WALK_PAGE_WORDS} u32): for each stop a bit a 4³
 *   brick (set: it holds a stopping cell; 512 bricks, 16 words), then a bit
 *   a cell (32,768 cells, 1,024 words; cell `(x · 32 + z) · 32 + y`, so a
 *   word is one column's 32 cells). 8,320 bytes; empty and solid blocks
 *   have none.
 * - **A cover** ({@link WALK_COVER_WORDS} u32, in {@link WALK_COVER_PAGES}
 *   page slots side by side) for a block holding cells the light stop
 *   passes but a body covers in part (`WalkBlockView.partial`): a bit a
 *   brick holding one (16 words), then 4 bits a cell, its coverage step
 *   (`walkCoverStep`; cell i in word 16 + i / 8 at bits 4 · (i mod 8)).
 *   Only such blocks have one.
 * - **The table** ({@link WalkTable}) finds a block by its level and
 *   coordinates: open addressing, linear probing, at most half full, four
 *   u32 an entry (two key words, the value, the cover's first page slot + 1 or 0), an empty entry's
 *   second key word all ones. The value is the solid stop's flag, the light
 *   stop's flag << 2 and the page << 4. Deletion shifts the entries after
 *   it back, so a search stops at the first empty entry.
 * - **The feed** ({@link WalkBlockFeed}) packs the blocks a streamer's
 *   events changed, where it runs, and hands them to the page in its draw
 *   batch: a block every one of whose parts the level knows is sent, one it
 *   no longer knows is removed.
 */
import { OCCUPANCY } from './derived-data';
import { WALK_COVER_STEPS, walkCoverOfStep, walkCoverStep, type WalkBlockView, type WalkPartial, type WalkSource, type WalkStop } from './occupancy-walk';

/** log2 of a walk block's edge, in its level's cells. */
export const WALK_BLOCK_SHIFT = 5;
const E = 1 << WALK_BLOCK_SHIFT;
const BRICKS = E / 4;

/** u32 words of a stop's brick bits and cell bits. */
export const WALK_BRICK_WORDS = (BRICKS * BRICKS * BRICKS) / 32;
export const WALK_CELL_WORDS = (E * E * E) / 32;

/** u32 words of a page: each stop's brick bits, then each stop's cell bits. */
export const WALK_PAGE_WORDS = 2 * (WALK_BRICK_WORDS + WALK_CELL_WORDS);

/** u32 words of a block's cover: its brick bits, then 4 bits a cell. */
export const WALK_COVER_WORDS = WALK_BRICK_WORDS + (E * E * E) / 8;

/** Page slots a cover takes, side by side. */
export const WALK_COVER_PAGES = Math.ceil(WALK_COVER_WORDS / WALK_PAGE_WORDS);

/** u32 words of a table entry. */
export const WALK_ENTRY_WORDS = 4;

/** A table entry's second key word when empty. */
export const WALK_EMPTY_KEY = 0xffffffff;

/** Probes a table search takes at most (the table grows before a key would need more). */
export const WALK_MAX_PROBES = 64;

/** Offset of a coordinate in a key's 16 bits. */
const KEY_BIAS = 1 << 15;

/** Word offsets inside a page of a stop's brick and cell bits. */
export function walkPageOffsets(stop: WalkStop): { readonly bricks: number; readonly cells: number } {
  const s = stop === 'solid' ? 0 : 1;
  return { bricks: s * WALK_BRICK_WORDS, cells: 2 * WALK_BRICK_WORDS + s * WALK_CELL_WORDS };
}

/** A block's two key words. */
export function walkKey(level: number, bx: number, by: number, bz: number): [number, number] {
  return [(((bx + KEY_BIAS) & 0xffff) | (((bz + KEY_BIAS) & 0xffff) << 16)) >>> 0, (((by + KEY_BIAS) & 0xffff) | (level << 16)) >>> 0];
}

/** The slot a key hashes to (the GPU's hash, step for step: u32 products wrap). */
export function walkHash(k0: number, k1: number, mask: number): number {
  let h = (Math.imul(k0 >>> 0, 0x9e3779b1) ^ Math.imul(k1 >>> 0, 0x85ebca77)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h & mask;
}

/** A block as packed: each stop's flag, and its page when either stop is mixed. */
export interface WalkPacked {
  readonly solid: number;
  readonly light: number;
  readonly page: Uint32Array | null;
  /** Its cover ({@link WALK_COVER_WORDS}) where it holds partly covered cells the light stop passes (absent or null: none). */
  readonly cover?: Uint32Array | null;
}

/** A block's cover from its light views' partly covered cells (null: none). */
function packCover(views: ReadonlyArray<readonly [WalkBlockView, WalkBlockView, number, number, number]>, pe: number): Uint32Array | null {
  let cover: Uint32Array | null = null;
  const pn = pe >> 2;
  for (const v of views) {
    const part = v[1].partial;
    if (part === undefined) continue;
    for (let bx = 0; bx < pn; bx++) for (let bz = 0; bz < pn; bz++) for (let by = 0; by < pn; by++) {
      if (!part.brick((bx * pn + bz) * pn + by)) continue;
      for (let x = bx * 4; x < bx * 4 + 4; x++) for (let z = bz * 4; z < bz * 4 + 4; z++) for (let y = by * 4; y < by * 4 + 4; y++) {
        const i = (x * pe + z) * pe + y;
        const q = v[1].cell(i) ? 0 : walkCoverStep(part.cell(i));
        if (q === 0) continue;
        cover ??= new Uint32Array(WALK_COVER_WORDS);
        const gi = ((v[2] + x) * E + (v[4] + z)) * E + (v[3] + y);
        cover[WALK_BRICK_WORDS + (gi >>> 3)]! |= q << ((gi & 7) * 4);
        const gb = (((v[2] + x) >> 2) * BRICKS + ((v[4] + z) >> 2)) * BRICKS + ((v[3] + y) >> 2);
        cover[gb >>> 5]! |= 1 << (gb & 31);
      }
    }
  }
  return cover;
}

/** A cover's partly covered cells as the walk reads them (coverage bytes back from the steps). */
export function coverPartial(words: Uint32Array, base: number): WalkPartial {
  return {
    brick: (i) => ((words[base + (i >>> 5)]! >>> (i & 31)) & 1) === 1,
    cell: (i) => walkCoverOfStep((words[base + WALK_BRICK_WORDS + (i >>> 3)]! >>> ((i & 7) * 4)) & WALK_COVER_STEPS),
  };
}

/**
 * Packs the 32³ block (level, bx, by, bz) from a source's views of it (null: the source does not know all of it).
 * The source's blocks at that level may be smaller (level-0 derive sections): every one inside is read.
 */
export function packWalkBlock(src: WalkSource, level: number, bx: number, by: number, bz: number): WalkPacked | null {
  const sh = src.blockShift(level);
  if (sh > WALK_BLOCK_SHIFT) throw new RangeError(`a source block of ${1 << sh} cells is larger than a walk block`);
  const parts = 1 << (WALK_BLOCK_SHIFT - sh);
  const pe = 1 << sh;
  const views: Array<[WalkBlockView, WalkBlockView, number, number, number]> = [];
  for (let px = 0; px < parts; px++) for (let pz = 0; pz < parts; pz++) for (let py = 0; py < parts; py++) {
    const sx = bx * parts + px;
    const sy = by * parts + py;
    const sz = bz * parts + pz;
    const s = src.block(level, sx, sy, sz, 'solid');
    const l = src.block(level, sx, sy, sz, 'light');
    if (s === null || l === null) return null;
    views.push([s, l, px * pe, py * pe, pz * pe]);
  }
  const flagOf = (k: 0 | 1): number => {
    const f = views.map((v) => v[k].flag);
    return f.every((x) => x === OCCUPANCY.empty) ? OCCUPANCY.empty : f.every((x) => x === OCCUPANCY.solid) ? OCCUPANCY.solid : OCCUPANCY.mixed;
  };
  const solid = flagOf(0);
  const light = flagOf(1);
  const cover = packCover(views, pe);
  if (solid !== OCCUPANCY.mixed && light !== OCCUPANCY.mixed) return { solid, light, page: null, cover };
  const page = new Uint32Array(WALK_PAGE_WORDS);
  const full = pe === 32 ? 0xffffffff : (1 << pe) - 1;
  (['solid', 'light'] as const).forEach((stop, k) => {
    const off = walkPageOffsets(stop);
    for (const v of views) {
      const view = v[k] as WalkBlockView;
      if (view.flag === OCCUPANCY.empty) continue;
      for (let x = 0; x < pe; x++) for (let z = 0; z < pe; z++) {
        const gx = v[2] + x;
        const gz = v[4] + z;
        // The column's cells as a word: whole for a solid view, read as a word where the view has one, else cell by cell.
        let bits = view.flag === OCCUPANCY.solid ? full : view.column !== undefined ? view.column(x * pe + z) : 0;
        if (view.flag !== OCCUPANCY.solid && view.column === undefined) for (let y = 0; y < pe; y++) if (view.cell((x * pe + z) * pe + y)) bits |= 1 << y;
        if (bits === 0) continue;
        page[off.cells + gx * E + gz]! |= bits << v[3];
        // A brick bit for each four cells of the column holding one.
        const row = ((gx >> 2) * BRICKS + (gz >> 2)) * BRICKS;
        for (let y = 0; y < pe; y += 4) {
          if (((bits >>> y) & 15) === 0) continue;
          const bi = row + ((v[3] + y) >> 2);
          page[off.bricks + (bi >>> 5)]! |= 1 << (bi & 31);
        }
      }
    }
  });
  return { solid, light, page, cover };
}

/** A page's view for one stop (block cells as the walk indexes them). */
export function pageWalkView(page: Uint32Array, base: number, flag: number, stop: WalkStop, partial?: WalkPartial): WalkBlockView {
  const off = walkPageOffsets(stop);
  const b = base + off.bricks;
  const c = base + off.cells;
  return {
    flag,
    brick: (i) => (((page[b + (i >>> 5)]! >>> (i & 31)) & 1) === 1 ? OCCUPANCY.mixed : OCCUPANCY.empty),
    cell: (i) => ((page[c + (i >>> 5)]! >>> (i & 31)) & 1) === 1,
    ...(partial !== undefined ? { partial } : {}),
  };
}

const EMPTY: WalkBlockView = Object.freeze({ flag: OCCUPANCY.empty, brick: () => OCCUPANCY.empty, cell: () => false });
const SOLID: WalkBlockView = Object.freeze({ flag: OCCUPANCY.solid, brick: () => OCCUPANCY.solid, cell: () => true });

/**
 * The walk's blocks by key, with their pages, in flat arrays a GPU buffer takes as they are; the entries and pages
 * written since the last {@link takeDirty} are listed for upload.
 */
export class WalkTable {
  entries: Uint32Array;
  pages: Uint32Array;
  private count = 0;
  private pageCount = 0;
  private readonly freePages: number[] = [];
  private readonly freeCovers: number[] = [];
  /** Entries and pages written since taken; `grown`: the arrays were replaced (upload them whole). */
  private dirtyEntries = new Set<number>();
  private dirtyPages = new Set<number>();
  private grown = true;
  /** The coarsest level written. */
  maxLevel = 0;

  constructor(capacity = 1024, pages = 16) {
    this.entries = WalkTable.emptyEntries(capacity);
    this.pages = new Uint32Array(pages * WALK_PAGE_WORDS);
  }

  private static emptyEntries(capacity: number): Uint32Array {
    if (capacity & (capacity - 1)) throw new RangeError('table capacity must be a power of two');
    const e = new Uint32Array(capacity * WALK_ENTRY_WORDS);
    for (let i = 0; i < capacity; i++) e[i * WALK_ENTRY_WORDS + 1] = WALK_EMPTY_KEY;
    return e;
  }

  get capacity(): number {
    return this.entries.length / WALK_ENTRY_WORDS;
  }

  /** Blocks held. */
  get size(): number {
    return this.count;
  }

  /** Pages in use. */
  get pagesUsed(): number {
    return this.pageCount - this.freePages.length - this.freeCovers.length * WALK_COVER_PAGES;
  }

  /** Bytes held (the entries and every page slot). */
  get bytes(): number {
    return this.entries.byteLength + this.pages.byteLength;
  }

  private find(k0: number, k1: number): number {
    const mask = this.capacity - 1;
    let i = walkHash(k0, k1, mask);
    for (let p = 0; p <= mask; p++) {
      const at = i * WALK_ENTRY_WORDS;
      const e1 = this.entries[at + 1]!;
      if (e1 === WALK_EMPTY_KEY) return -1 - i;
      if (e1 === k1 && this.entries[at]! === k0) return i;
      i = (i + 1) & mask;
    }
    return -1 - i;
  }

  /** The value of a block (−1: not held). */
  value(level: number, bx: number, by: number, bz: number): number {
    const [k0, k1] = walkKey(level, bx, by, bz);
    const i = this.find(k0, k1);
    return i < 0 ? -1 : this.entries[i * WALK_ENTRY_WORDS + 2]!;
  }

  /** A block's view for a stop (null: not held). */
  view(level: number, bx: number, by: number, bz: number, stop: WalkStop): WalkBlockView | null {
    return this.viewOf(level, bx, by, bz, stop, false);
  }

  /** A block's view for a stop over a copy of its page (null: not held): what it is now, after the table changes. */
  viewCopy(level: number, bx: number, by: number, bz: number, stop: WalkStop): WalkBlockView | null {
    return this.viewOf(level, bx, by, bz, stop, true);
  }

  private viewOf(level: number, bx: number, by: number, bz: number, stop: WalkStop, copy: boolean): WalkBlockView | null {
    const [k0, k1] = walkKey(level, bx, by, bz);
    const at = this.find(k0, k1);
    if (at < 0) return null;
    const v = this.entries[at * WALK_ENTRY_WORDS + 2]!;
    const cv = stop === 'light' ? this.entries[at * WALK_ENTRY_WORDS + 3]! : 0;
    const coverAt = (cv - 1) * WALK_PAGE_WORDS;
    const partial = cv === 0 ? undefined : copy ? coverPartial(this.pages.slice(coverAt, coverAt + WALK_COVER_WORDS), 0) : coverPartial(this.pages, coverAt);
    const flag = stop === 'solid' ? v & 3 : (v >>> 2) & 3;
    if (flag === OCCUPANCY.empty) return partial === undefined ? EMPTY : { ...EMPTY, partial };
    if (flag === OCCUPANCY.solid) return SOLID;
    const base = (v >>> 4) * WALK_PAGE_WORDS;
    return copy ? pageWalkView(this.pages.slice(base, base + WALK_PAGE_WORDS), 0, flag, stop, partial) : pageWalkView(this.pages, base, flag, stop, partial);
  }

  /** Puts a block in (replacing what it held). */
  set(level: number, bx: number, by: number, bz: number, b: WalkPacked): void {
    const [k0, k1] = walkKey(level, bx, by, bz);
    let i = this.find(k0, k1);
    let page = -1;
    if (i >= 0) {
      const old = this.entries[i * WALK_ENTRY_WORDS + 2]!;
      if (this.hasPage(old)) page = old >>> 4;
    }
    if (b.page !== null) {
      if (page < 0) page = this.takePage();
      this.pages.set(b.page, page * WALK_PAGE_WORDS);
      this.dirtyPages.add(page);
    } else if (page >= 0) {
      this.freePages.push(page);
      page = -1;
    }
    let cover = i >= 0 ? this.entries[i * WALK_ENTRY_WORDS + 3]! - 1 : -1;
    if (b.cover != null) {
      if (cover < 0) cover = this.takeCover();
      this.pages.set(b.cover, cover * WALK_PAGE_WORDS);
      for (let k = 0; k < WALK_COVER_PAGES; k++) this.dirtyPages.add(cover + k);
    } else if (cover >= 0) {
      this.freeCovers.push(cover);
      cover = -1;
    }
    if (i < 0) {
      if ((this.count + 1) * 2 > this.capacity) {
        this.rehash(this.capacity * 2);
        i = this.find(k0, k1);
      }
      i = -1 - i;
      this.count++;
    }
    const at = i * WALK_ENTRY_WORDS;
    this.entries[at] = k0;
    this.entries[at + 1] = k1;
    this.entries[at + 2] = (b.solid | (b.light << 2) | ((page < 0 ? 0 : page) << 4)) >>> 0;
    this.entries[at + 3] = cover + 1;
    this.dirtyEntries.add(i);
    this.maxLevel = Math.max(this.maxLevel, level);
    if (this.probeLength(i, k0, k1) > WALK_MAX_PROBES) this.rehash(this.capacity * 2);
  }

  private hasPage(v: number): boolean {
    return (v & 3) === OCCUPANCY.mixed || ((v >>> 2) & 3) === OCCUPANCY.mixed;
  }

  private probeLength(i: number, k0: number, k1: number): number {
    const mask = this.capacity - 1;
    return ((i - walkHash(k0, k1, mask)) & mask) + 1;
  }

  /** Takes a block out (a block not held: nothing). */
  delete(level: number, bx: number, by: number, bz: number): void {
    const [k0, k1] = walkKey(level, bx, by, bz);
    let i = this.find(k0, k1);
    if (i < 0) return;
    const v = this.entries[i * WALK_ENTRY_WORDS + 2]!;
    if (this.hasPage(v)) this.freePages.push(v >>> 4);
    const cv = this.entries[i * WALK_ENTRY_WORDS + 3]!;
    if (cv > 0) this.freeCovers.push(cv - 1);
    this.count--;
    // Backward shift: each later entry of the run moves into the hole when its home slot does not lie past the hole.
    const mask = this.capacity - 1;
    let j = i;
    for (;;) {
      j = (j + 1) & mask;
      const at = j * WALK_ENTRY_WORDS;
      if (this.entries[at + 1] === WALK_EMPTY_KEY) break;
      const home = walkHash(this.entries[at]!, this.entries[at + 1]!, mask);
      if (((j - home) & mask) >= ((j - i) & mask)) {
        this.entries.copyWithin(i * WALK_ENTRY_WORDS, at, at + WALK_ENTRY_WORDS);
        this.dirtyEntries.add(i);
        i = j;
      }
    }
    const at = i * WALK_ENTRY_WORDS;
    this.entries.fill(0, at, at + WALK_ENTRY_WORDS);
    this.entries[at + 1] = WALK_EMPTY_KEY;
    this.dirtyEntries.add(i);
  }

  private takePage(): number {
    const free = this.freePages.pop();
    if (free !== undefined) return free;
    const p = this.pageCount++;
    if ((p + 1) * WALK_PAGE_WORDS > this.pages.length) {
      const next = new Uint32Array(Math.max(16, this.pageCount * 2) * WALK_PAGE_WORDS);
      next.set(this.pages);
      this.pages = next;
      this.grown = true;
    }
    return p;
  }

  /** The first of {@link WALK_COVER_PAGES} page slots side by side for a cover (freed covers kept apart from single pages). */
  private takeCover(): number {
    const free = this.freeCovers.pop();
    if (free !== undefined) return free;
    const p = this.pageCount;
    this.pageCount += WALK_COVER_PAGES;
    if (this.pageCount * WALK_PAGE_WORDS > this.pages.length) {
      const next = new Uint32Array(Math.max(16, this.pageCount * 2) * WALK_PAGE_WORDS);
      next.set(this.pages);
      this.pages = next;
      this.grown = true;
    }
    return p;
  }

  private rehash(capacity: number): void {
    const old = this.entries;
    this.entries = WalkTable.emptyEntries(capacity);
    const mask = capacity - 1;
    for (let at = 0; at < old.length; at += WALK_ENTRY_WORDS) {
      if (old[at + 1] === WALK_EMPTY_KEY) continue;
      let i = walkHash(old[at]!, old[at + 1]!, mask);
      while (this.entries[i * WALK_ENTRY_WORDS + 1] !== WALK_EMPTY_KEY) i = (i + 1) & mask;
      this.entries.set(old.subarray(at, at + WALK_ENTRY_WORDS), i * WALK_ENTRY_WORDS);
    }
    this.grown = true;
  }

  /** What changed since the last call: everything (`whole`) when an array was replaced, else the entries and pages written. */
  takeDirty(): { readonly whole: boolean; readonly entries: number[]; readonly pages: number[] } {
    const out = { whole: this.grown, entries: [...this.dirtyEntries].sort((a, b) => a - b), pages: [...this.dirtyPages].sort((a, b) => a - b) };
    this.grown = false;
    this.dirtyEntries = new Set();
    this.dirtyPages = new Set();
    return out;
  }

  /** The table as a walk source (every level's blocks 32³). */
  source(): WalkSource {
    const levels = (): number => this.maxLevel;
    return {
      get maxLevel() {
        return levels();
      },
      blockShift: () => WALK_BLOCK_SHIFT,
      block: (level, bx, by, bz, stop) => this.view(level, bx, by, bz, stop),
    };
  }
}

/** A block in a feed: its key and, unless removed, its packed content. */
export interface WalkBlockWire {
  readonly level: number;
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
  /** Absent: the block is no longer known (taken out). */
  readonly packed?: WalkPacked;
}

/**
 * The blocks a streamer's changes touch, packed for the page where the world runs. `chunkEdge`: the storage chunks'
 * edge (a level's chunk or mip node is `chunkEdge` of its cells; a walk block holds one or 2³ of them).
 */
export class WalkBlockFeed {
  private readonly dirty = new Map<string, [number, number, number, number]>();
  private readonly sent = new Set<string>();
  private readonly per: number;

  constructor(
    private readonly src: WalkSource,
    chunkEdge: number,
  ) {
    this.per = E / chunkEdge;
  }

  /** A chunk (level 0) or a mip node (level ≥ 1) changed, arrived or went. */
  touch(level: number, cx: number, cy: number, cz: number): void {
    const b: [number, number, number, number] = [level, Math.floor(cx / this.per), Math.floor(cy / this.per), Math.floor(cz / this.per)];
    this.dirty.set(b.join(','), b);
  }

  /** Whether anything waits to be sent. */
  get pending(): boolean {
    return this.dirty.size > 0;
  }

  /**
   * The touched blocks packed (or removed), each once, in the order touched, while `more()` says so (at least one);
   * the rest wait for the next call.
   */
  take(more: () => boolean = () => true): WalkBlockWire[] {
    const out: WalkBlockWire[] = [];
    let n = 0;
    for (const [key, [level, bx, by, bz]] of this.dirty) {
      if (n++ > 0 && !more()) break;
      this.dirty.delete(key);
      const packed = packWalkBlock(this.src, level, bx, by, bz);
      this.packed++;
      if (packed === null) {
        if (this.sent.delete(key)) out.push({ level, bx, by, bz });
        continue;
      }
      this.sent.add(key);
      out.push({ level, bx, by, bz, packed });
    }
    return out;
  }

  /** Nothing waits and nothing counts as sent (the page let its blocks go: the next ones it gets are all it holds). */
  reset(): void {
    this.dirty.clear();
    this.sent.clear();
  }

  /** Blocks sent and not removed since. */
  get held(): number {
    return this.sent.size;
  }

  /** Blocks packed (or found gone) so far. */
  packed = 0;
}

/** Applies a feed's wires to a table. */
export function applyWalkWires(t: WalkTable, wires: readonly WalkBlockWire[]): void {
  for (const w of wires) {
    if (w.packed === undefined) t.delete(w.level, w.bx, w.by, w.bz);
    else t.set(w.level, w.bx, w.by, w.bz, w.packed);
  }
}
