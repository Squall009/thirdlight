/**
 * Where a drawn pixel's light is in the surface cache: the cache's addressing
 * packed for the materials' lookup (`surface-cache-read.ts`), which finds a
 * static surface's texel from the pixel's world position and normal — for
 * the engine's own geometry with no per-object data, so merged, batched and
 * shared geometry need nothing of their own — and samples it filtered, as a
 * lightmap is.
 *
 * - Block layers: the pixel's cell (its point a little behind the face it
 *   faces) and face; the face's chart from its chunk column's hash of face
 *   keys (`blockFaceKey`). Any geometry a block draws (cubes, slopes, a
 *   variant's model) reads the light of its cell's face on its facing.
 * - Terrain: the finest ring whose window holds the point (one texel in
 *   from its edge, so the filter stays inside), at the point's world x, z.
 * - Generated architecture: the charts are planes; a hash of world cells
 *   (`ARCH_CELL` metres) and facings (a normal's major axis and sign) lists
 *   the charts crossing each cell that a pixel of that facing may lie on,
 *   and a pixel takes the first whose plane it lies on (within
 *   `ARCH_PLANE_METRES`, facing its way) inside its rectangle. Trims and
 *   mouldings off the planes find none.
 * - Static models: a drawn copy carries its object's slot (`SurfaceModelSlots`:
 *   an instance column, a merged cell's vertex attribute, or the object's
 *   own); the slot's record holds the placement (world → model root) and its
 *   pieces. A UV1 piece is read at the pixel's UV1 in its square; a piece on
 *   surfels at the surfel of the pixel's cell (the set's grid at the level
 *   the cache holds it at) and facing, found in the set's hash.
 *
 * The words are read four at a time (an RGBA32UI texture, `LOOKUP_WIDTH`
 * texels a row); addresses count texels. `lookupSurfaceCpu` walks the same
 * words the same way (the reference the shaders are held to).
 *
 * Layout:
 *
 * - header: texel 0 (layers, their records, terrains, their records),
 *   texel 1 (the architecture hash's slots, its first slot, model slots,
 *   their table); the shaders take it as uniforms (`lookupHeader`), so no
 *   pixel waits on reading it, and the first terrain's rings too;
 * - a layer (`LAYER_TEXELS`): origin (f32 ×3) and its columns' first
 *   texel; cell size (f32 ×3) and its lowest row (i32); the first chunk
 *   column (cx, cz, i32), columns along x | along z << 16, and the row past
 *   its highest (i32); a column is a texel (its tile's hash: first texel and
 *   slots, a power of two; 0 slots: none); a hash slot is a texel: the face
 *   key (`EMPTY` when free), page | interior corner x << 12 | y << 20, the
 *   chart's texels w | h << 8 | the face's cell offset u << 16 | v << 24,
 *   and the chart's cells w | h << 8 (the face's place along the chart,
 *   without a chart record to read);
 * - a terrain (`TERRAIN_TEXELS`): rings, the first texture layer, then per
 *   ring its window's centre (x, z), half side and texel (m, f32);
 * - an architecture slot: cell x, y (i32), z × 8 + facing (i32) and its
 *   list's texel (0: free); a list: its count, then the charts' frame
 *   texels; a frame (`FRAME_TEXELS`): corner (f32 ×3) and width, u axis and
 *   height, v axis, then its chart: page, the interior's corner (x | y <<
 *   16), its texels (w | h << 16);
 * - model slots (`SLOT_TEXELS` each, at slot × that): the world → root
 *   map's rows (f32 ×4, three texels), the root → world map's columns (f32
 *   ×3, three texels: a world normal's root direction; the first's w 1 when
 *   the slot holds a piece), then its piece (`PIECE_TEXELS`): its surfel
 *   cell (m, f32), hash, buckets and 1 for a UV1 piece; page, corner (x | y
 *   << 16) and texels (w | h << 16: a UV1 square's interior, or the
 *   surfels' rectangle, a row `w` long); the cells' origin (i32 ×3). A
 *   hash bucket is a texel of two slots: a cell key (`surfelKey`) and
 *   facing | surfel << 3 (`EMPTY` when free); a cell is in its home bucket
 *   or the next (`surfelBucket`), so a look-up reads two texels and no loop.
 *
 * Pure (no three.js, no device).
 */
import { CHUNK_SIZE } from '@thirdlight/runtime';

import { SURFACE_CHART_BORDER, SURFACE_CHART_METRES, areaTexels, type AtlasBlock, type SurfaceChart, type TilePacking } from './surface-cache-atlas';
import { FACE_PLANE_AXES, type BlockChunkCharts } from './surface-cache-blocks';
import type { SurfaceCache } from './surface-cache';
import { surfelLevelFor } from './surface-cache-atlas';
import type { ArchTile, BlockTile, ModelTile, SurfaceScene } from './surface-cache-scene';
import { TERRAIN_RINGS_MAX } from './surface-cache-terrain';
import { Words, invertAffine } from './tracer-words';

