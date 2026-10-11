/**
 * The projected decals' table and world-grid index, as the receiving
 * materials read them (projected-decals.ts).
 *
 * The table is one row of {@link DECAL_ROW_TEXELS} float texels per decal:
 * its world-to-box matrix (the box is the unit cube −0.5…0.5 on each axis),
 * where its images are on the pages, its opacities, fades, layers and its
 * material's factors.
 *
 * The index is a grid of cells over the decals' boxes, each cell listing the
 * decals reaching into it, lowest sort order first, so a pixel blends them in
 * order by walking its cell's list. Only cells that list a decal are stored,
 * in a hash table: a level's decals may be spread over kilometres while each
 * stays a metre wide, and a dense grid over that spread would either be huge
 * or need cells so coarse that a pixel walks (and the overlap budget counts)
 * decals nowhere near it. A slot is one texel (the cell's x, y, z, then
 * where its list starts; −1: empty), a list's first texel its length, then
 * a texel per entry (a table row). The table is built at most a quarter
 * full, so a pixel in a cell without decals reads one slot, nearly always an
 * empty one, and stops (the lookup probes on through taken slots until its
 * cell or an empty slot; the longest probe is kept for the shader's loop).
 * Cell coordinates count from the grid's corner and may be negative (a decal
 * that moved past it): a cell is found by its hash, never by a bound.
 *
 * Cells follow the decals' sizes: per axis the median extent of their boxes,
 * so a cell's list is about the decals that overlap there; doubled while the
 * decals would reach into more than {@link DECAL_INDEX_ENTRIES_PER_DECAL}
 * cells each on average (a few huge decals among small ones). A cell lists
 * at most the overlap budget (project-model `DECAL_CELL_BUDGET`): past it the
 * lowest sort orders are dropped there and counted.
 *
 * The index changes in place ({@link DecalGrid}): a decal added, moved or
 * removed rewrites only the lists of the cells it left and entered, so a
 * moving or spawned decal costs its own few cells, never a rebuild, and a
 * still level costs the main thread nothing. A list sits in a block of a
 * power-of-two capacity and moves to a larger free one when it outgrows it.
 * A cell left empty gives its slot back, the cells probed past it moving up
 * into the gap (linear probing's deletion), so a decal travelling across a
 * level leaves no trail of slots that would lengthen the lookups.
 * The layout (the corner, the cell size, the table's size, the room for
 * lists) is chosen when the grid is built, with room to spare; a change it
 * cannot take (the table past {@link DECAL_SLOTS_FULL} full, the lists out of
 * room, a decal reaching into far more cells than the cells were sized for)
 * asks for a new build. Pure: no three.js.
 */

/** Texels a line of the table and index textures. */
export const DECAL_TEXTURE_WIDTH = 1024;
/** The cells a decal may reach into on average before the cells are made larger (each is an entry to store and walk). */
export const DECAL_INDEX_ENTRIES_PER_DECAL = 16;
/** The hash's multipliers per axis (the shader uses the same, as unsigned 32-bit products). */
export const DECAL_HASH: readonly [number, number, number] = [73856093, 19349663, 83492791];
/** Float texels a decal's row of the table holds (see {@link packDecalRow}). */
export const DECAL_ROW_TEXELS = 12;

/** One projected decal as the table holds it. */
export interface DecalRow {
  /** World to box: three rows of a 3×4 matrix (row-major), taking the box to the unit cube centred on 0. */
  readonly worldToBox: readonly number[];
  /** The box's world bounds. */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** [u0, v0, u1, v1] on its pages, from the top-left. */
  readonly rect: readonly [number, number, number, number];
  /** Its layer on the albedo, normal and ORM page arrays (−1: no image in that set). */
  readonly layers: readonly [number, number, number];
  /** The longest footprint a read may have, in level-0 texels (2^mip; a large number: no cap). */
  readonly footprint: number;
  /** Albedo, normal, roughness, metalness, occlusion, emission: 0–1 each. */
  readonly opacity: readonly [number, number, number, number, number, number];
  /** The cosine of the normal fade's angle (no mark past it) and of four fifths of it (full mark before it). */
  readonly normalFadeCos: readonly [number, number];
  /** Fractions of the box depth it fades over at its front (+Z) and back (−Z) ends. */
  readonly edgeFade: readonly [number, number];
  /** Metres from the camera where it has faded out (0: never). */
  readonly fadeDistance: number;
  /** The decal layers it marks (bit mask). */
  readonly layerMask: number;
  /** The material's tint (linear) and opacity, emissive colour × intensity (linear), occlusion intensity. */
  readonly tint: readonly [number, number, number, number];
  readonly emissive: readonly [number, number, number];
  readonly aoIntensity: number;
  /** Roughness and metalness factors, normal scale (x, y). */
  readonly roughness: number;
  readonly metalness: number;
  readonly normalScale: readonly [number, number];
  /** Where decals overlap the higher order is blended over the lower. */
  readonly sortOrder: number;
}

