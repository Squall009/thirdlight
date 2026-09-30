#!/usr/bin/env node
/**
 * One line per number from scale bench reports, for the plan's measurement
 * table: `node tools/perf/scale-summary.mjs <report.json>…`.
 */
import { readFileSync } from 'node:fs';

const f = (v, d = 0) => (v === null || v === undefined ? '–' : Number(v).toFixed(d));
for (const path of process.argv.slice(2)) {
  const { name, commit, machine, report: r } = JSON.parse(readFileSync(path, 'utf8'));
  const g = r.generated;
  const src = g !== undefined ? Object.values(g.sourceBytes).reduce((a, b) => a + b, 0) : null;
  console.log(`== ${name} (${commit}, ${machine.gpu})`);
  if (g !== undefined) console.log(`counts ${JSON.stringify(g.counts)}; content.json ${f(g.contentJsonBytes / 1024)} KiB (canonical ${f((g.contentCanonicalBytes ?? 0) / 1024)} KiB), sources ${f(src / 1048576, 1)} MiB, generated in ${f(g.generateMs / 1000, 1)} s`);
  const fc = r.files;
  if (fc) console.log(`file check (${fc.entries} files): first ${fc.firstMs} ms, again ${fc.againMs} ms, after a restart ${fc.afterRestartMs} ms; backend RSS ${f(fc.backendRssMiB.first)} / ${f(fc.backendRssMiB.again)} / ${f(fc.backendRssMiB.afterRestart)} MiB`);
  const o = r.open;
  if (o) console.log(`open: backend ${o.backendMs} ms, editor connected ${o.editorConnectedMs} ms, first frame ${f(o.editorFirstFrameMs)} ms, editor heap ${f(o.editorHeapMiB, 1)} MiB, backend RSS ${f(o.backendRssMiB)} MiB`);
  const c = r.commands;
  if (c) console.log(`command: scene edit p50 ${f(c.sceneEdit.p50, 1)} / p95 ${f(c.sceneEdit.p95, 1)} ms; content edit p50 ${f(c.contentEdit?.p50, 1)} / p95 ${f(c.contentEdit?.p95, 1)} ms; content.json ${f((c.contentBytes ?? 0) / 1024)} KiB`);
  const p = r.play;
  if (p) {
    const s = p.split;
    const st = (n) => s.stages.find((x) => x.name === n);
    console.log(`play: response ${s.responseMs} ms (backend total ${s.backend?.total}, closure ${s.backend?.closure}, closure.assets ${s.backend?.['closure.assets']}), manifest ${st('manifest')?.note ?? '–'}, ready ${f(s.readyMs)} ms, first frame ${f(s.firstFrameMs)} ms; heap ${f(p.memory.heapMiB, 1)} MiB, gpu ${f(p.memory.gpuMiB, 1)} MiB, backend RSS ${f(p.memory.backendRssMiB)} MiB (peak during the start ${f(p.backendRssPeakMiB)}, after the stop ${f(p.backendRssAfterStopMiB)})`);
  }
  const w = r.walk;
  if (w) {
    const last = w.loaded[w.loaded.length - 1];
    const maxHeap = Math.max(...w.loaded.map((m) => m.heapMiB ?? 0));
    console.log(`walk ${w.scenes}: load p50 ${f(w.loadMs.p50)} / p95 ${f(w.loadMs.p95)} ms (read p50 ${f(w.readMs?.p50)}, drawn p50 ${f(w.attachMs?.p50)} / p95 ${f(w.attachMs?.p95)} ms), unload p50 ${f(w.unloadMs.p50)} ms; heap ${f(w.before.heapMiB, 1)} → max ${f(maxHeap, 1)} → after ${f(w.after.heapMiB, 1)} MiB; gpu ${f(w.before.gpuMiB, 1)} → ${f(last?.gpuMiB, 1)} → ${f(w.after.gpuMiB, 1)} MiB; textures ${w.before.live.textures} → ${last?.live.textures} → ${w.after.live.textures}; three textures ${w.before.three?.textures} → ${w.after.three?.textures}, geometries ${w.before.three?.geometries} → ${w.after.three?.geometries}; asset bytes read ${f((w.after.assetReads?.bytes ?? 0) / 1048576, 1)} MiB; backend RSS ${f(w.after.backendRssMiB)} MiB`);
  }
  const d = r.dialogue;
  if (d) console.log(`dialogue ${d.lines}: seen ${d.linesSeen}, heard ${d.voicesHeard}; line→voice p50 ${f(d.startLatencyMs.p50)} / p95 ${f(d.startLatencyMs.p95)} / max ${f(d.startLatencyMs.max)} ms; gap p50 ${f(d.gapMs.p50)} / p95 ${f(d.gapMs.p95)} / max ${f(d.gapMs.max)} ms; wall ${f(d.wallMs / 1000, 1)} s`);
  const e = r.export;
  if (e) console.log(`export: ${e.ms} ms, ${e.files} files, ${f(e.bytes / 1048576, 1)} MiB, first frame ${f(e.firstFrameMs)} ms, ${e.state}${e.pageErrors.length ? `, errors ${e.pageErrors.join(' | ')}` : ''}`);
  for (const [k, v] of Object.entries(r.broke)) console.log(`BROKE ${k}: ${v.slice(0, 400)}`);
}
