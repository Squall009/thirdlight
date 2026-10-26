/**
 * Where a drawn pixel's light is in the surface cache: the cache's addressing
 * packed for the materials' lookup (`surface-cache-read.ts`), which finds a
 * static surface's texel from the pixel's world position and normal alone —
 * no per-object data, so merged, batched and shared geometry need nothing of
 * their own — and samples it filtered, as a lightmap is.
 *
 * - Block layers: the pixel's cell (its point a little behind the face it
 *   faces) and face; the face's chart from its chunk column's hash of face
 *   keys (`blockFaceKey`). Any geometry a block draws (cubes, slopes, a
 *   variant's model) reads the light of its cell's face on its facing.
 * - Terrain: the finest ring whose window holds the point (one texel in
 *   from its edge, so the filter stays inside), at the point's world x, z.
 * - Generated architecture: the charts are planes; a hash of world cells
 *   (`ARCH_CELL` metres) lists the charts crossing each, and a pixel takes
 *   the first whose plane it lies on (within `ARCH_PLANE_METRES`, facing its
 *   way) inside its rectangle. Trims and mouldings off the planes find none.
 *
 * The words are read four at a time (an RGBA32UI texture, `LOOKUP_WIDTH`
 * texels a row); addresses count texels. `lookupSurfaceCpu` walks the same
 * words the same way (the reference the shaders are held to).
 *
 * Layout:
 *
 * - header: texel 0 (layers, their records, terrains, their records),
 *   texel 1 (the architecture hash's slots, its first slot);
 * - a layer (`LAYER_TEXELS`): origin (f32 ×3), cell size (f32 ×3), cells'
 *   min (i32 ×3) and the column words' texel, cells' max (i32 ×3), the first
 *   chunk column (cx, cz, i32) and columns along x and z; a column word is
 *   its tile's texel (0: none); a tile: its hash's texel, its slots (a power
 *   of two), its charts' texel; a hash slot is two words (face key,
 *   `chart << 16 | u | v << 8`), the key `EMPTY` when free;
 * - a chart (`CHART_TEXELS`): page, the interior's corner (x | y << 16), its
 *   texels (w | h << 16), a spare word; its metres (w, h, f32);
 * - a terrain (`TERRAIN_TEXELS`): rings, the first texture layer, then per
 *   ring its window's centre (x, z), half side and texel (m, f32);
 * - an architecture slot: cell (x, y, z, i32) and its list's texel (0:
 *   free); a list: its count, then the charts' frame texels; a frame
 *   (`FRAME_TEXELS`): corner (f32 ×3) and width, u axis and height, v axis,
 *   then its chart record.
 *
 * Pure (no three.js, no device).
 */
import { CHUNK_SIZE } from '@thirdlight/runtime';

import { SURFACE_CHART_BORDER, SURFACE_CHART_METRES, areaTexels, type AtlasBlock, type SurfaceChart, type TilePacking } from './surface-cache-atlas';
import { FACE_PLANE_AXES, type BlockChunkCharts } from './surface-cache-blocks';
import type { SurfaceCache } from './surface-cache';
import type { ArchTile, BlockTile, SurfaceScene } from './surface-cache-scene';
import { TERRAIN_RINGS_MAX } from './surface-cache-terrain';
import { Words } from './tracer-words';

/** Texels a row of the lookup texture. */
export const LOOKUP_WIDTH = 2048;
export const LAYER_TEXELS = 5;
export const CHART_TEXELS = 2;
export const TERRAIN_TEXELS = 1 + TERRAIN_RINGS_MAX;
export const FRAME_TEXELS = 3 + CHART_TEXELS;
/** A free slot's key. */
export const EMPTY = 0xffffffff;
/** The architecture hash's cells (m). */
export const ARCH_CELL = 2;
/** How far (m) off a chart's plane a pixel may lie and still read it (a render surface against its collider's face). */
export const ARCH_PLANE_METRES = 0.05;
/** How far (as a cosine) a pixel's normal may turn from its chart's and still read it. */
export const ARCH_FACING = 0.5;
/** How far (cells) behind its face a block pixel's point is taken, so it falls in its own cell. */
export const BLOCK_INSET = 0.001;

