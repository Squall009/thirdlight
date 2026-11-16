/**
 * Sun heights: the top of what is solid in each column round the camera, at
 * two sizes, for a sun shadow past the key light's shadow map. A point is
 * out of the sun when, marching from it toward the sun, the ray passes under
 * a column's top (a height field's shadow: what stands over a column shades
 * all of it, so the sun under an arch, a bridge or an eave seen from far is
 * not shown).
 *
 * - **Near**, 0.5 m columns: the sky heights the stitching finds for each
 *   chunk column where the world runs (sky-columns.ts), one cell's step.
 * - **Far**, coarser columns: the far field's bricks as drawn. A node's tops
 *   are where its stored field first falls below the march's hit distance
 *   going down each column of samples ({@link farBrickTops}): the field is
 *   linear between samples along a column, so this is the surface the brick
 *   march converges to there, found in one pass instead of a march a column.
 *   A column's height is the highest of the drawn nodes over it.
 *
 * Both are windows over the ground that follow the camera a tile at a time,
 * held wrapped (a column's texel is its world index modulo the window, so a
 * move writes only what enters). The march's steps and a sample's openness
 * are written once over `ScalarOps` ({@link sunMarchT}, {@link sunSampleOpen})
 * for the shader and the CPU reference ({@link sunVisibilityAt}).
 */
import type { ScalarOps } from '@thirdlight/shared';

import { BRICK_HIT_VOXELS, DISTANCE_BRICK_BAND_VOXELS, DISTANCE_BRICK_CELLS, DISTANCE_BRICK_INSIDE, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, distanceOfSample } from './distance-brick-format';
import type { FarBricks } from './far-bricks';
import { SKY_NONE, type SkyColumns } from './sky-columns';

/** A column nothing has told the window about: the march reads the next window there (a power of two: exact in 32 bits). */
export const SUN_HEIGHT_UNKNOWN = -(2 ** 100);
/** A column known to hold nothing solid (open sky down to the world's floor). */
export const SUN_HEIGHT_NONE = -(2 ** 96);
/** Heights at or below this are not a top (either of the two above). */
export const SUN_HEIGHT_NO_TOP = -(2 ** 90);

/** Texels a side of each window. */
export const SUN_WINDOW_TEXELS = 1024;
/** Texels a side of a tile (a chunk column of the near window): what a move or a change writes at once. */
export const SUN_TILE_TEXELS = 32;
/** Metres a far column spans: the 2 m bricks' cells at half resolution, so the window reaches 2 km each way. */
export const SUN_FAR_CELL_M = 4;

/** The march goes no farther toward the sun than this (metres, across the ground): the far window's half side. */
export const SUN_MARCH_REACH_M = (SUN_WINDOW_TEXELS * SUN_FAR_CELL_M) / 2;
/** A sun this low (the sine of its elevation) or lower shades nothing by the march: the ray never rises out of the field. */
export const SUN_MIN_RISE = 0.02;
/** A lit point starts this many of its column's widths out along its normal (off its own column's top). */
export const SUN_NORMAL_OFFSET = 0.75;
/** The march's first sample is no nearer than this (metres across): a column's own top is taken apart. */
export const SUN_MARCH_FIRST_M = 0.5;

/**
 * The sample after one at `d` metres across the ground toward the sun: samples are spaced by a constant ratio
 * `grow` ((d1 / d0)^(1 / steps), the k-th at d0 · grow^(k + ½)) from the march's start to its end, so a house beside
 * a column and a mountain kilometres off each get samples at their own scale.
 */
export function sunMarchT<F, B>(o: ScalarOps<F, B>, d: F, grow: F): F {
  return o.mul(d, grow);
}

/**
 * The shade line a caster puts on a column: the height below which a point of the column cannot see the sun past
 * a top `top` metres high, `d` metres across toward the sun (`slope` the sun's rise a metre across).
 */
export function sunShadeOf<F, B>(o: ScalarOps<F, B>, top: F, d: F, slope: F): F {
  return o.sub(top, o.mul(d, slope));
}

/** How much of the sun a point `y` metres high sees over a column's shade line `shade` (0–1, soft over `pen` metres below it). */
export function sunLit<F, B>(o: ScalarOps<F, B>, y: F, shade: F, pen: F): F {
  return o.min(o.n(1), o.max(o.n(0), o.add(o.div(o.sub(y, shade), pen), o.n(1))));
}

