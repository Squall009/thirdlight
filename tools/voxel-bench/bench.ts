/**
 * The access and edit benchmarks: a window of a test world (a square
 * footprint at its centre, every height) is loaded into a store candidate,
 * then timed: `voxelAt` at random cells and in a coherent column scan,
 * single-cell edits, brush strokes (balls of 1, 2 and 4 m radius) and box
 * fills (2 m and 8 m cubes) at surface points, and the round trip of chunk
 * buffers through a real worker, copied and transferred.
 */
import { mulberry32 } from '@thirdlight/shared';
import {
  createDenseChunk,
  storeChunkCoords,
  voxel,
  VOXEL_CATEGORY,
  type ChunkGrid,
  type VoxelStoreFactory,
  type VoxelStroke,
} from '@thirdlight/voxel';
import { ZSTD } from './codecs';
import { measureTransfer, type TransferResult } from './transfer';
import { chunkRange, MAT, type TestWorld } from './world-kit';

export interface BenchOptions {
  randomReads: number;
  coherentColumns: number;
  edits: number;
  strokes: number;
  transferChunks: number;
  seed: number;
}

export const DEFAULT_BENCH: BenchOptions = { randomReads: 2_000_000, coherentColumns: 4096, edits: 200_000, strokes: 300, transferChunks: 64, seed: 1 };

export interface StrokeResult {
  name: string;
  usPerOp: number;
  cellsPerOp: number;
}

export interface BenchResult {
  windowCells: [number, number];
  chunks: number;
  memoryBytes: number;
  loadMs: number;
  randomReadNs: number;
  coherentReadNs: number;
  coherentReads: number;
  editUs: number;
  strokes: StrokeResult[];
  transfer: { raw: TransferResult; zstd: TransferResult } | null;
}

/** Best of three timings of `run` (ms). */
function best(run: () => void): number {
  let t = Infinity;
  for (let r = 0; r < 3; r++) {
    const t0 = performance.now();
    run();
    t = Math.min(t, performance.now() - t0);
  }
  return t;
}