/** Texels a row of the lookup texture. */
export const LOOKUP_WIDTH = 2048;
export const LAYER_TEXELS = 3;
export const TERRAIN_TEXELS = 1 + TERRAIN_RINGS_MAX;
export const FRAME_TEXELS = 4;
export const PIECE_TEXELS = 3;
/** A model slot's record: its placement (six texels) and its piece, read by a pixel together with no table in between. */
export const SLOT_TEXELS = 6 + PIECE_TEXELS;
/** Bits of a surfel cell's coordinate in its key, from the set's lowest cell (a set spans at most ~130 cells along an axis: `distanceBrickVoxel`). */
export const SURFEL_KEY_BITS = 10;

/** A surfel cell's key: its place from the set's lowest cell (null: outside the key's range: no surfel there). */
export function surfelKey(x: number, y: number, z: number): number | null {
  const lim = 1 << SURFEL_KEY_BITS;
  if (x < 0 || y < 0 || z < 0 || x >= lim || y >= lim || z >= lim) return null;
  return (x | (y << SURFEL_KEY_BITS) | (z << (2 * SURFEL_KEY_BITS))) >>> 0;
}

/** A cell key and facing's home bucket among `buckets` (a power of two; the shaders hash alike, in u32). */
export function surfelBucket(key: number, facing: number, buckets: number): number {
  let h = (Math.imul(key, 0x9e3779b1) ^ Math.imul(facing + 1, 0x85ebca6b)) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) & (buckets - 1);
}
/** A free slot's key. */
export const EMPTY = 0xffffffff;
/** The architecture hash's cells (m). */
export const ARCH_CELL = 2;
/** How far (m) off a chart's plane a pixel may lie and still read it (a render surface against its collider's face). */
export const ARCH_PLANE_METRES = 0.05;
/** How far (as a cosine) a pixel's normal may turn from its chart's and still read it. */
export const ARCH_FACING = 0.5;
/** A chart is listed under each facing whose axis it faces at least this much (a cosine): a pixel on its plane faces one of them. */
const ARCH_FACING_LISTED = 0.25;
/** How far (cells) behind its face a block pixel's point is taken, so it falls in its own cell. */
export const BLOCK_INSET = 0.001;

/**
 * The surfaces' colours (what their light bounces as) are kept beside the
 * cache's light, coarser: one packed rgba8 word per `ALBEDO_PAGE_STEP`² page
 * texels, and per `ALBEDO_RING_STEP`² ring texels, after the pages
 * (`ALBEDO_CELLS` words a page or ring layer). Alpha 0: no material drew
 * there yet.
 */
export const ALBEDO_PAGE_STEP = 2;
export const ALBEDO_RING_STEP = 4;
export const ALBEDO_CELLS = 128 * 128;

/** The words the surfaces' colours take for `pages` atlas pages and `ringLayers` ring layers. */
export function albedoWords(pages: number, ringLayers: number): number {
  return (pages + ringLayers) * ALBEDO_CELLS;
}

/** The kinds of static surface a material reads the cache for (a drawn mesh's `SURFACE_READ_KEY`). */
export const SURFACE_READ = { blocks: 1, terrain: 2, arch: 3, model: 4 } as const;
export type SurfaceReadKind = (typeof SURFACE_READ)[keyof typeof SURFACE_READ];

/** A face key's slot in a hash of `cap` slots (the shaders hash alike, in u32). */
export function faceHash(key: number, cap: number): number {
  const h = Math.imul(key, 0x9e3779b1) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) & (cap - 1);
}

/** A world cell's slot in a hash of `cap` slots (`zf`: the cell's z × 8 + the facing listed). */
export function cellHash(x: number, y: number, zf: number, cap: number): number {
  return ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(zf, 83492791)) >>> 0) & (cap - 1);
}

function pow2AtLeast(n: number): number {
  let c = 2;
  while (c < n) c *= 2;
  return c;
}

/** Texel-aligned allocation over `Words` (4 words a texel). */
class Texels {
  readonly w = new Words();
  alloc(n: number): number {
    return this.w.alloc(n * 4) / 4;
  }
  setU(t: number, k: number, v: number): void {
    this.w.setU(t * 4 + k, v);
  }
  setF(t: number, k: number, v: number): void {
    this.w.setF(t * 4 + k, v);
  }
}

type Resident = { level: number; blocks: readonly AtlasBlock[]; packing: TilePacking; charts: readonly SurfaceChart[] };

