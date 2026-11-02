/**
 * The voxel storage harness's command line (started by run.mjs, which
 * bundles it and checks the memory cap).
 *
 *   node tools/voxel-bench/run.mjs [options]
 *
 *   --candidate NAME     store candidate (default dense; see CANDIDATES in harness.ts)
 *   --edge 16|32         chunk edge in cells (default 32); repeat or comma-list for both
 *   --worlds a,b,…       plain, hilly, town, caves, vertical (default all)
 *   --sample-tiles N     sweep only N evenly spaced 256 m tiles of larger worlds, extrapolated by footprint
 *   --no-bench           sizes only (skip access, edit and transfer timings)
 *   --quick              fewer benchmark operations (a smoke run)
 *   --codecs a,b,…       compressors to size and time: zstd1, zstd (level 3), zstd9, zstd19, deflate,
 *                        zstd-dict, or all (default zstd,deflate)
 *   --shape-bits 3|4     quantize the worlds' fill levels to 8 levels (3) or keep the format's 16 (4, default)
 *   --wetness P          none (default), patches (authored wet patches) or rain (a rain pattern on exposed cells)
 *   --corpus DIR         also write 2,000 randomly sampled chunks' encoded bytes per world to DIR (browser decode bench)
 *   --out DIR            report folder (default ~/.cache/thirdlight-voxel-bench)
 *
 * Writes <out>/voxel-bench-<time>.json and .md (and latest.json / latest.md).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, homedir, loadavg } from 'node:os';
import { join } from 'node:path';
import { CHUNK_EDGES, type ChunkEdge } from '@thirdlight/voxel';
import { DEFAULT_BENCH, type BenchOptions } from './bench';
import { markdownReport, runHarness, type HarnessReport, type WorldReport } from './harness';
import { allWorlds } from './worlds';
import { corpusSampleOf, type CorpusSample } from './corpus';
import { DEFAULT_VARIANT, variantLabel, variantWorld, WETNESS_PATTERNS, type ValueVariant, type WetnessPattern } from './value-variants';

function arg(name: string): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1] !== undefined) out.push(...argv[i + 1]!.split(','));
  return out;
}

const flag = (name: string): boolean => process.argv.includes(name);

/** The memory cap run.mjs found this run under (bytes), or null. */
function memoryCapBytes(): number | null {
  const cap = Number(process.env.TL_VOXEL_BENCH_CAP);
  return Number.isFinite(cap) && cap > 0 ? cap : null;
}

async function main(): Promise<void> {
  const candidate = arg('--candidate')[0] ?? 'dense';
  const edges = (arg('--edge').length > 0 ? arg('--edge').map(Number) : [32]) as ChunkEdge[];
  for (const e of edges) if (!CHUNK_EDGES.includes(e)) throw new Error(`--edge must be one of ${CHUNK_EDGES.join(', ')}`);
  const names = arg('--worlds');
  const shapeBits = Number(arg('--shape-bits')[0] ?? DEFAULT_VARIANT.shapeBits);
  const wetness = (arg('--wetness')[0] ?? DEFAULT_VARIANT.wetness) as WetnessPattern;
  if (shapeBits !== 3 && shapeBits !== 4) throw new Error('--shape-bits must be 3 or 4');
  if (!WETNESS_PATTERNS.includes(wetness)) throw new Error(`--wetness must be one of ${WETNESS_PATTERNS.join(', ')}`);
  const variant: ValueVariant = { shapeBits, wetness };
  const worlds = allWorlds()
    .filter((w) => names.length === 0 || names.includes(w.name))
    .map((w) => variantWorld(w, variant));
  if (worlds.length === 0) throw new Error(`no world matches ${names.join(', ')}`);
  const sample = arg('--sample-tiles')[0];
  const sampleTiles = sample === undefined ? undefined : Number(sample);
  const bench = !flag('--no-bench');
  const benchOptions: BenchOptions = flag('--quick') ? { ...DEFAULT_BENCH, randomReads: 200_000, coherentColumns: 256, edits: 20_000, strokes: 40, transferChunks: 16 } : DEFAULT_BENCH;
  const out = arg('--out')[0] ?? join(homedir(), '.cache', 'thirdlight-voxel-bench');
  mkdirSync(out, { recursive: true });

  const codecs = arg('--codecs');
  const corpusDir = arg('--corpus')[0];
  if (corpusDir !== undefined) mkdirSync(corpusDir, { recursive: true });

  const started = new Date().toISOString();
  const log = (line: string): void => console.log(`[${((performance.now()) / 1000).toFixed(0)} s] ${line}`);
  const reports: WorldReport[] = [];
  for (const edge of edges) {
    const samples = new Map<string, CorpusSample>();
    const corpus = corpusDir === undefined ? undefined : (world: string, b: Uint8Array): void => corpusSampleOf(samples, world).add(b);
    reports.push(...(await runHarness(worlds, candidate, { edge, sampleTiles, bench, benchOptions, codecs, corpus, log })));
    for (const [world, s] of samples) writeFileSync(join(corpusDir!, `${candidate}-${edge}-${world}.bin`), s.bytes());
  }
  const report: HarnessReport = {
    started,
    node: process.version,
    host: { cpus: `${cpus().length} × ${cpus()[0]?.model ?? '?'}`, loadavg: loadavg() },
    memoryCapBytes: memoryCapBytes(),
    options: { edge: edges[0]!, sampleTiles: sampleTiles ?? null, bench, benchOptions },
    worlds: reports,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  };
  const md = `# Voxel storage harness ${started} (${variantLabel(variant)})\n\nnode ${process.version}, ${report.host?.cpus}, load ${loadavg().map((l) => l.toFixed(2)).join(' ')}, peak RSS ${(report.peakRssBytes / 1e6).toFixed(0)} MB\n\n${markdownReport(reports)}`;
  const stamp = started.replace(/[:.]/g, '-');
  for (const [name, body] of [[`voxel-bench-${stamp}.json`, JSON.stringify(report, null, 1)], [`voxel-bench-${stamp}.md`, md], ['latest.json', JSON.stringify(report, null, 1)], ['latest.md', md]] as const) {
    writeFileSync(join(out, name), body);
  }
  console.log(md);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
