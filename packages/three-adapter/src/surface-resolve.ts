/**
 * Where a traced hit's light is, on the GPU: the surface cache's addressing
 * (`SurfaceScene.resolve`, `SurfaceCache.texelOf`) packed into one word
 * table the resolve pass (`surface-resolve-wgsl.ts`) reads beside the
 * tracer's hits, so probe and reflection rays find their texel without a
 * read-back. `resolveHitCpu` walks the same words the same way (the
 * reference the GPU pass is held to, and what a caller without a device
 * resolves with).
 *
 * A resolved texel is two words: the first `RESOLVE_PAGE << 30 | page`, or
 * `RESOLVE_RING << 30 | terrain << 3 | ring` (terrain: its index in
 * `ResolveTable.terrains`), or 0 (a miss, an unfinished ray, not resident);
 * the second `x | y << 16`.
 *
 * Table layout (word offsets):
 *
 * - header (`RESOLVE_HEADER_WORDS`): 0 layers, 1 their records, 2 terrains,
 *   3 their records, 4 architecture objects, 5 their records, 6 boxes in
 *   all, 7 each box's object, 8 each box's unit-box → world map (12), 9
 *   triangles in all, 10 each triangle's object, 11 their corners (9), 12
 *   model pieces, 13 their records;
 * - a chart (`CHART_WORDS`): 0 page, 1 the interior's corner x | y << 16, 2
 *   texels w | h << 16 (an area chart's interior), or w | h << 12 | 1 << 31
 *   (surfels: its rectangle), 3–4 the area's metres (f32);
 * - a layer (`LAYER_R_WORDS`): 0–2 its cells' min, 3–5 cells per axis, 6–8
 *   cell size (f32), 9–10 the first chunk column (x, z), 11–12 columns per
 *   axis, 13 the column table (a word per column: its tile, 0 none); a
 *   block tile: 0 face keys, 1 their pairs (key, chart << 16 | u | v << 8),
 *   2 its charts;
 * - a terrain (`TERRAIN_R_WORDS`): 0 cells along x, 1–2 the first cell (x,
 *   z), 3 spacing, 4–6 and 7–9 the local → world map's x and z rows (x, z
 *   and the offset), 10 rings, 11 its cache rings' terrain (the index its
 *   texels' words carry: a terrain traced in several rings has a record per
 *   ring, all naming the same one), then per ring its centre (x, z), half
 *   side and texel (m);
 * - an architecture object (`ARCH_R_WORDS`): 0 its first box, 1 boxes, 2
 *   first triangle, 3 triangles, 4 each piece's component (i32, −1: none),
 *   5 its components (`COMP_WORDS`: origin, u and v axes, u0, v0, nu, nv,
 *   first chart), 6 its charts (0: not resident);
 * - a model piece (`MODEL_R_WORDS`): 0 its chart (0: not resident), 1–3 the
 *   field's min, 4–6 its size (m), 7–15 world normal → root (row-major),
 *   16 the surfel cell (m), 17 the surfel hash, 18 its capacity (a power of
 *   two), 19 positions, 20 UV1 (0: none); a hash slot (`HASH_WORDS`): cell
 *   x, y, z (i32), facing | surfel << 3 (`EMPTY_SLOT`: empty).
 *
 * Pure (no three.js, no device).
 */
import { DISTANCE_BRICK_CELLS, surfelFacing, type DistanceBrickSet, type SurfelSet } from '@thirdlight/project-model';

import { SURFACE_CHART_BORDER, SURFACE_CHART_METRES, areaTexels, surfelLevelFor, type AtlasBlock, type SurfaceChart, type TilePacking } from './surface-cache-atlas';
import { FACE_PLANE_AXES } from './surface-cache-blocks';
import type { SurfaceCache, SurfaceTexel } from './surface-cache';
import type { SurfaceScene } from './surface-cache-scene';
import { HIT_WORDS, TRACE_ARCH, TRACE_BLOCKS, TRACE_BRICKS, TRACE_TERRAIN } from './tracer-scene';
import { Words, invertAffine, worldToLocalOf } from './tracer-words';