/** A chart's place: page, corner (x | y << 16), texels (w | h << 16): an area chart's interior, or a surfel chart's rectangle. */
function putChart(t: Texels, at: number, r: Resident, c: number): void {
  const chart = r.charts[c]!;
  const place = r.packing.places[c]!;
  const b = r.blocks[place.block]!;
  t.setU(at, 0, b.page);
  if (chart.kind === 'area') {
    t.setU(at, 1, (b.x + place.x + SURFACE_CHART_BORDER) | ((b.y + place.y + SURFACE_CHART_BORDER) << 16));
    t.setU(at, 2, areaTexels(chart.w, r.level) | (areaTexels(chart.h, r.level) << 16));
  } else {
    t.setU(at, 1, (b.x + place.x) | ((b.y + place.y) << 16));
    t.setU(at, 2, place.w | (place.h << 16));
  }
}

/** A block tile's face hash: each face's slot (open addressing by `faceHash`), kept with its charts: residency changes do not move them. */
const faceHashes = new WeakMap<BlockChunkCharts, { cap: number; slotOf: Uint32Array }>();

function faceHashOf(made: BlockChunkCharts): { cap: number; slotOf: Uint32Array } {
  let h = faceHashes.get(made);
  if (h !== undefined) return h;
  const cap = pow2AtLeast(made.keys.length * 2);
  const used = new Uint8Array(cap);
  const slotOf = new Uint32Array(made.keys.length);
  for (let i = 0; i < made.keys.length; i += 1) {
    let s = faceHash(made.keys[i]!, cap);
    while (used[s] === 1) s = (s + 1) & (cap - 1);
    used[s] = 1;
    slotOf[i] = s;
  }
  h = { cap, slotOf };
  faceHashes.set(made, h);
  return h;
}

/** A chart of an architecture tile in world space: corner, axes and size. */
interface ArchFrame {
  readonly chart: number;
  readonly o: readonly number[];
  readonly u: readonly number[];
  readonly v: readonly number[];
  readonly w: number;
  readonly h: number;
}

/** The facings (`facingOf`) a pixel on a plane of normal `n` may have: each axis and sign `n` faces at least `ARCH_FACING_LISTED`. */
function facingsOf(n: readonly number[]): number[] {
  const out: number[] = [];
  for (let a = 0; a < 3; a += 1) {
    if (n[a]! >= ARCH_FACING_LISTED) out.push(a * 2);
    if (-n[a]! >= ARCH_FACING_LISTED) out.push(a * 2 + 1);
  }
  return out;
}

/** An architecture tile's chart frames and the world cells and facings (`x,y,z × 8 + facing`) each may be read from, kept with its charts. */
const archFrames = new WeakMap<ArchTile['made'], { frames: ArchFrame[]; cells: Map<string, number[]> }>();

function archFramesOf(tile: ArchTile): { frames: ArchFrame[]; cells: Map<string, number[]> } {
  let got = archFrames.get(tile.made);
  if (got !== undefined) return got;
  const frames: ArchFrame[] = [];
  const cells = new Map<string, number[]>();
  for (const comp of tile.made.components) {
    for (let j = 0; j < comp.nv; j += 1) {
      for (let i = 0; i < comp.nu; i += 1) {
        const c = comp.first + j * comp.nu + i;
        const chart = tile.made.charts[c]!;
        if (chart.kind !== 'area') continue;
        const du = comp.u0 + i * SURFACE_CHART_METRES;
        const dv = comp.v0 + j * SURFACE_CHART_METRES;
        const o = [0, 1, 2].map((k) => comp.origin[k]! + comp.uAxis[k]! * du + comp.vAxis[k]! * dv);
        const f: ArchFrame = { chart: c, o, u: comp.uAxis, v: comp.vAxis, w: chart.w, h: chart.h };
        const fi = frames.length;
        frames.push(f);
        // The cells its rectangle's box (a plane's tolerance thick) crosses.
        const lo = [Infinity, Infinity, Infinity];
        const hi = [-Infinity, -Infinity, -Infinity];
        for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
          for (let k = 0; k < 3; k += 1) {
            const p = o[k]! + f.u[k]! * f.w * a + f.v[k]! * f.h * b;
            lo[k] = Math.min(lo[k]!, p - ARCH_PLANE_METRES);
            hi[k] = Math.max(hi[k]!, p + ARCH_PLANE_METRES);
          }
        }
        const c0 = lo.map((v) => Math.floor(v / ARCH_CELL));
        const c1 = hi.map((v) => Math.floor(v / ARCH_CELL));
        const u = f.u;
        const v = f.v;
        const facings = facingsOf([u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]);
        for (let z = c0[2]!; z <= c1[2]!; z += 1) for (let y = c0[1]!; y <= c1[1]!; y += 1) for (let x = c0[0]!; x <= c1[0]!; x += 1) {
          for (const facing of facings) {
            const key = `${x},${y},${z * 8 + facing}`;
            const list = cells.get(key);
            if (list === undefined) cells.set(key, [fi]);
            else list.push(fi);
          }
        }
      }
    }
  }
  got = { frames, cells };
  archFrames.set(tile.made, got);
  return got;
}

