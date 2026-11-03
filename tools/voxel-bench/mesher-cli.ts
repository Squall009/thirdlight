/**
 * The terrain mesher candidates (mesher-candidates.ts) side by side: on the
 * hard cases (mesh-cases.ts: closed, golden failures, errors, probes,
 * triangles) and on windows of the test worlds, the slice ring and the
 * whole town (triangles and vertex bytes, the share of ground chunks whose
 * ground is a lattice heightfield, flat triangles a coplanar merge could
 * take, and µs a 16³ section: the terrain rules' evaluation plus the
 * candidate's ground surface, Node, every section of the window).
 *
 *   node tools/voxel-bench/run.mjs mesher [--worlds features,plain,hilly,caves,town,vertical,slice] [--candidates a,b] [--out DIR]
 *
 * Writes mesher.md and mesher.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, uptime } from 'node:os';
import { join } from 'node:path';
import {
  ASSEMBLY_CLASS,
  chunkGrid,
  chunkOfKey,
  CLASS_MASK,
  createNeighbourhood,
  createWorldStore,
  deriveFromStore,
  evaluateAssembly,
  groundHeightfield,
  jobRadius,
  POSITION_STEPS_PER_CELL,
  SURFACE_VERTEX_BYTES,
  TERRAIN_RULES,
  type Neighbourhood,
  type PaletteStore,
  type SurfaceBuffer,
} from '@thirdlight/voxel';
import { benchDir } from './bench-dirs';
import { featuresStore } from './features';
import { chunkMesherOf, MESHER_CANDIDATES, terrainJob, type MesherCandidate } from './mesher-candidates';
import { goldenFailures, measureCases, meshFeatures, type CaseResult } from './mesh-cases';
import { REFERENCE_GOLDENS } from './mesh-goldens';
import { loadArea } from './regions';
import { buildSliceWorld } from './slice-world';
import { TOWN_FOOTPRINT } from './slice-world';
import { cavesWorld, hillyWorld, plainWorld, townWorld, verticalWorld } from './worlds';

const grid = chunkGrid(32);
const E = grid.edge;
const SECTION = 16;
const PAD = jobRadius(TERRAIN_RULES);

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : dflt;
}

const pct = (xs: readonly number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

interface CandidateWorldRow {
  triangles: number;
  vertices: number;
  vertexBytes: number;
  indexBytes: number;
  /** Up-facing triangles whose three corners share one height: what a coplanar merge of flat ground could take. */
  flatTriangles: number;
  groundChunks: number;
  heightfields: number;
  /** Ground chunks not a heightfield, by why (groundHeightfield's refusal, or `built`). */
  refusals: Record<string, number>;
  /** Sections with ground surface (the reference's), evaluation + mesh µs. */
  sectionUs: number[];
  /** Every section of the window, evaluation + mesh µs. */
  allSectionUs: number[];
}

interface WorldReport {
  world: string;
  window: string;
  chunks: number;
  sections: number;
  /** The derive's own ground (the terrain mesher) and base triangles (terrain rules), where measured. */
  derive?: { ground: number; base: number };
  /** Evaluation alone, µs a section with ground surface p50 / p95. */
  evaluateUs: { p50: number; p95: number };
  candidates: Record<string, Omit<CandidateWorldRow, 'sectionUs' | 'allSectionUs'> & { us: { p50: number; p95: number }; allUs: { p50: number; p95: number } }>;
}

/** Whether a chunk holds a cell the construction rules resolve as a built body (it then collides with boxes, never as a heightfield). */
function hasBuilt(n: Neighbourhood, classes: Uint8Array): boolean {
  const s = n.side;
  const p = n.pad;
  for (let x = 0; x < n.edge; x++) for (let z = 0; z < n.edge; z++) {
    const col = ((x + p) * s + (z + p)) * s + p;
    for (let y = 0; y < n.edge; y++) {
      const k = classes[col + y]! & CLASS_MASK;
      if (k === ASSEMBLY_CLASS.wall || k === ASSEMBLY_CLASS.beam || k === ASSEMBLY_CLASS.rail) return true;
    }
  }
  return false;
}