export const RESOLVE_HEADER_WORDS = 16;
export const CHART_WORDS = 5;
export const LAYER_R_WORDS = 14;
export const TERRAIN_R_WORDS = 12 + 4 * 8;
export const ARCH_R_WORDS = 7;
export const COMP_WORDS = 14;
export const MODEL_R_WORDS = 21;
export const HASH_WORDS = 4;
export const EMPTY_SLOT = 0xffffffff;
export const RESOLVE_PAGE = 1;
export const RESOLVE_RING = 2;
/** Words per resolved texel. */
export const TEXEL_WORDS = 2;
const SURFELS_FLAG = 0x80000000;

/** The packed table and the terrains its ring texels name by index. */
export interface ResolveTable {
  readonly words: Uint32Array;
  readonly terrains: readonly string[];
}

/** A surfel cell's slot in a hash of `cap` slots (the WGSL pass hashes alike, in u32). */
export function surfelHash(x: number, y: number, z: number, facing: number, cap: number): number {
  const h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ Math.imul(facing, 0x9e3779b1)) >>> 0;
  return h & (cap - 1);
}

type Resident = { level: number; blocks: readonly AtlasBlock[]; packing: TilePacking; charts: readonly SurfaceChart[] };

/** A resident tile's chart records (0: not resident). */
function putCharts(w: Words, r: Resident | undefined): number {
  if (r === undefined) return 0;
  const { level, blocks, packing, charts } = r;
  const out = w.alloc(Math.max(1, charts.length) * CHART_WORDS);
  charts.forEach((c, i) => {
    const place = packing.places[i]!;
    const b = blocks[place.block]!;
    const at = out + i * CHART_WORDS;
    w.setU(at, b.page);
    if (c.kind === 'area') {
      w.setU(at + 1, (b.x + place.x + SURFACE_CHART_BORDER) | ((b.y + place.y + SURFACE_CHART_BORDER) << 16));
      w.setU(at + 2, areaTexels(c.w, level) | (areaTexels(c.h, level) << 16));
      w.setF(at + 3, c.w);
      w.setF(at + 4, c.h);
    } else {
      w.setU(at + 1, (b.x + place.x) | ((b.y + place.y) << 16));
      w.setU(at + 2, (place.w | (place.h << 12) | SURFELS_FLAG) >>> 0);
    }
  });
  return out;
}

interface PackedSurfels {
  readonly cell: number;
  readonly hash: number;
  readonly cap: number;
  readonly pos: number;
  /** 0: none. */
  readonly uv: number;
}

/** A set's surfels of level `k`: hashed by cell and facing, their positions and (`uv1`) their UV1. */
function packSurfels(w: Words, s: SurfelSet, k: number, uv1: boolean): PackedSurfels {
  const cell = s.spacing * 2 ** k;
  const n = s.levels[k] ?? 0;
  let cap = 1;
  while (cap < n * 2) cap *= 2;
  const hash = w.alloc(cap * HASH_WORDS);
  for (let i = 0; i < cap; i += 1) w.setU(hash + i * HASH_WORDS + 3, EMPTY_SLOT);
  for (let i = 0; i < n; i += 1) {
    const c = [0, 1, 2].map((a) => Math.floor(s.positions[i * 3 + a]! / cell));
    const facing = surfelFacing([s.normals[i * 3]!, s.normals[i * 3 + 1]!, s.normals[i * 3 + 2]!]);
    // Open addressing; a later surfel of the same cell and facing takes the slot, as the CPU lookup's map does.
    for (let h = surfelHash(c[0]!, c[1]!, c[2]!, facing, cap); ; h = (h + 1) & (cap - 1)) {
      const sa = hash + h * HASH_WORDS;
      const tag = w.getU(sa + 3);
      if (tag === EMPTY_SLOT || ((tag & 7) === facing && w.getU(sa) === c[0]! >>> 0 && w.getU(sa + 1) === c[1]! >>> 0 && w.getU(sa + 2) === c[2]! >>> 0)) {
        for (let a = 0; a < 3; a += 1) w.setU(sa + a, c[a]!);
        w.setU(sa + 3, facing | (i << 3));
        break;
      }
    }
  }
  const pos = w.alloc(n * 3);
  for (let i = 0; i < n * 3; i += 1) w.setF(pos + i, s.positions[i]!);
  let uv = 0;
  if (uv1 && s.uv1 !== null) {
    uv = w.alloc(n * 2);
    for (let i = 0; i < n * 2; i += 1) w.setF(uv + i, s.uv1[i]!);
  }
  return { cell, hash, cap, pos, uv };
}