/** A set's surfels of level `k` in buckets by cell and facing, kept with the set: placed copies share it. */
const surfelHashes = new WeakMap<object, Map<number, SurfelHash>>();

/** A surfel hash: its buckets (four words each) and the cells' origin. */
interface SurfelHash {
  readonly buckets: number;
  readonly words: Uint32Array;
  readonly origin: readonly number[];
}

function surfelHashOf(tile: ModelTile, k: number): SurfelHash {
  const s = tile.set.surfels!;
  let byLevel = surfelHashes.get(s);
  if (byLevel === undefined) surfelHashes.set(s, (byLevel = new Map()));
  const had = byLevel.get(k);
  if (had !== undefined) return had;
  const cell = s.spacing * 2 ** k;
  const n = s.levels[k] ?? 0;
  const cells = Array.from({ length: n }, (_, i) => [0, 1, 2].map((a) => Math.floor(s.positions[i * 3 + a]! / cell)));
  const origin = [0, 1, 2].map((a) => cells.reduce((m, c) => Math.min(m, c[a]!), Infinity) - 1);
  // Twice the buckets until every cell sits in its home bucket or the next (two slots each).
  for (let buckets = pow2AtLeast(Math.max(1, n)); ; buckets *= 2) {
    const words = new Uint32Array(buckets * 4);
    for (let i = 0; i < buckets; i += 1) words[i * 4 + 1] = words[i * 4 + 3] = EMPTY;
    let fits = true;
    for (let i = 0; i < n && fits; i += 1) {
      const c = cells[i]!;
      const key = surfelKey(c[0]! - origin[0]!, c[1]! - origin[1]!, c[2]! - origin[2]!);
      if (key === null) continue;
      const facing = facingOf([s.normals[i * 3]!, s.normals[i * 3 + 1]!, s.normals[i * 3 + 2]!]);
      const home = surfelBucket(key, facing, buckets);
      let at = -1;
      for (let j = 0; j < 4 && at < 0; j += 1) {
        const w = (((home + (j >> 1)) & (buckets - 1)) * 4) + (j & 1) * 2;
        // One surfel a cell and facing at each level; a later one of the same takes its slot.
        if (words[w + 1] === EMPTY || (words[w] === key && (words[w + 1]! & 7) === facing)) at = w;
      }
      if (at < 0) fits = false;
      else {
        words[at] = key;
        words[at + 1] = (facing | (i << 3)) >>> 0;
      }
    }
    if (!fits) continue;
    const h = { buckets, words, origin };
    byLevel.set(k, h);
    return h;
  }
}

/** Static models' slots and records: per slot the placement and its resident pieces with surfels. */
function packModels(t: Texels, models: readonly ModelTile[], resident: ReadonlyMap<string, Resident>, slotOf: (owner: string) => number | undefined): void {
  const bySlot = new Map<number, ModelTile[]>();
  let top = 0;
  for (const tile of models) {
    if (tile.chart === null || tile.set.surfels === null || !resident.has(tile.key)) continue;
    const slot = slotOf(tile.owner);
    if (slot === undefined || slot <= 0) continue;
    const list = bySlot.get(slot);
    if (list === undefined) bySlot.set(slot, [tile]);
    else list.push(tile);
    top = Math.max(top, slot);
  }
  const table = t.alloc((top + 1) * SLOT_TEXELS);
  t.setU(1, 2, top + 1);
  t.setU(1, 3, table);
  const hashes = new Map<object, number>();
  for (const [slot, tiles] of bySlot) {
    const rec = table + slot * SLOT_TEXELS;
    // A model placed whole with several pieces: its first piece is read (the others keep the probes' and their own lights).
    const tile = tiles[0]!;
    const w = tile.worldToLocal;
    for (let r = 0; r < 3; r += 1) for (let k = 0; k < 4; k += 1) t.setF(rec + r, k, w[r * 4 + k]!);
    // A world normal's direction in the root: the root → world map's linear part, transposed (its columns as rows).
    const m = invertAffine(w);
    for (let c = 0; c < 3; c += 1) for (let r = 0; r < 3; r += 1) t.setF(rec + 3 + c, r, m[r * 4 + c]!);
    t.setU(rec + 3, 3, 1);
    const r = resident.get(tile.key)!;
    const s = tile.set.surfels!;
    const uv1 = tile.chart!.kind === 'area';
    const k = tile.chart!.kind === 'surfels' ? surfelLevelFor(tile.chart!, r.level) : 0;
    const h = surfelHashOf(tile, k);
    let at = hashes.get(h);
    if (at === undefined) {
      at = t.alloc(h.buckets);
      for (let q = 0; q < h.buckets * 4; q += 1) t.w.setU(at * 4 + q, h.words[q]!);
      hashes.set(h, at);
    }
    const pa = rec + 6;
    t.setF(pa, 0, s.spacing * 2 ** k);
    t.setU(pa, 1, at);
    t.setU(pa, 2, h.buckets);
    t.setU(pa, 3, uv1 ? 1 : 0);
    putChart(t, pa + 1, r, 0);
    for (let a = 0; a < 3; a += 1) t.setU(pa + 2, a, h.origin[a]! | 0);
  }
}