/** Write `row` as table row `i` of `data` (RGBA float texels). */
export function packDecalRow(data: Float32Array, i: number, row: DecalRow): void {
  const o = i * DECAL_ROW_TEXELS * 4;
  for (let k = 0; k < 12; k++) data[o + k] = row.worldToBox[k] ?? 0;
  data.set(row.rect, o + 12);
  data[o + 16] = row.layers[0];
  data[o + 17] = row.layers[1];
  data[o + 18] = row.layers[2];
  data[o + 19] = row.footprint;
  data.set(row.opacity.slice(0, 4), o + 20);
  data[o + 24] = row.opacity[4];
  data[o + 25] = row.opacity[5];
  data[o + 26] = row.normalFadeCos[0];
  data[o + 27] = row.normalFadeCos[1];
  data[o + 28] = row.edgeFade[0];
  data[o + 29] = row.edgeFade[1];
  data[o + 30] = row.fadeDistance;
  data[o + 31] = row.layerMask;
  data.set(row.tint, o + 32);
  data.set(row.emissive, o + 36);
  data[o + 39] = row.aoIntensity;
  data[o + 40] = row.roughness;
  data[o + 41] = row.metalness;
  data[o + 42] = row.normalScale[0];
  data[o + 43] = row.normalScale[1];
}

/** The table's texels for `rows`: `DECAL_TEXTURE_WIDTH` a line, at least one line. */
export function packDecalTable(rows: readonly DecalRow[]): { data: Float32Array; height: number } {
  const height = Math.max(1, Math.ceil((rows.length * DECAL_ROW_TEXELS) / DECAL_TEXTURE_WIDTH));
  const data = new Float32Array(height * DECAL_TEXTURE_WIDTH * 4);
  rows.forEach((r, i) => packDecalRow(data, i, r));
  return { data, height };
}

/** What the index needs of a decal: its world bounds and the order it is drawn in. */
export interface DecalBox {
  readonly min: readonly number[];
  readonly max: readonly number[];
  readonly sortOrder: number;
}

/** The index as the shader reads it (a view of a {@link DecalGrid}). */
export interface DecalIndex {
  /** The grid's corner and 1 / its cell size per axis. */
  readonly origin: readonly [number, number, number];
  readonly invCell: readonly [number, number, number];
  /** The hash table's slots − 1 (a power of two less one; 0: no decals) and the longest probe a lookup makes (slots read). */
  readonly mask: number;
  readonly probes: number;
  /** RGBA texels, `DECAL_TEXTURE_WIDTH` a line: the slots (cell x, y, z, list start or −1), then the lists (length, then table rows). */
  readonly data: Float32Array;
  readonly height: number;
  /** Cells that list a decal, and their entries. */
  readonly cells: number;
  readonly entries: number;
  /** Cell entries left out over the overlap budget, and the decals left out of at least one cell. */
  readonly dropped: number;
  readonly droppedDecals: number;
}

/** The share of the hash table's slots a grid may fill with cells before it is built again. */
export const DECAL_SLOTS_FULL = 3 / 8;
/** A change that makes a decal reach into more cells than this asks for a new build (larger cells). */
const CELLS_PER_DECAL_MAX = 4 * DECAL_INDEX_ENTRIES_PER_DECAL;
/** Cell coordinates stay exact in a float texel (2^24). */
const COORD_MAX = 1 << 23;

