/**
 * The sweep: every chunk of a test world, one chunk column at a time,
 * through a store candidate. Each column is generated, imported, checked
 * cell by cell against what was generated (the candidate must answer exactly
 * what the dense oracle would), encoded, compressed, measured and dropped,
 * so memory holds one column whatever the world's size. Large worlds can be
 * swept on evenly spaced sample tiles and extrapolated by footprint.
 */
import {
  copyDenseChunk,
  createDenseChunk,
  isUniformChunk,
  maskDenseChunk,
  planeMask,
  sameDenseChunk,
  VOXEL_CATEGORY,
  VOXEL_PLANES,
  type ChunkGrid,
  type DenseChunk,
  voxel,
  type VoxelPlane,
  type VoxelRecord,
  type VoxelStoreCandidate,
  type VoxelStoreFactory,
} from '@thirdlight/voxel';
import { CODECS, ZSTD, type Codec } from './codecs';
import { chunkRange, type TestGrid, type TestWorld } from './world-kit';

/** Cells per side of a sweep tile (256 m, the default region footprint). */
export const SWEEP_TILE = 512;

/** Plane subsets whose zstd size shows what the category and orientation planes cost. */
const PLANE_SUBSETS: Record<'noCategory' | 'noOrientation' | 'neither', readonly VoxelPlane[]> = {
  noCategory: VOXEL_PLANES.filter((p) => p !== 'category'),
  noOrientation: VOXEL_PLANES.filter((p) => p !== 'orientation'),
  neither: VOXEL_PLANES.filter((p) => p !== 'category' && p !== 'orientation'),
};

/** Sizes and counts summed over the swept chunks. */
export interface SweepTotals {
  chunksVisited: number;
  chunksPresent: number;
  chunksUniform: number;
  cells: number;
  surfaceCells: number;
  liquidCells: number;
  constructionCells: number;
  roofCells: number;
  memoryBytes: number;
  rawBytes: number;
  zstdBytes: number;
  deflateBytes: number;
  zstdNoCategory: number;
  zstdNoOrientation: number;
  zstdNeither: number;
  /** Compressed bytes per codec the run measured (by codec name). */
  codecBytes: Record<string, number>;
  /** Material runs along y inside each chunk column (a run-length encoding's entry count). */
  materialRuns: number;
  /** Chunk columns (edge × edge per chunk) the runs were counted over. */
  runColumns: number;
  /** Chunks by distinct material count: 1, 2, 3–4, 5–8, 9–16, 17+. */
  paletteHistogram: number[];
  /** Distinct whole records (all four fields) per chunk, summed over the chunks it was counted on, and that count. */
  recordPaletteSum: number;
  recordPaletteChunks: number;
}

/** Timings over the swept chunks (ms; decode and decompress on every fourth chunk). */
export interface SweepTimings {
  generateMs: number;
  importMs: number;
  encodeMs: number;
  encodedBytes: number;
  encodedChunks: number;
  decodeMs: number;
  decodedBytes: number;
  decodedChunks: number;
  compressMs: Record<string, number>;
  decompressMs: Record<string, number>;
  decompressedBytes: Record<string, number>;
}

export interface SweepResult {
  grids: number;
  /** World-grid tiles swept and in the world, and the footprint factor applied to the world grid's totals. */
  tilesSwept: number;
  tilesTotal: number;
  factor: number;
  /** Totals extrapolated to the whole world (the swept part × factor for the world grid, rotated grids as they are). */
  totals: SweepTotals;
  timings: SweepTimings;
  /** Every chunk read back equal to what was generated. */
  verified: boolean;
  mismatches: number;
  /** Cells read through `voxelAt` and compared with the generated chunk (a spread of every chunk's cells). */
  voxelAtChecks: number;
}

/** Every chunk's `voxelAt` check reads one cell in this many, from an offset that moves chunk to chunk. */
const VOXEL_AT_STRIDE = 37;

