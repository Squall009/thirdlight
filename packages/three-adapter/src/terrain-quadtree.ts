/**
 * Which pieces of a terrain are drawn, at which level of detail: CDLOD
 * (Strugar, "Continuous Distance-Dependent Level of Detail for Rendering
 * Heightmaps").
 *
 * Every tile is the root of a quadtree. A node at level L covers
 * `grid · 2^L` cells and is drawn as the one shared grid mesh of `grid`²
 * quads, scaled to it; level 0 is the finest. A level reaches `ranges[L]`
 * metres from the camera (each twice the one before); a node is split while
 * the next finer level reaches it. Vertices morph toward the next coarser
 * level over the last part of their level's range (in the vertex shader, by
 * their own distance), so where two levels meet the finer one has finished
 * morphing into the coarser one's shape: no cracks, and nothing pops when a
 * node is split or joined. The ranges are kept far enough apart for that to
 * hold: neighbouring nodes are never more than one level apart, and a node
 * next to a finer one has not begun to morph along their shared edge.
 *
 * A child its parent's split leaves outside the finer range is drawn at the
 * finer level anyway: its vertices are all past that level's range, fully
 * morphed, so it has the parent's shape.
 *
 * A tile's root is drawn however far it is (the coarsest level does not
 * morph), so the terrain reaches the horizon at one node per tile.
 *
 * Pure (no three.js): the selection fills flat arrays the renderer uploads.
 */

/** Quads along a side of the shared grid mesh (a tile with fewer cells uses its own cell count). */
export const TERRAIN_GRID_QUADS = 16;

/** Where in its level's range (0 = the finer level's reach, 1 = its own) a vertex starts morphing to the coarser level. */
export const TERRAIN_MORPH_START = 0.7;

/**
 * The finest level reaches at least this many leaf-node sides: with the
 * morph start above, a node next to a finer one has not begun to morph along
 * their shared edge, and neighbours stay within one level (both need about 4).
 */
export const TERRAIN_LOD_MIN_LEAVES = 4.5;

/** Floats a drawn node takes in the instance buffer (two vec4). */
export const TERRAIN_NODE_FLOATS = 8;

/** The quadtree's shape for a terrain's tile size. */
export interface TerrainLodLayout {
  /** Cells along a tile side (samples − 1). */
  readonly cells: number;
  /** Quads along the grid mesh's side. */
  readonly grid: number;
  /** Levels from the leaf (0) to the tile's root (`levels − 1`). */
  readonly levels: number;
  /** Metres between samples. */
  readonly spacing: number;
}

export function terrainLodLayout(tileSamples: number, spacing: number): TerrainLodLayout {
  const cells = tileSamples - 1;
  const grid = Math.min(TERRAIN_GRID_QUADS, cells);
  return { cells, grid, levels: Math.round(Math.log2(cells / grid)) + 1, spacing };
}

/** The least distance (metres) the finest level reaches for a layout. */
export function terrainMinLodDistance(layout: TerrainLodLayout): number {
  return TERRAIN_LOD_MIN_LEAVES * layout.grid * layout.spacing;
}

/**
 * Each level's reach (metres): the terrain's `lodDistance` (absent: the
 * least) divided by the LOD bias, never below the least, doubling per level.
 */
export function terrainLodRanges(layout: TerrainLodLayout, lodDistance: number | undefined, bias: number): Float64Array {
  const least = terrainMinLodDistance(layout);
  const base = Math.max(least, (lodDistance ?? least) / (bias > 0 && Number.isFinite(bias) ? bias : 1));
  const out = new Float64Array(layout.levels);
  for (let l = 0; l < layout.levels; l++) out[l] = base * 2 ** l;
  return out;
}

/** A level's morph: [start distance, 1 / (end − start)]; the coarsest level never morphs. */
export function terrainMorph(ranges: Float64Array, level: number): [number, number] {
  if (level >= ranges.length - 1) return [1e30, 0];
  const prev = level > 0 ? ranges[level - 1]! : 0;
  const end = ranges[level]!;
  const start = prev + TERRAIN_MORPH_START * (end - prev);
  return [start, 1 / (end - start)];
}

