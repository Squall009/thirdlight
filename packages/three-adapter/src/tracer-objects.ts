/**
 * The tracer's object sections: generated architecture (boxes with their
 * real thickness and flat triangles, from the same generator that makes
 * their colliders) and imported static models (distance-field brick sets
 * placed by instances). Each section is a uniform grid over its items'
 * world boxes, walked cell by cell; a cell lists the items that overlap it.
 *
 * Layouts (word offsets):
 *
 * - grid record (`GRID_WORDS`): 0–2 origin, 3 cell size (m), 4–6 cells per
 *   axis, 7 the cells' list starts (cells + 1 words), 8 the lists, 9 the
 *   items, 10 the item count, 11 the item stride;
 * - an architecture item (`ARCH_ITEM_WORDS`): 0 its shape (`ARCH_BOX`: then
 *   1–12 world → unit-box map; `ARCH_TRIANGLE`: 1–9 its corners), 13 its
 *   light layers;
 * - a model instance (`INSTANCE_WORDS`): 0–11 world → model root map, 12
 *   its brick set's record, 13–18 its world box (min xyz, max xyz): a ray
 *   that misses the box skips the map and the set's words; 19 its light
 *   layers (a shadow ray of a light whose caster mask shares none passes it);
 * - a brick set's record (`SET_WORDS`): 0–2 the field's first sample, 3
 *   voxel, 4 band, 5–7 bricks per axis, 8 the brick table (an i32 per
 *   brick: sample block, or OUTSIDE / INSIDE), 9 the set's first sample
 *   block in the brick atlas, 10 the set's index.
 *
 * The sample blocks (9³ bytes each) live in a brick atlas, a 3D texture of
 * blocks side by side (`brickAtlasOrigin`): the GPU reads a distance with
 * one filtered texture sample instead of eight word loads.
 */
import { DISTANCE_BRICK_CELLS, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, LIGHT_LAYERS_ALL, type DistanceBrickSet } from '@thirdlight/project-model';

import { Words, invertAffine, putAffine, worldToLocalOf, type Affine } from './tracer-words';

export const GRID_WORDS = 12;
export const ARCH_ITEM_WORDS = 14;
export const ARCH_BOX = 0;
export const ARCH_TRIANGLE = 1;
export const INSTANCE_WORDS = 20;
export const SET_WORDS = 12;
/** Sample blocks along each side of the brick atlas at most (a 3D texture's default size limit is 2048 texels). */
const ATLAS_AXIS_BLOCKS = Math.floor(2048 / DISTANCE_BRICK_SIDE);

/** Every placed set's sample blocks, side by side in a 3D texture (r8unorm; `size` texels per axis). */
export interface BrickAtlas {
  readonly data: Uint8Array;
  readonly size: readonly [number, number, number];
  /** Blocks along x and y (z grows as needed). */
  readonly blocksPerAxis: number;
}

/** The atlas texel at which sample block `g` starts. */
export function brickAtlasOrigin(g: number, blocksPerAxis: number): [number, number, number] {
  const S = DISTANCE_BRICK_SIDE;
  return [(g % blocksPerAxis) * S, (Math.floor(g / blocksPerAxis) % blocksPerAxis) * S, Math.floor(g / (blocksPerAxis * blocksPerAxis)) * S];
}
/** Grid cells per item at most, on average (a cell lists a few items). */
const CELLS_PER_ITEM = 2;
/** Cells per grid axis at most. */
const GRID_AXIS_MAX = 256;

type V3 = [number, number, number];

/** A box of generated architecture: its centre, half extents and rotation (quaternion xyzw), in world space. */
export interface TraceBox {
  center: readonly number[];
  half: readonly number[];
  rotation: readonly number[];
}

/** Generated architecture as the tracer takes it. */
export interface TraceArchitecture {
  boxes: readonly TraceBox[];
  /** Flat pieces (floors, roofs) as world triangles, nine floats each. */
  triangles: Float32Array;
  /** Each item's light layers, boxes then triangles (absent: every layer). */
  layers?: readonly number[];
}

/** One placed brick set: the model's world → root map and the set (sets shared by instances are stored once). */
export interface TraceModelInstance {
  worldToLocal: Affine;
  set: DistanceBrickSet;
  /** Its object's light layers (absent: every layer). */
  layers?: number;
}

