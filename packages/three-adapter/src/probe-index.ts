/**
 * Which probe tile holds a point, in constant time however many tiles are
 * loaded: a coarse grid of cells over the loaded tiles (each tile's box
 * grown by its fade), each cell listing the tiles that reach into it in
 * table order. A pixel outside its object's tile (probe-lighting.ts) and the
 * CPU's pick of an object's tile look up the cell and test only its tiles:
 * the first holding the point wins (where tiles share a face both hold the
 * same probes), else the nearest (for the fade past a tile's edge).
 *
 * Cells are half the smallest tile along each axis, so a cell of a regular
 * lattice of tiles lists at most two tiles a side; over a sparse spread of
 * tiles the cells grow so the grid stays within `PROBE_INDEX_MAX_CELLS` and
 * lists get longer instead (never a tile left out).
 *
 * The index is one float texture, `PROBE_INDEX_WIDTH` texels a line: a
 * header texel per cell (first entry, count), then the entries (a table row
 * each).
 */

/** Texels a line of the index texture. */
export const PROBE_INDEX_WIDTH = 1024;
/** The most cells the grid has (its texture's header part: 16 bytes a cell). */
export const PROBE_INDEX_MAX_CELLS = 1 << 16;

export interface ProbeIndexTile {
  /** The tile's table row. */
  readonly row: number;
  readonly min: readonly number[];
  readonly max: readonly number[];
  /** How far past its box the tile's light reaches (fading out). */
  readonly fade: number;
}

export interface ProbeIndex {
  /** The grid's corner, 1 / its cell size and its cells per axis (0: no tiles). */
  readonly origin: readonly [number, number, number];
  readonly invCell: readonly [number, number, number];
  readonly dims: readonly [number, number, number];
  /** RGBA texels, `PROBE_INDEX_WIDTH` a line: headers (first entry's texel, count), then entries (row). */
  readonly data: Float32Array;
  readonly height: number;
  readonly cells: number;
  readonly entries: number;
}

export const EMPTY_PROBE_INDEX: ProbeIndex = { origin: [0, 0, 0], invCell: [0, 0, 0], dims: [0, 0, 0], data: new Float32Array(4), height: 1, cells: 0, entries: 0 };

/** The index of `tiles`, given in table order (the first holding a point wins). */
export function buildProbeIndex(tiles: readonly ProbeIndexTile[]): ProbeIndex {
  if (tiles.length === 0) return EMPTY_PROBE_INDEX;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const cell = [Infinity, Infinity, Infinity];
  for (const t of tiles) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, t.min[a]! - t.fade);
      hi[a] = Math.max(hi[a]!, t.max[a]! + t.fade);
      cell[a] = Math.min(cell[a]!, Math.max(1e-3, (t.max[a]! - t.min[a]!) / 2));
    }
  }
  const dimsOf = (): [number, number, number] => [0, 1, 2].map((a) => Math.max(1, Math.ceil((hi[a]! - lo[a]!) / cell[a]!))) as [number, number, number];
  let dims = dimsOf();
  while (dims[0] * dims[1] * dims[2] > PROBE_INDEX_MAX_CELLS) {
    const f = Math.max(1.01, Math.cbrt((dims[0] * dims[1] * dims[2]) / PROBE_INDEX_MAX_CELLS));
    for (let a = 0; a < 3; a++) cell[a] = cell[a]! * f;
    dims = dimsOf();
  }
  const [dx, dy, dz] = dims;
  const cells = dx * dy * dz;
  const range = (t: ProbeIndexTile, a: number): [number, number] => {
    const from = Math.floor((t.min[a]! - t.fade - lo[a]!) / cell[a]!);
    const to = Math.floor((t.max[a]! + t.fade - lo[a]!) / cell[a]!);
    return [Math.max(0, from), Math.min(dims[a]! - 1, to)];
  };
  const visit = (t: ProbeIndexTile, f: (c: number) => void): void => {
    const [x0, x1] = range(t, 0);
    const [y0, y1] = range(t, 1);
    const [z0, z1] = range(t, 2);
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) f(x + dx * (y + dy * z));
  };
  const counts = new Uint32Array(cells);
  for (const t of tiles) visit(t, (c) => counts[c]!++);
  let entries = 0;
  for (let c = 0; c < cells; c++) entries += counts[c]!;
  const height = Math.max(1, Math.ceil((cells + entries) / PROBE_INDEX_WIDTH));
  const data = new Float32Array(height * PROBE_INDEX_WIDTH * 4);
  const next = new Uint32Array(cells);
  let at = cells;
  for (let c = 0; c < cells; c++) {
    data[c * 4] = at;
    data[c * 4 + 1] = counts[c]!;
    next[c] = at;
    at += counts[c]!;
  }
  for (const t of tiles) visit(t, (c) => (data[next[c]!++ * 4] = t.row));
  return { origin: [lo[0]!, lo[1]!, lo[2]!], invCell: [1 / cell[0]!, 1 / cell[1]!, 1 / cell[2]!], dims, data, height, cells, entries };
}

/**
 * The table row of the tile holding `point` — the first of its cell's tiles
 * containing it, else the nearest of them — or -1 outside every tile's
 * reach. `boxes`: per row its box (min.xyz, max.xyz). The shader picks the
 * same way.
 */
export function probeRowAt(index: ProbeIndex, boxes: Float32Array, point: { x: number; y: number; z: number }): number {
  const [dx, dy, dz] = index.dims;
  const cx = Math.floor((point.x - index.origin[0]) * index.invCell[0]);
  const cy = Math.floor((point.y - index.origin[1]) * index.invCell[1]);
  const cz = Math.floor((point.z - index.origin[2]) * index.invCell[2]);
  if (cx < 0 || cy < 0 || cz < 0 || cx >= dx || cy >= dy || cz >= dz) return -1;
  const c = cx + dx * (cy + dy * cz);
  const start = index.data[c * 4]!;
  const count = index.data[c * 4 + 1]!;
  let best = -1;
  let bestOut = Infinity;
  for (let i = 0; i < count; i++) {
    const row = index.data[(start + i) * 4]!;
    const o = row * 6;
    const ox = Math.max(boxes[o]! - point.x, 0, point.x - boxes[o + 3]!);
    const oy = Math.max(boxes[o + 1]! - point.y, 0, point.y - boxes[o + 4]!);
    const oz = Math.max(boxes[o + 2]! - point.z, 0, point.z - boxes[o + 5]!);
    const out = Math.hypot(ox, oy, oz);
    if (out < bestOut) {
      best = row;
      bestOut = out;
      if (out <= 0) break;
    }
  }
  return best;
}
