/**
 * The case pass on the whole town and the slice ring: µs a 16³ section to
 * extract every construction cell's window case with the world catalogue
 * (none since the edge catalogue has no window rules; Node, this thread; a
 * cold pass with an empty window cache, then measured passes), the
 * detail-bearing cells, the case keys
 * seen and how often each case occurs; and the world rule set against the
 * terrain rules alone, measured the way a derive job runs them: the
 * evaluation (classes, plus cases for the world rules) and
 * the whole section derive (evaluation and meshes), interleaved section by
 * section; and what the consumers receive a chunk (derived bytes by part,
 * collision boxes) under the world rules; or (`--pieces`) the kit pieces: the piece table's bytes and the
 * instances a chunk and a level-1 node list without and with a test kit;
 * or (`--roofs`) the roof mesher: µs a 16³ section with plane cells (the
 * classification and the planes), and the roofs' triangles against the
 * same cells drawn as stair faces (their role read as wall), or
 * (`--edges`) the edge catalogue's passes (window cases, none now, plus the
 * edge pass), section by section, and the edge pieces by case.
 *
 *   node tools/voxel-bench/run.mjs cases [--worlds town,slice] [--rounds 3] [--consumers-only | --pieces | --edges | --roofs] [--out DIR]
 *
 * Writes cases.md and cases.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, uptime } from 'node:os';
import { join } from 'node:path';
import {
  buildApron,
  buildPieceTable,
  CaseCatalogue,
  caseWindowAt,
  chunkGrid,
  chunkOfKey,
  createDenseChunk,
  createEdgeMasks,
  createNeighbourhood,
  createWorldStore,
  cropNeighbourhood,
  deriveChunk,
  derivedBytes,
  derivedPartBytes,
  deriveFromStore,
  deriveMipNode,
  EDGE_CASE_CATALOGUE,
  EDGE_CASE_IDS,
  EDGE_RULES,
  edgePiecesOf,
  evaluateAssembly,
  evaluateCases,
  evaluateEdges,
  fillNeighbourhood,
  isConstructionRole,
  MipTree,
  NO_CASE,
  PLACEHOLDER_RULES,
  jobRadius,
  classifyRoofs,
  roofSurface,
  valueMaterial,
  valueOf,
  valueShape,
  valueWetness,
  VOXEL_ROLE,
  TERRAIN_RULES,
  terrainSurface,
  valueRole,
  type AssemblyRuleSet,
  type DerivedData,
  type Neighbourhood,
  type PaletteStore,
  WORLD_RULES,
} from '@thirdlight/voxel';
import { benchDir } from './bench-dirs';
import { loadArea } from './regions';
import { buildSliceWorld, TOWN_FOOTPRINT } from './slice-world';
import { BUILDING_MATERIALS, fullTestKit } from './test-kits';
import { townWorld } from './town';

const grid = chunkGrid(32);
const E = grid.edge;
const SECTION = 16;
const PAD = jobRadius(WORLD_RULES);

const pct = (xs: readonly number[], p: number): number => {
  if (xs.length === 0) return NaN;
  const s = Float64Array.from(xs).sort();
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const q2 = (xs: readonly number[]): { p50: number; p95: number } => ({ p50: Math.round(pct(xs, 0.5)), p95: Math.round(pct(xs, 0.95)) });

/** Every stored chunk inside [x0, x1) × [z0, z1) and the chunk under it. */
function chunksOf(store: PaletteStore, x0: number, z0: number, x1: number, z1: number): Array<[number, number, number]> {
  const chunks = new Set<string>();
  const c = { cx: 0, cy: 0, cz: 0 };
  for (const key of store.chunkKeys()) {
    chunkOfKey(grid, key, c);
    if (c.cx * E < x0 || (c.cx + 1) * E > x1 || c.cz * E < z0 || (c.cz + 1) * E > z1) continue;
    chunks.add(`${c.cx},${c.cy},${c.cz}`);
    chunks.add(`${c.cx},${c.cy - 1},${c.cz}`);
  }
  return [...chunks].sort().map((id) => id.split(',').map(Number) as [number, number, number]);
}