/** The kinds of static surface a material reads the cache for (a drawn mesh's `SURFACE_READ_KEY`). */
export const SURFACE_READ = { blocks: 1, terrain: 2, arch: 3 } as const;
export type SurfaceReadKind = (typeof SURFACE_READ)[keyof typeof SURFACE_READ];

/** A face key's slot in a hash of `cap` slots (the shaders hash alike, in u32). */
export function faceHash(key: number, cap: number): number {
  const h = Math.imul(key, 0x9e3779b1) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) & (cap - 1);
}

/** A world cell's slot in a hash of `cap` slots. */
export function cellHash(x: number, y: number, z: number, cap: number): number {
  return ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0) & (cap - 1);
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

/** An area chart's record (page, interior corner and texels, metres). */
function putChart(t: Texels, at: number, r: Resident, c: number): void {
  const chart = r.charts[c]!;
  const place = r.packing.places[c]!;
  const b = r.blocks[place.block]!;
  if (chart.kind !== 'area') return;
  t.setU(at, 0, b.page);
  t.setU(at, 1, (b.x + place.x + SURFACE_CHART_BORDER) | ((b.y + place.y + SURFACE_CHART_BORDER) << 16));
  t.setU(at, 2, areaTexels(chart.w, r.level) | (areaTexels(chart.h, r.level) << 16));
  t.setF(at + 1, 0, chart.w);
  t.setF(at + 1, 1, chart.h);
}

/** A block tile's face hash (key, entry pairs), kept with its charts: residency changes do not change it. */
const faceHashes = new WeakMap<BlockChunkCharts, { cap: number; slots: Uint32Array }>();

function faceHashOf(made: BlockChunkCharts): { cap: number; slots: Uint32Array } {
  let h = faceHashes.get(made);
  if (h !== undefined) return h;
  const cap = pow2AtLeast(made.keys.length * 2);
  const slots = new Uint32Array(cap * 2).fill(0);
  for (let s = 0; s < cap; s += 1) slots[s * 2] = EMPTY;
  for (let i = 0; i < made.keys.length; i += 1) {
    const key = made.keys[i]!;
    let s = faceHash(key, cap);
    while (slots[s * 2] !== EMPTY) s = (s + 1) & (cap - 1);
    slots[s * 2] = key;
    slots[s * 2 + 1] = ((made.chartOf[i]! << 16) | made.offsets[i]!) >>> 0;
  }
  h = { cap, slots };
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

/** An architecture tile's chart frames and the world cells each crosses, kept with its charts. */
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
        for (let z = c0[2]!; z <= c1[2]!; z += 1) for (let y = c0[1]!; y <= c1[1]!; y += 1) for (let x = c0[0]!; x <= c1[0]!; x += 1) {
          const key = `${x},${y},${z}`;
          const list = cells.get(key);
          if (list === undefined) cells.set(key, [fi]);
          else list.push(fi);
        }
      }
    }
  }
  got = { frames, cells };
  archFrames.set(tile.made, got);
  return got;
}

