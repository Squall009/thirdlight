#!/usr/bin/env node
/**
 * The phase run's performance report: frame rate, frame time, GPU time and
 * memory from one headroom bench run (tools/voxel-bench/headroom-cli.ts, low
 * tier, at its cap), written beside the previous phase run's numbers.
 *
 *   node tools/perf-report.mjs <headroom.json> <reports dir> [label]
 *   node tools/perf-report.mjs --latest <reports dir>    the newest kept report beside the one before it (the picture set's copy)
 *
 * Prints the report (Markdown) and keeps this run's numbers in the reports
 * folder as `<time>-<label>.json`; the previous numbers are the newest file
 * already there. The numbers are a baseline, never a verdict: this host is a
 * shared box whose load moves them, so nothing here passes or fails, and the
 * exit code is 0 whenever a report could be written.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const CATEGORIES = ['near', 'far', 'shadows', 'lighting', 'post', 'effects'];

/** The numbers the report shows, from a headroom result (null where the run did not produce one). */
export function perfNumbers(h) {
  const round = Array.isArray(h.rounds) ? h.rounds[0] : undefined;
  const noLoad = round?.noLoad;
  const gpu = round?.gpu ?? null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const cats = Object.fromEntries(CATEGORIES.map((c) => [c, num(gpu?.categories?.find((x) => x.category === c)?.medianMs)]));
  return {
    quality: h.quality ?? null,
    viewport: h.viewport ? `${h.viewport.width}x${h.viewport.height}` : null,
    capFps: num(h.cap?.fps),
    fps: num(noLoad?.meanMs) !== null && noLoad.meanMs > 0 ? Number((1000 / noLoad.meanMs).toFixed(1)) : null,
    missed: num(noLoad?.missed),
    frames: num(noLoad?.frames),
    frameP50Ms: num(noLoad?.p50),
    frameP95Ms: num(noLoad?.p95),
    gpuFrameMs: num(gpu?.frameMs),
    gpuMs: cats,
    pageHeapMiB: num(h.memory?.pageHeapMiB),
    gpuMiB: num(h.memory?.gpuMiB),
    fillS: num(h.fillS),
    load: Array.isArray(h.start?.load) ? h.start.load : null,
    error: typeof h.error === 'string' ? h.error : null,
  };
}

const show = (v, unit = '') => (v === null || v === undefined ? '—' : `${v}${unit}`);
/** A pass's GPU ms: the measurement's difference can come out below zero for a pass it cannot isolate (post). */
const showMs = (v) => (typeof v === 'number' && v < 0 ? `not readable (${v} ms)` : show(v, ' ms'));

/** The report's Markdown: this run beside the previous one (or a dash where there is none). */
export function perfReport(now, prev, meta = {}) {
  const rows = [
    ['frame rate (no load)', show(now.fps, ' fps'), show(prev?.fps, ' fps')],
    ['frames missed / drawn', `${show(now.missed)} / ${show(now.frames)}`, prev ? `${show(prev.missed)} / ${show(prev.frames)}` : '—'],
    ['frame time p50 / p95', `${show(now.frameP50Ms)} / ${show(now.frameP95Ms)} ms`, prev ? `${show(prev.frameP50Ms)} / ${show(prev.frameP95Ms)} ms` : '—'],
    ['GPU frame', show(now.gpuFrameMs, ' ms'), show(prev?.gpuFrameMs, ' ms')],
    ...CATEGORIES.map((c) => [`GPU ${c}`, showMs(now.gpuMs[c]), showMs(prev?.gpuMs?.[c])]),
    ['page heap', show(now.pageHeapMiB, ' MiB'), show(prev?.pageHeapMiB, ' MiB')],
    ['GPU memory', show(now.gpuMiB, ' MiB'), show(prev?.gpuMiB, ' MiB')],
    ['world fill', show(now.fillS, ' s'), show(prev?.fillS, ' s')],
  ];
  return [
    `# Performance report${meta.label ? ` (${meta.label})` : ''}`,
    '',
    `The headroom bench on the 8 km world's town, ${show(now.quality)} tier, ${show(now.viewport)}, at its ${show(now.capFps)} fps cap, WebGPU.`,
    'Recorded as a baseline, never a gate: this host is shared, and its load moves these numbers.',
    `Host load at the start: ${now.load ? now.load.join(' ') : '—'}${prev ? `; previous run: ${prev.load ? prev.load.join(' ') : '—'} (${meta.previous ?? 'earlier'})` : ''}.`,
    ...(now.error ? ['', `The bench reported an error: ${now.error}`] : []),
    '',
    `| | this run | previous${meta.previous ? ` (${meta.previous})` : ''} |`,
    '|---|---|---|',
    ...rows.map((r) => `| ${r.join(' | ')} |`),
    '',
  ].join('\n');
}

/** The newest report kept in `dir` beside the one kept before it, as Markdown; null when none is kept. Writes nothing. */
export function latestReport(dir) {
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')).sort() : [];
  const last = names.at(-1);
  if (last === undefined) return null;
  const prev = names.at(-2);
  const read = (n) => JSON.parse(readFileSync(join(dir, n), 'utf8'));
  return perfReport(read(last), prev === undefined ? null : read(prev), { label: last.replace(/\.json$/, ''), previous: prev?.replace(/\.json$/, '') });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--latest') {
    const md = latestReport(process.argv[3] ?? '');
    if (md === null) {
      console.error(`no performance report kept in ${process.argv[3]}`);
      process.exit(3);
    }
    process.stdout.write(md);
    process.exit(0);
  }
  const [input, dir, label = 'phase'] = process.argv.slice(2);
  if (input === undefined || dir === undefined) {
    console.error('usage: node tools/perf-report.mjs <headroom.json> <reports dir> [label]');
    process.exit(2);
  }
  const now = perfNumbers(JSON.parse(readFileSync(input, 'utf8')));
  mkdirSync(dir, { recursive: true });
  const earlier = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  const last = earlier.at(-1);
  const prev = last === undefined ? null : JSON.parse(readFileSync(join(dir, last), 'utf8'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(dir, `${stamp}-${label}.json`), `${JSON.stringify(now, null, 1)}\n`);
  process.stdout.write(perfReport(now, prev, { label, previous: last?.replace(/\.json$/, '') }));
}