/** Every 16³ section of the chunks, cut from its chunk's job neighbourhood. */
function sectionsOf(store: PaletteStore, chunks: ReadonlyArray<readonly [number, number, number]>): Neighbourhood[] {
  const full = createNeighbourhood(E, PAD);
  const dense = createDenseChunk(grid);
  const sections: Neighbourhood[] = [];
  for (const [cx, cy, cz] of chunks) {
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
  /** The evaluation (classes; with the world rules, classes and cases), sections with detail-bearing cells and all. */
  evaluate: { terrain: { cells: { p50: number; p95: number }; all: { p50: number; p95: number } }; world: { cells: { p50: number; p95: number }; all: { p50: number; p95: number } } };
  /** The whole section derive (evaluation and meshes; deriveChunk), sections with a surface (ground, base or pieces) and all. */
  derive: { terrain: { surface: { p50: number; p95: number }; all: { p50: number; p95: number } }; world: { surface: { p50: number; p95: number }; all: { p50: number; p95: number } } };
  surfaceSections: number;
  /** The evaluation and the terrain mesher's ground surface (the terrain mesher's measure), sections with ground triangles. */
  ground: { terrain: { p50: number; p95: number }; world: { p50: number; p95: number } };
  groundSections: number;
}

/**
 * The terrain rules alone against the world rules, section by section, the
 * order alternating so neither runs on the other's warm caches every time.
 */
function measureComposed(sections: readonly Neighbourhood[], rounds: number): Composed {
  const classes = new Uint8Array(sections[0]!.values.length);
  const cases = new Uint16Array(sections[0]!.values.length);
  const sets: Array<[string, AssemblyRuleSet]> = [['terrain', TERRAIN_RULES], ['world', WORLD_RULES]];
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
      if (round === 0 && gv.get('world')!.length > groundSections) groundSections = gv.get('world')!.length;
    }
  }
  return {
    evaluate: { terrain: { cells: q2(ev.get('terrain')!.cells), all: q2(ev.get('terrain')!.all) }, world: { cells: q2(ev.get('world')!.cells), all: q2(ev.get('world')!.all) } },
    derive: { terrain: { surface: q2(dv.get('terrain')!.surface), all: q2(dv.get('terrain')!.all) }, world: { surface: q2(dv.get('world')!.surface), all: q2(dv.get('world')!.all) } },
    surfaceSections,
    ground: { terrain: q2(gv.get('terrain')!), world: q2(gv.get('world')!) },
    groundSections,
  };
}

/** What the consumers receive a chunk (whole 32³ chunks, world rules): bytes per part and collision boxes, over the chunks with construction (a base surface or pieces). */
interface Consumers {
  chunks: number;
  built: number;
  /** Sums over the built chunks. */
  total: { bytes: number; collision: number; light: number; nav: number; base: number; fullBoxes: number; partialBoxes: number; instances: number; baseTriangles: number };
  /** Per built chunk p50 / p95. */
  perChunk: { bytes: { p50: number; p95: number }; fullBoxes: { p50: number; p95: number }; partialBoxes: { p50: number; p95: number } };
}

function measureConsumers(store: PaletteStore, chunks: ReadonlyArray<readonly [number, number, number]>): Consumers {
  const total = { bytes: 0, collision: 0, light: 0, nav: 0, base: 0, fullBoxes: 0, partialBoxes: 0, instances: 0, baseTriangles: 0 };
  const bytes: number[] = [];
  const full: number[] = [];
  const partial: number[] = [];
  for (const [cx, cy, cz] of chunks) {
    const d = deriveFromStore(store, cx, cy, cz, WORLD_RULES);
    if (d.base.indices.length === 0 && d.instances.count === 0) continue;
    const parts = derivedPartBytes(d);
    const b = derivedBytes(d);
    const boxes = d.collision.boxes.length / 6;
    total.bytes += b;
    total.collision += parts.collision;
    total.light += parts.light;
    total.nav += parts.nav;
    total.base += parts.base;
    total.fullBoxes += d.collision.fullBoxes;
    total.partialBoxes += boxes - d.collision.fullBoxes;
    total.instances += d.instances.count;
    total.baseTriangles += d.base.indices.length / 3;
    bytes.push(b);
    full.push(d.collision.fullBoxes);
    partial.push(boxes - d.collision.fullBoxes);
  }
  return { chunks: chunks.length, built: bytes.length, total, perChunk: { bytes: q2(bytes), fullBoxes: q2(full), partialBoxes: q2(partial) } };
}

/** Instances a derive unit lists, per level, with no kit and with a full test kit bound to the building materials. */
interface PieceCounts {
  units: number;
  total: number;
  perUnit: { p50: number; p95: number; max: number };
  deriveMs: number;
}

/**
 * Kit pieces (piece table, the world's rule set): the table's bytes for one
 * and for six full test kits, and the instances each 32³ chunk (level 0) and
 * level-1 node lists without a kit and with one full test kit, and the
 * whole derive's ms for each.
 */
