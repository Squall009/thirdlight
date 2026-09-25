// SPIKE 22.2 (archived): print a spike222 report (default: the newest) as rows, and
// the medians over repeats per class × renderer × mode.
//   node archive/spike-22-render-worker/summarize.mjs [report.json] [--detail]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = join(process.env.TL_PERF_ROOT ?? join(homedir(), '.cache', 'thirdlight-perf'), 'reports');
const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const file = arg ?? join(dir, readdirSync(dir).filter((f) => f.startsWith('spike222-')).sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)[0]);
const r = JSON.parse(readFileSync(file, 'utf8'));
console.log(`${file}\nload ${r.loadStart.join(' ')} -> ${r.loadEnd.join(' ')}; options ${JSON.stringify(r.options)}`);
if (process.argv.includes('--detail')) {
  for (const m of r.results) console.log(JSON.stringify({ cls: m.cls, renderer: m.renderer, mode: m.mode, rep: m.repeat, apis: m.apis, frame: m.frameMs, adapter: m.adapterFrameMs, audio: m.audioLatencyMs, lag: m.renderLagMs, input: m.input, mt: m.mainThread, notes: m.notes, load: m.loadavg }));
}
const med = (xs) => {
  const s = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  return s.length === 0 ? '-' : Math.round(s[Math.floor((s.length - 1) / 2)] * 10) / 10;
};
const groups = new Map();
for (const m of r.results) {
  const k = `${m.cls} ${m.renderer} ${m.mode}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(m);
}
console.log('| class renderer mode | n | frame mean / p95 (instr.) | adapter renders, mean interval | main thread ms/frame, busy | audio latency p50 / p95 | sim→drawn p50 / p95 | key→moved p50 / max ms | frames p50 / max | first frame |');
for (const [k, ms] of groups) {
  console.log(`| ${k} | ${ms.length} | ${med(ms.map((m) => m.frameMs.mean))} / ${med(ms.map((m) => m.frameMs.p95))} | ${med(ms.map((m) => (m.adapterFrameMs ? m.adapterFrameMs.n + 1 : null)))}, ${med(ms.map((m) => m.adapterFrameMs?.mean))} | ${med(ms.map((m) => m.mainThread.taskMsPerFrame))}, ${med(ms.map((m) => m.mainThread.busyShare * 100))} % | ${med(ms.map((m) => m.audioLatencyMs?.p50))} / ${med(ms.map((m) => m.audioLatencyMs?.p95))} | ${med(ms.map((m) => m.renderLagMs?.p50))} / ${med(ms.map((m) => m.renderLagMs?.p95))} | ${med(ms.map((m) => m.input?.latencyMs.p50))} / ${med(ms.map((m) => m.input?.latencyMs.max))} | ${med(ms.map((m) => m.input?.frames.p50))} / ${med(ms.map((m) => m.input?.frames.max))} | ${med(ms.map((m) => m.firstFrameMs))} |`);
}
if (r.errors.length > 0) console.log(`errors: ${r.errors.join(' | ')}`);
