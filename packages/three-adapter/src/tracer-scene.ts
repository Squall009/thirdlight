/**
 * The tracer's scene: the static geometry every lighting ray is traced
 * against, packed into one word buffer the GPU pass (`tracer-gpu.ts`) and the
 * CPU twin (`tracer-cpu.ts`) read alike. One buffer keeps the pass at three
 * storage bindings (scene, rays, hits), well inside the default device limit
 * of eight, so the renderer needs to ask the adapter for nothing.
 *
 * Each geometry kind keeps its own exact form instead of one voxelization:
 *
 * - block layers: occupancy bits in 16³ chunks plus a chunk table (an empty
 *   chunk is one zero word, stepped whole by the trace), a mask of the
 *   chunk's occupied 4³ sub-blocks (empty ones are stepped whole too), and
 *   the box of the layer's occupied cells (a ray is walked only inside it,
 *   so a sun ray leaving the built area stops at once);
 * - terrain: the height samples and a min/max pyramid over their cells;
 * - architecture: oriented boxes in a uniform grid;
 * - imported static models: distance-field bricks per asset, placed by
 *   instances in a uniform grid.
 *
 * Every placement is a world → local affine map (3 × 4, row-major). The map
 * may scale (a block layer's cell size, the terrain's sample spacing), and
 * a ray's distance survives an affine map, so the trace runs in local space
 * and reports world distances; normals go back through the map's transpose.
 *
 * Pure data (no three.js, no device).
 */
import { CHUNK_SIZE } from '@thirdlight/runtime';

import { packArchitecture, packModelInstances, type TraceArchitecture, type TraceModelInstance } from './tracer-objects';
import { Words, putAffine, type Affine } from './tracer-words';

export { IDENTITY_AFFINE, invertAffine, worldToLocalOf, type Affine } from './tracer-words';

/** What a hit's `kind` word says (low byte; the face is the next byte). */
export const TRACE_MISS = 0;
export const TRACE_BLOCKS = 1;
export const TRACE_TERRAIN = 2;
export const TRACE_ARCH = 3;
export const TRACE_BRICKS = 4;
/** The step budget ran out before the ray was resolved: re-trace it from the hit's `t` (`tmin`). */
export const TRACE_UNFINISHED = 255;

/** Floats per ray: origin xyz, tmin, direction xyz (unit), tmax. */
export const RAY_FLOATS = 8;
/**
 * Words per hit: t (f32), normal xyz (f32), kind | face << 8 (u32), the
 * object (u32: the layer, terrain, box or instance it hit, in packing order),
 * and two address words whose meaning is the kind's (`HitAddress`).
 */
export const HIT_WORDS = 8;

/**
 * Fixed step counts per pass: neighbouring GPU threads stay on similar paths
 * (Intel GPUs lose most of their speed to divergent loops), and a ray that
 * needs more steps comes back `TRACE_UNFINISHED` instead of stalling its
 * wave. Each kind counts its own steps.
 */
export const TRACE_STEPS = {
  /** Chunk and cell steps through one block layer. */
  blocks: 384,
  /** Node visits in the terrain's pyramid. */
  terrain: 256,
  /** Grid cells crossed among the architecture boxes, and among model instances. */
  grid: 128,
  /** Brick and sphere-tracing steps over every model a ray meets in one pass (shared, so a ray through a crowd of models stays bounded). */
  bricks: 256,
} as const;

/** Cells per block-chunk side: the block layer's own chunk size (columns of 16 × 16, cut into 16 cells of height here). */
export const TRACE_CHUNK = CHUNK_SIZE;
const CHUNK_CELLS = TRACE_CHUNK * TRACE_CHUNK * TRACE_CHUNK;
/** Occupancy words per occupied chunk's cells. */
export const CHUNK_WORDS = CHUNK_CELLS / 32;
/** Cells per sub-block side within a chunk: a chunk holds (16 / 4)³ = 64 sub-blocks, one mask bit each. */
export const TRACE_SUB = 4;
const SUBS = TRACE_CHUNK / TRACE_SUB;
/** Words per occupied chunk: its cells' bits, then the two words of its sub-block mask. */
export const CHUNK_BLOCK_WORDS = CHUNK_WORDS + (SUBS * SUBS * SUBS) / 32;
/**
 * How far (m) a bounce or probe ray is traced: about the probe spacing, past
 * which the probes give the far field, so a ray never marches across an open
 * scene for light it would read from a probe anyway.
 */