/**
 * The lookup's words for `scene` with what `cache` holds resident now
 * (packed again when residency changes); `slotOf`: the slot a placed
 * model's drawn copies carry (`ModelTile.owner`; none: its pieces are not read).
 */
export function packSurfaceLookup(scene: SurfaceScene, cache: SurfaceCache, slotOf: (owner: string) => number | undefined = () => undefined): Uint32Array {
  const t = new Texels();
  t.alloc(2);
  const view = scene.resolveView();
  const layers = scene.input.blocks ?? [];
  const resident = new Map<string, Resident>();
  cache.forEachResident((key, level, blocks, packing, charts) => resident.set(key, { level, blocks, packing, charts }));
  // Block layers.
  const lrec = t.alloc(layers.length * LAYER_TEXELS);
  t.setU(0, 0, layers.length);
  t.setU(0, 1, lrec);
  layers.forEach((layer, li) => {
    const g = layer.grid;
    const at = lrec + li * LAYER_TEXELS;
    const cx0 = Math.floor(g.min[0]! / CHUNK_SIZE);
    const cz0 = Math.floor(g.min[2]! / CHUNK_SIZE);
    const ncx = Math.floor((g.max[0]! - 1) / CHUNK_SIZE) - cx0 + 1;
    const ncz = Math.floor((g.max[2]! - 1) / CHUNK_SIZE) - cz0 + 1;
    for (let k = 0; k < 3; k += 1) {
      t.setF(at, k, layer.origin[k]!);
      t.setF(at + 1, k, g.cellSize[k]!);
    }
    t.setU(at + 1, 3, g.min[1]! | 0);
    t.setU(at + 2, 0, cx0 | 0);
    t.setU(at + 2, 1, cz0 | 0);
    t.setU(at + 2, 2, (ncx | (ncz << 16)) >>> 0);
    t.setU(at + 2, 3, g.max[1]! | 0);
    const cols = t.alloc(ncx * ncz);
    t.setU(at, 3, cols);
    for (let cz = cz0; cz < cz0 + ncz; cz += 1) {
      for (let cx = cx0; cx < cx0 + ncx; cx += 1) {
        const tile: BlockTile | undefined = view.blockTiles.get(`${li}/${cx},${cz}`);
        const r = tile === undefined ? undefined : resident.get(tile.key);
        if (tile === undefined || r === undefined) continue;
        tile.charts();
        const made = tile.made!;
        const { cap, slotOf } = faceHashOf(made);
        const hash = t.alloc(cap);
        for (let s = 0; s < cap; s += 1) t.setU(hash + s, 0, EMPTY);
        // Each chart's place on its page, then each face's slot: its key, its chart's place and its own cell along it.
        const place = r.charts.map((chart, c) => {
          const pl = r.packing.places[c]!;
          const b = r.blocks[pl.block]!;
          return chart.kind !== 'area' ? null : { page: b.page, x: b.x + pl.x + SURFACE_CHART_BORDER, y: b.y + pl.y + SURFACE_CHART_BORDER, iw: areaTexels(chart.w, r.level), ih: areaTexels(chart.h, r.level) };
        });
        const frames = made.frames;
        for (let i = 0; i < made.keys.length; i += 1) {
          const c = made.chartOf[i]!;
          const p = place[c];
          if (p === null || p === undefined) continue;
          const axis = frames[c * 4]! >> 1;
          const [pu, pv] = FACE_PLANE_AXES[axis]!;
          const chart = r.charts[c]! as { w: number; h: number };
          const wc = Math.round(chart.w / g.cellSize[pu]!);
          const hc = Math.round(chart.h / g.cellSize[pv]!);
          const o = made.offsets[i]!;
          const sl = hash + slotOf[i]!;
          t.setU(sl, 0, made.keys[i]!);
          t.setU(sl, 1, (p.page | (p.x << 12) | (p.y << 20)) >>> 0);
          t.setU(sl, 2, (p.iw | (p.ih << 8) | ((o & 255) << 16) | ((o >> 8) << 24)) >>> 0);
          t.setU(sl, 3, wc | (hc << 8));
        }
        const j = (cz - cz0) * ncx + (cx - cx0);
        t.setU(cols + j, 0, hash);
        t.setU(cols + j, 1, cap);
      }
    }
  });
  // Terrains with rings.
  const ringKeys = cache.ringTerrains();
  const trec = t.alloc(ringKeys.length * TERRAIN_TEXELS);
  t.setU(0, 2, ringKeys.length);
  t.setU(0, 3, trec);
  ringKeys.forEach((key, ti) => {
    const at = trec + ti * TERRAIN_TEXELS;
    const rings = cache.ringsOf(key)!;
    const windows = rings.windows();
    t.setU(at, 0, windows.length);
    t.setU(at, 1, ti * TERRAIN_RINGS_MAX);
    windows.forEach((win, k) => {
      t.setF(at + 1 + k, 0, (win[0] + win[2]) / 2);
      t.setF(at + 1 + k, 1, (win[1] + win[3]) / 2);
      t.setF(at + 1 + k, 2, (win[2] - win[0]) / 2);
      t.setF(at + 1 + k, 3, rings.texelMetres(k));
    });
  });
  // Architecture: every resident chart's frame, and the world cells' lists of them.
  const lists = new Map<string, number[]>();
  for (const o of view.arch) {
    const r = resident.get(o.tile.key);
    if (r === undefined) continue;
    const { frames, cells } = archFramesOf(o.tile);
    const at = frames.map((f) => {
      const fa = t.alloc(FRAME_TEXELS);
      for (let k = 0; k < 3; k += 1) {
        t.setF(fa, k, f.o[k]!);
        t.setF(fa + 1, k, f.u[k]!);
        t.setF(fa + 2, k, f.v[k]!);
      }
      t.setF(fa, 3, f.w);
      t.setF(fa + 1, 3, f.h);
      putChart(t, fa + 3, r, f.chart);
      return fa;
    });
    for (const [key, list] of cells) {
      const all = lists.get(key);
      const mine = list.map((i) => at[i]!);
      if (all === undefined) lists.set(key, mine);
      else all.push(...mine);
    }
  }
  const cap = pow2AtLeast(lists.size * 2);
  const slots = t.alloc(cap);
  t.setU(1, 0, cap);
  t.setU(1, 1, slots);
  for (const [key, list] of lists) {
    const [x, y, z] = key.split(',').map(Number) as [number, number, number];
    const la = t.alloc(1 + Math.ceil(list.length / 4));
    t.setU(la, 0, list.length);
    list.forEach((f, i) => t.w.setU(la * 4 + 1 + i, f));
    let s = cellHash(x, y, z, cap);
    while (t.w.getU((slots + s) * 4 + 3) !== 0) s = (s + 1) & (cap - 1);
    t.setU(slots + s, 0, x);
    t.setU(slots + s, 1, y);
    t.setU(slots + s, 2, z);
    t.setU(slots + s, 3, la);
  }
  packModels(t, view.models, resident, slotOf);
  // Whole rows of the texture.
  const texels = Math.max(LOOKUP_WIDTH, Math.ceil(t.w.length / 4 / LOOKUP_WIDTH) * LOOKUP_WIDTH);
  const out = new Uint32Array(texels * 4);
  out.set(t.w.done());
  return out;
}