/** A column's top as a lookup gives it: metres (or {@link SUN_HEIGHT_UNKNOWN} / {@link SUN_HEIGHT_NONE}) and the column's width. */
export interface SunColumn {
  readonly top: number;
  readonly cellM: number;
}

/**
 * The CPU reference of the shader's shade line at a column centred at (x, z): over its own top and `steps` samples
 * toward the sun (unit `sun`, toward it) out to `reach` metres across or where the ray clears `topMax`, the highest
 * shade any caster puts there (`all`), and the highest of those `farFrom` metres across or farther (`far`: what a
 * shadow map round the column does not hold). {@link SUN_HEIGHT_NONE} where nothing shades it.
 */
export function sunShadeAt(column: (x: number, z: number) => SunColumn, x: number, z: number, sun: readonly number[], o: { readonly steps: number; readonly topMax: number; readonly farFrom: number; readonly reach?: number; readonly ops: ScalarOps<number, boolean> }): { all: number; far: number } {
  const ops = o.ops;
  const own = column(x, z).top;
  let all = own > SUN_HEIGHT_NO_TOP ? own : SUN_HEIGHT_NONE;
  let far = SUN_HEIGHT_NONE;
  const across = Math.hypot(sun[0]!, sun[2]!);
  if (!(sun[1]! > SUN_MIN_RISE) || across < 1e-3 || o.steps <= 0) return { all, far };
  const slope = sun[1]! / across;
  const dx = sun[0]! / across;
  const dz = sun[2]! / across;
  const d0 = SUN_MARCH_FIRST_M;
  const d1 = Math.max(d0, Math.min(o.reach ?? SUN_MARCH_REACH_M, (o.topMax - Math.max(own, -1e4)) / slope));
  const grow = 2 ** (Math.log2(d1 / d0) / o.steps);
  let d = d0 * Math.sqrt(grow);
  for (let i = 0; i < o.steps; i++, d = sunMarchT(ops, d, grow)) {
    const c = column(x + dx * d, z + dz * d);
    if (c.top <= SUN_HEIGHT_NO_TOP) continue;
    const shade = sunShadeOf(ops, c.top, d, slope);
    all = Math.max(all, shade);
    if (d >= o.farFrom) far = Math.max(far, shade);
  }
  return { all, far };
}

/**
 * A far node's tops: for each of its sample columns ((side × 8 + 1)², x fastest, then z) the height, in the node's
 * cells from its floor, where its field first falls below the march's hit distance coming down the column; -Infinity
 * where it never does (nothing solid in the node there). A wholly inside brick's top is its own.
 */
export function farBrickTops(b: FarBricks): Float32Array {
  const C = DISTANCE_BRICK_CELLS;
  const S = DISTANCE_BRICK_SIDE;
  const n = b.side * C + 1;
  const out = new Float32Array(n * n).fill(-Infinity);
  const hit = BRICK_HIT_VOXELS;
  const field = (block: number, x: number, y: number, z: number): number => distanceOfSample(b.samples[block * DISTANCE_BRICK_SAMPLES + (z * S + y) * S + x]!, DISTANCE_BRICK_BAND_VOXELS);
  for (let bz = 0; bz < b.side; bz++) {
    for (let bx = 0; bx < b.side; bx++) {
      // The brick's own sample columns; a column on a brick's face is the same samples in both bricks there.
      for (let sz = 0; sz < S; sz++) {
        for (let sx = 0; sx < S; sx++) {
          const k = (bz * C + sz) * n + bx * C + sx;
          let top = -Infinity;
          for (let by = b.side - 1; by >= 0 && top === -Infinity; by--) {
            const brick = b.bricks[bx + b.side * (by + b.side * bz)]!;
            if (brick === DISTANCE_BRICK_INSIDE) {
              top = (by + 1) * C;
              break;
            }
            if (brick < 0) continue;
            let above = field(brick, sx, C, sz);
            if (above < hit) {
              top = (by + 1) * C;
              break;
            }
            for (let y = C - 1; y >= 0; y--) {
              const f = field(brick, sx, y, sz);
              if (f < hit) {
                // Linear between the two samples: where it crosses the hit distance.
                top = by * C + y + (hit - f) / (above - f);
                break;
              }
              above = f;
            }
          }
          if (top > out[k]!) out[k] = top;
        }
      }
    }
  }
  return out;
}

