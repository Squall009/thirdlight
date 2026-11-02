/**
 * The browser decode bench (started by `node tools/voxel-bench/run.mjs decode`):
 * how fast a module worker in headless Chrome turns compressed chunk bytes
 * back into chunks, per codec, and what each decoder adds to a bundle.
 *
 *   --corpus DIR    corpus files from a harness run with --corpus (default ~/.cache/thirdlight-voxel-bench/corpus)
 *   --out DIR       report and site folder (default ~/.cache/thirdlight-voxel-bench/decode)
 *   --rounds N      rounds per measurement, the best counts (default 3)
 *
 * Each corpus file (chunks of one candidate, edge and world, sampled by the
 * harness) is compressed here with zstd 3, zstd 19, deflate and lz4 (Node,
 * as a writer would), then the worker decompresses every chunk with fzstd,
 * DecompressionStream('deflate-raw') (one chunk at a time, and all chunks at
 * once), or lz4js, and decodes every chunk's palette codec bytes (which
 * checks each chunk's CRC). One browser, one page, one worker.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, homedir, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';
import { scanExportFiles } from '../../packages/exporter/src/scan';
import { launch, serveDir } from '../perf/browser';
import { NAMED_CODECS } from './codecs';
import { readCorpus } from './corpus';
import type { DecodeJob, DecodeResult } from './decode-worker';

/** This folder in the checkout (run.mjs passes the repository root; the bundle runs from dist/). */
const HERE = resolve(process.env.TL_VOXEL_BENCH_REPO ?? '.', 'tools', 'voxel-bench');

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** The site files a codec's measurement reads: chunks back to back, and the offsets. */
function writeCompressed(site: string, name: string, chunks: readonly Uint8Array[], codec: string): void {
  const c = NAMED_CODECS[codec];
  const parts = c === undefined ? chunks : chunks.map((b) => c.compress(b));
  for (let k = 0; k < parts.length; k++) {
    if (c !== undefined && Buffer.compare(c.decompress(parts[k]!), chunks[k]!) !== 0) throw new Error(`${name} ${codec}: chunk ${k} does not round-trip in Node`);
  }
  const offsets = [0];
  for (const p of parts) offsets.push(offsets[offsets.length - 1]! + p.length);
  writeFileSync(join(site, `${name}.${codec}.bin`), Buffer.concat(parts));
  writeFileSync(join(site, `${name}.${codec}.bin.json`), JSON.stringify({ offsets, rawBytes: chunks.reduce((s, b) => s + b.length, 0) }));
}