/** A uniform grid over world boxes (six floats each: min xyz, max xyz) and the items' words after it. */
function packGrid(w: Words, slot: number, boxes: readonly number[][], itemWords: number, writeItem: (at: number, i: number) => void): void {
  const n = boxes.length;
  w.setU(slot, n);
  if (n === 0) {
    w.setU(slot + 1, 0);
    return;
  }
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (let k = 0; k < 3; k += 1) {
      lo[k] = Math.min(lo[k]!, b[k]!);
      hi[k] = Math.max(hi[k]!, b[k + 3]!);
    }
  }
  const ext: V3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const largest = Math.max(ext[0], ext[1], ext[2], 1e-3);
  const volume = Math.max(ext[0], 1e-3) * Math.max(ext[1], 1e-3) * Math.max(ext[2], 1e-3);
  const cs = Math.max(Math.cbrt(volume / (n * CELLS_PER_ITEM)), largest / GRID_AXIS_MAX);
  const dims = ext.map((e) => Math.max(1, Math.ceil(e / cs))) as V3;
  const cells = dims[0] * dims[1] * dims[2];
  const at = w.alloc(GRID_WORDS);
  w.setU(slot + 1, at);
  for (let k = 0; k < 3; k += 1) {
    w.setF(at + k, lo[k]!);
    w.setU(at + 4 + k, dims[k]!);
  }
  w.setF(at + 3, cs);
  const range = (b: number[]): [number, number][] => [0, 1, 2].map((k) => [Math.max(0, Math.floor((b[k]! - lo[k]!) / cs)), Math.min(dims[k]! - 1, Math.floor((b[k + 3]! - lo[k]!) / cs))]);
  const counts = new Uint32Array(cells + 1);
  for (const b of boxes) {
    const r = range(b);
    for (let z = r[2]![0]; z <= r[2]![1]; z += 1) for (let y = r[1]![0]; y <= r[1]![1]; y += 1) for (let x = r[0]![0]; x <= r[0]![1]; x += 1) counts[(z * dims[1] + y) * dims[0] + x + 1]! += 1;
  }
  for (let c = 0; c < cells; c += 1) counts[c + 1]! += counts[c]!;
  const starts = w.alloc(cells + 1);
  for (let c = 0; c <= cells; c += 1) w.setU(starts + c, counts[c]!);
  const list = w.alloc(counts[cells]!);
  const fill = counts.slice(0, cells);
  boxes.forEach((b, i) => {
    const r = range(b);
    for (let z = r[2]![0]; z <= r[2]![1]; z += 1) for (let y = r[1]![0]; y <= r[1]![1]; y += 1) for (let x = r[0]![0]; x <= r[0]![1]; x += 1) {
      const c = (z * dims[1] + y) * dims[0] + x;
      w.setU(list + fill[c]!, i);
      fill[c]! += 1;
    }
  });
  w.setU(at + 7, starts);
  w.setU(at + 8, list);
  const items = w.alloc(n * itemWords);
  w.setU(at + 9, items);
  w.setU(at + 10, n);
  w.setU(at + 11, itemWords);
  for (let i = 0; i < n; i += 1) writeItem(items + i * itemWords, i);
}

/** The world box of a local box [lo, hi] through a local → world map. */
function worldBox(toWorld: readonly number[], lo: readonly number[], hi: readonly number[]): number[] {
  const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c += 1) {
    const p = [c & 1 ? hi[0]! : lo[0]!, c & 2 ? hi[1]! : lo[1]!, c & 4 ? hi[2]! : lo[2]!];
    for (let r = 0; r < 3; r += 1) {
      const v = toWorld[r * 4]! * p[0]! + toWorld[r * 4 + 1]! * p[1]! + toWorld[r * 4 + 2]! * p[2]! + toWorld[r * 4 + 3]!;
      out[r] = Math.min(out[r]!, v);
      out[r + 3] = Math.max(out[r + 3]!, v);
    }
  }
  return out;
}

