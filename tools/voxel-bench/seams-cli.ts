/**
 * Seams between chunk-tree levels (lod-seams.ts) on two-level patches:
 * the hard cases cut through their middle (the row moved by whole chunks so
 * a node face runs through each case), and seams across the hilly, caves
 * and town worlds; L0 | L1 and L1 | L2.
 *
 *   node tools/voxel-bench/run.mjs seams [--patches features,hilly,caves,town] [--levels 0,1] [--sparse N] [--out DIR]
 *
 * Writes seams.md and seams.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, uptime } from 'node:os';
import { join } from 'node:path';
import { chunkGrid, createWorldStore, type PaletteStore } from '@thirdlight/voxel';
import { benchDir } from './bench-dirs';
import { featureSpecs, measurePatch, SEAM_CANDIDATES, SEAM_CASES, type PatchReport, type SeamPatchSpec } from './lod-seams';
import { loadArea } from './regions';
import { townWorld } from './town';
import { cavesWorld, hillyWorld } from './worlds';

const grid = chunkGrid(32);

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : dflt;
}

function worldStore(fill: (s: PaletteStore) => void): PaletteStore {
  const s = createWorldStore(grid);
  fill(s);
  return s;
}

function main(): void {
  const patches = arg('--patches', 'features,hilly,caves,town').split(',');
  const levels = arg('--levels', '0,1').split(',').map(Number);
  const sparse = Number(arg('--sparse', '1'));
  const outDir = arg('--out', benchDir('seams'));
  mkdirSync(outDir, { recursive: true });
  const started = new Date().toISOString();
  const load0 = loadavg();
  const up0 = uptime();
  const log = (s: string): void => console.log(`[${(performance.now() / 1000).toFixed(0)} s] ${s}`);
  const specs: SeamPatchSpec[] = [];
  if (patches.includes('features')) for (const f of levels) specs.push(...featureSpecs(f, SEAM_CASES, sparse));
  if (patches.includes('hilly')) {
    const store = worldStore((s) => loadArea(hillyWorld({ footprint: 512 }).grids[0]!, s, -128, -128, 384, 384));
    for (const f of levels) specs.push({ name: 'hilly', store, fine: f, axis: 0, face: 128, fineBelow: false, along: [32, 224], sparse });
  }
  if (patches.includes('caves')) {
    const store = worldStore((s) => loadArea(cavesWorld({ footprint: 512 }).grids[0]!, s, 0, 0, 512, 512));
    for (const f of levels) specs.push({ name: 'caves', store, fine: f, axis: 0, face: 256, fineBelow: true, along: [96, 224], sparse });
  }
  if (patches.includes('town')) {
    const store = worldStore((s) => loadArea(townWorld({ footprint: 512 }).grids[0]!, s, 0, 0, 512, 512));
    for (const f of levels) specs.push({ name: 'town', store, fine: f, axis: 0, face: 256, fineBelow: false, along: [128, 384], sparse });
  }
  const reports: PatchReport[] = [];
  for (const spec of specs) {
    reports.push(measurePatch(spec));
    log(`${spec.name} L${spec.fine}|L${spec.fine + 1} done`);
  }
  const json = { started, node: process.version, host: { cpus: `${cpus().length} × ${cpus()[0]?.model ?? '?'}`, loadavg: [load0, loadavg()], uptimeH: up0 / 3600 }, reports };
  writeFileSync(join(outDir, 'seams.json'), JSON.stringify(json, null, 2));
  const md: string[] = [
    `# Seams between levels (${started})`,
    '',
    `Node ${process.version}, ${json.host.cpus}, load ${load0.map((l) => l.toFixed(1)).join(' / ')} → ${loadavg().map((l) => l.toFixed(1)).join(' / ')}, uptime ${(up0 / 86400).toFixed(1)} d.`,
    '',
    '| Patch | Levels | Candidate | Crack rays / rays | Open m | Added tris (per fine face; % of seam nodes) | µs a fine face | Max move m | Folds | Unmatched | Skirt first % |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of reports) {
    for (const x of r.results) {
      const faces = Math.max(1, x.seamFaces);
      md.push(`| ${r.name} | ${r.levels} | ${x.candidate} | ${x.crackRays} / ${x.rays} | ${x.openM.toFixed(2)} (${x.openEdges}) | ${x.addedTriangles} (${Math.round(x.addedTriangles / faces)}; ${((100 * x.addedTriangles) / Math.max(1, x.seamTriangles)).toFixed(1)} %) | ${Math.round(x.us)} | ${x.maxMoveM.toFixed(2)} | ${x.folds} | ${x.unmatched} | ${((100 * x.skirtFirst) / Math.max(1, x.rays)).toFixed(1)} |`);
    }
  }
  md.push('', '| Patch | Levels | Truth rays | Let through by the finer / coarser control (left out) | Normal jump at the seam p50 / p95 ° | Largest fine → coarse boundary gap m |', '|---|---|---|---|---|---|');
  for (const r of reports) md.push(`| ${r.name} | ${r.levels} | ${r.truthRays} | ${r.controlMisses[0]} / ${r.controlMisses[1]} | ${r.normalJumpDeg[0].toFixed(1)} / ${r.normalJumpDeg[1].toFixed(1)} | ${r.gapM.toFixed(2)} |`);
  md.push('', '| Levels | Candidate | Patches with cracks | Crack rays (all) | Open m (all) | Added tris a fine face (mean) | µs a fine face (p50 of patches) | Folds | Unmatched |', '|---|---|---|---|---|---|---|---|---|');
  for (const lv of [...new Set(reports.map((r) => r.levels))]) {
    for (const cand of SEAM_CANDIDATES) {
      const rows = reports.filter((r) => r.levels === lv).map((r) => r.results.find((x) => x.candidate === cand)!).filter((x) => x !== undefined);
      if (rows.length === 0) continue;
      const us = rows.map((x) => x.us).sort((a, b) => a - b);
      md.push(`| ${lv} | ${cand} | ${rows.filter((x) => x.crackRays > 0).length} / ${rows.length} | ${rows.reduce((s, x) => s + x.crackRays, 0)} | ${rows.reduce((s, x) => s + x.openM, 0).toFixed(1)} | ${Math.round(rows.reduce((s, x) => s + x.addedTriangles / Math.max(1, x.seamFaces), 0) / rows.length)} | ${Math.round(us[Math.floor(us.length / 2)]!)} | ${rows.reduce((s, x) => s + x.folds, 0)} | ${rows.reduce((s, x) => s + x.unmatched, 0)} |`);
    }
  }
  md.push('');
  writeFileSync(join(outDir, 'seams.md'), md.join('\n'));
  console.log(md.join('\n'));
}

main();