/** A looked-up place: an atlas page or a ring texture layer, and continuous texel coordinates (the texel is their floor). */
export interface LookedUp {
  readonly texture: 'atlas' | 'rings';
  readonly layer: number;
  readonly x: number;
  readonly y: number;
}

const i32 = (v: number): number => v | 0;

/** A chart's place (`putChart`, at texel `at`) for metres (uu, vv) along its `wm` × `hm`, held a half texel inside its interior (the filter never reads its border). */
function chartPlace(u: Uint32Array, at: number, uu: number, vv: number, wm: number, hm: number): LookedUp {
  const w = at * 4;
  const x0 = u[w + 1]! & 0xffff;
  const y0 = u[w + 1]! >>> 16;
  const iw = u[w + 2]! & 0xffff;
  const ih = u[w + 2]! >>> 16;
  const x = x0 + Math.min(iw - 0.5, Math.max(0.5, (uu / wm) * iw));
  const y = y0 + Math.min(ih - 0.5, Math.max(0.5, (vv / hm) * ih));
  return { texture: 'atlas', layer: u[w]!, x, y };
}

/** The facing of a normal: its major axis × 2, + 1 when it points along −axis. */
function facingOf(n: readonly number[]): number {
  const a = Math.abs(n[0]!) >= Math.abs(n[1]!) && Math.abs(n[0]!) >= Math.abs(n[2]!) ? 0 : Math.abs(n[1]!) >= Math.abs(n[2]!) ? 1 : 2;
  return a * 2 + (n[a]! < 0 ? 1 : 0);
}