function flatCount(buf: SurfaceBuffer): number {
  const view = new DataView(buf.vertices.buffer, buf.vertices.byteOffset, buf.vertices.byteLength);
  const at = (v: number, k: number): number => view.getUint16(v * SURFACE_VERTEX_BYTES + 2 * k, true);
  let flat = 0;
  const idx = buf.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]!, b = idx[t + 1]!, c = idx[t + 2]!;
    if (at(a, 1) !== at(b, 1) || at(b, 1) !== at(c, 1)) continue;
    // Up-facing: counter-clockwise seen from +y.
    const up = (at(b, 2) - at(a, 2)) * (at(c, 0) - at(a, 0)) - (at(b, 0) - at(a, 0)) * (at(c, 2) - at(a, 2));
    if (up > 0) flat++;
  }
  return flat;
}

/** Copies section (lx, ly, lz) of a chunk's neighbourhood and its pad into `out` (same pad). */
function cropSection(full: Neighbourhood, lx: number, ly: number, lz: number, out: Neighbourhood): void {
  const fs = full.side;
  const os = out.side;
  for (let x = 0; x < os; x++) for (let z = 0; z < os; z++) {
    const src = ((lx + x) * fs + (lz + z)) * fs + ly;
    const dst = (x * os + z) * os;
    out.values.set(full.values.subarray(src, src + os), dst);
    out.shapes.set(full.shapes.subarray(src, src + os), dst);
  }
}

const sec = createNeighbourhood(SECTION, PAD);
const secClasses = new Uint8Array(sec.values.length);

/**
 * Measures the candidates over every chunk of `store` within [x0, x1) ×
 * [z0, z1) cells (and the chunk under each, which owns the ground's
 * underside edges): whole-chunk meshes for triangles, bytes and
 * heightfields; 16³ sections for µs.
 */
function measureWorld(name: string, window: string, store: PaletteStore, x0: number, z0: number, x1: number, z1: number, candidates: readonly MesherCandidate[], withDerive: boolean): WorldReport {
  const list = new Set<string>();
  const c = { cx: 0, cy: 0, cz: 0 };
  for (const key of store.chunkKeys()) {
    chunkOfKey(grid, key, c);
    if (c.cx * E < x0 || (c.cx + 1) * E > x1 || c.cz * E < z0 || (c.cz + 1) * E > z1) continue;
    list.add(`${c.cx},${c.cy},${c.cz}`);
    list.add(`${c.cx},${c.cy - 1},${c.cz}`);
  }
  const rows = new Map<string, CandidateWorldRow>(candidates.map((m) => [m.name, { triangles: 0, vertices: 0, vertexBytes: 0, indexBytes: 0, flatTriangles: 0, groundChunks: 0, heightfields: 0, refusals: {}, sectionUs: [], allSectionUs: [] }]));
  const evalUs: number[] = [];
  const derive = { ground: 0, base: 0 };
  let sections = 0;
  const ids = [...list].sort();
  for (const id of ids) {
    const [cx, cy, cz] = id.split(',').map(Number) as [number, number, number];
    if (withDerive) {
      const d = deriveFromStore(store, cx, cy, cz, TERRAIN_RULES);
      derive.ground += d.ground.indices.length / 3;
      derive.base += d.base.indices.length / 3;
    }
    const { n, classes } = terrainJob(store, cx, cy, cz);
    const built = hasBuilt(n, classes);
    let ground = false;
    for (const m of candidates) {
      const buf = m.mesh(n, classes);
      const r = rows.get(m.name)!;
      const tris = buf.indices.length / 3;
      if (m === candidates[0]) ground = tris > 0;
      r.triangles += tris;
      r.vertices += buf.vertexCount;
      r.vertexBytes += buf.vertexCount * SURFACE_VERTEX_BYTES;
      r.indexBytes += buf.indices.byteLength;
      r.flatTriangles += flatCount(buf);
      if (ground) {
        r.groundChunks++;
        const hf = built ? 'built' : groundHeightfield(buf, E);
        if (typeof hf !== 'string') r.heightfields++;
        else r.refusals[hf] = (r.refusals[hf] ?? 0) + 1;
      }
    }
    // Sections: the rules evaluated on the section's own neighbourhood, then each candidate (order rotated a chunk).
    for (let s = 0; s < 8; s++) {
      cropSection(n, (s >> 2) * SECTION, (s & 1) * SECTION, ((s >> 1) & 1) * SECTION, sec);
      const t0 = performance.now();
      evaluateAssembly(sec, TERRAIN_RULES, secClasses);
      const ev = (performance.now() - t0) * 1000;
      sections++;
      let withSurface = false;
      const order = candidates.map((_, k) => candidates[(k + sections) % candidates.length]!);
      const us = new Map<string, number>();
      for (const m of order) {
        const t1 = performance.now();
        const buf = m.mesh(sec, secClasses);
        us.set(m.name, (performance.now() - t1) * 1000);
        if (m === candidates[0] && buf.indices.length > 0) withSurface = true;
      }
      if (withSurface) evalUs.push(ev);
      for (const m of candidates) {
        const r = rows.get(m.name)!;
        const total = ev + us.get(m.name)!;
        r.allSectionUs.push(total);
        if (withSurface) r.sectionUs.push(total);
      }
    }
  }
  const round = (v: number): number => Math.round(v);
  return {
    world: name,
    window,
    chunks: ids.length,
    sections,
    ...(withDerive ? { derive } : {}),
    evaluateUs: { p50: round(pct(evalUs, 50)), p95: round(pct(evalUs, 95)) },
    candidates: Object.fromEntries([...rows].map(([k, r]) => {
      const { sectionUs, allSectionUs, ...rest } = r;
      return [k, { ...rest, us: { p50: round(pct(sectionUs, 50)), p95: round(pct(sectionUs, 95)) }, allUs: { p50: round(pct(allSectionUs, 50)), p95: round(pct(allSectionUs, 95)) } }];
    })),
  };
}

