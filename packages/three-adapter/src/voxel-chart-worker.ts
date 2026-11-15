/**
 * The surface cache's charts of a voxel chunk made off the page's main
 * thread: one chunk a job, from the mesh its draw batch brought (copied: the
 * page draws it) and the occupancy of the cells round it (the walk's level-0
 * blocks of the chunk and its neighbours, as the page holds them), so a
 * surface with a body in front of it is hidden as on the page. The charts
 * come back handed over; nothing is kept in the worker or stored.
 *
 * It runs in the view's worker script beside the block mesher and the
 * others, on a worker of its own; the page charts in steps itself when no
 * worker can (the same charts either way: `voxelChunkCharts`).
 *
 * This module imports no three.js: the worker bundle stays small.
 */
import { OCCUPANCY, WALK_BLOCK_SHIFT, WALK_BRICK_WORDS, WALK_CELL_WORDS, WALK_PAGE_WORDS, type WalkTable } from '@thirdlight/voxel';

import { voxelChunkCharts, type VoxelChunkCharts } from './surface-cache-voxels';

/** The level-0 walk blocks round a chunk, as the job carries them: a box of blocks from `origin`, `side` a side, each unknown (0) or its solid stop's occupancy + 1 (empty 1, solid 2, mixed 3, with its 32³ cell bits). */
export interface VoxelSolidBlocks {
  readonly origin: readonly [number, number, number];
  readonly side: number;
  readonly flags: Uint8Array;
  /** `WALK_CELL_WORDS` a block (a mixed block's bits; others' left zero). */
  readonly cells: Uint32Array;
}

/** The blocks round a chunk of `edge` cells at `cell0` from a walk table's level 0 (every block a cell past the chunk's box reaches: a surface's front cell lies within one). */
export function solidBlocksOf(table: WalkTable, cell0: readonly number[], edge: number): VoxelSolidBlocks {
  const lo = cell0.map((c) => (c - 2) >> WALK_BLOCK_SHIFT) as [number, number, number];
  const hi = cell0.map((c) => (c + edge + 1) >> WALK_BLOCK_SHIFT);
  const side = Math.max(hi[0]! - lo[0] + 1, hi[1]! - lo[1] + 1, hi[2]! - lo[2] + 1);
  const n = side * side * side;
  const flags = new Uint8Array(n);
  const cells = new Uint32Array(n * WALK_CELL_WORDS);
  const solidCells = 2 * WALK_BRICK_WORDS;
  for (let k = 0; k < side; k++) for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) {
    const at = (k * side + j) * side + i;
    const v = table.value(0, lo[0] + i, lo[1] + j, lo[2] + k);
    if (v < 0) continue;
    const flag = v & 3;
    flags[at] = flag + 1;
    if (flag === OCCUPANCY.mixed) {
      const base = (v >>> 4) * WALK_PAGE_WORDS + solidCells;
      cells.set(table.pages.subarray(base, base + WALK_CELL_WORDS), at * WALK_CELL_WORDS);
    }
  }
  return { origin: lo, side, flags, cells };
}

/** Whether a level-0 cell is drawn as a body, over blocks a job carries (null: no block known there): `walkSolidAt`'s answers. */
export function solidAtBlocks(b: VoxelSolidBlocks): (x: number, y: number, z: number) => boolean | null {
  const e = 1 << WALK_BLOCK_SHIFT;
  return (x, y, z) => {
    const i = (x >> WALK_BLOCK_SHIFT) - b.origin[0];
    const j = (y >> WALK_BLOCK_SHIFT) - b.origin[1];
    const k = (z >> WALK_BLOCK_SHIFT) - b.origin[2];
    if (i < 0 || j < 0 || k < 0 || i >= b.side || j >= b.side || k >= b.side) return null;
    const at = (k * b.side + j) * b.side + i;
    const f = b.flags[at]!;
    if (f === 0) return null;
    if (f !== 3) return f === 2;
    const c = (((x & (e - 1)) * e + (z & (e - 1))) * e + (y & (e - 1)));
    return ((b.cells[at * WALK_CELL_WORDS + (c >>> 5)]! >>> (c & 31)) & 1) === 1;
  };
}

/** Page → worker: chart one chunk. */
export interface VoxelChartRequest {
  readonly t: 'voxelCharts';
  readonly job: number;
  readonly positions: Float32Array;
  readonly indices: Uint32Array | Uint16Array;
  readonly cell0: readonly [number, number, number];
  readonly edge: number;
  readonly solid: VoxelSolidBlocks | null;
}

/** Worker → page. */
export type VoxelChartReply =
  | { readonly t: 'voxelCharted'; readonly job: number; readonly ok: true; readonly made: VoxelChunkCharts; readonly ms: number }
  | { readonly t: 'voxelCharted'; readonly job: number; readonly ok: false; readonly message: string };

/** The endpoint a worker talks through (its global scope, or a port in tests). */
export interface VoxelChartEndpoint {
  post(message: unknown, transfer?: readonly ArrayBuffer[]): void;
  listen(onMessage: (message: unknown) => void): void;
}

/** Answer one request (what the worker runs). */
export function answerVoxelChartJob(req: VoxelChartRequest): VoxelChartReply {
  const t0 = performance.now();
  try {
    const made = voxelChunkCharts(req.positions, req.indices, req.cell0, req.edge, req.solid === null ? undefined : solidAtBlocks(req.solid));
    return { t: 'voxelCharted', job: req.job, ok: true, made, ms: performance.now() - t0 };
  } catch (e) {
    return { t: 'voxelCharted', job: req.job, ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** A chunk's charts' arrays (handed over with the reply). */
export function voxelChartBuffers(m: VoxelChunkCharts): ArrayBuffer[] {
  return [m.frames, m.samples, m.keys, m.chartOf, m.offsets].map((a) => a.buffer as ArrayBuffer);
}

/** Run the charting on an endpoint (beside the view worker's other parts on the same one: each ignores the others' messages). */
export function runVoxelChartWorker(endpoint: VoxelChartEndpoint): void {
  endpoint.listen((raw) => {
    const m = raw as Partial<VoxelChartRequest> | null;
    if (m?.t !== 'voxelCharts') return;
    const reply = answerVoxelChartJob(m as VoxelChartRequest);
    endpoint.post(reply, reply.ok ? voxelChartBuffers(reply.made) : undefined);
  });
}