/**
 * Where a pixel of `kind` at world point `p` with normal `n` reads its light
 * (null: nowhere: it keeps its own lights); a model's pixel names its copy's
 * slot and, on a UV1 model, its UV1.
 */
export function lookupSurfaceCpu(words: Uint32Array, kind: SurfaceReadKind, p: readonly number[], n: readonly number[], model?: { readonly slot: number; readonly uv1?: readonly number[] }): LookedUp | null {
  const u = words;
  const f = new Float32Array(u.buffer, u.byteOffset, u.length);
  if (kind === SURFACE_READ.blocks) {
    const face = facingOf(n);
    const axis = face >> 1;
    const sgn = face & 1 ? -1 : 1;
    for (let li = 0; li < u[0]!; li += 1) {
      const at = (u[1]! + li * LAYER_TEXELS) * 4;
      const q = [0, 1, 2].map((k) => (p[k]! - f[at + k]!) / f[at + 4 + k]!);
      q[axis]! -= sgn * BLOCK_INSET;
      const cell = q.map(Math.floor);
      if (cell[1]! < i32(u[at + 7]!) || cell[1]! >= i32(u[at + 11]!)) continue;
      const cx = Math.floor(cell[0]! / CHUNK_SIZE);
      const cz = Math.floor(cell[2]! / CHUNK_SIZE);
      const jx = cx - i32(u[at + 8]!);
      const jz = cz - i32(u[at + 9]!);
      const ncx = u[at + 10]! & 0xffff;
      if (jx < 0 || jz < 0 || jx >= ncx || jz >= u[at + 10]! >>> 16) continue;
      const col = (u[at + 3]! + jz * ncx + jx) * 4;
      const hash = u[col]!;
      const cap = u[col + 1]!;
      if (cap === 0) continue;
      const key = (((cell[1]! - i32(u[at + 7]!)) * CHUNK_SIZE + (cell[2]! - cz * CHUNK_SIZE)) * CHUNK_SIZE + (cell[0]! - cx * CHUNK_SIZE)) * 6 + face;
      for (let s = faceHash(key, cap), tries = 0; tries < cap; s = (s + 1) & (cap - 1), tries += 1) {
        const w = (hash + s) * 4;
        if (u[w] === EMPTY) break;
        if (u[w] !== key) continue;
        const [pu, pv] = FACE_PLANE_AXES[axis]!;
        const fu = Math.min(1, Math.max(0, q[pu]! - cell[pu]!));
        const fv = Math.min(1, Math.max(0, q[pv]! - cell[pv]!));
        const a = u[w + 1]!;
        const b = u[w + 2]!;
        const c = u[w + 3]!;
        const iw = b & 255;
        const ih = (b >>> 8) & 255;
        const x = ((a >>> 12) & 255) + Math.min(iw - 0.5, Math.max(0.5, ((((b >>> 16) & 255) + fu) / (c & 255)) * iw));
        const y = ((a >>> 20) & 255) + Math.min(ih - 0.5, Math.max(0.5, (((b >>> 24) + fv) / ((c >>> 8) & 255)) * ih));
        return { texture: 'atlas', layer: a & 0xfff, x, y };
      }
    }
    return null;
  }
  if (kind === SURFACE_READ.terrain) {
    for (let ti = 0; ti < u[2]!; ti += 1) {
      const at = (u[3]! + ti * TERRAIN_TEXELS) * 4;
      for (let k = 0; k < u[at]!; k += 1) {
        const r = at + 4 + k * 4;
        const t = f[r + 3]!;
        const half = f[r + 2]! - t;
        if (Math.abs(p[0]! - f[r]!) > half || Math.abs(p[2]! - f[r + 1]!) > half) continue;
        return { texture: 'rings', layer: u[at + 1]! + k, x: p[0]! / t, y: p[2]! / t };
      }
    }
    return null;
  }
  if (kind === SURFACE_READ.model) return model === undefined ? null : lookupModelCpu(u, f, p, n, model.slot, model.uv1);
  const cap = u[4]!;
  const slots = u[5]!;
  const c = p.map((v) => Math.floor(v / ARCH_CELL));
  const zf = c[2]! * 8 + facingOf(n);
  for (let s = cellHash(c[0]!, c[1]!, zf, cap), tries = 0; tries < cap; s = (s + 1) & (cap - 1), tries += 1) {
    const w = (slots + s) * 4;
    if (u[w + 3] === 0) break;
    if (i32(u[w]!) !== c[0] || i32(u[w + 1]!) !== c[1] || i32(u[w + 2]!) !== zf) continue;
    const la = u[w + 3]! * 4;
    for (let i = 0; i < u[la]!; i += 1) {
      const fa = u[la + 1 + i]! * 4;
      const d = [p[0]! - f[fa]!, p[1]! - f[fa + 1]!, p[2]! - f[fa + 2]!];
      const uax = [f[fa + 4]!, f[fa + 5]!, f[fa + 6]!];
      const vax = [f[fa + 8]!, f[fa + 9]!, f[fa + 10]!];
      const nn = [uax[1]! * vax[2]! - uax[2]! * vax[1]!, uax[2]! * vax[0]! - uax[0]! * vax[2]!, uax[0]! * vax[1]! - uax[1]! * vax[0]!];
      const dist = d[0]! * nn[0]! + d[1]! * nn[1]! + d[2]! * nn[2]!;
      if (Math.abs(dist) > ARCH_PLANE_METRES || n[0]! * nn[0]! + n[1]! * nn[1]! + n[2]! * nn[2]! < ARCH_FACING) continue;
      const uu = d[0]! * uax[0]! + d[1]! * uax[1]! + d[2]! * uax[2]!;
      const vv = d[0]! * vax[0]! + d[1]! * vax[1]! + d[2]! * vax[2]!;
      const wm = f[fa + 3]!;
      const hm = f[fa + 7]!;
      if (uu < -ARCH_PLANE_METRES || vv < -ARCH_PLANE_METRES || uu > wm + ARCH_PLANE_METRES || vv > hm + ARCH_PLANE_METRES) continue;
      return chartPlace(u, fa / 4 + 3, uu, vv, wm, hm);
    }
    return null;
  }
  return null;
}

