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
 * where its list starts; −1: empty), the list's first texel its length, then
 * a texel per entry (a table row). The table is at most a quarter full, so
 * a pixel in a cell without decals reads one slot, nearly always an empty
 * one, and stops (the lookup probes on through taken slots until its cell
 * or an empty slot; the longest probe is kept for the shader's loop).
 *
 * Cells follow the decals' sizes: per axis the median extent of their boxes,
 * so a cell's list is about the decals that overlap there; doubled while the
 * decals would reach into more than {@link DECAL_INDEX_ENTRIES_PER_DECAL}
 * cells each on average (a few huge decals among small ones). A cell lists
 * at most the overlap budget (project-model `DECAL_CELL_BUDGET`): past it the
 * lowest sort orders are dropped there and counted.
 *
 * Built on change, never per frame: a still level costs the main thread
 * nothing. Pure: no three.js.
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

export interface DecalIndex {
  /** The grid's corner, 1 / its cell size and its cells per axis (0: no decals). */
  readonly origin: readonly [number, number, number];
  readonly invCell: readonly [number, number, number];
  readonly dims: readonly [number, number, number];
  /** The hash table's slots − 1 (a power of two less one) and the longest probe a lookup makes (slots read). */
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

export const EMPTY_DECAL_INDEX: DecalIndex = { origin: [0, 0, 0], invCell: [0, 0, 0], dims: [0, 0, 0], mask: 0, probes: 0, data: new Float32Array([0, 0, 0, -1]), height: 1, cells: 0, entries: 0, dropped: 0, droppedDecals: 0 };

const median = (v: number[]): number => {
  v.sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)]!;
};

/** A cell's slot before probing: the cell's coordinates hashed (unsigned 32-bit, as the shader computes it), masked. */
export function decalHashSlot(x: number, y: number, z: number, mask: number): number {
  return ((Math.imul(x, DECAL_HASH[0]) ^ Math.imul(y, DECAL_HASH[1]) ^ Math.imul(z, DECAL_HASH[2])) >>> 0) & mask;
}

/** The index of `rows` (table order): each cell's list sorted by sort order, then table order, at most `budget` long. */
export function buildDecalIndex(rows: readonly Pick<DecalRow, 'min' | 'max' | 'sortOrder'>[], budget: number): DecalIndex {
  if (rows.length === 0) return EMPTY_DECAL_INDEX;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const cell = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const extents: number[] = [];
    for (const r of rows) {
      lo[a] = Math.min(lo[a]!, r.min[a]!);
      hi[a] = Math.max(hi[a]!, r.max[a]!);
      extents.push(r.max[a]! - r.min[a]!);
    }
    cell[a] = Math.max(0.05, median(extents));
  }
  const range = (r: Pick<DecalRow, 'min' | 'max'>, a: number): [number, number] => [Math.floor((r.min[a]! - lo[a]!) / cell[a]!), Math.floor((r.max[a]! - lo[a]!) / cell[a]!)];
  const reach = (r: Pick<DecalRow, 'min' | 'max'>): number => [0, 1, 2].reduce((n, a) => n * (range(r, a)[1] - range(r, a)[0] + 1), 1);
  // Coordinates stay exact in a float texel (2^24) and the cells per decal bounded.
  const fits = (): boolean => [0, 1, 2].every((a) => (hi[a]! - lo[a]!) / cell[a]! < 1 << 23) && rows.reduce((n, r) => n + reach(r), 0) <= DECAL_INDEX_ENTRIES_PER_DECAL * rows.length;
  while (!fits()) for (let a = 0; a < 3; a++) cell[a] = cell[a]! * 2;
  const dims = [0, 1, 2].map((a) => Math.floor((hi[a]! - lo[a]!) / cell[a]!) + 1) as [number, number, number];
  // Rows in drawing order: lower sort orders first, ties in table order. Each cell's list keeps that order.
  const order = rows.map((_, i) => i).sort((a, b) => rows[a]!.sortOrder - rows[b]!.sortOrder || a - b);
  const lists = new Map<string, { at: [number, number, number]; rows: number[] }>();
  for (const i of order) {
    const r = rows[i]!;
    const [x0, x1] = range(r, 0);
    const [y0, y1] = range(r, 1);
    const [z0, z1] = range(r, 2);
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const k = `${x},${y},${z}`;
          const l = lists.get(k);
          if (l === undefined) lists.set(k, { at: [x, y, z], rows: [i] });
          else l.rows.push(i);
        }
  }
  let entries = 0;
  let dropped = 0;
  const droppedRows = new Set<number>();
  for (const l of lists.values()) {
    if (l.rows.length > budget) {
      // The highest orders are kept (drawn on top); the list stays in drawing order.
      const cut = l.rows.length - budget;
      for (const i of l.rows.slice(0, cut)) droppedRows.add(i);
      dropped += cut;
      l.rows = l.rows.slice(cut);
    }
    entries += l.rows.length;
  }
  // At most a quarter full: a lookup of an empty cell nearly always reads one empty slot.
  const slots = 2 ** Math.ceil(Math.log2(Math.max(1, lists.size * 4)));
  const mask = slots - 1;
  const height = Math.max(1, Math.ceil((slots + lists.size + entries) / DECAL_TEXTURE_WIDTH));
  const data = new Float32Array(height * DECAL_TEXTURE_WIDTH * 4);
  for (let s = 0; s < slots; s++) data[s * 4 + 3] = -1;
  let at = slots;
  let probes = 1;
  for (const l of lists.values()) {
    const [x, y, z] = l.at;
    let s = decalHashSlot(x, y, z, mask);
    let n = 1;
    while (data[s * 4 + 3]! >= 0) {
      s = (s + 1) & mask;
      n += 1;
    }
    probes = Math.max(probes, n);
    data.set([x, y, z, at], s * 4);
    data[at++ * 4] = l.rows.length;
    for (const i of l.rows) data[at++ * 4] = i;
  }
  return { origin: [lo[0]!, lo[1]!, lo[2]!], invCell: [1 / cell[0]!, 1 / cell[1]!, 1 / cell[2]!], dims, mask, probes, data, height, cells: lists.size, entries, dropped, droppedDecals: droppedRows.size };
}

/** The table rows a world point's cell lists, in drawing order (the shader walks the same list, found the same way). */
export function decalRowsAt(index: DecalIndex, p: { x: number; y: number; z: number }): number[] {
  const [dx, dy, dz] = index.dims;
  const cx = Math.floor((p.x - index.origin[0]) * index.invCell[0]);
  const cy = Math.floor((p.y - index.origin[1]) * index.invCell[1]);
  const cz = Math.floor((p.z - index.origin[2]) * index.invCell[2]);
  if (cx < 0 || cy < 0 || cz < 0 || cx >= dx || cy >= dy || cz >= dz) return [];
  let s = decalHashSlot(cx, cy, cz, index.mask);
  for (let k = 0; k < index.probes; k++, s = (s + 1) & index.mask) {
    const d = index.data;
    const start = d[s * 4 + 3]!;
    if (start < 0) return [];
    if (d[s * 4] !== cx || d[s * 4 + 1] !== cy || d[s * 4 + 2] !== cz) continue;
    const out: number[] = [];
    for (let i = 0; i < d[start * 4]!; i++) out.push(d[(start + 1 + i) * 4]!);
    return out;
  }
  return [];
}
