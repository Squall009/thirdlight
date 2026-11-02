/**
 * What joining a chunk's derive sections into one draw costs on the thread
 * that draws (chunk-join.ts): µs a chunk, split into surfaces and shader
 * grid, the vertices the unwelded section faces add, on the slice world
 * (hilly ground and the wall-beam-banister scene) and the town.
 *
 *   node tools/voxel-bench/run.mjs join [--section 16] [--rounds 3] [--out DIR]
 *
 * Every chunk within 192 cells of the slice's scene (horizontally) and every
 * chunk of the 256 m town whose neighbourhood holds anything other than air
 * is derived on this thread as sections (one apron a chunk, the worker's
 * path), joined `--rounds` times (the first round is reported apart: cold
 * code and caches), and checked against the whole-chunk derive (triangle and
 * instance counts, shader bytes). Only chunks that draw something are
 * joined, as a renderer joins only what a `chunk` event names with a draw.
 * Writes join.md / join.json to --out.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, homedir, loadavg } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  buildApron,
  chunkGrid,
  chunkOfKey,
  createWorldStore,
  deriveSectionsWithApron,
  deriveWithApron,
  encodeShader,
  jobRadius,
  joinSections,
  PLACEHOLDER_RULES,
  type DenseChunk,
  type DerivedData,
  type JoinTimes,
  type PaletteStore,
} from '@thirdlight/voxel';
import { loadArea } from './regions';
import { buildSliceWorld } from './slice-world';
import { townWorld } from './town';

const grid = chunkGrid(32);
const E = grid.edge;
const R = jobRadius(PLACEHOLDER_RULES);

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : dflt;
}

function log(s: string): void {
  console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
}

const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const stats = (xs: number[]): { p50: number; p95: number; max: number; mean: number } => ({
  p50: Number(pct(xs, 50).toFixed(1)),
  p95: Number(pct(xs, 95).toFixed(1)),
  max: Number(Math.max(0, ...xs).toFixed(1)),
  mean: Number((xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)),
});

interface Row {
  coldUs: number;
  warmUs: number[];
  surfacesUs: number;
  shaderUs: number;
  vertsWhole: number;
  vertsJoined: number;
  tris: number;
  grid: boolean;
}

/** Chunks holding anything, and their neighbours, inside [x0, x1) × [z0, z1) cells. */
function targets(store: PaletteStore, x0: number, z0: number, x1: number, z1: number): Array<[number, number, number]> {
  const out = new Set<string>();
  const c = { cx: 0, cy: 0, cz: 0 };
  for (const key of store.chunkKeys()) {
    chunkOfKey(grid, key, c);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const x = c.cx + dx;
      const z = c.cz + dz;
      if (x * E >= x0 && (x + 1) * E <= x1 && z * E >= z0 && (z + 1) * E <= z1) out.add(`${x},${c.cy + dy},${z}`);
    }
  }
  return [...out].sort().map((k) => k.split(',').map(Number) as [number, number, number]);
}

function measure(name: string, store: PaletteStore, x0: number, z0: number, x1: number, z1: number, edge: number, rounds: number): { name: string; rows: Row[]; mismatches: number; chunks: number } {
  const n = E / edge;
  const ids = Array.from({ length: n * n * n }, (_, i) => i);
  const rows: Row[] = [];
  let mismatches = 0;
  const list = targets(store, x0, z0, x1, z1);
  for (const [cx, cy, cz] of list) {
    const apron = buildApron(store, cx, cy, cz, R);
    const exportChunk = (out: DenseChunk): boolean => store.exportChunk(cx, cy, cz, out);
    const whole: DerivedData = deriveWithApron(grid, PLACEHOLDER_RULES, apron, exportChunk);
    const drawn = whole.ground.indices.length + whole.base.indices.length + whole.instances.count > 0;
    if (!drawn) continue;
    const sections = deriveSectionsWithApron(grid, PLACEHOLDER_RULES, buildApron(store, cx, cy, cz, R), exportChunk, edge, ids).map((r) => r.assembly);
    const times: JoinTimes = { surfacesUs: 0, shaderUs: 0 };
    let t0 = performance.now();
    const joined = joinSections(E, edge, sections, times);
    const coldUs = (performance.now() - t0) * 1000;
    const warmUs: number[] = [];
    for (let r = 1; r < rounds; r++) {
      t0 = performance.now();
      joinSections(E, edge, sections);
      warmUs.push((performance.now() - t0) * 1000);
    }
    const same =
      joined.ground.indices.length === whole.ground.indices.length &&
      joined.base.indices.length === whole.base.indices.length &&
      joined.instances.count === whole.instances.count &&
      Buffer.from(encodeShader(joined.shader)).equals(Buffer.from(encodeShader(whole.shader)));
    if (!same) mismatches++;
    rows.push({
      coldUs,
      warmUs,
      surfacesUs: times.surfacesUs,
      shaderUs: times.shaderUs,
      vertsWhole: whole.ground.vertexCount + whole.base.vertexCount,
      vertsJoined: joined.ground.vertexCount + joined.base.vertexCount,
      tris: (whole.ground.indices.length + whole.base.indices.length) / 3,
      grid: whole.shader.width > 0,
    });
  }
  return { name, rows, mismatches, chunks: list.length };
}