/** The surfel of cell `c` (from the cells' origin) and `facing` in a set's buckets (−1: none). */
function surfelAt(u: Uint32Array, hash: number, buckets: number, c: readonly number[], facing: number): number {
  const key = surfelKey(c[0]!, c[1]!, c[2]!);
  if (key === null) return -1;
  const home = surfelBucket(key, facing, buckets);
  for (let j = 0; j < 4; j += 1) {
    const w = (hash + ((home + (j >> 1)) & (buckets - 1))) * 4 + (j & 1) * 2;
    if (u[w + 1] !== EMPTY && u[w] === key && (u[w + 1]! & 7) === facing) return u[w + 1]! >>> 3;
  }
  return -1;
}

/** A model pixel's place: its slot's placement takes the point and normal into the root; a UV1 piece reads its UV1, a piece on surfels the surfel of the point's cell and facing (or of the cell across the nearer boundary along its normal). */
function lookupModelCpu(u: Uint32Array, f: Float32Array, p: readonly number[], n: readonly number[], slot: number, uv1: readonly number[] | undefined): LookedUp | null {
  if (slot <= 0 || slot >= u[6]!) return null;
  const rec = u[7]! + slot * SLOT_TEXELS;
  const r = rec * 4;
  if (u[r + 15] !== 1) return null;
  const pa = (rec + 6) * 4;
  const ca = pa + 4;
  const x0 = u[ca + 1]! & 0xffff;
  const y0 = u[ca + 1]! >>> 16;
  const w = u[ca + 2]! & 0xffff;
  const h = u[ca + 2]! >>> 16;
  if (u[pa + 3] === 1) {
    if (uv1 === undefined) return null;
    return { texture: 'atlas', layer: u[ca]!, x: x0 + Math.min(w - 0.5, Math.max(0.5, uv1[0]! * w)), y: y0 + Math.min(h - 0.5, Math.max(0.5, uv1[1]! * h)) };
  }
  const lp = [0, 1, 2].map((k) => f[r + k * 4]! * p[0]! + f[r + k * 4 + 1]! * p[1]! + f[r + k * 4 + 2]! * p[2]! + f[r + k * 4 + 3]!);
  const ln = [0, 1, 2].map((k) => f[r + 12 + k * 4]! * n[0]! + f[r + 12 + k * 4 + 1]! * n[1]! + f[r + 12 + k * 4 + 2]! * n[2]!);
  const facing = facingOf(ln);
  const cell = f[pa]!;
  const q = lp.map((v) => v / cell);
  const c = q.map((v, a) => Math.floor(v) - i32(u[pa + 8 + a]!));
  let index = surfelAt(u, u[pa + 1]!, u[pa + 2]!, c, facing);
  // A face on a cell boundary has its surfels on either side of it (their points round either way): the cell across the nearer boundary along its normal.
  if (index < 0) {
    const axis = facing >> 1;
    c[axis]! += q[axis]! - Math.floor(q[axis]!) < 0.5 ? -1 : 1;
    index = surfelAt(u, u[pa + 1]!, u[pa + 2]!, c, facing);
  }
  if (index < 0) return null;
  // A surfel's own texel, at its centre (its light is not filtered with its neighbours': they lie anywhere on the model).
  return { texture: 'atlas', layer: u[ca]!, x: x0 + (index % w) + 0.5, y: y0 + Math.floor(index / w) + 0.5 };
}