/** Reads a spread of a chunk's cells through `voxelAt` and compares them with `expected`; returns how many it read. */
function checkVoxelAt(store: VoxelStoreCandidate, grid: ChunkGrid, cx: number, cy: number, cz: number, expected: DenseChunk, offset: number, out: VoxelRecord, miss: () => void): number {
  const s = grid.shift;
  const m = grid.mask;
  let read = 0;
  for (let i = offset; i < grid.cellsPerChunk; i += VOXEL_AT_STRIDE) {
    const v = store.voxelAt((cx << s) | (i >> (2 * s)), (cy << s) | (i & m), (cz << s) | ((i >> s) & m), out);
    if (v.material !== expected.material[i] || v.category !== expected.category[i] || v.shape !== expected.shape[i] || v.orientation !== expected.orientation[i]) miss();
    read++;
  }
  return read;
}

function emptyTotals(): SweepTotals {
  return {
    chunksVisited: 0,
    chunksPresent: 0,
    chunksUniform: 0,
    cells: 0,
    surfaceCells: 0,
    liquidCells: 0,
    constructionCells: 0,
    roofCells: 0,
    memoryBytes: 0,
    rawBytes: 0,
    zstdBytes: 0,
    deflateBytes: 0,
    zstdNoCategory: 0,
    zstdNoOrientation: 0,
    zstdNeither: 0,
    codecBytes: {},
    materialRuns: 0,
    runColumns: 0,
    paletteHistogram: [0, 0, 0, 0, 0, 0],
    recordPaletteSum: 0,
    recordPaletteChunks: 0,
  };
}

function addTotals(into: SweepTotals, from: SweepTotals, factor: number): void {
  for (const k of Object.keys(into) as Array<keyof SweepTotals>) {
    if (k === 'paletteHistogram') from.paletteHistogram.forEach((n, i) => (into.paletteHistogram[i]! += n * factor));
    else if (k === 'codecBytes') for (const [name, n] of Object.entries(from.codecBytes)) into.codecBytes[name] = (into.codecBytes[name] ?? 0) + n * factor;
    else (into[k] as number) += (from[k] as number) * factor;
  }
}

const seenMaterial = new Uint8Array(65536);

/** Data properties of one generated chunk (candidate-independent). */
function chunkStats(grid: ChunkGrid, c: DenseChunk, t: SweepTotals, countRecords: boolean): void {
  const n = grid.cellsPerChunk;
  const e = grid.edge;
  const { material: m, category: cat, shape: s } = c;
  const used: number[] = [];
  for (let i = 0; i < n; i++) {
    const mi = m[i]!;
    if (seenMaterial[mi] === 0) {
      seenMaterial[mi] = 1;
      used.push(mi);
    }
    const si = s[i]!;
    if (si > 0 && si < 255) t.surfaceCells++;
    const ci = cat[i]!;
    if (ci === VOXEL_CATEGORY.liquid) t.liquidCells++;
    else if (ci === VOXEL_CATEGORY.construction) t.constructionCells++;
    else if (ci === VOXEL_CATEGORY.roof) t.roofCells++;
  }
  for (const u of used) seenMaterial[u] = 0;
  const p = used.length;
  t.paletteHistogram[p <= 1 ? 0 : p === 2 ? 1 : p <= 4 ? 2 : p <= 8 ? 3 : p <= 16 ? 4 : 5]!++;
  // y runs fastest in a chunk's arrays, so each run of `e` cells is one column.
  for (let col = 0; col < n; col += e) {
    let runs = 1;
    for (let i = col + 1; i < col + e; i++) if (m[i] !== m[i - 1]) runs++;
    t.materialRuns += runs;
  }
  t.runColumns += e * e;
  if (countRecords) {
    const records = new Set<number>();
    for (let i = 0; i < n; i++) records.add(m[i]! * 16777216 + cat[i]! * 65536 + s[i]! * 256 + c.orientation[i]!);
    t.recordPaletteSum += records.size;
    t.recordPaletteChunks++;
  }
}

