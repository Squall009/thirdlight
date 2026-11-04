/**
 * The case pass on the whole town: µs a 16³ section to extract every
 * construction cell's case with the draft catalogue (Node, this thread; a
 * cold pass with an empty window cache, then measured passes), the
 * detail-bearing cells, the case keys seen and how often each case occurs.
 *
 *   node tools/voxel-bench/run.mjs cases [--rounds 3] [--out DIR]
 *
 * Writes cases.md and cases.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, uptime } from 'node:os';
import { join } from 'node:path';
import {
  buildApron,
  CaseCatalogue,
  caseWindowAt,
  chunkGrid,
  chunkOfKey,
  createDenseChunk,
  createNeighbourhood,
  createWorldStore,
  cropNeighbourhood,
  DRAFT_CASE_CATALOGUE,
  fillNeighbourhood,
  NO_CASE,
  PLACEHOLDER_RULES,
  jobRadius,
  SampleRing,
  valueRole,
  type Neighbourhood,
} from '@thirdlight/voxel';
import { benchDir } from './bench-dirs';
import { loadArea } from './regions';
import { TOWN_FOOTPRINT } from './slice-world';
import { townWorld } from './town';

const grid = chunkGrid(32);
const E = grid.edge;
const SECTION = 16;
const PAD = jobRadius(PLACEHOLDER_RULES);

function main(): void {
  const at = (name: string, dflt: string): string => {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : dflt;
  };
  const rounds = Number(at('--rounds', '3'));
  const outDir = at('--out', benchDir('cases'));
  mkdirSync(outDir, { recursive: true });
  const started = new Date().toISOString();
  const load0 = loadavg();
  const store = createWorldStore(grid);
  loadArea(townWorld({ footprint: TOWN_FOOTPRINT }).grids[0]!, store, 0, 0, TOWN_FOOTPRINT, TOWN_FOOTPRINT);
  // Every 16³ section of every stored chunk and the chunk under it, cut from its chunk's neighbourhood.
  const chunks = new Set<string>();
  const c = { cx: 0, cy: 0, cz: 0 };
  for (const key of store.chunkKeys()) {
    chunkOfKey(grid, key, c);
    chunks.add(`${c.cx},${c.cy},${c.cz}`);
    chunks.add(`${c.cx},${c.cy - 1},${c.cz}`);
  }
  const full = createNeighbourhood(E, PAD);
  const dense = createDenseChunk(grid);
  const sections: Neighbourhood[] = [];
  for (const id of [...chunks].sort()) {
    const [cx, cy, cz] = id.split(',').map(Number) as [number, number, number];
    const has = store.exportChunk(cx, cy, cz, dense);
    fillNeighbourhood(full, grid, has ? dense : null, buildApron(store, cx, cy, cz, PAD));
    for (let s = 0; s < 8; s++) {
      const n = createNeighbourhood(SECTION, PAD);
      cropNeighbourhood(full, (s >> 2) * SECTION, (s & 1) * SECTION, ((s >> 1) & 1) * SECTION, n);
      sections.push(n);
    }
  }
  const cat = new CaseCatalogue(DRAFT_CASE_CATALOGUE);
  const out = new Uint16Array(sections[0]!.values.length);
  const t0 = performance.now();
  for (const n of sections) cat.extract(n, PAD, PAD + SECTION, out);
  const coldMs = performance.now() - t0;
  const all = new SampleRing();
  const withCells = new SampleRing();
  const roundMs: number[] = [];
  let cells = 0;
  for (let r = 0; r < rounds; r++) {
    const r0 = performance.now();
    cells = 0;
    for (const n of sections) {
      const s0 = performance.now();
      const count = cat.extract(n, PAD, PAD + SECTION, out);
      const us = (performance.now() - s0) * 1000;
      all.add(us);
      if (count > 0) withCells.add(us);
      cells += count;
    }
    roundMs.push(performance.now() - r0);
  }
  // Keys and cases, through the slow window path (not timed).
  const keys = new Set<string>();
  const cases = new Map<string, number>();
  for (const n of sections) {
    if (cat.extract(n, PAD, PAD + SECTION, out) === 0) continue;
    const s = n.side;
    for (let x = PAD; x < PAD + SECTION; x++) for (let z = PAD; z < PAD + SECTION; z++) for (let y = PAD; y < PAD + SECTION; y++) {
      const i = (x * s + z) * s + y;
      if (out[i] === NO_CASE) continue;
      const m = cat.matchWindow(valueRole(n.values[i]!), caseWindowAt(n, i));
      keys.add(m.key);
      cases.set(m.caseId, (cases.get(m.caseId) ?? 0) + 1);
    }
  }
  const q = (r: SampleRing, p: number): number => Math.round(r.quantile(p));
  const json = {
    started,
    node: process.version,
    host: { cpus: `${cpus().length} × ${cpus()[0]?.model ?? '?'}`, loadavg: [load0, loadavg()], uptimeH: uptime() / 3600 },
    catalogue: { id: cat.id, version: cat.version, draft: cat.draft, cases: cat.cases.length, rules: cat.rules.length },
    sections: sections.length,
    sectionsWithCells: withCells.count / rounds,
    detailCells: cells,
    keysSeen: keys.size,
    us: { all: { p50: q(all, 0.5), p95: q(all, 0.95) }, withCells: { p50: q(withCells, 0.5), p95: q(withCells, 0.95) } },
    coldPassMs: Math.round(coldMs),
    roundMs: roundMs.map(Math.round),
    cases: Object.fromEntries([...cases].sort((a, b) => b[1] - a[1])),
    caseList: cat.cases.map((x) => x.id),
  };
  writeFileSync(join(outDir, 'cases.json'), JSON.stringify(json, null, 2));
  const md = [
    `# Case extraction on the town (${started})`,
    '',
    `Node ${process.version}, ${json.host.cpus}, load ${load0.map((l) => l.toFixed(1)).join(' / ')}, uptime ${(uptime() / 86400).toFixed(1)} d. Catalogue ${cat.id} v${cat.version}${cat.draft ? ' (DRAFT)' : ''}: ${cat.cases.length} cases, ${cat.rules.length} rules.`,
    '',
    `- ${sections.length} sections of 16³ (whole ${TOWN_FOOTPRINT}² town), ${json.sectionsWithCells} with detail-bearing cells, ${cells} cells, ${keys.size} case keys seen.`,
    `- µs a section p50 / p95: with cells ${json.us.withCells.p50} / ${json.us.withCells.p95}, all ${json.us.all.p50} / ${json.us.all.p95} (${rounds} rounds: ${json.roundMs.join(', ')} ms; cold pass ${json.coldPassMs} ms).`,
    `- Cases: ${[...cases].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id} ${n}`).join(', ')}; never seen: ${cat.cases.filter((x) => !cases.has(x.id)).map((x) => x.id).join(', ') || 'none'}.`,
    '',
  ];
  writeFileSync(join(outDir, 'cases.md'), md.join('\n'));
  console.log(md.join('\n'));
}

main();