/** The architecture section (the header slot gets the item count and the grid record). */
export function packArchitecture(w: Words, slot: number, arch: TraceArchitecture | undefined): void {
  const boxes = arch?.boxes ?? [];
  const tris = arch?.triangles ?? new Float32Array(0);
  const nt = Math.floor(tris.length / 9);
  const maps = boxes.map((b) => worldToLocalOf(b.center, b.rotation, b.half));
  const bounds = [
    ...maps.map((m) => worldBox(invertAffine(m), [-1, -1, -1], [1, 1, 1])),
    ...Array.from({ length: nt }, (_, i) => {
      const t = tris.subarray(i * 9, i * 9 + 9);
      return [Math.min(t[0]!, t[3]!, t[6]!), Math.min(t[1]!, t[4]!, t[7]!), Math.min(t[2]!, t[5]!, t[8]!), Math.max(t[0]!, t[3]!, t[6]!), Math.max(t[1]!, t[4]!, t[7]!), Math.max(t[2]!, t[5]!, t[8]!)];
    }),
  ];
  packGrid(w, slot, bounds, ARCH_ITEM_WORDS, (at, i) => {
    w.setU(at + 13, arch?.layers?.[i] ?? LIGHT_LAYERS_ALL);
    if (i < maps.length) {
      w.setU(at, ARCH_BOX);
      putAffine(w, at + 1, maps[i]!);
    } else {
      w.setU(at, ARCH_TRIANGLE);
      const t = tris.subarray((i - maps.length) * 9, (i - maps.length) * 9 + 9);
      for (let k = 0; k < 9; k += 1) w.setF(at + 1 + k, t[k]!);
    }
  });
}

/** The models section: each distinct brick set once, then the instances in their grid; the sets' samples go to the atlas. */
export function packModelInstances(w: Words, slot: number, instances: readonly TraceModelInstance[]): BrickAtlas {
  const setAt = new Map<DistanceBrickSet, number>();
  const sets: DistanceBrickSet[] = [];
  let blocks = 0;
  for (const inst of instances) {
    const s = inst.set;
    if (setAt.has(s)) continue;
    const at = w.alloc(SET_WORDS);
    setAt.set(s, at);
    sets.push(s);
    for (let k = 0; k < 3; k += 1) {
      w.setF(at + k, s.min[k]!);
      w.setU(at + 5 + k, s.dims[k]!);
    }
    w.setF(at + 3, s.voxel);
    w.setF(at + 4, s.band);
    w.setU(at + 10, setAt.size - 1);
    const table = w.alloc(s.bricks.length);
    for (let i = 0; i < s.bricks.length; i += 1) w.setU(table + i, s.bricks[i]! >>> 0);
    w.setU(at + 8, table);
    w.setU(at + 9, blocks);
    blocks += s.samples.length / DISTANCE_BRICK_SAMPLES;
  }
  const atlas = packBrickAtlas(sets, blocks);
  const bounds = instances.map((inst) => {
    const s = inst.set;
    const size = s.voxel * DISTANCE_BRICK_CELLS;
    return worldBox(invertAffine(inst.worldToLocal), s.min, [s.min[0]! + s.dims[0]! * size, s.min[1]! + s.dims[1]! * size, s.min[2]! + s.dims[2]! * size]);
  });
  packGrid(w, slot, bounds, INSTANCE_WORDS, (at, i) => {
    putAffine(w, at, instances[i]!.worldToLocal);
    w.setU(at + 12, setAt.get(instances[i]!.set)!);
    for (let k = 0; k < 6; k += 1) w.setF(at + 13 + k, bounds[i]![k]!);
    w.setU(at + 19, instances[i]!.layers ?? LIGHT_LAYERS_ALL);
  });
  return atlas;
}

/** The sets' sample blocks in atlas order (a set's blocks follow each other). */
function packBrickAtlas(sets: readonly DistanceBrickSet[], blocks: number): BrickAtlas {
  const S = DISTANCE_BRICK_SIDE;
  const A = Math.max(1, Math.min(ATLAS_AXIS_BLOCKS, Math.ceil(Math.sqrt(blocks))));
  const size: [number, number, number] = [Math.min(blocks, A) * S || 1, Math.min(Math.ceil(blocks / A), A) * S || 1, Math.ceil(blocks / (A * A)) * S || 1];
  const data = new Uint8Array(size[0] * size[1] * size[2]);
  let g = 0;
  for (const s of sets) {
    for (let b = 0; b < s.samples.length / DISTANCE_BRICK_SAMPLES; b += 1, g += 1) {
      const [x0, y0, z0] = brickAtlasOrigin(g, A);
      for (let z = 0; z < S; z += 1) for (let y = 0; y < S; y += 1) data.set(s.samples.subarray(b * DISTANCE_BRICK_SAMPLES + (z * S + y) * S, b * DISTANCE_BRICK_SAMPLES + (z * S + y) * S + S), ((z0 + z) * size[1] + y0 + y) * size[0] + x0);
    }
  }
  return { data, size, blocksPerAxis: A };
}