/** Loads the window and runs every benchmark on it. */
export async function benchWorld(world: TestWorld, factory: VoxelStoreFactory, grid: ChunkGrid, opts: BenchOptions = DEFAULT_BENCH): Promise<BenchResult> {
  const g = world.grids[0]!;
  const half = world.benchFootprint >> 1;
  const cxm = (g.bounds.min[0] + g.bounds.max[0]) >> 1;
  const czm = (g.bounds.min[2] + g.bounds.max[2]) >> 1;
  const x0 = Math.max(g.bounds.min[0], cxm - half);
  const x1 = Math.min(g.bounds.max[0], cxm + half);
  const z0 = Math.max(g.bounds.min[2], czm - half);
  const z1 = Math.min(g.bounds.max[2], czm + half);
  const store = factory(grid);
  const gen = createDenseChunk(grid);
  const [cy0, cy1] = chunkRange(grid, g.bounds.min[1], g.bounds.max[1]);
  const [cx0, cx1] = chunkRange(grid, x0, x1);
  const [cz0, cz1] = chunkRange(grid, z0, z1);
  const tLoad = performance.now();
  for (let cx = cx0; cx < cx1; cx++) for (let cz = cz0; cz < cz1; cz++) for (let cy = cy0; cy < cy1; cy++) {
    if (g.fill(grid, cx, cy, cz, gen)) store.importChunk(cx, cy, cz, gen);
  }
  const loadMs = performance.now() - tLoad;
  // Memory as loaded: the edits below grow it (a dug cell in an absent chunk allocates nothing, a filled one does).
  const memoryBytes = store.memoryBytes();
  const coords = storeChunkCoords(store);
  let ylo = Infinity;
  let yhi = -Infinity;
  for (const c of coords) {
    ylo = Math.min(ylo, c.cy << grid.shift);
    yhi = Math.max(yhi, (c.cy + 1) << grid.shift);
  }
  const wx = (cx1 - cx0) << grid.shift;
  const wz = (cz1 - cz0) << grid.shift;
  const bx = cx0 << grid.shift;
  const bz = cz0 << grid.shift;
  const rand = mulberry32(opts.seed);
  const out = voxel();

  // Random reads over the loaded box (air above the ground included, as any query would).
  const n = opts.randomReads;
  const rx = new Int32Array(n);
  const ry = new Int32Array(n);
  const rz = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    rx[i] = bx + Math.floor(rand() * wx);
    ry[i] = ylo + Math.floor(rand() * (yhi - ylo));
    rz[i] = bz + Math.floor(rand() * wz);
  }
  let sink = 0;
  const randomMs = best(() => {
    for (let i = 0; i < n; i++) sink += store.voxelAt(rx[i]!, ry[i]!, rz[i]!, out).material;
  });

  // Coherent reads: whole columns, y fastest, over a square patch of columns.
  const side = Math.max(1, Math.min(Math.floor(Math.sqrt(opts.coherentColumns)), wx, wz));
  const coherentReads = side * side * (yhi - ylo);
  const coherentMs = best(() => {
    for (let x = bx; x < bx + side; x++) for (let z = bz; z < bz + side; z++) for (let y = ylo; y < yhi; y++) sink += store.voxelAt(x, y, z, out).material;
  });

  // Surface points for the strokes: the highest non-air cell of random columns.
  const surface: Array<[number, number, number]> = [];
  for (let k = 0; k < opts.strokes; k++) {
    const x = bx + 16 + Math.floor(rand() * Math.max(1, wx - 32));
    const z = bz + 16 + Math.floor(rand() * Math.max(1, wz - 32));
    let y = yhi - 1;
    while (y > ylo && store.voxelAt(x, y, z, out).material === 0) y--;
    surface.push([x, Math.max(ylo + 16, Math.min(yhi - 17, y)), z]);
  }

  // Transfer: raw and zstd bytes of chunks spread over the window, before edits change them.
  let transfer: BenchResult['transfer'] = null;
  if (opts.transferChunks > 0 && coords.length > 0) {
    const raw: Uint8Array[] = [];
    for (let k = 0; k < opts.transferChunks; k++) {
      const c = coords[Math.floor(((k + 0.5) * coords.length) / opts.transferChunks)]!;
      const b = store.encodeChunk(c.cx, c.cy, c.cz);
      if (b !== null) raw.push(b);
    }
    transfer = { raw: await measureTransfer(raw), zstd: await measureTransfer(raw.map((b) => ZSTD.compress(b))) };
  }

  // Single edits: random cells of the box, alternately set to rock and dug to air.
  const rock = voxel(MAT.rock, VOXEL_CATEGORY.terrain, 255, 0);
  const air = voxel();
  const m = Math.min(opts.edits, n);
  const editMs = best(() => {
    for (let i = 0; i < m; i++) store.setVoxel(rx[i]!, ry[i]!, rz[i]!, (i & 1) === 0 ? rock : air);
  });

  const strokes: StrokeResult[] = [];
  const shapes: Array<{ name: string; make: (c: [number, number, number], fill: boolean) => VoxelStroke }> = [
    ...[2, 4, 8].map((r) => ({ name: `sphere r=${r / 2} m`, make: (c: [number, number, number], fill: boolean): VoxelStroke => ({ kind: 'sphere', center: c, radius: r, voxel: fill ? rock : air }) })),
    ...[4, 16].map((s) => ({
      name: `box ${s / 2} m`,
      make: (c: [number, number, number], fill: boolean): VoxelStroke => ({ kind: 'box', min: [c[0] - (s >> 1), c[1] - (s >> 1), c[2] - (s >> 1)], max: [c[0] + (s >> 1) - 1, c[1] + (s >> 1) - 1, c[2] + (s >> 1) - 1], voxel: fill ? rock : air }),
    })),
  ];
  for (const shape of shapes) {
    let cells = 0;
    const ms = best(() => {
      cells = 0;
      surface.forEach((c, i) => (cells += store.applyStroke(shape.make(c, (i & 1) === 1))));
    });
    strokes.push({ name: shape.name, usPerOp: (ms * 1000) / surface.length, cellsPerOp: cells / surface.length });
  }
  if (sink === -1) console.log('unreachable');

  return {
    windowCells: [x1 - x0, z1 - z0],
    chunks: coords.length,
    memoryBytes,
    loadMs,
    randomReadNs: (randomMs * 1e6) / n,
    coherentReadNs: (coherentMs * 1e6) / coherentReads,
    coherentReads,
    editUs: (editMs * 1000) / m,
    strokes,
    transfer,
  };
}