/** Pack the resolve table of `scene` with what `cache` holds resident now (packed again when residency changes). */
export function packResolveTable(scene: SurfaceScene, cache: SurfaceCache): ResolveTable {
  const w = new Words();
  w.alloc(RESOLVE_HEADER_WORDS);
  const view = scene.resolveView();
  const input = scene.input;
  const resident = new Map<string, Resident>();
  cache.forEachResident((key, level, blocks, packing, charts) => resident.set(key, { level, blocks, packing, charts }));
  // Block layers: a column table per layer over its chunk columns.
  const layers = input.blocks ?? [];
  const lrec = w.alloc(layers.length * LAYER_R_WORDS);
  w.setU(0, layers.length);
  w.setU(1, lrec);
  layers.forEach((layer, li) => {
    const g = layer.grid;
    const at = lrec + li * LAYER_R_WORDS;
    const cx0 = Math.floor(g.min[0]! / 16);
    const cz0 = Math.floor(g.min[2]! / 16);
    const ncx = Math.floor((g.max[0]! - 1) / 16) - cx0 + 1;
    const ncz = Math.floor((g.max[2]! - 1) / 16) - cz0 + 1;
    for (let k = 0; k < 3; k += 1) {
      w.setU(at + k, g.min[k]! | 0);
      w.setU(at + 3 + k, g.max[k]! - g.min[k]!);
      w.setF(at + 6 + k, g.cellSize[k]!);
    }
    w.setU(at + 9, cx0 | 0);
    w.setU(at + 10, cz0 | 0);
    w.setU(at + 11, ncx);
    w.setU(at + 12, ncz);
    const cols = w.alloc(ncx * ncz);
    w.setU(at + 13, cols);
    for (let cz = cz0; cz < cz0 + ncz; cz += 1) {
      for (let cx = cx0; cx < cx0 + ncx; cx += 1) {
        const tile = view.blockTiles.get(`${li}/${cx},${cz}`);
        if (tile === undefined || cache.levelOf(tile.key) === null) continue;
        tile.charts();
        const made = tile.made!;
        const rec = w.alloc(3);
        const keys = w.alloc(made.keys.length * 2);
        for (let i = 0; i < made.keys.length; i += 1) {
          w.setU(keys + i * 2, made.keys[i]!);
          w.setU(keys + i * 2 + 1, ((made.chartOf[i]! << 16) | made.offsets[i]!) >>> 0);
        }
        w.setU(rec, made.keys.length);
        w.setU(rec + 1, keys);
        w.setU(rec + 2, putCharts(w, resident.get(tile.key)));
        w.setU(cols + (cz - cz0) * ncx + (cx - cx0), rec);
      }
    }
  });
  // Terrains: the local → world map and the rings resident now.
  const terrains = input.terrain ?? [];
  const trec = w.alloc(terrains.length * TERRAIN_R_WORDS);
  w.setU(2, terrains.length);
  w.setU(3, trec);
  const ringKeys = cache.ringTerrains();
  terrains.forEach((t, ti) => {
    const at = trec + ti * TERRAIN_R_WORDS;
    w.setU(at + 11, Math.max(0, ringKeys.indexOf(t.key)));
    const m = invertAffine(t.trace.worldToLocal);
    w.setU(at, t.trace.cellsX);
    w.setU(at + 1, t.trace.cellX0 | 0);
    w.setU(at + 2, t.trace.cellZ0 | 0);
    w.setF(at + 3, t.trace.spacing);
    [m[0]!, m[2]!, m[3]!, m[8]!, m[10]!, m[11]!].forEach((v, k) => w.setF(at + 4 + k, v));
    const windows = cache.ringsOf(t.key)?.windows() ?? [];
    w.setU(at + 10, windows.length);
    windows.forEach((win, k) => {
      w.setF(at + 12 + k * 4, (win[0] + win[2]) / 2);
      w.setF(at + 12 + k * 4 + 1, (win[1] + win[3]) / 2);
      w.setF(at + 12 + k * 4 + 2, (win[2] - win[0]) / 2);
      w.setF(at + 12 + k * 4 + 3, cache.ringsOf(t.key)!.texelMetres(k));
    });
  });
  // Architecture: per box and triangle its object, the boxes' frames and the triangles' corners; per object its pieces' components and charts.
  const arch = view.arch;
  const boxes = arch.reduce((n, o) => n + o.boxes, 0);
  const tris = arch.reduce((n, o) => n + o.triangles, 0);
  const arec = w.alloc(arch.length * ARCH_R_WORDS);
  const boxObj = w.alloc(boxes);
  const frames = w.alloc(boxes * 12);
  const triObj = w.alloc(tris);
  const corners = w.alloc(tris * 9);
  w.setU(4, arch.length);
  w.setU(5, arec);
  w.setU(6, boxes);
  w.setU(7, boxObj);
  w.setU(8, frames);
  w.setU(9, tris);
  w.setU(10, triObj);
  w.setU(11, corners);
  let b0 = 0;
  let t0 = 0;
  arch.forEach((o, oi) => {
    const at = arec + oi * ARCH_R_WORDS;
    const { pieces, made } = o.tile;
    w.setU(at, b0);
    w.setU(at + 1, o.boxes);
    w.setU(at + 2, t0);
    w.setU(at + 3, o.triangles);
    for (let i = 0; i < o.boxes; i += 1) {
      const b = pieces.boxes[i]!;
      w.setU(boxObj + b0 + i, oi);
      invertAffine(worldToLocalOf(b.center, b.rotation, b.half)).forEach((v, k) => w.setF(frames + (b0 + i) * 12 + k, v));
    }
    for (let i = 0; i < o.triangles; i += 1) {
      w.setU(triObj + t0 + i, oi);
      for (let k = 0; k < 9; k += 1) w.setF(corners + (t0 + i) * 9 + k, pieces.triangles[i * 9 + k]!);
    }
    const pof = w.alloc(made.pieceOf.length);
    made.pieceOf.forEach((c, i) => w.setU(pof + i, c));
    const comps = w.alloc(made.components.length * COMP_WORDS);
    made.components.forEach((c, i) => {
      const ca = comps + i * COMP_WORDS;
      [...c.origin, ...c.uAxis, ...c.vAxis, c.u0, c.v0].forEach((v, k) => w.setF(ca + k, v));
      w.setU(ca + 11, c.nu);
      w.setU(ca + 12, c.nv);
      w.setU(ca + 13, c.first);
    });
    w.setU(at + 4, pof);
    w.setU(at + 5, comps);
    w.setU(at + 6, putCharts(w, resident.get(o.tile.key)));
    b0 += o.boxes;
    t0 += o.triangles;
  });
  // Model pieces: the field's box, the normal map, and the surfels of the level the cache holds them at, hashed by cell and facing.
  const models = view.models;
  const shared = new Map<DistanceBrickSet, Map<number, PackedSurfels>>();
  const mrec = w.alloc(models.length * MODEL_R_WORDS);
  w.setU(12, models.length);
  w.setU(13, mrec);
  models.forEach((tile, mi) => {
    const at = mrec + mi * MODEL_R_WORDS;
    const level = cache.levelOf(tile.key);
    const s = tile.set.surfels;
    if (tile.chart === null || level === null || s === null) return;
    w.setU(at, putCharts(w, resident.get(tile.key)));
    const size = tile.set.voxel * DISTANCE_BRICK_CELLS;
    for (let k = 0; k < 3; k += 1) {
      w.setF(at + 1 + k, tile.set.min[k]!);
      w.setF(at + 4 + k, tile.set.dims[k]! * size);
    }
    // localNormal's map: the root → world map's linear part, transposed.
    const m = invertAffine(tile.worldToLocal);
    for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) w.setF(at + 7 + r * 3 + c, m[c * 4 + r]!);
    const k = tile.chart.kind === 'surfels' ? surfelLevelFor(tile.chart, level) : 0;
    const uv1 = tile.chart.kind === 'area' && s.uv1 !== null;
    // Placed copies of one model share its set: its surfels' hash, positions and UV1 are packed once per level.
    let byLevel = shared.get(tile.set);
    if (byLevel === undefined) shared.set(tile.set, (byLevel = new Map()));
    const key = k * 2 + (uv1 ? 1 : 0);
    let sl = byLevel.get(key);
    if (sl === undefined) byLevel.set(key, (sl = packSurfels(w, s, k, uv1)));
    w.setF(at + 16, sl.cell);
    w.setU(at + 17, sl.hash);
    w.setU(at + 18, sl.cap);
    w.setU(at + 19, sl.pos);
    w.setU(at + 20, sl.uv);
  });
  return { words: w.done(), terrains: ringKeys };
}