function measurePieces(store: PaletteStore, chunks: ReadonlyArray<readonly [number, number, number]>): Record<string, unknown> {
  const one = buildPieceTable([fullTestKit('town', BUILDING_MATERIALS, 2)], WORLD_RULES, 0).table;
  const six = buildPieceTable(BUILDING_MATERIALS.map((m, k) => fullTestKit(`kit-${k}`, [m], 4)), WORLD_RULES, 0).table;
  const tree = new MipTree(store);
  const nodes = [...new Set(chunks.map(([x, y, z]) => `${x >> 1},${y >> 1},${z >> 1}`))].map((k) => k.split(',').map(Number) as [number, number, number]);
  const count = (units: ReadonlyArray<readonly [number, number, number]>, derive: (u: readonly [number, number, number]) => DerivedData): PieceCounts => {
    const per: number[] = [];
    const t0 = performance.now();
    for (const u of units) {
      const d = derive(u);
      if (d.instances.count === 0) continue;
      per.push(d.instances.count);
    }
    const ms = performance.now() - t0;
    return { units: per.length, total: per.reduce((a, b) => a + b, 0), perUnit: { ...q2(per), max: Math.max(0, ...per) }, deriveMs: Math.round(ms) };
  };
  return {
    tableBytes: { oneKit: one.bytes.length, sixKits: six.bytes.length, noKit: 0 },
    level0: {
      noKit: count(chunks, ([x, y, z]) => deriveFromStore(store, x, y, z, WORLD_RULES)),
      kit: count(chunks, ([x, y, z]) => deriveFromStore(store, x, y, z, WORLD_RULES, undefined, one)),
    },
    level1: {
      noKit: count(nodes, ([x, y, z]) => deriveMipNode(tree, { level: 1, nx: x, ny: y, nz: z }, WORLD_RULES)),
      kit: count(nodes, ([x, y, z]) => deriveMipNode(tree, { level: 1, nx: x, ny: y, nz: z }, WORLD_RULES, undefined, one)),
    },
  };
}

/**
 * The roof mesher a section at a time: classification and planes (µs,
 * sections with a plane cell), the section's whole derive with them, and its
 * base triangles against the same voxels with every roof cell read as a
 * wall (the stair's faces, what the base surface drew before).
 */
function measureRoofs(sections: readonly Neighbourhood[], rounds: number): Record<string, unknown> {
  const words = new Uint32Array(sections[0]!.values.length);
  const us: number[] = [];
  const classifyUs: number[] = [];
  const deriveUs: number[] = [];
  let planeCells = 0;
  let roofSections = 0;
  let rampTris = 0;
  let after = 0;
  let before = 0;
  for (let round = 0; round < rounds; round++) {
    for (const n of sections) {
      let roofs = false;
      for (let i = 0; i < n.values.length && !roofs; i++) roofs = valueRole(n.values[i]!) === VOXEL_ROLE.roof;
      if (!roofs) continue;
      const t = performance.now();
      const cells = classifyRoofs(n, words);
      const tc = performance.now();
      const ramps = cells === 0 ? null : roofSurface(n, words);
      const t1 = performance.now();
      if (cells === 0) continue;
      us.push((t1 - t) * 1000);
      classifyUs.push((tc - t) * 1000);
      const t2 = performance.now();
      const d = deriveChunk(n, WORLD_RULES);
      deriveUs.push((performance.now() - t2) * 1000);
      if (round > 0) continue;
      roofSections++;
      planeCells += cells;
      rampTris += ramps!.indices.length / 3;
      after += d.base.indices.length / 3;
      const asWall = { ...n, values: Uint32Array.from(n.values, (v) => (valueRole(v) === VOXEL_ROLE.roof ? valueOf({ material: valueMaterial(v), role: VOXEL_ROLE.wall, shape: valueShape(v), wetness: valueWetness(v) }) : v)) };
      before += deriveChunk(asWall, WORLD_RULES).base.indices.length / 3;
    }
  }
  return { roofSections, planeCells, us: q2(us), classifyUs: q2(classifyUs), deriveUs: q2(deriveUs), rampTriangles: rampTris, baseTriangles: { stairFaces: before, planes: after } };
}

/**
 * The edge catalogue's passes (window cases for beams and banisters, then
 * the edge pass), a section at a time; sections with construction only.
 */