/** A far node as the far window composes it. */
interface FarTopsNode {
  readonly level: number;
  readonly nx: number;
  readonly nz: number;
  /** World metres of its corner (x, z) and floor, its cell's size and its sample columns a side. */
  readonly x0: number;
  readonly z0: number;
  readonly y0: number;
  readonly cellM: number;
  readonly n: number;
  readonly tops: Float32Array;
}

/** A node's place in a world: its level, its node coordinates and the cells a node spans an axis (its edge). */
export interface FarTopsPlace {
  readonly level: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

/** Where world tile (tx, tz) of a window `tiles` tiles a side, `tile` columns a side, starts in its data (the shader's twin reads the same). */
export function sunTileOffset(tx: number, tz: number, tiles: number, tile: number): number {
  return (mod(tz, tiles) * tiles + mod(tx, tiles)) * tile * tile;
}

const tileKey = (tx: number, tz: number): number => (tx + 0x8000) * 0x10000 + (tz + 0x8000);
const mod = (a: number, m: number): number => ((a % m) + m) % m;

/**
 * A window of column tops round the camera, wrapped: `texels`² columns of `cellM` metres in tiles of `tile`², world
 * tile (tx, tz) held in slot (tx mod tiles, tz mod tiles), each slot's columns one after another (row by row), so a
 * tile is one run of the data ({@link sunTileOffset}: the shader reads the same place). It follows the camera a tile
 * at a time; a tile entering is cleared to unknown at once (so no texel ever speaks for a place it does not hold) and
 * filled by its source when composed.
 */
export class SunHeightWindow {
  readonly data: Float32Array;
  /** The window's first tile (world tile coordinates; NaN before the first follow). */
  tileX = NaN;
  tileZ = NaN;
  /** Tiles waiting to be composed (world tile keys) and those whose texels changed since last taken. */
  private readonly dirty = new Map<number, readonly [number, number]>();
  private readonly changed = new Map<number, readonly [number, number]>();
  /** The highest top written since the window was made (metres): the march stops once a ray is over it. */
  topMax = SUN_HEIGHT_NONE;

  constructor(
    readonly cellM: number,
    readonly texels = SUN_WINDOW_TEXELS,
    readonly tile = SUN_TILE_TEXELS,
    /** Where the columns are kept (absent: an array of its own): a view of a buffer the GPU reads. */
    data?: Float32Array,
  ) {
    if (data !== undefined && data.length !== texels * texels) throw new RangeError('sun heights: the data is not the window\'s size');
    this.data = (data ?? new Float32Array(texels * texels)).fill(SUN_HEIGHT_UNKNOWN);
  }

  /** Tiles a side. */
  get tiles(): number {
    return this.texels / this.tile;
  }

  /** Metres a tile spans. */
  get tileM(): number {
    return this.tile * this.cellM;
  }

  /** The window's world corner (x, z, metres). */
  get origin(): [number, number] {
    return [this.tileX * this.tileM, this.tileZ * this.tileM];
  }

  /** Whether a world tile lies in the window. */
  holds(tx: number, tz: number): boolean {
    return tx >= this.tileX && tz >= this.tileZ && tx < this.tileX + this.tiles && tz < this.tileZ + this.tiles;
  }

  /** Centres the window on (x, z) metres; the tiles that entered are cleared and waiting. True when it moved. */
  follow(x: number, z: number): boolean {
    const half = this.tiles / 2;
    const tx = Math.floor(x / this.tileM) - half;
    const tz = Math.floor(z / this.tileM) - half;
    if (tx === this.tileX && tz === this.tileZ) return false;
    const was = Number.isNaN(this.tileX) ? null : [this.tileX, this.tileZ];
    this.tileX = tx;
    this.tileZ = tz;
    for (const k of [...this.dirty.keys()]) {
      const [a, b] = this.dirty.get(k)!;
      if (!this.holds(a, b)) this.dirty.delete(k);
    }
    for (let j = 0; j < this.tiles; j++) {
      for (let i = 0; i < this.tiles; i++) {
        const a = tx + i;
        const b = tz + j;
        if (was !== null && a >= was[0]! && b >= was[1]! && a < was[0]! + this.tiles && b < was[1]! + this.tiles) continue;
        this.fillTile(a, b, SUN_HEIGHT_UNKNOWN);
        this.mark(a, b);
      }
    }
    return true;
  }