const median = (v: number[]): number => {
  v.sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)]!;
};
const pow2 = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

/** A cell's slot before probing: the cell's coordinates hashed (unsigned 32-bit, as the shader computes it from their signed values), masked. */
export function decalHashSlot(x: number, y: number, z: number, mask: number): number {
  return ((Math.imul(x, DECAL_HASH[0]) ^ Math.imul(y, DECAL_HASH[1]) ^ Math.imul(z, DECAL_HASH[2])) >>> 0) & mask;
}

interface Cell {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  slot: number;
  /** Its list's block (the length's texel) and how many entries the block has room for. */
  block: number;
  cap: number;
  /** Every decal reaching into it, in drawing order; the list holds the last `budget` of them. */
  rows: number[];
  /** Those the budget leaves out, and the entries the list holds. */
  cut: number[];
  stored: number;
}

/** The world-grid index of a changing set of decals (see the module comment). */
export class DecalGrid {
  origin: [number, number, number] = [0, 0, 0];
  /** The cell size per axis (m). */
  cell: [number, number, number] = [1, 1, 1];
  mask = 0;
  probes = 1;
  data = new Float32Array(DECAL_TEXTURE_WIDTH * 4);
  height = 1;
  entries = 0;
  dropped = 0;
  private readonly cells = new Map<string, Cell>();
  private rowCells: (Cell[] | undefined)[] = [];
  private boxes: (DecalBox | undefined)[] = [];
  private seq: number[] = [];
  /** Slots holding a cell. */
  private slotsTaken = 0;
  /** Where the next list block goes; the shared empty list; freed blocks by capacity. */
  private heapEnd = 0;
  private emptyBlock = 0;
  private readonly free = new Map<number, number[]>();
  /** The decals the budget leaves out of a cell: in how many cells. */
  private readonly cutCounts = new Map<number, number>();
  private dirtyLo = Infinity;
  private dirtyHi = 0;

  constructor(private readonly budget: number) {
    this.clear();
  }

  /** Cells that list a decal. */
  get cellCount(): number {
    return this.cells.size;
  }

  /** Decals left out of at least one cell over the overlap budget. */
  get droppedDecals(): number {
    return this.cutCounts.size;
  }

  /** The texels written since the last call ([from, to), whole lines), or null. */
  takeDirty(): { from: number; to: number } | null {
    if (this.dirtyLo >= this.dirtyHi) return null;
    const out = { from: this.dirtyLo, to: this.dirtyHi };
    this.dirtyLo = Infinity;
    this.dirtyHi = 0;
    return out;
  }

  /** The index as the shader reads it. */
  view(): DecalIndex {
    return { origin: this.origin, invCell: [1 / this.cell[0], 1 / this.cell[1], 1 / this.cell[2]], mask: this.mask, probes: this.probes, data: this.data, height: this.height, cells: this.cells.size, entries: this.entries, dropped: this.dropped, droppedDecals: this.droppedDecals };
  }