/** A texel as the resolve pass writes it (two words; [0, 0]: none). */
export function texelWords(t: SurfaceTexel | null, terrains: readonly string[]): [number, number] {
  if (t === null) return [0, 0];
  if ('page' in t) return [((RESOLVE_PAGE << 30) | t.page) >>> 0, (t.x | (t.y << 16)) >>> 0];
  return [((RESOLVE_RING << 30) | (terrains.indexOf(t.terrain) << 3) | t.ring) >>> 0, (t.x | (t.y << 16)) >>> 0];
}

/** An area chart's texel at (u, v) metres, or a surfel chart's texel `index` (two words; [0, 0]: none). */
function chartTexel(u: Uint32Array, f: Float32Array, at: number, uu: number, vv: number, index: number): [number, number] {
  const page = u[at]!;
  const x0 = u[at + 1]! & 0xffff;
  const y0 = u[at + 1]! >>> 16;
  const dims = u[at + 2]!;
  let x: number;
  let y: number;
  if ((dims & SURFELS_FLAG) !== 0) {
    const pw = dims & 0xfff;
    const ph = (dims >>> 12) & 0xfff;
    if (index < 0 || index >= pw * ph) return [0, 0];
    x = x0 + (index % pw);
    y = y0 + Math.floor(index / pw);
  } else {
    if (index >= 0) return [0, 0];
    const iw = dims & 0xffff;
    const ih = dims >>> 16;
    x = x0 + Math.min(iw - 1, Math.max(0, Math.floor((uu / f[at + 3]!) * iw)));
    y = y0 + Math.min(ih - 1, Math.max(0, Math.floor((vv / f[at + 4]!) * ih)));
  }
  return [((RESOLVE_PAGE << 30) | page) >>> 0, (x | (y << 16)) >>> 0];
}