export const BOUNCE_RAY_SPACINGS = 2;
export function bounceRayMetres(probeSpacing: number): number {
  return probeSpacing * BOUNCE_RAY_SPACINGS;
}

/** Words of the scene header: per kind its count and its section's offset. */
export const SCENE_HEADER_WORDS = 16;
/** Header slots (word index of the count; the offset is the next word). */
export const HEADER = { blocks: 0, terrain: 2, arch: 4, bricks: 6 } as const;

/** Words of a block layer's record. */
export const LAYER_WORDS = 26;
/** Words of a terrain's record. */
export const TERRAIN_WORDS = 20;

/** A block layer as the tracer takes it: its cells' bounds, which cells stop light, and where it sits. */
export interface TraceBlockLayer {
  /** World → layer-local metres (the layer object's inverse world matrix). */
  worldToLocal: Affine;
  cellSize: readonly number[];
  /** Cell bounds, max exclusive. */
  min: readonly number[];
  max: readonly number[];
  /** Calls `cell` for every opaque cell (any order). */
  forEachOpaque(cell: (x: number, y: number, z: number) => void): void;
}

/** A terrain as the tracer takes it: its samples on one rectangle of the height grid. */
export interface TraceTerrain {
  /** World → terrain-local metres (the terrain's origin is local 0). */
  worldToLocal: Affine;
  spacing: number;
  /** Cells along x and z (samples are one more). */
  cellsX: number;
  cellsZ: number;
  /** The rectangle's first cell in the terrain's grid (tiles before it are absent). */
  cellX0: number;
  cellZ0: number;
  /** Local height in metres per sample, row by row (z), (cellsX + 1) × (cellsZ + 1). */
  heights: Float32Array;
  /** Whether a cell is open (a hole or no tile): rays pass it. Absent: none is. */
  hole?: (x: number, z: number) => boolean;
}

/** Everything one tracer pass sees. */
export interface TraceSceneSource {
  blocks?: readonly TraceBlockLayer[];
  terrain?: readonly TraceTerrain[];
  /** Every generated architecture object's pieces, in world space. */
  arch?: TraceArchitecture;
  /** Imported static models: one entry per placed brick set. */
  bricks?: readonly TraceModelInstance[];
}

/** The packed scene and what it takes. */
export interface PackedTraceScene {
  words: Uint32Array;
  /** Bytes per kind (memory budgets count these). */
  bytes: { blocks: number; terrain: number; arch: number; bricks: number };
}

/**
 * A block layer's record (`LAYER_WORDS`): 0–11 world → grid (cells from the
 * layer's min corner), 12–14 cells per axis, 15–17 chunks per axis, 18 the
 * chunk table's offset, 19 the occupancy's offset, 20–22 the occupied
 * cells' min corner and 23–25 their max corner (exclusive; all 0 when none).
 * The chunk table holds one word per chunk (0: empty, else 1 + its
 * occupancy block); a block (`CHUNK_BLOCK_WORDS`) holds `CHUNK_WORDS` bits,
 * cell (x, y, z) in the chunk at bit (y × 16 + z) × 16 + x, then the
 * sub-block mask, sub-block (x, y, z) at bit (y × 4 + z) × 4 + x.
 */