/** The lookup's words for `scene` with what `cache` holds resident now (packed again when residency changes). */
export function packSurfaceLookup(scene: SurfaceScene, cache: SurfaceCache): Uint32Array {
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
      t.setU(at + 2, k, g.min[k]! | 0);
      t.setU(at + 3, k, g.max[k]! | 0);
    }
    t.setU(at + 4, 0, cx0 | 0);
    t.setU(at + 4, 1, cz0 | 0);
    t.setU(at + 4, 2, ncx);
    t.setU(at + 4, 3, ncz);
    const cols = t.alloc(Math.ceil((ncx * ncz) / 4));
    t.setU(at + 2, 3, cols);
    for (let cz = cz0; cz < cz0 + ncz; cz += 1) {
      for (let cx = cx0; cx < cx0 + ncx; cx += 1) {
        const tile: BlockTile | undefined = view.blockTiles.get(`${li}/${cx},${cz}`);
        const r = tile === undefined ? undefined : resident.get(tile.key);
        if (tile === undefined || r === undefined) continue;
        tile.charts();
        const { cap, slots } = faceHashOf(tile.made!);
        const rec = t.alloc(1);
        const hash = t.alloc(cap / 2);
        for (let i = 0; i < cap * 2; i += 1) t.w.setU(hash * 4 + i, slots[i]!);
        const charts = t.alloc(r.charts.length * CHART_TEXELS);
        for (let c = 0; c < r.charts.length; c += 1) putChart(t, charts + c * CHART_TEXELS, r, c);
        t.setU(rec, 0, hash);
        t.setU(rec, 1, cap);
        t.setU(rec, 2, charts);
        const j = (cz - cz0) * ncx + (cx - cx0);
        t.w.setU(cols * 4 + j, rec);
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

/** A chart record's place for metres (uu, vv) along it, held a half texel inside its interior (the filter never reads its border). */
function chartPlace(u: Uint32Array, f: Float32Array, at: number, uu: number, vv: number): LookedUp {
  const w = at * 4;
  const x0 = u[w + 1]! & 0xffff;
  const y0 = u[w + 1]! >>> 16;
  const iw = u[w + 2]! & 0xffff;
  const ih = u[w + 2]! >>> 16;
  const x = x0 + Math.min(iw - 0.5, Math.max(0.5, (uu / f[w + 4]!) * iw));
  const y = y0 + Math.min(ih - 0.5, Math.max(0.5, (vv / f[w + 5]!) * ih));
  return { texture: 'atlas', layer: u[w]!, x, y };
}

/** The facing of a normal: its major axis × 2, + 1 when it points along −axis. */
function facingOf(n: readonly number[]): number {
  const a = Math.abs(n[0]!) >= Math.abs(n[1]!) && Math.abs(n[0]!) >= Math.abs(n[2]!) ? 0 : Math.abs(n[1]!) >= Math.abs(n[2]!) ? 1 : 2;
  return a * 2 + (n[a]! < 0 ? 1 : 0);
}

/** Where a pixel of `kind` at world point `p` with normal `n` reads its light (null: nowhere: it keeps its own lights). */
export function lookupSurfaceCpu(words: Uint32Array, kind: SurfaceReadKind, p: readonly number[], n: readonly number[]): LookedUp | null {
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
      if ([0, 1, 2].some((k) => cell[k]! < i32(u[at + 8 + k]!) || cell[k]! >= i32(u[at + 12 + k]!))) continue;
      const cx = Math.floor(cell[0]! / CHUNK_SIZE);
      const cz = Math.floor(cell[2]! / CHUNK_SIZE);
      const jx = cx - i32(u[at + 16]!);
      const jz = cz - i32(u[at + 17]!);
      if (jx < 0 || jz < 0 || jx >= u[at + 18]! || jz >= u[at + 19]!) continue;
      const rec = u[u[at + 11]! * 4 + jz * u[at + 18]! + jx]!;
      if (rec === 0) continue;
      const key = (((cell[1]! - i32(u[at + 9]!)) * CHUNK_SIZE + (cell[2]! - cz * CHUNK_SIZE)) * CHUNK_SIZE + (cell[0]! - cx * CHUNK_SIZE)) * 6 + face;
      const hash = u[rec * 4]!;
      const cap = u[rec * 4 + 1]!;
      for (let s = faceHash(key, cap), tries = 0; tries < cap; s = (s + 1) & (cap - 1), tries += 1) {
        const w = hash * 4 + s * 2;
        if (u[w] === EMPTY) break;
        if (u[w] !== key) continue;
        const e = u[w + 1]!;
        const [pu, pv] = FACE_PLANE_AXES[axis]!;
        const fu = Math.min(1, Math.max(0, q[pu]! - cell[pu]!));
        const fv = Math.min(1, Math.max(0, q[pv]! - cell[pv]!));
        return chartPlace(u, f, u[rec * 4 + 2]! + (e >>> 16) * CHART_TEXELS, ((e & 255) + fu) * f[at + 4 + pu]!, (((e >>> 8) & 255) + fv) * f[at + 4 + pv]!);
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
  const cap = u[4]!;
  const slots = u[5]!;
  const c = p.map((v) => Math.floor(v / ARCH_CELL));
  for (let s = cellHash(c[0]!, c[1]!, c[2]!, cap), tries = 0; tries < cap; s = (s + 1) & (cap - 1), tries += 1) {
    const w = (slots + s) * 4;
    if (u[w + 3] === 0) break;
    if (i32(u[w]!) !== c[0] || i32(u[w + 1]!) !== c[1] || i32(u[w + 2]!) !== c[2]) continue;
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
      return chartPlace(u, f, fa / 4 + 3, uu, vv);
    }
    return null;
  }
  return null;
}