const NONE: [number, number] = [0, 0];

/** The texel hit `i` of `hits` (`HIT_WORDS` each, as the tracer writes them) keeps its light in, as the resolve pass finds it. */
export function resolveHitCpu(table: Uint32Array, hits: Uint32Array, i: number): [number, number] {
  const u = table;
  const f = new Float32Array(u.buffer, u.byteOffset, u.length);
  const hf = new Float32Array(hits.buffer, hits.byteOffset, hits.length);
  const h = i * HIT_WORDS;
  const kind = hits[h + 4]! & 255;
  const face = (hits[h + 4]! >>> 8) & 255;
  const obj = hits[h + 5]!;
  const a0 = hits[h + 6]!;
  const a1 = hits[h + 7]!;
  const fu = (a1 & 0xffff) / 65535;
  const fv = (a1 >>> 16) / 65535;
  const i32 = (v: number): number => v | 0;
  if (kind === TRACE_BLOCKS) {
    if (obj >= u[0]!) return NONE;
    const at = u[1]! + obj * LAYER_R_WORDS;
    const min = [i32(u[at]!), i32(u[at + 1]!), i32(u[at + 2]!)];
    const dx = u[at + 3]!;
    const dz = u[at + 5]!;
    const cell = [(a0 % dx) + min[0]!, Math.floor(a0 / (dx * dz)) + min[1]!, (Math.floor(a0 / dx) % dz) + min[2]!];
    const cx = Math.floor(cell[0]! / 16);
    const cz = Math.floor(cell[2]! / 16);
    const col = [cx - i32(u[at + 9]!), cz - i32(u[at + 10]!)];
    if (col[0]! < 0 || col[1]! < 0 || col[0]! >= u[at + 11]! || col[1]! >= u[at + 12]!) return NONE;
    const rec = u[u[at + 13]! + col[1]! * u[at + 11]! + col[0]!]!;
    if (rec === 0) return NONE;
    // `blockFaceKey`: the cell's index in its chunk column (from the grid's lowest row) × 6 + the face.
    const key = (((cell[1]! - min[1]!) * 16 + (cell[2]! - cz * 16)) * 16 + (cell[0]! - cx * 16)) * 6 + face;
    let lo = 0;
    let hi = u[rec]! - 1;
    const keys = u[rec + 1]!;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const k = u[keys + mid * 2]!;
      if (k === key) {
        const e = u[keys + mid * 2 + 1]!;
        const [pu, pv] = FACE_PLANE_AXES[face >> 1]!;
        const uu = ((e & 255) + fu) * f[at + 6 + pu]!;
        const vv = (((e >>> 8) & 255) + fv) * f[at + 6 + pv]!;
        return chartTexel(u, f, u[rec + 2]! + (e >>> 16) * CHART_WORDS, uu, vv, -1);
      }
      if (k < key) lo = mid + 1;
      else hi = mid - 1;
    }
    return NONE;
  }
  if (kind === TRACE_TERRAIN) {
    if (obj >= u[2]!) return NONE;
    const at = u[3]! + obj * TERRAIN_R_WORDS;
    const nx = u[at]!;
    const s = f[at + 3]!;
    const lx = (i32(u[at + 1]!) + (a0 % nx) + fu) * s;
    const lz = (i32(u[at + 2]!) + Math.floor(a0 / nx) + fv) * s;
    const x = f[at + 4]! * lx + f[at + 5]! * lz + f[at + 6]!;
    const z = f[at + 7]! * lx + f[at + 8]! * lz + f[at + 9]!;
    for (let k = 0; k < u[at + 10]!; k += 1) {
      const r = at + 12 + k * 4;
      if (Math.abs(x - f[r]!) > f[r + 2]! || Math.abs(z - f[r + 1]!) > f[r + 2]!) continue;
      const t = f[r + 3]!;
      const wrap = (v: number): number => ((Math.floor(v / t) % 512) + 512) % 512;
      return [((RESOLVE_RING << 30) | (u[at + 11]! << 3) | k) >>> 0, (wrap(x) | (wrap(z) << 16)) >>> 0];
    }
    return NONE;
  }
  if (kind === TRACE_ARCH) {
    let o: number;
    let piece: number;
    let p: number[];
    if (obj < u[6]!) {
      o = u[u[7]! + obj]!;
      const m = u[8]! + obj * 12;
      const axis = face >> 1;
      const [pu, pv] = FACE_PLANE_AXES[axis]!;
      const q = [0, 0, 0];
      q[axis] = face & 1 ? -1 : 1;
      q[pu] = fu * 2 - 1;
      q[pv] = fv * 2 - 1;
      p = [0, 1, 2].map((r) => f[m + r * 4]! * q[0]! + f[m + r * 4 + 1]! * q[1]! + f[m + r * 4 + 2]! * q[2]! + f[m + r * 4 + 3]!);
      piece = (obj - u[u[5]! + o * ARCH_R_WORDS]!) * 6 + face;
    } else {
      const tri = obj - u[6]!;
      if (tri >= u[9]!) return NONE;
      o = u[u[10]! + tri]!;
      const c = u[11]! + tri * 9;
      p = [0, 1, 2].map((k) => f[c + k]! + (f[c + 3 + k]! - f[c + k]!) * fu + (f[c + 6 + k]! - f[c + k]!) * fv);
      const rec = u[5]! + o * ARCH_R_WORDS;
      piece = u[rec + 1]! * 6 + (tri - u[rec + 2]!);
    }
    const rec = u[5]! + o * ARCH_R_WORDS;
    const charts = u[rec + 6]!;
    if (charts === 0) return NONE;
    const ci = i32(u[u[rec + 4]! + piece]!);
    if (ci < 0) return NONE;
    const c = u[rec + 5]! + ci * COMP_WORDS;
    const d = [p[0]! - f[c]!, p[1]! - f[c + 1]!, p[2]! - f[c + 2]!];
    const uu = d[0]! * f[c + 3]! + d[1]! * f[c + 4]! + d[2]! * f[c + 5]! - f[c + 9]!;
    const vv = d[0]! * f[c + 6]! + d[1]! * f[c + 7]! + d[2]! * f[c + 8]! - f[c + 10]!;
    const nu = u[c + 11]!;
    const nv = u[c + 12]!;
    const ii = Math.min(nu - 1, Math.max(0, Math.floor(uu / SURFACE_CHART_METRES)));
    const jj = Math.min(nv - 1, Math.max(0, Math.floor(vv / SURFACE_CHART_METRES)));
    return chartTexel(u, f, charts + (u[c + 13]! + jj * nu + ii) * CHART_WORDS, Math.max(0, uu - ii * SURFACE_CHART_METRES), Math.max(0, vv - jj * SURFACE_CHART_METRES), -1);
  }
  if (kind === TRACE_BRICKS) {
    if (obj >= u[12]!) return NONE;
    const at = u[13]! + obj * MODEL_R_WORDS;
    const chart = u[at]!;
    if (chart === 0) return NONE;
    const q = [a0 & 2047, (a0 >>> 11) & 2047, (a0 >>> 22) & 1023];
    const bits = [2048, 2048, 1024];
    const p = [0, 1, 2].map((k) => f[at + 1 + k]! + ((q[k]! + 0.5) / bits[k]!) * f[at + 4 + k]!);
    const n = [hf[h + 1]!, hf[h + 2]!, hf[h + 3]!];
    const ln = [0, 1, 2].map((r) => f[at + 7 + r * 3]! * n[0]! + f[at + 7 + r * 3 + 1]! * n[1]! + f[at + 7 + r * 3 + 2]! * n[2]!);
    const len = Math.hypot(ln[0]!, ln[1]!, ln[2]!) || 1;
    const facing = surfelFacing([ln[0]! / len, ln[1]! / len, ln[2]! / len]);
    const cell = f[at + 16]!;
    const hash = u[at + 17]!;
    const cap = u[at + 18]!;
    const pos = u[at + 19]!;
    let best = -1;
    let bestD = Infinity;
    for (let dz = -1; dz <= 1; dz += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      const c = [Math.floor((p[0]! + dx * cell) / cell), Math.floor((p[1]! + dy * cell) / cell), Math.floor((p[2]! + dz * cell) / cell)];
      for (let s = surfelHash(c[0]!, c[1]!, c[2]!, facing, cap); ; s = (s + 1) & (cap - 1)) {
        const sa = hash + s * HASH_WORDS;
        const tag = u[sa + 3]!;
        if (tag === EMPTY_SLOT) break;
        if ((tag & 7) !== facing || u[sa]! !== c[0]! >>> 0 || u[sa + 1]! !== c[1]! >>> 0 || u[sa + 2]! !== c[2]! >>> 0) continue;
        const idx = tag >>> 3;
        const dd = (f[pos + idx * 3]! - p[0]!) ** 2 + (f[pos + idx * 3 + 1]! - p[1]!) ** 2 + (f[pos + idx * 3 + 2]! - p[2]!) ** 2;
        if (dd < bestD) {
          bestD = dd;
          best = idx;
        }
        break;
      }
    }
    if (best < 0) return NONE;
    const uv = u[at + 20]!;
    if (uv === 0) return chartTexel(u, f, chart, 0, 0, best);
    return chartTexel(u, f, chart, f[uv + best * 2]! * f[chart + 3]!, f[uv + best * 2 + 1]! * f[chart + 4]!, -1);
  }
  return NONE;
}