  /**
   * Lay the grid out for `boxes` (by table row; undefined: a row not in
   * use). `seq` orders decals of one sort order (absent: table order); the
   * layout leaves room for as many lists again.
   */
  build(boxes: readonly (DecalBox | undefined)[], seq?: readonly number[]): void {
    this.boxes = [...boxes];
    this.seq = boxes.map((_, i) => seq?.[i] ?? i);
    this.clear();
    const live: number[] = [];
    boxes.forEach((b, i) => (b !== undefined ? live.push(i) : undefined));
    if (live.length === 0) return;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    const cell: [number, number, number] = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      const extents: number[] = [];
      for (const i of live) {
        const r = boxes[i]!;
        lo[a] = Math.min(lo[a]!, r.min[a]!);
        hi[a] = Math.max(hi[a]!, r.max[a]!);
        extents.push(r.max[a]! - r.min[a]!);
      }
      cell[a] = Math.max(0.05, median(extents));
    }
    this.origin = [lo[0]!, lo[1]!, lo[2]!];
    const reach = (r: DecalBox): number => [0, 1, 2].reduce((n, a) => n * (Math.floor((r.max[a]! - lo[a]!) / cell[a]!) - Math.floor((r.min[a]! - lo[a]!) / cell[a]!) + 1), 1);
    // Coordinates stay exact in a float texel and the cells per decal bounded.
    const fits = (): boolean => [0, 1, 2].every((a) => (hi[a]! - lo[a]!) / cell[a]! < COORD_MAX / 2) && live.reduce((n, i) => n + reach(boxes[i]!), 0) <= DECAL_INDEX_ENTRIES_PER_DECAL * live.length;
    while (!fits()) for (let a = 0; a < 3; a++) cell[a] = cell[a]! * 2;
    this.cell = cell;
    // Each cell's decals in drawing order (rows placed lowest order first, so every list is appended to in order).
    const order = [...live].sort((a, b) => this.before(a, b));
    const lists = new Map<string, { at: [number, number, number]; rows: number[] }>();
    for (const i of order) {
      for (const at of this.cellsOf(boxes[i]!, Infinity)!) {
        const k = `${at[0]},${at[1]},${at[2]}`;
        const l = lists.get(k);
        if (l === undefined) lists.set(k, { at, rows: [i] });
        else l.rows.push(i);
      }
    }
    // A quarter full at most; lists in blocks, with as much room again for the changes to come.
    const slots = pow2(Math.max(64, lists.size * 4));
    let room = 1;
    for (const l of lists.values()) room += 1 + pow2(Math.min(l.rows.length, this.budget));
    this.layout(slots, slots + 2 * room + DECAL_TEXTURE_WIDTH);
    for (const l of lists.values()) {
      const c = this.open(l.at[0], l.at[1], l.at[2])!;
      c.rows = l.rows;
      this.write(c);
      for (const i of l.rows) (this.rowCells[i] ??= []).push(c);
    }
    this.markDirty(0, this.height * DECAL_TEXTURE_WIDTH);
  }

  /**
   * Row `i`'s box now (undefined: the decal is gone); `seq` its place among
   * decals of its sort order (absent: kept, or table order). Rewrites only
   * the lists of the cells it left and entered. False: the layout cannot
   * take the change, and the grid must be built again.
   */
  set(i: number, box: DecalBox | undefined, seq?: number): boolean {
    const before = this.rowCells[i] ?? [];
    const old = this.boxes[i];
    this.boxes[i] = box;
    if (seq !== undefined) this.seq[i] = seq;
    else this.seq[i] ??= i;
    if (box === undefined) {
      for (const c of before) this.leave(c, i);
      this.rowCells[i] = undefined;
      return true;
    }
    if (this.mask === 0) return false;
    const at = this.cellsOf(box, CELLS_PER_DECAL_MAX);
    if (at === null) return false;
    const reorder = old !== undefined && old.sortOrder !== box.sortOrder;
    // The cells it left first: their slots are free for the cells it enters.
    const keys = new Set(at.map(([x, y, z]) => `${x},${y},${z}`));
    for (const c of before) if (!keys.has(c.key)) this.leave(c, i);
    const next: Cell[] = [];
    for (const [x, y, z] of at) {
      let c = this.cells.get(`${x},${y},${z}`);
      if (c !== undefined && before.includes(c)) {
        next.push(c);
        if (reorder) {
          c.rows.splice(c.rows.indexOf(i), 1);
          this.insert(c, i);
          this.write(c);
        }
        continue;
      }
      c ??= this.open(x, y, z) ?? undefined;
      if (c === undefined) return false;
      this.insert(c, i);
      if (!this.write(c)) return false;
      next.push(c);
    }
    this.rowCells[i] = next;
    return true;
  }

  /** No decals: one empty slot. */
  private clear(): void {
    this.cells.clear();
    this.rowCells = [];
    this.free.clear();
    this.cutCounts.clear();
    this.entries = 0;
    this.dropped = 0;
    this.probes = 1;
    this.layout(1, 2);
    this.mask = 0;
    this.markDirty(0, this.height * DECAL_TEXTURE_WIDTH);
  }

  private layout(slots: number, texels: number): void {
    this.height = Math.ceil(texels / DECAL_TEXTURE_WIDTH);
    this.data = new Float32Array(this.height * DECAL_TEXTURE_WIDTH * 4);
    this.mask = slots - 1;
    for (let s = 0; s < slots; s++) this.data[s * 4 + 3] = -1;
    this.slotsTaken = 0;
    this.probes = 1;
    // The shared empty list (a cell left empty points at it), then the blocks.
    this.emptyBlock = slots;
    this.heapEnd = slots + 1;
  }

  /** Whether row `a` is drawn before row `b`: lower sort orders first, then by `seq`. */
  private before(a: number, b: number): number {
    return this.boxes[a]!.sortOrder - this.boxes[b]!.sortOrder || this.seq[a]! - this.seq[b]!;
  }

  /** The cells `box` reaches into (null: more than `most`, or past what a texel holds exactly). */
  private cellsOf(box: DecalBox, most: number): [number, number, number][] | null {
    const c0: number[] = [];
    const c1: number[] = [];
    let n = 1;
    for (let a = 0; a < 3; a++) {
      c0.push(Math.floor((box.min[a]! - this.origin[a]!) / this.cell[a]!));
      c1.push(Math.floor((box.max[a]! - this.origin[a]!) / this.cell[a]!));
      n *= c1[a]! - c0[a]! + 1;
      if (!(Math.abs(c0[a]!) < COORD_MAX && Math.abs(c1[a]!) < COORD_MAX)) return null;
    }
    if (n > most) return null;
    const out: [number, number, number][] = [];
    for (let z = c0[2]!; z <= c1[2]!; z++) for (let y = c0[1]!; y <= c1[1]!; y++) for (let x = c0[0]!; x <= c1[0]!; x++) out.push([x, y, z]);
    return out;
  }

  /** A slot for a new cell: the empty slot that ends its probe (null: the table is full enough to build again). */
  private open(x: number, y: number, z: number): Cell | null {
    if (this.slotsTaken + 1 > DECAL_SLOTS_FULL * (this.mask + 1)) return null;
    const d = this.data;
    let s = decalHashSlot(x, y, z, this.mask);
    let n = 1;
    while (d[s * 4 + 3]! >= 0) {
      s = (s + 1) & this.mask;
      n += 1;
    }
    this.slotsTaken += 1;
    this.probes = Math.max(this.probes, n);
    d[s * 4] = x;
    d[s * 4 + 1] = y;
    d[s * 4 + 2] = z;
    // Taken (its list follows when it is written).
    d[s * 4 + 3] = this.emptyBlock;
    this.markDirty(s, s + 1);
    const c: Cell = { key: `${x},${y},${z}`, x, y, z, slot: s, block: this.emptyBlock, cap: 0, rows: [], cut: [], stored: 0 };
    this.cells.set(c.key, c);
    return c;
  }

  /**
   * Empty slot `i`, moving the cells probed past it back into the gap
   * (linear probing's deletion): every cell stays where a lookup finds it,
   * and no emptied slot is left to lengthen the lookups of empty cells.
   */
  private closeSlot(i: number): void {
    const d = this.data;
    let gap = i;
    let j = i;
    for (;;) {
      j = (j + 1) & this.mask;
      if (d[j * 4 + 3]! < 0) break;
      const home = decalHashSlot(d[j * 4]!, d[j * 4 + 1]!, d[j * 4 + 2]!, this.mask);
      // A cell whose home lies cyclically in (gap, j] is found before the gap: it stays.
      const stays = gap <= j ? gap < home && home <= j : gap < home || home <= j;
      if (stays) continue;
      d.copyWithin(gap * 4, j * 4, j * 4 + 4);
      this.cells.get(`${d[gap * 4]},${d[gap * 4 + 1]},${d[gap * 4 + 2]}`)!.slot = gap;
      this.markDirty(gap, gap + 1);
      gap = j;
    }
    d[gap * 4] = 0;
    d[gap * 4 + 1] = 0;
    d[gap * 4 + 2] = 0;
    d[gap * 4 + 3] = -1;
    this.markDirty(gap, gap + 1);
    this.slotsTaken -= 1;
  }

  /** Put row `i` into `c`'s decals in drawing order (a new decal most often goes last). */
  private insert(c: Cell, i: number): void {
    let k = c.rows.length;
    while (k > 0 && this.before(c.rows[k - 1]!, i) > 0) k -= 1;
    c.rows.splice(k, 0, i);
  }

  private leave(c: Cell, i: number): void {
    const k = c.rows.indexOf(i);
    if (k < 0) return;
    c.rows.splice(k, 1);
    this.write(c);
  }

  /** Write `c`'s list (the last `budget` of its decals); an emptied cell gives its block back. False: no room for a larger block. */
  private write(c: Cell): boolean {
    const cutN = Math.max(0, c.rows.length - this.budget);
    const stored = c.rows.length - cutN;
    if (cutN > 0 || c.cut.length > 0) {
      for (const r of c.cut) {
        const n = (this.cutCounts.get(r) ?? 0) - 1;
        if (n <= 0) this.cutCounts.delete(r);
        else this.cutCounts.set(r, n);
      }
      this.dropped += cutN - c.cut.length;
      c.cut = c.rows.slice(0, cutN);
      for (const r of c.cut) this.cutCounts.set(r, (this.cutCounts.get(r) ?? 0) + 1);
    }
    this.entries += stored - c.stored;
    c.stored = stored;
    const d = this.data;
    if (stored === 0) {
      if (c.cap > 0) this.release(c.block, c.cap);
      c.block = this.emptyBlock;
      c.cap = 0;
      this.cells.delete(c.key);
      this.closeSlot(c.slot);
      return true;
    }
    if (stored > c.cap) {
      const cap = pow2(stored);
      const block = this.alloc(cap);
      if (block < 0) return false;
      if (c.cap > 0) this.release(c.block, c.cap);
      c.block = block;
      c.cap = cap;
      d[c.slot * 4 + 3] = block;
      this.markDirty(c.slot, c.slot + 1);
    }
    d[c.block * 4] = stored;
    for (let k = 0; k < stored; k++) d[(c.block + 1 + k) * 4] = c.rows[cutN + k]!;
    this.markDirty(c.block, c.block + 1 + stored);
    return true;
  }

  private alloc(cap: number): number {
    const reused = this.free.get(cap)?.pop();
    if (reused !== undefined) return reused;
    if (this.heapEnd + 1 + cap > this.height * DECAL_TEXTURE_WIDTH) return -1;
    const b = this.heapEnd;
    this.heapEnd += 1 + cap;
    return b;
  }

  private release(block: number, cap: number): void {
    const l = this.free.get(cap);
    if (l === undefined) this.free.set(cap, [block]);
    else l.push(block);
  }

  private markDirty(from: number, to: number): void {
    this.dirtyLo = Math.min(this.dirtyLo, from);
    this.dirtyHi = Math.max(this.dirtyHi, to);
  }
}