/** The grid's tiles (tile x, tile z; `tile` cells a side) to sweep: all, or `sample` spread evenly over the grid. */
export function sweepTiles(
  g: TestGrid,
  sample: number | undefined,
  tile = SWEEP_TILE,
): { tiles: Array<[number, number]>; total: number; sweptCells: number; totalCells: number } {
  const [tx0, tx1] = [Math.floor(g.bounds.min[0] / tile), Math.ceil(g.bounds.max[0] / tile)];
  const [tz0, tz1] = [Math.floor(g.bounds.min[2] / tile), Math.ceil(g.bounds.max[2] / tile)];
  const all: Array<[number, number]> = [];
  for (let tx = tx0; tx < tx1; tx++) for (let tz = tz0; tz < tz1; tz++) all.push([tx, tz]);
  const area = ([tx, tz]: [number, number]): number => {
    const w = Math.min(g.bounds.max[0], (tx + 1) * tile) - Math.max(g.bounds.min[0], tx * tile);
    const d = Math.min(g.bounds.max[2], (tz + 1) * tile) - Math.max(g.bounds.min[2], tz * tile);
    return Math.max(0, w) * Math.max(0, d);
  };
  const totalCells = all.reduce((s, t) => s + area(t), 0);
  let tiles = all;
  if (sample !== undefined && sample < all.length) {
    tiles = [];
    for (let k = 0; k < sample; k++) tiles.push(all[Math.floor(((k + 0.5) * all.length) / sample)]!);
  }
  return { tiles, total: all.length, sweptCells: tiles.reduce((s, t) => s + area(t), 0), totalCells };
}

/** What a sweep compresses chunks with, and where it hands sample chunk bytes. */
export interface SweepExtras {
  /** Compressors to measure (default {@link CODECS}: zstd 3 and deflate). */
  codecs?: readonly Codec[];
  /** Receives the encoded bytes of every present chunk (uniform ones included). */
  corpus?: (bytes: Uint8Array) => void;
}

