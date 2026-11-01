/**
 * The storage harness: runs store candidates over the test worlds and
 * reports, per world and candidate, memory, `voxelAt` cost, edit and stroke
 * cost, encode/decode and compression speed and size (raw, zstd, deflate;
 * with and without the category and orientation planes), bytes per km², and
 * worker-transfer cost. Output is one JSON document plus a markdown table.
 */
import { chunkGrid, DenseReferenceStore, PaletteStore, VOXEL_PLANES, type ChunkEdge, type PaletteStoreOptions, type VoxelStoreFactory } from '@thirdlight/voxel';
import { benchWorld, DEFAULT_BENCH, type BenchOptions, type BenchResult } from './bench';
import { sweepWorld, type SweepResult } from './sweep';
import type { TestWorld } from './world-kit';

const palette =
  (opts: Omit<PaletteStoreOptions, 'name'>, name: string): VoxelStoreFactory =>
  (grid) =>
    new PaletteStore(grid, { ...opts, name });

/** The candidates the harness knows by name; the storage candidates add theirs here. */
export const CANDIDATES: Readonly<Record<string, VoxelStoreFactory>> = Object.freeze({
  dense: (grid) => new DenseReferenceStore(grid),
  // One record palette per chunk, bit-packed in memory and at rest.
  palette: palette({ palette: 'record', layout: 'packed', atRest: 'packed' }, 'palette'),
  // The same palette with vertical runs per column, in memory and at rest.
  'palette-runs': palette({ palette: 'record', layout: 'runs', atRest: 'runs' }, 'palette-runs'),
  // Bit-packed in memory, runs only at rest.
  'palette-rest-runs': palette({ palette: 'record', layout: 'packed', atRest: 'runs' }, 'palette-rest-runs'),
  // One palette per plane (material with the density flag, category, orientation), bit-packed.
  'palette-planes': palette({ palette: 'planes', layout: 'packed', atRest: 'packed' }, 'palette-planes'),
  // The record palette without a category or an orientation plane (what each plane costs in memory).
  'palette-nocat': palette({ palette: 'record', layout: 'packed', atRest: 'packed', planes: VOXEL_PLANES.filter((p) => p !== 'category') }, 'palette-nocat'),
  'palette-noorient': palette({ palette: 'record', layout: 'packed', atRest: 'packed', planes: VOXEL_PLANES.filter((p) => p !== 'orientation') }, 'palette-noorient'),
});

export interface HarnessOptions {
  edge: ChunkEdge;
  /** World-grid tiles to sweep on worlds with more (undefined: every tile). */
  sampleTiles?: number;
  /** Run the access/edit/transfer benchmarks (the sweep always runs). */
  bench: boolean;
  benchOptions?: BenchOptions;
  log?: (line: string) => void;
}

export interface WorldReport {
  world: string;
  description: string;
  seed: number;
  areaM2: number;
  candidate: string;
  edge: ChunkEdge;
  sweep: SweepResult;
  bench: BenchResult | null;
  /** Wall-clock seconds of this world's run. */
  seconds: number;
}

export interface HarnessReport {
  started: string;
  node: string;
  host: { cpus: string; loadavg: number[] } | null;
  memoryCapBytes: number | null;
  options: { edge: ChunkEdge; sampleTiles: number | null; bench: boolean; benchOptions: BenchOptions };
  worlds: WorldReport[];
  peakRssBytes: number;
}

/** Runs one candidate over the worlds. */
export async function runHarness(worlds: readonly TestWorld[], candidate: string, opts: HarnessOptions): Promise<WorldReport[]> {
  const factory = CANDIDATES[candidate];
  if (factory === undefined) throw new Error(`unknown candidate '${candidate}' (known: ${Object.keys(CANDIDATES).join(', ')})`);
  const grid = chunkGrid(opts.edge);
  const reports: WorldReport[] = [];
  for (const world of worlds) {
    const t0 = performance.now();
    opts.log?.(`${world.name} (${candidate}, ${opts.edge}³): sweep`);
    const sweep = sweepWorld(world, factory, grid, opts.sampleTiles, opts.log);
    opts.log?.(`${world.name}: sweep done, ${sweep.totals.chunksPresent.toFixed(0)} chunks, verified ${String(sweep.verified)}`);
    const bench = opts.bench ? await benchWorld(world, factory, grid, opts.benchOptions ?? DEFAULT_BENCH) : null;
    reports.push({ world: world.name, description: world.description, seed: world.seed, areaM2: world.areaM2, candidate, edge: opts.edge, sweep, bench, seconds: (performance.now() - t0) / 1000 });
  }
  return reports;
}

const MB = 1e6;
const f1 = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : '-');
const f2 = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : '-');
const f0 = (n: number): string => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '-');