function measureEdges(sections: readonly Neighbourhood[], rounds: number): Record<string, unknown> {
  const cases = new Uint16Array(sections[0]!.values.length);
  const masks = createEdgeMasks(sections[0]!);
  const now: number[] = [];
  const edgesOnly: number[] = [];
  const byCase: Record<string, number> = Object.fromEntries(EDGE_CASE_IDS.map((id) => [id, 0]));
  let owners = 0;
  let built = 0;
  for (const n of sections) {
    evaluateCases(n, EDGE_RULES, 0, cases);
    evaluateEdges(n, EDGE_RULES, 0, masks);
  }
  for (let round = 0; round < rounds; round++) {
    for (const n of sections) {
      let has = false;
      for (let i = 0; i < n.values.length && !has; i++) has = isConstructionRole(valueRole(n.values[i]!));
      if (!has) continue;
      const runNew = (): [number, number] => {
        const t = performance.now();
        evaluateCases(n, EDGE_RULES, 0, cases);
        const te = performance.now();
        const count = evaluateEdges(n, EDGE_RULES, 0, masks);
        const t1 = performance.now();
        if (round === 0) {
          owners += count;
          const s = n.side;
          for (let x = PAD; x < PAD + SECTION; x++) for (let z = PAD; z < PAD + SECTION; z++) for (let y = PAD; y < PAD + SECTION; y++) {
            const i = (x * s + z) * s + y;
            if (masks.pieces[i] !== 0) for (const p of edgePiecesOf(masks, i)) byCase[p.caseId]!++;
          }
        }
        return [(t1 - t) * 1000, (t1 - te) * 1000];
      };
      const [a, e] = runNew();
      now.push(a);
      edgesOnly.push(e);
      if (round === 0) built++;
    }
  }
  return { sectionsWithConstruction: built, edgeCataloguePassesUs: q2(now), edgePassAloneUs: q2(edgesOnly), owners, pieces: byCase, totalPieces: Object.values(byCase).reduce((a, b) => a + b, 0) };
}