  /** A world tile's tops changed at their source: composed again when its turn comes (nothing outside the window). */
  mark(tx: number, tz: number): void {
    if (this.holds(tx, tz)) this.dirty.set(tileKey(tx, tz), [tx, tz]);
  }

  /** Tiles waiting to be composed. */
  get waiting(): number {
    return this.dirty.size;
  }

  /** Whether a world tile waits to be composed. */
  isWaiting(tx: number, tz: number): boolean {
    return this.dirty.has(tileKey(tx, tz));
  }

  /** The next tile waiting (nearest the window's centre first), taken off the list; null: none. */
  next(): readonly [number, number] | null {
    if (this.dirty.size === 0) return null;
    const cx = this.tileX + this.tiles / 2 - 0.5;
    const cz = this.tileZ + this.tiles / 2 - 0.5;
    let best: readonly [number, number] | null = null;
    let bestKey = 0;
    let bestD = Infinity;
    for (const [k, t] of this.dirty) {
      const d = Math.max(Math.abs(t[0] - cx), Math.abs(t[1] - cz));
      if (d < bestD) {
        bestD = d;
        best = t;
        bestKey = k;
      }
    }
    this.dirty.delete(bestKey);
    return best;
  }

  /** The offset of world column (i, j) in {@link data}. */
  index(i: number, j: number): number {
    const tx = Math.floor(i / this.tile);
    const tz = Math.floor(j / this.tile);
    return sunTileOffset(tx, tz, this.tiles, this.tile) + (j - tz * this.tile) * this.tile + (i - tx * this.tile);
  }

  /** Writes `top` (metres) into world column (i, j) of a tile being composed. */
  set(i: number, j: number, top: number): void {
    this.data[this.index(i, j)] = top;
    if (top > this.topMax) this.topMax = top;
  }

  /** Raises world column (i, j) to `top` where it is lower (an unknown column takes it). */
  raise(i: number, j: number, top: number): void {
    const k = this.index(i, j);
    if (top > this.data[k]!) {
      this.data[k] = top;
      if (top > this.topMax) this.topMax = top;
    }
  }

  /** Every column of a world tile set to `top` (a tile cleared before it is composed). */
  fillTile(tx: number, tz: number, top: number): void {
    for (let j = 0; j < this.tile; j++) for (let i = 0; i < this.tile; i++) this.data[this.index(tx * this.tile + i, tz * this.tile + j)] = top;
    this.changed.set(tileKey(tx, tz), [tx, tz]);
  }

  /** A tile's texels were written (by {@link set} or {@link raise}): it goes to the GPU. */
  touched(tx: number, tz: number): void {
    this.changed.set(tileKey(tx, tz), [tx, tz]);
  }

  /** The runs of {@link data} whose columns changed since the last call (a tile each: its offset and length). */
  takeChanged(): Array<{ readonly offset: number; readonly count: number }> {
    const out: Array<{ offset: number; count: number }> = [];
    for (const [, [tx, tz]] of this.changed) {
      if (this.holds(tx, tz)) out.push({ offset: sunTileOffset(tx, tz, this.tiles, this.tile), count: this.tile * this.tile });
    }
    this.changed.clear();
    return out;
  }

  /** The top at world point (x, z) metres (CPU: the reference and tests), {@link SUN_HEIGHT_UNKNOWN} outside. */
  topAt(x: number, z: number): number {
    const i = Math.floor(x / this.cellM);
    const j = Math.floor(z / this.cellM);
    if (!this.holds(Math.floor(i / this.tile), Math.floor(j / this.tile))) return SUN_HEIGHT_UNKNOWN;
    return this.data[this.index(i, j)]!;
  }
}

/**
 * The far field's tops by node and the far window composed from them: a node drawn adds its tops, a node gone takes
 * them away, and the tiles under either are composed again (each column the highest of the nodes over it).
 */
export class FarSunTops {
  readonly window: SunHeightWindow;
  private readonly nodes = new Map<string, FarTopsNode>();
  /** Node keys by level and node column (`level:nx,nz`). */
  private readonly columns = new Map<string, Set<string>>();
  private readonly levels = new Map<number, number>();
  /** Bytes the nodes' tops hold. */
  bytes = 0;
  /** While held: tiles already composed whose nodes changed since, composed again once let go ({@link hold}). */
  private readonly later = new Map<number, readonly [number, number]>();
  private holding = false;