function packBlockLayer(w: Words, at: number, layer: TraceBlockLayer): void {
  const dims = [0, 1, 2].map((k) => Math.max(0, (layer.max[k] ?? 0) - (layer.min[k] ?? 0)));
  const chunks = dims.map((d) => Math.ceil(d / TRACE_CHUNK));
  // Grid = (local / cellSize) − min.
  const m = layer.worldToLocal;
  const grid: number[] = [];
  for (let r = 0; r < 3; r += 1) {
    const s = 1 / (layer.cellSize[r] ?? 1);
    grid.push(m[r * 4]! * s, m[r * 4 + 1]! * s, m[r * 4 + 2]! * s, m[r * 4 + 3]! * s - (layer.min[r] ?? 0));
  }
  putAffine(w, at, grid);
  for (let k = 0; k < 3; k += 1) {
    w.setU(at + 12 + k, dims[k]!);
    w.setU(at + 15 + k, chunks[k]!);
  }
  const table = w.alloc(chunks[0]! * chunks[1]! * chunks[2]!);
  w.setU(at + 18, table);
  // Occupied chunks first (their blocks are allocated in first-seen order), then their bits.
  const cells: number[] = [];
  layer.forEachOpaque((x, y, z) => {
    const gx = x - layer.min[0]!;
    const gy = y - layer.min[1]!;
    const gz = z - layer.min[2]!;
    if (gx < 0 || gy < 0 || gz < 0 || gx >= dims[0]! || gy >= dims[1]! || gz >= dims[2]!) return;
    cells.push(gx, gy, gz);
  });
  const blockOf = new Map<number, number>();
  const lo = [Infinity, Infinity, Infinity];
  const hi = [0, 0, 0];
  for (let i = 0; i < cells.length; i += 3) {
    const c = ((Math.floor(cells[i + 1]! / TRACE_CHUNK) * chunks[2]! + Math.floor(cells[i + 2]! / TRACE_CHUNK)) * chunks[0]!) + Math.floor(cells[i]! / TRACE_CHUNK);
    if (!blockOf.has(c)) blockOf.set(c, blockOf.size);
    for (let k = 0; k < 3; k += 1) {
      lo[k] = Math.min(lo[k]!, cells[i + k]!);
      hi[k] = Math.max(hi[k]!, cells[i + k]! + 1);
    }
  }
  for (let k = 0; k < 3; k += 1) {
    w.setU(at + 20 + k, cells.length > 0 ? lo[k]! : 0);
    w.setU(at + 23 + k, cells.length > 0 ? hi[k]! : 0);
  }
  const bits = w.alloc(blockOf.size * CHUNK_BLOCK_WORDS);
  w.setU(at + 19, bits);
  for (const [c, b] of blockOf) w.setU(table + c, b + 1);
  for (let i = 0; i < cells.length; i += 3) {
    const [x, y, z] = [cells[i]!, cells[i + 1]!, cells[i + 2]!];
    const c = ((Math.floor(y / TRACE_CHUNK) * chunks[2]! + Math.floor(z / TRACE_CHUNK)) * chunks[0]!) + Math.floor(x / TRACE_CHUNK);
    const lx = x % TRACE_CHUNK;
    const ly = y % TRACE_CHUNK;
    const lz = z % TRACE_CHUNK;
    const base = bits + blockOf.get(c)! * CHUNK_BLOCK_WORDS;
    const bit = (ly * TRACE_CHUNK + lz) * TRACE_CHUNK + lx;
    w.orU(base + (bit >> 5), 1 << (bit & 31));
    const sub = (Math.floor(ly / TRACE_SUB) * SUBS + Math.floor(lz / TRACE_SUB)) * SUBS + Math.floor(lx / TRACE_SUB);
    w.orU(base + CHUNK_WORDS + (sub >> 5), 1 << (sub & 31));
  }
}

/** The pyramid's levels for a cells grid: each level's size (cells along x, z), finest first, until one node is left. */
export function pyramidLevels(cellsX: number, cellsZ: number): [number, number][] {
  const out: [number, number][] = [[cellsX, cellsZ]];
  while (out[out.length - 1]![0] > 1 || out[out.length - 1]![1] > 1) {
    const [x, z] = out[out.length - 1]!;
    out.push([Math.ceil(x / 2), Math.ceil(z / 2)]);
  }
  return out;
}

/**
 * A terrain's record (`TERRAIN_WORDS`): 0–11 world → sample space (x and z
 * in samples from the rectangle's first, y in metres), 12 cells along x,
 * 13 along z, 14 levels, 15 the heights' offset, 16 the pyramid's offset,
 * 17 the rectangle's first cell x, 18 its first cell z. The pyramid starts
 * with a table of three words per level (its nodes' offset, nodes along x,
 * along z), then holds, level by level from the cells up, a (min, max) pair
 * per node; an open cell has min > max, so no ray meets it and its parents
 * ignore it.
 */