/** Per level (leaf first), the lowest and highest height step under each node, rows of z then x. */
export interface TileHeightBounds {
  readonly min: readonly Uint16Array[];
  readonly max: readonly Uint16Array[];
}

/** The height bounds of every node of a tile's quadtree. */
export function tileHeightBounds(heights: Uint16Array, layout: TerrainLodLayout): TileHeightBounds {
  const s = layout.cells + 1;
  const g = layout.grid;
  const min: Uint16Array[] = [];
  const max: Uint16Array[] = [];
  let side = layout.cells / g;
  const lo = new Uint16Array(side * side);
  const hi = new Uint16Array(side * side);
  // Leaves: the samples each covers, its edges included (shared with its neighbours).
  for (let nz = 0; nz < side; nz++) {
    for (let nx = 0; nx < side; nx++) {
      let a = 0xffff;
      let b = 0;
      for (let z = nz * g; z <= nz * g + g; z++) {
        for (let x = nx * g, i = z * s + x; x <= nx * g + g; x++, i++) {
          const h = heights[i]!;
          if (h < a) a = h;
          if (h > b) b = h;
        }
      }
      lo[nz * side + nx] = a;
      hi[nz * side + nx] = b;
    }
  }
  min.push(lo);
  max.push(hi);
  for (let l = 1; l < layout.levels; l++) {
    const below = side;
    side /= 2;
    const pl = min[l - 1]!;
    const ph = max[l - 1]!;
    const ml = new Uint16Array(side * side);
    const mh = new Uint16Array(side * side);
    for (let z = 0; z < side; z++) {
      for (let x = 0; x < side; x++) {
        const a = 2 * z * below + 2 * x;
        ml[z * side + x] = Math.min(pl[a]!, pl[a + 1]!, pl[a + below]!, pl[a + below + 1]!);
        mh[z * side + x] = Math.max(ph[a]!, ph[a + 1]!, ph[a + below]!, ph[a + below + 1]!);
      }
    }
    min.push(ml);
    max.push(mh);
  }
  return { min, max };
}

/** A loaded tile as the selection sees it. */
export interface SelectTile {
  readonly x: number;
  readonly z: number;
  /** The texture page and the layer in it holding the tile's data. */
  readonly page: number;
  readonly layer: number;
  readonly bounds: TileHeightBounds;
}

/** One page's drawn nodes: those in view first. */
export class PageNodes {
  data: Float32Array<ArrayBuffer> = new Float32Array(TERRAIN_NODE_FLOATS * 64);
  count = 0;
  inView = 0;
  /** Scratch for the nodes out of view (appended after the ones in view). */
  private rest: Float32Array<ArrayBuffer> = new Float32Array(TERRAIN_NODE_FLOATS * 16);
  private restCount = 0;

  begin(): void {
    this.count = 0;
    this.restCount = 0;
  }

  push(inView: boolean, a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number): void {
    let arr: Float32Array<ArrayBuffer>;
    let at: number;
    if (inView) {
      if ((this.count + 1) * TERRAIN_NODE_FLOATS > this.data.length) this.data = grow(this.data);
      arr = this.data;
      at = this.count * TERRAIN_NODE_FLOATS;
      this.count += 1;
    } else {
      if ((this.restCount + 1) * TERRAIN_NODE_FLOATS > this.rest.length) this.rest = grow(this.rest);
      arr = this.rest;
      at = this.restCount * TERRAIN_NODE_FLOATS;
      this.restCount += 1;
    }
    arr[at] = a;
    arr[at + 1] = b;
    arr[at + 2] = c;
    arr[at + 3] = d;
    arr[at + 4] = e;
    arr[at + 5] = f;
    arr[at + 6] = g;
    arr[at + 7] = h;
  }

  end(): void {
    this.inView = this.count;
    const total = this.count + this.restCount;
    while (total * TERRAIN_NODE_FLOATS > this.data.length) this.data = grow(this.data);
    this.data.set(this.rest.subarray(0, this.restCount * TERRAIN_NODE_FLOATS), this.count * TERRAIN_NODE_FLOATS);
    this.count = total;
  }
}