  constructor(
    /** Cells a node spans an axis (the world's chunk edge). */
    private readonly edge: number,
    /** Metres a cell of level 0 spans. */
    private readonly voxelM: number,
    cellM = SUN_FAR_CELL_M,
    /** Where the window keeps its columns (absent: an array of its own). */
    data?: Float32Array,
  ) {
    this.window = new SunHeightWindow(cellM, SUN_WINDOW_TEXELS, SUN_TILE_TEXELS, data);
  }

  get count(): number {
    return this.nodes.size;
  }

  /** A node drawn (again: its tops replaced) with these bricks. */
  add(key: string, at: FarTopsPlace, bricks: FarBricks): void {
    this.remove(key);
    const cellM = 2 ** at.level * this.voxelM;
    const tops = farBrickTops(bricks);
    const n = bricks.side * DISTANCE_BRICK_CELLS + 1;
    const span = this.edge * cellM;
    const node: FarTopsNode = { level: at.level, nx: at.nx, nz: at.nz, x0: at.nx * span, z0: at.nz * span, y0: at.ny * span, cellM, n, tops };
    this.nodes.set(key, node);
    const ck = `${at.level}:${at.nx},${at.nz}`;
    let col = this.columns.get(ck);
    if (col === undefined) this.columns.set(ck, (col = new Set()));
    col.add(key);
    this.levels.set(at.level, (this.levels.get(at.level) ?? 0) + 1);
    this.bytes += tops.byteLength;
    this.markNode(node);
  }

  /** Every node whose key starts with `prefix` taken away (a world closed). */
  removePrefixed(prefix: string): void {
    for (const k of [...this.nodes.keys()]) if (k.startsWith(prefix)) this.remove(k);
  }

  /** A node no longer drawn. */
  remove(key: string): void {
    const node = this.nodes.get(key);
    if (node === undefined) return;
    this.nodes.delete(key);
    const ck = `${node.level}:${node.nx},${node.nz}`;
    const col = this.columns.get(ck)!;
    col.delete(key);
    if (col.size === 0) this.columns.delete(ck);
    const c = this.levels.get(node.level)! - 1;
    if (c === 0) this.levels.delete(node.level);
    else this.levels.set(node.level, c);
    this.bytes -= node.tops.byteLength;
    this.markNode(node);
  }

  private markNode(node: FarTopsNode): void {
    const w = this.window;
    const span = (node.n - 1) * node.cellM;
    const t0x = Math.floor(node.x0 / w.tileM);
    const t0z = Math.floor(node.z0 / w.tileM);
    const t1x = Math.floor((node.x0 + span - 1e-6) / w.tileM);
    const t1z = Math.floor((node.z0 + span - 1e-6) / w.tileM);
    for (let tz = t0z; tz <= t1z; tz++) {
      for (let tx = t0x; tx <= t1x; tx++) {
        if (this.holding && w.holds(tx, tz) && !w.isWaiting(tx, tz)) this.later.set(tileKey(tx, tz), [tx, tz]);
        else w.mark(tx, tz);
      }
    }
  }

  /**
   * Held (the camera faster than the streamer's level-0 speed): a node drawn or taken away over a tile already
   * composed does not compose it again, it waits; tiles that enter the window, or wait already, are composed as
   * ever. At speed the far field's nodes come and go many times over each tile (a flight at 150 m/s composed each
   * tile about six times for every time one entered), and a 4 m column's line a second late is not seen. Let go,
   * the tiles that waited are marked to compose (nearest first, in the slice).
   */
  hold(on: boolean): void {
    if (on === this.holding) return;
    this.holding = on;
    if (on) return;
    for (const [tx, tz] of this.later.values()) this.window.mark(tx, tz);
    this.later.clear();
  }

  /** Tiles waiting for the hold to end. */
  get held(): number {
    return this.later.size;
  }