/** The case extraction alone (the extraction cost) and the keys and cases seen. */
function measureExtraction(sections: readonly Neighbourhood[], rounds: number): { coldMs: number; roundMs: number[]; cells: number; withCellsCount: number; us: { all: { p50: number; p95: number }; withCells: { p50: number; p95: number } }; keys: number; cases: Map<string, number>; cat: CaseCatalogue } {
  const cat = new CaseCatalogue(EDGE_CASE_CATALOGUE);
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
      const id = m.caseId ?? '(none)';
      cases.set(id, (cases.get(id) ?? 0) + 1);
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
  const md = [`# Case pass and the world rule set (${started})`, ''];
  for (const world of worlds) {
    let store: PaletteStore;
    let chunks: Array<[number, number, number]>;
    let window: string;
    if (world === 'town') {
      store = createWorldStore(grid);
      loadArea(townWorld({ footprint: TOWN_FOOTPRINT }).grids[0]!, store, 0, 0, TOWN_FOOTPRINT, TOWN_FOOTPRINT);
      chunks = chunksOf(store, 0, 0, TOWN_FOOTPRINT, TOWN_FOOTPRINT);
      window = `whole ${TOWN_FOOTPRINT}² town`;
    } else if (world === 'slice') {
      const slice = buildSliceWorld();
      const [sx, , sz] = slice.scene;
      store = slice.store;
      // The slice page's drawn ring round the scene.
      chunks = chunksOf(store, sx - 192, sz - 192, sx + 192, sz + 192);
      window = 'slice ring ±192 cells';
    } else throw new Error(`unknown world ${world}`);
    if (process.argv.includes('--roofs')) {
      const roofs = measureRoofs(sectionsOf(store, chunks), rounds);
      reports.push({ world, window, roofs });
      md.push(`## ${world} (${window})`, '', `- Roofs: ${JSON.stringify(roofs)}`, '');
      continue;
    }
    if (process.argv.includes('--edges')) {
      const edges = measureEdges(sectionsOf(store, chunks), rounds);
      reports.push({ world, window, edges });
      md.push(`## ${world} (${window})`, '', `- Edges: ${JSON.stringify(edges)}`, '');
      continue;
    }
    if (process.argv.includes('--pieces')) {
      const pieces = measurePieces(store, chunks);
      reports.push({ world, window, pieces });
      md.push(`## ${world} (${window})`, '', `- Pieces: ${JSON.stringify(pieces)}`, '');
      continue;
    }
    const consumers = measureConsumers(store, chunks);
    if (process.argv.includes('--consumers-only')) {
      reports.push({ world, window, consumers });
      md.push(`## ${world} (${window})`, '', `- Consumers: ${JSON.stringify(consumers)}`, '');
      continue;
    }
    const sections = sectionsOf(store, chunks);
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
      consumers,
      cases: Object.fromEntries([...x.cases].sort((a, b) => b[1] - a[1])),
      neverSeen: cat.cases.filter((c) => !x.cases.has(c.id)).map((c) => c.id),
    });
    const c = composed;
    md.push(
      `## ${world} (${window})`,
      '',
      `- ${sections.length} sections of 16³, ${x.withCellsCount} with detail-bearing cells, ${x.cells} cells, ${x.keys} case keys seen.`,
      `- Case extraction alone, µs a section p50 / p95: with cells ${x.us.withCells.p50} / ${x.us.withCells.p95}, all ${x.us.all.p50} / ${x.us.all.p95} (${rounds} rounds: ${x.roundMs.map(Math.round).join(', ')} ms; cold pass ${Math.round(x.coldMs)} ms).`,
      `- Evaluation µs p50 / p95, sections with detail cells: terrain rules ${c.evaluate.terrain.cells.p50} / ${c.evaluate.terrain.cells.p95}, world rules (terrain + cases + run sections + edges) ${c.evaluate.world.cells.p50} / ${c.evaluate.world.cells.p95}; all sections: ${c.evaluate.terrain.all.p50} / ${c.evaluate.terrain.all.p95} vs ${c.evaluate.world.all.p50} / ${c.evaluate.world.all.p95}.`,
      `- Section derive (evaluation + meshes) µs p50 / p95, ${c.surfaceSections} sections with a surface: terrain rules ${c.derive.terrain.surface.p50} / ${c.derive.terrain.surface.p95}, world rules ${c.derive.world.surface.p50} / ${c.derive.world.surface.p95}; all sections: ${c.derive.terrain.all.p50} / ${c.derive.terrain.all.p95} vs ${c.derive.world.all.p50} / ${c.derive.world.all.p95}.`,
      `- Evaluation + ground mesh µs p50 / p95 (the terrain mesher's measure), ${c.groundSections} sections with ground: terrain rules ${c.ground.terrain.p50} / ${c.ground.terrain.p95}, world rules ${c.ground.world.p50} / ${c.ground.world.p95}.`,
      `- Consumers (whole 32³ chunks, world rules), ${consumers.built} of ${consumers.chunks} chunks with construction: derived bytes ${consumers.total.bytes} (collision ${consumers.total.collision}, light ${consumers.total.light}, nav ${consumers.total.nav}, base ${consumers.total.base}); boxes full ${consumers.total.fullBoxes}, partial ${consumers.total.partialBoxes}; instances ${consumers.total.instances}; base triangles ${consumers.total.baseTriangles}. A chunk p50 / p95: bytes ${consumers.perChunk.bytes.p50} / ${consumers.perChunk.bytes.p95}, full boxes ${consumers.perChunk.fullBoxes.p50} / ${consumers.perChunk.fullBoxes.p95}, partial ${consumers.perChunk.partialBoxes.p50} / ${consumers.perChunk.partialBoxes.p95}.`,
      `- Cases: ${[...x.cases].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id} ${n}`).join(', ')}; never seen: ${cat.cases.filter((k) => !x.cases.has(k.id)).map((k) => k.id).join(', ') || 'none'}.`,
      '',
    );
  }
  const json = {
    started,
    node: process.version,
    host: { cpus: `${cpus().length} × ${cpus()[0]?.model ?? '?'}`, loadavg: [load0, loadavg()], uptimeH: uptime() / 3600 },
    catalogue: { id: EDGE_CASE_CATALOGUE.id, version: EDGE_CASE_CATALOGUE.version, draft: EDGE_CASE_CATALOGUE.draft, cases: EDGE_CASE_CATALOGUE.cases.length, rules: EDGE_CASE_CATALOGUE.rules.length },
    rules: { terrain: `${TERRAIN_RULES.id} v${TERRAIN_RULES.version}`, world: `${WORLD_RULES.id} v${WORLD_RULES.version}` },
    worlds: reports,
  };
  md.splice(2, 0, `Node ${process.version}, ${json.host.cpus}, load ${load0.map((l) => l.toFixed(1)).join(' / ')}, uptime ${(uptime() / 86400).toFixed(1)} d. Catalogue ${json.catalogue.id} v${json.catalogue.version}${json.catalogue.draft ? ' (DRAFT)' : ''}: ${json.catalogue.cases} cases, ${json.catalogue.rules} rules.`, '');
  writeFileSync(join(outDir, 'cases.json'), JSON.stringify(json, null, 2));
  writeFileSync(join(outDir, 'cases.md'), md.join('\n'));
  console.log(md.join('\n'));
}

main();