/** Sweeps every grid of a world through a fresh store of the candidate. */
export function sweepWorld(
  world: TestWorld,
  factory: VoxelStoreFactory,
  grid: ChunkGrid,
  sampleTiles?: number,
  log?: (line: string) => void,
  tile = SWEEP_TILE,
  extras: SweepExtras = {},
): SweepResult {
  const codecs = extras.codecs ?? CODECS;
  const totals = emptyTotals();
  const timings: SweepTimings = {
    generateMs: 0,
    importMs: 0,
    encodeMs: 0,
    encodedBytes: 0,
    encodedChunks: 0,
    decodeMs: 0,
    decodedBytes: 0,
    decodedChunks: 0,
    compressMs: Object.fromEntries(codecs.map((c) => [c.name, 0])),
    decompressMs: Object.fromEntries(codecs.map((c) => [c.name, 0])),
    decompressedBytes: Object.fromEntries(codecs.map((c) => [c.name, 0])),
  };
  const gen = createDenseChunk(grid);
  const back = createDenseChunk(grid);
  // What a store that keeps fewer planes must read back: the generated cells with the other planes cleared.
  const masked = createDenseChunk(grid);
  let mismatches = 0;
  let voxelAtChecks = 0;
  const cell = voxel();
  let tilesSwept = 0;
  let tilesTotal = 0;
  let factor = 1;
  let counter = 0;

  for (const g of world.grids) {
    const isWorld = g === world.grids[0];
    const plan = sweepTiles(g, isWorld ? sampleTiles : undefined, tile);
    const gridFactor = plan.sweptCells > 0 ? plan.totalCells / plan.sweptCells : 1;
    if (isWorld) {
      tilesSwept = plan.tiles.length;
      tilesTotal = plan.total;
      factor = gridFactor;
    }
    const part = emptyTotals();
    const store = factory(grid);
    const keep = store.planes === undefined ? null : planeMask(store.planes);
    const expected = keep === null || keep === planeMask(VOXEL_PLANES) ? gen : masked;
    const [cy0, cy1] = chunkRange(grid, g.bounds.min[1], g.bounds.max[1]);
    for (const [tx, tz] of plan.tiles) {
      const [cx0, cx1] = chunkRange(grid, Math.max(g.bounds.min[0], tx * tile), Math.min(g.bounds.max[0], (tx + 1) * tile));
      const [cz0, cz1] = chunkRange(grid, Math.max(g.bounds.min[2], tz * tile), Math.min(g.bounds.max[2], (tz + 1) * tile));
      for (let cx = cx0; cx < cx1; cx++) for (let cz = cz0; cz < cz1; cz++) {
        const present: number[] = [];
        for (let cy = cy0; cy < cy1; cy++) {
          part.chunksVisited++;
          let t = performance.now();
          const any = g.fill(grid, cx, cy, cz, gen);
          timings.generateMs += performance.now() - t;
          if (!any) continue;
          if (expected === masked) {
            copyDenseChunk(gen, masked);
            maskDenseChunk(masked, keep!);
          }
          t = performance.now();
          store.importChunk(cx, cy, cz, gen);
          timings.importMs += performance.now() - t;
          present.push(cy);
          part.chunksPresent++;
          part.cells += grid.cellsPerChunk;
          if (isUniformChunk(gen)) part.chunksUniform++;
          const k = counter++;
          chunkStats(grid, gen, part, k % 8 === 0);
          if (!store.exportChunk(cx, cy, cz, back) || !sameDenseChunk(back, expected)) mismatches++;
          voxelAtChecks += checkVoxelAt(store, grid, cx, cy, cz, expected, k % VOXEL_AT_STRIDE, cell, () => mismatches++);

          t = performance.now();
          const bytes = store.encodeChunk(cx, cy, cz);
          timings.encodeMs += performance.now() - t;
          if (bytes === null) {
            mismatches++;
            continue;
          }
          timings.encodedBytes += bytes.length;
          timings.encodedChunks++;
          part.rawBytes += bytes.length;
          extras.corpus?.(bytes);
          for (const codec of codecs) {
            t = performance.now();
            const packed = codec.compress(bytes);
            timings.compressMs[codec.name]! += performance.now() - t;
            part.codecBytes[codec.name] = (part.codecBytes[codec.name] ?? 0) + packed.length;
            if (codec.name === 'zstd') part.zstdBytes += packed.length;
            else if (codec.name === 'deflate') part.deflateBytes += packed.length;
            if (k % 4 === 0) {
              t = performance.now();
              const unpacked = codec.decompress(packed);
              timings.decompressMs[codec.name]! += performance.now() - t;
              timings.decompressedBytes[codec.name]! += unpacked.length;
              if (Buffer.compare(unpacked, bytes) !== 0) mismatches++;
            }
          }
          part.zstdNoCategory += ZSTD.compress(store.encodeChunk(cx, cy, cz, PLANE_SUBSETS.noCategory)!).length;
          part.zstdNoOrientation += ZSTD.compress(store.encodeChunk(cx, cy, cz, PLANE_SUBSETS.noOrientation)!).length;
          part.zstdNeither += ZSTD.compress(store.encodeChunk(cx, cy, cz, PLANE_SUBSETS.neither)!).length;
          if (k % 4 === 0) {
            t = performance.now();
            store.decodeChunk(cx, cy, cz, bytes);
            timings.decodeMs += performance.now() - t;
            timings.decodedBytes += bytes.length;
            timings.decodedChunks++;
            if (!store.exportChunk(cx, cy, cz, back) || !sameDenseChunk(back, expected)) mismatches++;
          }
        }
        part.memoryBytes += store.memoryBytes();
        for (const cy of present) store.dropChunk(cx, cy, cz);
      }
      if (isWorld) log?.(`  ${world.name}/${g.name} tile ${tx},${tz}: ${part.chunksPresent} chunks so far`);
    }
    addTotals(totals, part, isWorld ? gridFactor : 1);
  }
  return { grids: world.grids.length, tilesSwept, tilesTotal, factor, totals, timings, verified: mismatches === 0, mismatches, voxelAtChecks };
}