/** The index of `boxes` (table order): each cell's list sorted by sort order, then table order, at most `budget` long. */
export function buildDecalIndex(boxes: readonly DecalBox[], budget: number): DecalIndex {
  const g = new DecalGrid(budget);
  g.build(boxes);
  return g.view();
}

/** The table rows a world point's cell lists, in drawing order (the shader walks the same list, found the same way). */
export function decalRowsAt(index: DecalIndex, p: { x: number; y: number; z: number }): number[] {
  if (index.mask === 0) return [];
  const cx = Math.floor((p.x - index.origin[0]) * index.invCell[0]);
  const cy = Math.floor((p.y - index.origin[1]) * index.invCell[1]);
  const cz = Math.floor((p.z - index.origin[2]) * index.invCell[2]);
  let s = decalHashSlot(cx, cy, cz, index.mask);
  const d = index.data;
  for (let k = 0; k < index.probes; k++, s = (s + 1) & index.mask) {
    const start = d[s * 4 + 3]!;
    if (start < 0) return [];
    if (d[s * 4] !== cx || d[s * 4 + 1] !== cy || d[s * 4 + 2] !== cz) continue;
    const out: number[] = [];
    for (let i = 0; i < d[start * 4]!; i++) out.push(d[(start + 1 + i) * 4]!);
    return out;
  }
  return [];
}