  /** Composes the next waiting tile (true: one was composed; false: none waits). */
  composeNext(): boolean {
    const t = this.window.next();
    if (t === null) return false;
    this.compose(t[0], t[1]);
    return true;
  }

  /** A world tile's columns again from the nodes over it. */
  compose(tx: number, tz: number): void {
    const w = this.window;
    w.fillTile(tx, tz, SUN_HEIGHT_UNKNOWN);
    const x0 = tx * w.tileM;
    const z0 = tz * w.tileM;
    const x1 = x0 + w.tileM;
    const z1 = z0 + w.tileM;
    const i0 = tx * w.tile;
    const j0 = tz * w.tile;
    for (const level of this.levels.keys()) {
      const span = this.edge * 2 ** level * this.voxelM;
      for (let nz = Math.floor(z0 / span); nz * span < z1; nz++) {
        for (let nx = Math.floor(x0 / span); nx * span < x1; nx++) {
          const col = this.columns.get(`${level}:${nx},${nz}`);
          if (col === undefined) continue;
          for (const key of col) this.splat(this.nodes.get(key)!, i0, j0);
        }
      }
    }
    w.touched(tx, tz);
  }

  /** A node's tops into the tile's columns it covers (bilinear between its sample columns). */
  private splat(node: FarTopsNode, i0: number, j0: number): void {
    const w = this.window;
    const last = node.n - 1;
    // Only the tile's columns the node can cover (a column further in or out by one, each still tested): a node much
    // smaller than the tile reads its own few columns, not all of the tile's.
    const span = (o: number, c0: number): [number, number] => [Math.max(0, Math.floor(o / w.cellM - c0 - 0.5) - 1), Math.min(w.tile - 1, Math.ceil((o + last * node.cellM) / w.cellM - c0 - 0.5) + 1)];
    const [ja, jb] = span(node.z0, j0);
    const [ia, ib] = span(node.x0, i0);
    for (let j = ja; j <= jb; j++) {
      const v = ((j0 + j + 0.5) * w.cellM - node.z0) / node.cellM;
      if (v < 0 || v > last) continue;
      for (let i = ia; i <= ib; i++) {
        const u = ((i0 + i + 0.5) * w.cellM - node.x0) / node.cellM;
        if (u < 0 || u > last) continue;
        const top = bilinearTop(node.tops, node.n, u, v);
        if (top === -Infinity) continue;
        w.raise(i0 + i, j0 + j, node.y0 + top * node.cellM);
      }
    }
  }
}

/** A tops grid at a point between its columns: bilinear where the four are tops, else the highest of those that are. */
function bilinearTop(tops: Float32Array, n: number, u: number, v: number): number {
  const a = Math.min(n - 2, Math.floor(u));
  const b = Math.min(n - 2, Math.floor(v));
  const fu = u - a;
  const fv = v - b;
  const t00 = tops[b * n + a]!;
  const t10 = tops[b * n + a + 1]!;
  const t01 = tops[(b + 1) * n + a]!;
  const t11 = tops[(b + 1) * n + a + 1]!;
  if (t00 === -Infinity || t10 === -Infinity || t01 === -Infinity || t11 === -Infinity) return Math.max(t00, t10, t01, t11);
  return (t00 * (1 - fu) + t10 * fu) * (1 - fv) + (t01 * (1 - fu) + t11 * fu) * fv;
}

/**
 * A near window's tile (one chunk column: the window's tile is the world's chunk edge) from the sky heights of every
 * world drawn: each column the highest top any of them knows (a column with nothing solid is open sky), unknown where
 * none knows the chunk column.
 */
export function composeSkyTile(w: SunHeightWindow, tx: number, tz: number, skies: Iterable<SkyColumns>, voxelM: number): void {
  const E = w.tile;
  w.fillTile(tx, tz, SUN_HEIGHT_UNKNOWN);
  for (const k of skies) {
    if (k.edge !== E) continue;
    const h = k.column(tx, tz);
    if (h === null) continue;
    for (let x = 0; x < E; x++) {
      for (let z = 0; z < E; z++) {
        const v = h[x * E + z]!;
        w.raise(tx * E + x, tz * E + z, v > SKY_NONE ? v * voxelM : SUN_HEIGHT_NONE);
      }
    }
  }
  w.touched(tx, tz);
}