function grow(a: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
  const b = new Float32Array(a.length * 2);
  b.set(a);
  return b;
}

/** What one selection pass reads. */
export interface SelectInput {
  readonly layout: TerrainLodLayout;
  readonly ranges: Float64Array;
  /** The camera in the terrain's own frame (metres from its object's position). */
  readonly eye: readonly [number, number, number];
  /** A stored height step's height in the terrain's frame. */
  readonly heightOf: (step: number) => number;
  /** Whether a sphere in the terrain's frame is in view (null: everything is). */
  readonly inView: ((x: number, y: number, z: number, r: number) => boolean) | null;
}

/** Totals of the last selection. */
export interface SelectStats {
  nodes: number;
  inView: number;
  /** Nodes drawn per level (leaf first). */
  perLevel: number[];
}

/**
 * Select the nodes of every tile for `input`, into one `PageNodes` per page
 * (`pages[i]`, begun and ended here).
 */
export function selectTerrainNodes(tiles: Iterable<SelectTile>, input: SelectInput, pages: readonly PageNodes[], stats: SelectStats): void {
  for (const p of pages) p.begin();
  stats.nodes = 0;
  stats.inView = 0;
  stats.perLevel.length = input.layout.levels;
  stats.perLevel.fill(0);
  const { layout, ranges, eye, heightOf, inView } = input;
  const morph = Array.from({ length: layout.levels }, (_, l) => terrainMorph(ranges, l));
  const tileSize = layout.cells * layout.spacing;
  for (const t of tiles) {
    const page = pages[t.page];
    if (page === undefined) continue;
    const ox = t.x * tileSize;
    const oz = t.z * tileSize;
    /** Distance from the eye to a node's box, and its box's centre and half diagonal. */
    const box = (level: number, ix: number, iz: number, out: Float64Array): number => {
      const side = layout.cells / layout.grid / 2 ** level;
      const size = tileSize / side;
      const x0 = ox + ix * size;
      const z0 = oz + iz * size;
      const k = iz * side + ix;
      const y0 = heightOf(t.bounds.min[level]![k]!);
      const y1 = heightOf(t.bounds.max[level]![k]!);
      const dx = Math.max(x0 - eye[0], 0, eye[0] - (x0 + size));
      const dy = Math.max(y0 - eye[1], 0, eye[1] - y1);
      const dz = Math.max(z0 - eye[2], 0, eye[2] - (z0 + size));
      out[0] = x0 + size / 2;
      out[1] = (y0 + y1) / 2;
      out[2] = z0 + size / 2;
      out[3] = Math.sqrt(size * size * 0.5 + ((y1 - y0) * (y1 - y0)) / 4);
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    };
    const tmp = new Float64Array(4);
    const add = (level: number, ix: number, iz: number): void => {
      box(level, ix, iz, tmp);
      const seen = inView === null || inView(tmp[0]!, tmp[1]!, tmp[2]!, tmp[3]!);
      const samples = layout.grid * 2 ** level;
      const [ms, mi] = morph[level]!;
      page.push(seen, ox + ix * samples * layout.spacing, oz + iz * samples * layout.spacing, samples, t.layer, ix * samples, iz * samples, ms, mi);
      stats.nodes += 1;
      if (seen) stats.inView += 1;
      stats.perLevel[level]! += 1;
    };
    const visit = (level: number, ix: number, iz: number, root: boolean): boolean => {
      const d = box(level, ix, iz, tmp);
      if (!root && d > ranges[level]!) return false;
      if (level === 0 || d > ranges[level - 1]!) {
        add(level, ix, iz);
        return true;
      }
      for (let c = 0; c < 4; c++) {
        const cx = ix * 2 + (c & 1);
        const cz = iz * 2 + (c >> 1);
        if (!visit(level - 1, cx, cz, false)) add(level - 1, cx, cz);
      }
      return true;
    };
    visit(layout.levels - 1, 0, 0, true);
  }
  for (const p of pages) p.end();
}