/** A square window of a bench world loaded with a chunk of margin round it (so the window's chunks have their neighbours). */
function windowOf(world: ReturnType<typeof hillyWorld>, cells: number): { store: PaletteStore; x0: number; z0: number; x1: number; z1: number } {
  const g = world.grids[0]!;
  const store = createWorldStore(grid);
  const x0 = g.bounds.min[0] + E;
  const z0 = g.bounds.min[2] + E;
  loadArea(g, store, x0 - E, z0 - E, x0 + cells + E, z0 + cells + E);
  return { store, x0, z0, x1: x0 + cells, z1: z0 + cells };
}

interface CaseRow {
  candidate: string;
  closed: boolean;
  failures: string[];
  cases: Array<Pick<CaseResult, 'name' | 'triangles' | 'openEdges' | 'maxErrorM' | 'meanErrorM' | 'lost'>>;
}

function main(): void {
  const worlds = arg('--worlds', 'features,plain,hilly,caves,town,vertical,slice').split(',');
  const names = arg('--candidates', MESHER_CANDIDATES.map((m) => m.name).join(',')).split(',');
  const candidates = MESHER_CANDIDATES.filter((m) => names.includes(m.name));
  const outDir = arg('--out', benchDir('mesher'));
  mkdirSync(outDir, { recursive: true });
  const started = new Date().toISOString();
  const load0 = loadavg();
  const up0 = uptime();
  const caseRows: CaseRow[] = [];
  const reports: WorldReport[] = [];
  const log = (s: string): void => console.log(`[${((performance.now()) / 1000).toFixed(0)} s] ${s}`);
  if (worlds.includes('features')) {
    const store = featuresStore();
    for (const m of candidates) {
      const results = measureCases(meshFeatures(store, chunkMesherOf(m)));
      const failures = results.flatMap((r) => goldenFailures(r, REFERENCE_GOLDENS[r.name]!));
      caseRows.push({
        candidate: m.name,
        closed: results.every((r) => r.openEdges === 0),
        failures,
        cases: results.map((r) => ({ name: r.name, triangles: r.triangles, openEdges: r.openEdges, maxErrorM: r.maxErrorM, meanErrorM: r.meanErrorM, lost: r.lost })),
      });
      log(`features ${m.name}: ${failures.length} golden failures`);
    }
    reports.push(measureWorld('features', 'whole row', store, 0, 0, 1 << 20, 1 << 20, candidates, false));
  }
  const W = 192;
  const benchWorlds: Array<[string, () => ReturnType<typeof hillyWorld>, number]> = [
    ['plain', () => plainWorld({ footprint: 512 }), W],
    ['hilly', () => hillyWorld({ footprint: 512 }), W],
    ['caves', () => cavesWorld({ footprint: 512 }), W],
    ['vertical', () => verticalWorld({ footprint: 512 }), 128],
  ];
  for (const [name, make, cells] of benchWorlds) {
    if (!worlds.includes(name)) continue;
    const w = windowOf(make(), cells);
    reports.push(measureWorld(name, `${cells}² cells`, w.store, w.x0, w.z0, w.x1, w.z1, candidates, false));
    log(`${name} done`);
  }
  if (worlds.includes('town')) {
    const store = createWorldStore(grid);
    loadArea(townWorld({ footprint: TOWN_FOOTPRINT }).grids[0]!, store, 0, 0, TOWN_FOOTPRINT, TOWN_FOOTPRINT);
    reports.push(measureWorld('town', `whole ${TOWN_FOOTPRINT}² cells`, store, 0, 0, TOWN_FOOTPRINT, TOWN_FOOTPRINT, candidates, true));
    log('town done');
  }
  if (worlds.includes('slice')) {
    const slice = buildSliceWorld();
    const [sx, , sz] = slice.scene;
    // The slice page's drawn ring round the scene (45.9's 448 chunks, 0.90 M triangles).
    reports.push(measureWorld('slice', 'ring ±192 cells', slice.store, sx - 192, sz - 192, sx + 192, sz + 192, candidates, true));
    log('slice done');
  }
  const json = { started, node: process.version, host: { cpus: `${cpus().length} × ${cpus()[0]?.model ?? '?'}`, loadavg: [load0, loadavg()], uptimeH: up0 / 3600 }, steps: POSITION_STEPS_PER_CELL, caseRows, reports };
  writeFileSync(join(outDir, 'mesher.json'), JSON.stringify(json, null, 2));
  const cm = (m: number): string => (m * 100).toFixed(1);
  const md: string[] = [
    `# Terrain mesher candidates (${started})`,
    '',
    `Node ${process.version}, ${json.host.cpus}, load ${load0.map((l) => l.toFixed(1)).join(' / ')}, uptime ${(up0 / 86400).toFixed(1)} d.`,
    '',
  ];
  if (caseRows.length > 0) {
    md.push('## Hard cases (triangles / max cm / mean cm; ! = misses its golden)', '', `| Case | ${caseRows.map((r) => r.candidate).join(' | ')} |`, `|---|${caseRows.map(() => '---').join('|')}|`);
    for (let k = 0; k < caseRows[0]!.cases.length; k++) {
      const name = caseRows[0]!.cases[k]!.name;
      md.push(`| ${name} | ${caseRows.map((r) => {
        const c = r.cases[k]!;
        const bad = r.failures.some((f) => f.startsWith(`${name}: `));
        return `${c.triangles} / ${cm(c.maxErrorM)} / ${cm(c.meanErrorM)}${c.openEdges > 0 ? ` open ${c.openEdges}` : ''}${c.lost.length > 0 ? ` lost ${c.lost.length}` : ''}${bad ? ' !' : ''}`;
      }).join(' | ')} |`);
    }
    md.push(`| closed / golden failures | ${caseRows.map((r) => `${r.closed ? 'closed' : 'OPEN'} / ${r.failures.length}`).join(' | ')} |`, '');
  }
  md.push('## Worlds', '', '| World (window) | Candidate | Triangles | Flat | Vertices (KB) | Heightfield chunks (not: why) | µs a 16³ section with ground p50 / p95 (all p50 / p95) |', '|---|---|---|---|---|---|---|');
  for (const r of reports) {
    for (const [name, c] of Object.entries(r.candidates)) {
      md.push(`| ${r.world} (${r.window}) | ${name} | ${c.triangles} | ${c.triangles === 0 ? 0 : Math.round((100 * c.flatTriangles) / c.triangles)} % | ${c.vertices} (${(c.vertexBytes / 1024).toFixed(0)}) | ${c.heightfields} / ${c.groundChunks} (${c.groundChunks === 0 ? 0 : Math.round((100 * c.heightfields) / c.groundChunks)} %; ${Object.entries(c.refusals).map(([k, v]) => `${k} ${v}`).join(', ')}) | ${c.us.p50} / ${c.us.p95} (${c.allUs.p50} / ${c.allUs.p95}) |`);
    }
    md.push(`| ${r.world} | evaluation alone | ${r.derive === undefined ? '' : `derive: ground ${r.derive.ground} + base ${r.derive.base}`} | | | | ${r.evaluateUs.p50} / ${r.evaluateUs.p95} |`);
  }
  md.push('');
  writeFileSync(join(outDir, 'mesher.md'), md.join('\n'));
  console.log(md.join('\n'));
}

main();
