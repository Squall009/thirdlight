/**
 * The case pass on the whole town and the slice ring: µs a 16³ section to
 * extract every construction cell's case with the draft catalogue (Node,
 * this thread; a cold pass with an empty window cache, then measured
 * passes), the detail-bearing cells, the case keys seen and how often each
 * case occurs; and the composed kit rule set against the terrain rules
 * alone, measured the way a derive job runs them: the evaluation (classes,
 * plus cases for the kit rules) and the whole section derive (evaluation
 * and meshes), interleaved section by section.
 *
 *   node tools/voxel-bench/run.mjs cases [--worlds town,slice] [--rounds 3] [--out DIR]
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
  deriveChunk,
  DRAFT_CASE_CATALOGUE,
  evaluateAssembly,
  evaluateCases,
  fillNeighbourhood,
  KIT_RULES,
  NO_CASE,
  PLACEHOLDER_RULES,
  jobRadius,
  TERRAIN_RULES,
  terrainSurface,
  valueRole,
  type AssemblyRuleSet,
  type Neighbourhood,
  type PaletteStore,
} from '@thirdlight/voxel';
import { benchDir } from './bench-dirs';
import { loadArea } from './regions';
import { buildSliceWorld, TOWN_FOOTPRINT } from './slice-world';
import { townWorld } from './town';

const grid = chunkGrid(32);
const E = grid.edge;
const SECTION = 16;
const PAD = jobRadius(KIT_RULES);

const pct = (xs: readonly number[], p: number): number => {
  if (xs.length === 0) return NaN;
  const s = Float64Array.from(xs).sort();
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const q2 = (xs: readonly number[]): { p50: number; p95: number } => ({ p50: Math.round(pct(xs, 0.5)), p95: Math.round(pct(xs, 0.95)) });

/** Every 16³ section of every stored chunk inside [x0, x1) × [z0, z1) and the chunk under it, cut from its chunk's job neighbourhood. */
function sectionsOf(store: PaletteStore, x0: number, z0: number, x1: number, z1: number): Neighbourhood[] {
  const chunks = new Set<string>();
  const c = { cx: 0, cy: 0, cz: 0 };
  for (const key of store.chunkKeys()) {
    chunkOfKey(grid, key, c);
    if (c.cx * E < x0 || (c.cx + 1) * E > x1 || c.cz * E < z0 || (c.cz + 1) * E > z1) continue;
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
  return sections;
}

interface Composed {
  /** The evaluation (classes; with the kit rules, classes and cases), sections with detail-bearing cells and all. */
  evaluate: { terrain: { cells: { p50: number; p95: number }; all: { p50: number; p95: number } }; kits: { cells: { p50: number; p95: number }; all: { p50: number; p95: number } } };
  /** The whole section derive (evaluation and meshes; deriveChunk), sections with a surface (ground, base or pieces) and all. */
  derive: { terrain: { surface: { p50: number; p95: number }; all: { p50: number; p95: number } }; kits: { surface: { p50: number; p95: number }; all: { p50: number; p95: number } } };
  surfaceSections: number;
  /** The evaluation and the terrain mesher's ground surface (what 46b measured), sections with ground triangles. */
  ground: { terrain: { p50: number; p95: number }; kits: { p50: number; p95: number } };
  groundSections: number;
}

/**
 * The terrain rules alone against the kit rules, section by section, the
 * order alternating so neither runs on the other's warm caches every time.
 */
function measureComposed(sections: readonly Neighbourhood[], rounds: number): Composed {
  const classes = new Uint8Array(sections[0]!.values.length);
  const cases = new Uint16Array(sections[0]!.values.length);
  const sets: Array<[string, AssemblyRuleSet]> = [['terrain', TERRAIN_RULES], ['kits', KIT_RULES]];
  const ev = new Map(sets.map(([k]) => [k, { cells: [] as number[], all: [] as number[] }]));
  const dv = new Map(sets.map(([k]) => [k, { surface: [] as number[], all: [] as number[] }]));
  const gv = new Map(sets.map(([k]) => [k, [] as number[]]));
  let groundSections = 0;
  // A cold pass first (window caches, JIT), not counted.
  for (const n of sections) for (const [, r] of sets) deriveChunk(n, r, classes);
  let surfaceSections = 0;
  const last = new Map<string, [number, number]>();
  for (let round = 0; round < rounds; round++) {
    let k = 0;
    for (const n of sections) {
      const order = (k++ + round) % 2 === 0 ? sets : [sets[1]!, sets[0]!];
      let detail = false;
      let surface = false;
      for (const [name, r] of order) {
        const t0 = performance.now();
        evaluateAssembly(n, r, classes);
        const count = evaluateCases(n, r, 0, cases);
        const evUs = (performance.now() - t0) * 1000;
        if (count > 0) detail = true;
        const tg = performance.now();
        const g = terrainSurface(n, classes);
        const gUs = (performance.now() - tg) * 1000;
        if (g.indices.length > 0) gv.get(name)!.push(evUs + gUs);
        const t1 = performance.now();
        const d = deriveChunk(n, r, classes);
        const dUs = (performance.now() - t1) * 1000;
        if (d.ground.indices.length + d.base.indices.length + d.instances.count > 0) surface = true;
        ev.get(name)!.all.push(evUs);
        dv.get(name)!.all.push(dUs);
        last.set(name, [evUs, dUs]);
      }
      // Both sets measured: the section counts as bearing detail (or a surface) for both or neither.
      for (const [name] of sets) {
        const [evUs, dUs] = last.get(name)!;
        if (detail) ev.get(name)!.cells.push(evUs);
        if (surface) dv.get(name)!.surface.push(dUs);
      }
      if (round === 0 && surface) surfaceSections++;
      if (round === 0 && gv.get('kits')!.length > groundSections) groundSections = gv.get('kits')!.length;
    }
  }
  return {
    evaluate: { terrain: { cells: q2(ev.get('terrain')!.cells), all: q2(ev.get('terrain')!.all) }, kits: { cells: q2(ev.get('kits')!.cells), all: q2(ev.get('kits')!.all) } },
    derive: { terrain: { surface: q2(dv.get('terrain')!.surface), all: q2(dv.get('terrain')!.all) }, kits: { surface: q2(dv.get('kits')!.surface), all: q2(dv.get('kits')!.all) } },
    surfaceSections,
    ground: { terrain: q2(gv.get('terrain')!), kits: q2(gv.get('kits')!) },
    groundSections,
  };
}

/** The case extraction alone (the 46c.2 measurement) and the keys and cases seen. */
function measureExtraction(sections: readonly Neighbourhood[], rounds: number): { coldMs: number; roundMs: number[]; cells: number; withCellsCount: number; us: { all: { p50: number; p95: number }; withCells: { p50: number; p95: number } }; keys: number; cases: Map<string, number>; cat: CaseCatalogue } {
  const cat = new CaseCatalogue(DRAFT_CASE_CATALOGUE);
  const out = new Uint16Array(sections[0]!.values.length);
  const t0 = performance.now();
  for (const n of sections) cat.extract(n, PAD, PAD + SECTION, out);
  const coldMs = performance.now() - t0;
  const all: number[] = [];
  const withCells: number[] = [];
  const roundMs: number[] = [];
  let cells = 0;
  for (let r = 0; r < rounds; r++) {
    const r0 = performance.now();
    cells = 0;
    for (const n of sections) {
      const s0 = performance.now();
      const count = cat.extract(n, PAD, PAD + SECTION, out);
      const us = (performance.now() - s0) * 1000;
      all.push(us);
      if (count > 0) withCells.push(us);
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
  return { coldMs, roundMs, cells, withCellsCount: withCells.length / rounds, us: { all: q2(all), withCells: q2(withCells) }, keys: keys.size, cases, cat };
}

function main(): void {
  const at = (name: string, dflt: string): string => {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : dflt;
  };
  const rounds = Number(at('--rounds', '3'));
  const worlds = at('--worlds', 'town,slice').split(',');
  const outDir = at('--out', benchDir('cases'));
  mkdirSync(outDir, { recursive: true });
  const started = new Date().toISOString();
  const load0 = loadavg();
  const reports: Array<Record<string, unknown>> = [];
  const md = [`# Case pass and the kit rule set (${started})`, ''];
  for (const world of worlds) {
    let sections: Neighbourhood[];
    let window: string;
    if (world === 'town') {
      const store = createWorldStore(grid);
      loadArea(townWorld({ footprint: TOWN_FOOTPRINT }).grids[0]!, store, 0, 0, TOWN_FOOTPRINT, TOWN_FOOTPRINT);
      sections = sectionsOf(store, 0, 0, TOWN_FOOTPRINT, TOWN_FOOTPRINT);
      window = `whole ${TOWN_FOOTPRINT}² town`;
    } else if (world === 'slice') {
      const slice = buildSliceWorld();
      const [sx, , sz] = slice.scene;
      // The slice page's drawn ring round the scene.
      sections = sectionsOf(slice.store, sx - 192, sz - 192, sx + 192, sz + 192);
      window = 'slice ring ±192 cells';
    } else throw new Error(`unknown world ${world}`);
    const x = measureExtraction(sections, rounds);
    const composed = measureComposed(sections, rounds);
    const cat = x.cat;
    reports.push({
      world,
      window,
      sections: sections.length,
      sectionsWithCells: x.withCellsCount,
      detailCells: x.cells,
      keysSeen: x.keys,
      extractionUs: x.us,
      coldPassMs: Math.round(x.coldMs),
      roundMs: x.roundMs.map(Math.round),
      composed,
      cases: Object.fromEntries([...x.cases].sort((a, b) => b[1] - a[1])),
      neverSeen: cat.cases.filter((c) => !x.cases.has(c.id)).map((c) => c.id),
    });
    const c = composed;
    md.push(
      `## ${world} (${window})`,
      '',
      `- ${sections.length} sections of 16³, ${x.withCellsCount} with detail-bearing cells, ${x.cells} cells, ${x.keys} case keys seen.`,
      `- Case extraction alone, µs a section p50 / p95: with cells ${x.us.withCells.p50} / ${x.us.withCells.p95}, all ${x.us.all.p50} / ${x.us.all.p95} (${rounds} rounds: ${x.roundMs.map(Math.round).join(', ')} ms; cold pass ${Math.round(x.coldMs)} ms).`,
      `- Evaluation µs p50 / p95, sections with detail cells: terrain rules ${c.evaluate.terrain.cells.p50} / ${c.evaluate.terrain.cells.p95}, kit rules (terrain + cases) ${c.evaluate.kits.cells.p50} / ${c.evaluate.kits.cells.p95}; all sections: ${c.evaluate.terrain.all.p50} / ${c.evaluate.terrain.all.p95} vs ${c.evaluate.kits.all.p50} / ${c.evaluate.kits.all.p95}.`,
      `- Section derive (evaluation + meshes) µs p50 / p95, ${c.surfaceSections} sections with a surface: terrain rules ${c.derive.terrain.surface.p50} / ${c.derive.terrain.surface.p95}, kit rules ${c.derive.kits.surface.p50} / ${c.derive.kits.surface.p95}; all sections: ${c.derive.terrain.all.p50} / ${c.derive.terrain.all.p95} vs ${c.derive.kits.all.p50} / ${c.derive.kits.all.p95}.`,
      `- Evaluation + ground mesh µs p50 / p95 (46b's measure), ${c.groundSections} sections with ground: terrain rules ${c.ground.terrain.p50} / ${c.ground.terrain.p95}, kit rules ${c.ground.kits.p50} / ${c.ground.kits.p95}.`,
      `- Cases: ${[...x.cases].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id} ${n}`).join(', ')}; never seen: ${cat.cases.filter((k) => !x.cases.has(k.id)).map((k) => k.id).join(', ') || 'none'}.`,
      '',
    );
  }
  const json = {
    started,
    node: process.version,
    host: { cpus: `${cpus().length} × ${cpus()[0]?.model ?? '?'}`, loadavg: [load0, loadavg()], uptimeH: uptime() / 3600 },
    catalogue: { id: DRAFT_CASE_CATALOGUE.id, version: DRAFT_CASE_CATALOGUE.version, draft: DRAFT_CASE_CATALOGUE.draft, cases: DRAFT_CASE_CATALOGUE.cases.length, rules: DRAFT_CASE_CATALOGUE.rules.length },
    rules: { terrain: `${TERRAIN_RULES.id} v${TERRAIN_RULES.version}`, kits: `${KIT_RULES.id} v${KIT_RULES.version}` },
    worlds: reports,
  };
  md.splice(2, 0, `Node ${process.version}, ${json.host.cpus}, load ${load0.map((l) => l.toFixed(1)).join(' / ')}, uptime ${(uptime() / 86400).toFixed(1)} d. Catalogue ${json.catalogue.id} v${json.catalogue.version}${json.catalogue.draft ? ' (DRAFT)' : ''}: ${json.catalogue.cases} cases, ${json.catalogue.rules} rules.`, '');
  writeFileSync(join(outDir, 'cases.json'), JSON.stringify(json, null, 2));
  writeFileSync(join(outDir, 'cases.md'), md.join('\n'));
  console.log(md.join('\n'));
}

main();