/** Minified bundle bytes (raw and gzip) of one entry, and whether the export scan passes it (strict, as a non-bundle file). */
async function decoderCost(name: string, contents: string): Promise<{ name: string; bytes: number; gzipBytes: number; scanOk: boolean; scanHits: string[] }> {
  const r = await esbuild.build({ stdin: { contents, resolveDir: HERE, loader: 'ts' }, bundle: true, minify: true, format: 'esm', platform: 'browser', write: false, logLevel: 'error' });
  const bytes = r.outputFiles[0]!.contents;
  const scan = scanExportFiles([{ name: `${name}.js`, bytes }], { authoringOrigin: '', previewOrigin: '', tokenValues: [] }, 'js/main.js', { version: '', integrity: null }, null);
  return { name, bytes: bytes.length, gzipBytes: gzipSync(bytes).length, scanOk: scan.ok, scanHits: scan.hits.map((h) => `${h.pattern} @${h.byteOffset}`) };
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>voxel decode bench</title><script type="module">
const worker = new Worker('./decode-worker.js', { type: 'module' });
let pending = null;
worker.onmessage = (e) => { const p = pending; pending = null; p(e.data); };
window.__runJob = (job) => new Promise((ok) => { pending = ok; worker.postMessage(job); });
window.__ready = true;
</script>`;

const CODECS: readonly DecodeJob['codec'][] = ['none', 'zstd', 'zstd19', 'deflate', 'deflate-parallel', 'lz4'];

async function main(): Promise<void> {
  const base = join(homedir(), '.cache', 'thirdlight-voxel-bench');
  const corpusDir = arg('--corpus') ?? join(base, 'corpus');
  const out = arg('--out') ?? join(base, 'decode');
  const rounds = Number(arg('--rounds') ?? 3);
  const site = join(out, 'site');
  mkdirSync(site, { recursive: true });
  const files = readdirSync(corpusDir).filter((f) => /^.+-(16|32)-[a-z]+\.bin$/.test(f)).sort();
  if (files.length === 0) throw new Error(`no corpus files in ${corpusDir}`);
  const jobs: DecodeJob[] = [];
  for (const f of files) {
    const name = f.replace(/\.bin$/, '');
    const edge = Number(/-(16|32)-/.exec(f)![1]) as 16 | 32;
    const chunks = readCorpus(readFileSync(join(corpusDir, f)));
    for (const codec of ['none', 'zstd', 'zstd19', 'deflate', 'lz4']) writeCompressed(site, name, chunks, codec);
    for (const codec of CODECS) jobs.push({ file: `${name}.${codec === 'deflate-parallel' ? 'deflate' : codec}.bin`, codec, edge, rounds });
  }
  await esbuild.build({ entryPoints: [join(HERE, 'decode-worker.ts')], bundle: true, minify: true, format: 'esm', platform: 'browser', outfile: join(site, 'decode-worker.js'), logLevel: 'error' });
  writeFileSync(join(site, 'index.html'), PAGE);

  const costs = [
    await decoderCost('fzstd (zstd decoder)', `export { decompress } from 'fzstd';`),
    await decoderCost('lz4js (block decoder)', `export { lz4Block } from './lz4-block';`),
    await decoderCost('palette codec decoder', `export { decodePaletteImage } from '@thirdlight/voxel';`),
  ];

  const served = await serveDir(site);
  const browser = await launch('webgl2', false);
  const results: DecodeResult[] = [];
  const version = browser.version();
  try {
    const page = await browser.newPage();
    await page.goto(`${served.url}index.html`);
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
    for (const job of jobs) {
      const r = await page.evaluate((j) => (window as unknown as { __runJob(j: DecodeJob): Promise<DecodeResult> }).__runJob(j), job);
      if (r.error !== undefined) throw new Error(`${job.file} ${job.codec}: ${r.error}`);
      results.push(r);
      console.log(`${job.file} ${job.codec}: ${r.chunks} chunks, ${(r.decompressMs * 1000 / r.chunks).toFixed(1)} µs decompress + ${(r.paletteMs * 1000 / r.chunks).toFixed(1)} µs palette a chunk`);
    }
  } finally {
    await browser.close();
    await served.close();
  }

  const lines = [
    `# Voxel chunk decode in a browser module worker ${new Date().toISOString()}`,
    '',
    `Chrome ${version} (headless, Playwright), ${cpus().length} × ${cpus()[0]?.model ?? '?'}, load ${loadavg().map((l) => l.toFixed(2)).join(' ')}; best of ${rounds} rounds. MB/s = raw (decompressed) MB per second; µs per chunk over the sampled chunks, uniform ones included.`,
    '',
    '| Corpus | Codec | Chunks | Raw KB/chunk | Compressed KB/chunk | Ratio | Decompress MB/s | Decompress µs/chunk | Palette decode µs/chunk | Total µs/chunk |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    const per = (ms: number): number => (ms * 1000) / r.chunks;
    lines.push(
      `| ${r.job.file.replace(/\.[a-z0-9]+\.bin$/, '')} | ${r.job.codec} | ${r.chunks} | ${(r.rawBytes / r.chunks / 1000).toFixed(2)} | ${(r.compressedBytes / r.chunks / 1000).toFixed(2)} | ${(r.rawBytes / r.compressedBytes).toFixed(2)} | ${(r.rawBytes / 1e6 / (r.decompressMs / 1000)).toFixed(0)} | ${per(r.decompressMs).toFixed(1)} | ${per(r.paletteMs).toFixed(1)} | ${per(r.decompressMs + r.paletteMs).toFixed(1)} |`,
    );
  }
  lines.push('', '| Decoder | Minified bytes | gzip bytes | Export scan (strict) |', '|---|---|---|---|');
  for (const c of costs) lines.push(`| ${c.name} | ${c.bytes.toLocaleString('en-US')} | ${c.gzipBytes.toLocaleString('en-US')} | ${c.scanOk ? 'passes' : `fails: ${c.scanHits.join(', ')}`} |`);
  const md = lines.join('\n') + '\n';
  writeFileSync(join(out, 'decode.json'), JSON.stringify({ chrome: version, rounds, results, costs }, null, 1));
  writeFileSync(join(out, 'decode.md'), md);
  console.log(md);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