function main(): void {
  const edge = Number(arg('--section', '16'));
  const rounds = Math.max(2, Number(arg('--rounds', '3')));
  const outDir = arg('--out', join(homedir(), '.cache', 'thirdlight-phase46', 'work', '46a.5a'));
  mkdirSync(outDir, { recursive: true });
  const started = new Date().toISOString();
  const load0 = loadavg();
  const worlds: Array<ReturnType<typeof measure>> = [];
  {
    const t0 = performance.now();
    const slice = buildSliceWorld();
    const [sx, , sz] = slice.scene;
    log(`slice world built in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    worlds.push(measure('slice', slice.store, sx - 192, sz - 192, sx + 192, sz + 192, edge, rounds));
  }
  {
    const store = createWorldStore(grid);
    loadArea(townWorld({ footprint: 512 }).grids[0]!, store, 0, 0, 512, 512);
    worlds.push(measure('town', store, 0, 0, 512, 512, edge, rounds));
  }
  const report = worlds.map((w) => {
    const warm = w.rows.flatMap((r) => r.warmUs);
    const vw = w.rows.reduce((a, r) => a + r.vertsWhole, 0);
    const vj = w.rows.reduce((a, r) => a + r.vertsJoined, 0);
    return {
      world: w.name,
      chunksLooked: w.chunks,
      chunksJoined: w.rows.length,
      withGrid: w.rows.filter((r) => r.grid).length,
      mismatches: w.mismatches,
      joinUs: stats(warm),
      coldUs: stats(w.rows.map((r) => r.coldUs)),
      coldSurfacesUs: stats(w.rows.map((r) => r.surfacesUs)),
      coldShaderUs: stats(w.rows.map((r) => r.shaderUs)),
      trisPerChunk: stats(w.rows.map((r) => r.tris)),
      vertices: { whole: vw, joined: vj, extraShare: Number((vw === 0 ? 0 : (vj - vw) / vw).toFixed(3)) },
    };
  });
  for (const r of report) log(`${r.world}: ${r.chunksJoined} chunks joined, join µs p50 ${r.joinUs.p50} / p95 ${r.joinUs.p95} (cold ${r.coldUs.p50} / ${r.coldUs.p95}), +${(r.vertices.extraShare * 100).toFixed(1)} % vertices, ${r.mismatches} mismatches`);
  const json = { started, node: process.version, host: { cpus: `${cpus().length} × ${cpus()[0]?.model ?? '?'}`, loadavg: [load0, loadavg()] }, sectionEdge: edge, rounds, worlds: report };
  writeFileSync(join(outDir, 'join.json'), JSON.stringify(json, null, 2));
  const md = [
    `# Join of ${edge}³ sections into 32³ chunk draws (${started})`,
    '',
    `Node ${process.version}, ${json.host.cpus}, load ${load0.map((l) => l.toFixed(1)).join(' / ')}; ${rounds} joins a chunk (first = cold).`,
    '',
    '| World | Chunks joined (with grid) | Join µs p50 / p95 / max (warm) | Cold p50 / p95 | Cold surfaces / grid µs p50 | Tris a chunk p50 | Extra vertices | Mismatches |',
    '|---|---|---|---|---|---|---|---|',
    ...report.map((r) => `| ${r.world} | ${r.chunksJoined} (${r.withGrid}) | ${r.joinUs.p50} / ${r.joinUs.p95} / ${r.joinUs.max} | ${r.coldUs.p50} / ${r.coldUs.p95} | ${r.coldSurfacesUs.p50} / ${r.coldShaderUs.p50} | ${r.trisPerChunk.p50} | ${(r.vertices.extraShare * 100).toFixed(1)} % | ${r.mismatches} |`),
    '',
  ].join('\n');
  writeFileSync(join(outDir, 'join.md'), md);
  console.log(md);
}

main();