function packTerrain(w: Words, at: number, t: TraceTerrain): void {
  const m = t.worldToLocal;
  const s = 1 / t.spacing;
  putAffine(w, at, [m[0]! * s, m[1]! * s, m[2]! * s, m[3]! * s - t.cellX0, m[4]!, m[5]!, m[6]!, m[7]!, m[8]! * s, m[9]! * s, m[10]! * s, m[11]! * s - t.cellZ0]);
  const levels = pyramidLevels(t.cellsX, t.cellsZ);
  w.setU(at + 12, t.cellsX);
  w.setU(at + 13, t.cellsZ);
  w.setU(at + 14, levels.length);
  w.setU(at + 17, t.cellX0);
  w.setU(at + 18, t.cellZ0);
  const sx = t.cellsX + 1;
  const h = w.alloc(sx * (t.cellsZ + 1));
  w.setU(at + 15, h);
  for (let i = 0; i < sx * (t.cellsZ + 1); i += 1) w.setF(h + i, t.heights[i] ?? 0);
  let total = 0;
  for (const [x, z] of levels) total += x * z * 2;
  const p = w.alloc(levels.length * 3 + total);
  w.setU(at + 16, p);
  let prev = new Float32Array(0);
  let off = p + levels.length * 3;
  levels.forEach(([lx, lz], l) => {
    w.setU(p + l * 3, off);
    w.setU(p + l * 3 + 1, lx);
    w.setU(p + l * 3 + 2, lz);
    const cur = new Float32Array(lx * lz * 2);
    for (let z = 0; z < lz; z += 1) {
      for (let x = 0; x < lx; x += 1) {
        let lo = Infinity;
        let hi = -Infinity;
        if (l === 0) {
          if (t.hole?.(x, z) !== true) {
            const i = z * sx + x;
            for (const v of [t.heights[i]!, t.heights[i + 1]!, t.heights[i + sx]!, t.heights[i + sx + 1]!]) {
              lo = Math.min(lo, v);
              hi = Math.max(hi, v);
            }
          }
        } else {
          const [px, pz] = levels[l - 1]!;
          for (let dz = 0; dz < 2; dz += 1) {
            for (let dx = 0; dx < 2; dx += 1) {
              const cx = x * 2 + dx;
              const cz = z * 2 + dz;
              if (cx >= px || cz >= pz) continue;
              lo = Math.min(lo, prev[(cz * px + cx) * 2]!);
              hi = Math.max(hi, prev[(cz * px + cx) * 2 + 1]!);
            }
          }
        }
        // Open nodes keep min > max with finite values (WGSL has no infinity literal).
        cur[(z * lx + x) * 2] = Number.isFinite(lo) ? lo : 3e38;
        cur[(z * lx + x) * 2 + 1] = Number.isFinite(hi) ? hi : -3e38;
      }
    }
    for (let i = 0; i < cur.length; i += 1) w.setF(off + i, cur[i]!);
    off += cur.length;
    prev = cur;
  });
}

/** Pack a scene for the tracer (the CPU twin and the GPU pass read the same words). */
export function packTraceScene(src: TraceSceneSource): PackedTraceScene {
  const w = new Words();
  w.alloc(SCENE_HEADER_WORDS);
  const bytes = { blocks: 0, terrain: 0, arch: 0, bricks: 0 };
  // Each section: its fixed-stride records, then their data.
  const section = <T>(slot: number, kind: keyof typeof bytes, items: readonly T[] | undefined, recordWords: number, pack: (w: Words, at: number, item: T) => void): void => {
    const list = items ?? [];
    const start = w.length;
    const recs = w.alloc(list.length * recordWords);
    w.setU(slot, list.length);
    w.setU(slot + 1, recs);
    list.forEach((item, i) => pack(w, recs + i * recordWords, item));
    bytes[kind] = (w.length - start) * 4;
  };
  section(HEADER.blocks, 'blocks', src.blocks, LAYER_WORDS, packBlockLayer);
  section(HEADER.terrain, 'terrain', src.terrain, TERRAIN_WORDS, packTerrain);
  let start = w.length;
  packArchitecture(w, HEADER.arch, src.arch);
  bytes.arch = (w.length - start) * 4;
  start = w.length;
  packModelInstances(w, HEADER.bricks, src.bricks ?? []);
  bytes.bricks = (w.length - start) * 4;
  return { words: w.done(), bytes };
}