/** MB/s from bytes and milliseconds. */
function rate(bytes: number, ms: number): number {
  return ms > 0 ? bytes / MB / (ms / 1000) : NaN;
}

/** The markdown tables of a run: sizes per world, then speeds. */
export function markdownReport(worlds: readonly WorldReport[]): string {
  const lines: string[] = [];
  lines.push('| World | Cand. | Edge | Swept | Verified | Chunks (uniform) | Memory MB | Raw MB | zstd MB | deflate MB | zstd −cat / −orient / −both | zstd MB/km² | B/voxel zstd | surface % | runs/col | palette ≤2 / ≤4 / >16 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const w of worlds) {
    const t = w.sweep.totals;
    const km2 = w.areaM2 / 1e6;
    const h = t.paletteHistogram;
    const pct = (a: number, b: number): string => (b > 0 ? `${((100 * a) / b).toFixed(1)} %` : '-');
    lines.push(
      `| ${w.world} | ${w.candidate} | ${w.edge} | ${w.sweep.tilesSwept}/${w.sweep.tilesTotal} tiles${w.sweep.grids > 1 ? ` + ${w.sweep.grids - 1} grids` : ''} | ${w.sweep.verified ? 'yes' : `NO (${w.sweep.mismatches})`}, ${f0(w.sweep.voxelAtChecks ?? 0)} voxelAt | ${f0(t.chunksPresent)} (${pct(t.chunksUniform, t.chunksPresent)}) | ${f1(t.memoryBytes / MB)} | ${f1(t.rawBytes / MB)} | ${f2(t.zstdBytes / MB)} | ${f2(t.deflateBytes / MB)} | ${pct(t.zstdBytes - t.zstdNoCategory, t.zstdBytes)} / ${pct(t.zstdBytes - t.zstdNoOrientation, t.zstdBytes)} / ${pct(t.zstdBytes - t.zstdNeither, t.zstdBytes)} | ${f2(t.zstdBytes / MB / km2)} | ${(t.zstdBytes / Math.max(1, t.cells)).toFixed(4)} | ${pct(t.surfaceCells, t.cells)} | ${f2(t.materialRuns / Math.max(1, t.runColumns))} | ${pct((h[0] ?? 0) + (h[1] ?? 0), t.chunksPresent)} / ${pct(h[2] ?? 0, t.chunksPresent)} / ${pct(h[5] ?? 0, t.chunksPresent)} |`,
    );
  }
  lines.push('');
  lines.push('| World | Cand. | Edge | window MB counted / heap | voxelAt random ns | coherent ns | edit µs | sphere 1/2/4 m µs | box 2/8 m µs | edits vs oracle | encode / decode µs/chunk | encode / decode MB/s | zstd c / d MB/s | deflate c / d MB/s | worker raw copy / move µs | zstd copy / move µs |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const w of worlds) {
    const b = w.bench;
    const tm = w.sweep.timings;
    const s = (name: string): string => f1(b?.strokes.find((x) => x.name === name)?.usPerOp ?? NaN);
    const tr = b?.transfer;
    lines.push(
      `| ${w.world} | ${w.candidate} | ${w.edge} | ${f1((b?.memoryBytes ?? NaN) / MB)} / ${f1((b?.heapBytes ?? NaN) / MB)} | ${f1(b?.randomReadNs ?? NaN)} | ${f1(b?.coherentReadNs ?? NaN)} | ${f2(b?.editUs ?? NaN)} | ${s('sphere r=1 m')} / ${s('sphere r=2 m')} / ${s('sphere r=4 m')} | ${s('box 2 m')} / ${s('box 8 m')} | ${b?.editMismatches === null || b === null ? '-' : b.editMismatches === 0 ? 'equal' : `${b.editMismatches} differ`} | ${f1((tm.encodeMs * 1000) / Math.max(1, tm.encodedChunks ?? 0))} / ${f1((tm.decodeMs * 1000) / Math.max(1, tm.decodedChunks ?? 0))} | ${f0(rate(tm.encodedBytes, tm.encodeMs))} / ${f0(rate(tm.decodedBytes, tm.decodeMs))} | ${f0(rate(tm.encodedBytes, tm.compressMs.zstd ?? 0))} / ${f0(rate(tm.decompressedBytes.zstd ?? 0, tm.decompressMs.zstd ?? 0))} | ${f0(rate(tm.encodedBytes, tm.compressMs.deflate ?? 0))} / ${f0(rate(tm.decompressedBytes.deflate ?? 0, tm.decompressMs.deflate ?? 0))} | ${tr ? `${f1(tr.raw.copyUsPerChunk)} / ${f1(tr.raw.transferUsPerChunk)}` : '-'} | ${tr ? `${f1(tr.zstd.copyUsPerChunk)} / ${f1(tr.zstd.transferUsPerChunk)}` : '-'} |`,
    );
  }
  return lines.join('\n') + '\n';
}
