/**
 * The walk graph and its path queries measured (`node tools/voxel-bench/run.mjs paths …`).
 *
 * - **In Node** (always): staging's 8 km world read from its region files (the town at its middle and the dug cave;
 *   staging need not run), derived in this process with the world rules over a box round the town and one round the
 *   cave; each chunk's walk part made one at a time (ms a chunk with standable cells, beside its derive's ms), the
 *   crossings, the graph's bytes; then the fixed queries ({@link PATH_QUERIES}), each three ways (the default: one
 *   A* over the cells first, then the levels; the levels at once; one A* over the cells alone): status, length,
 *   nodes expanded, ms, and the steps it spans served at the low tier's path-finding budget (3.33 ms a step); 100
 *   queries queued at once; an edit (the room house's door walled up and dug again) to the answer that sees it.
 * - **In the browser** (`--play`, staging running): Play on the 8 km world at `--quality` (WebGPU, the viewport, the
 *   level's cap), the project's "Perf far camera" at the street camera with the bench's script: on `paths-run` it
 *   asks the fixed queries through `ctx.voxels.findPath` (`paths-cave` with the camera at the cave), on `paths-100`
 *   a hundred at once; their answers come back as counters, and the frame profile's `path finding` span (the
 *   `pathfinding` category on the simulation thread) and `walk graph stitched` are read against the budget table.
 *
 *   --play  --origin URL  --token-file FILE  --project ID (voxel-slice)  --world NAME (far)  --quality (low)
 *   --viewport WxH (1280x720)  --world-dir DIR (staging's voxel-slice `far`)  --out FILE
 *
 * How to (alone on the machine):
 *
 *   sudo -n systemd-run --scope --quiet -p MemoryMax=10G -p MemorySwapMax=0 -- sudo -n -u $USER -- \
 *     env HOME=$HOME PATH=$PATH TMPDIR=$HOME/.cache/tmp/paths node tools/voxel-bench/run.mjs paths [--play]
 *
 * Not part of `npm test`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, loadavg, uptime } from 'node:os';
import { dirname, join } from 'node:path';
import { buildApron, chunkGrid, deriveSectionsWithApron, jobRadius, sectionLocalOrigin, voxel, VOXEL_ROLE, WalkGraph, WalkQueries, WORLD_RULES, type DeriveOutput, type DerivedData, type WalkGraphView, type WalkPathAnswer, type WalkQueryOptions } from '@thirdlight/voxel';
import { pickStore } from '@thirdlight/workspace';
import { FRAME_BUDGET_BY_TIER, frameBudgetMs } from '@thirdlight/project-model';

import { benchDir } from './bench-dirs';
import { diskFeed } from './chunk-feeds';
import { PATH_QUERIES, PATH_DOOR, type PathQuery } from './path-queries';
import { pathsPlay } from './paths-play';

const args = process.argv.slice(2);
const opt = (name: string, d: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1]! : d;
};
const WORLD_DIR = opt('world-dir', join(homedir(), 'thirdlight-staging-p45', 'projects', 'voxel-slice', 'voxels', 'far'));
const OUT = opt('out', join(benchDir('paths'), `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`));
const host = () => ({ at: new Date().toISOString(), uptimeDays: Number((uptime() / 86400).toFixed(2)), load: loadavg().map((x) => Number(x.toFixed(2))) });

const grid = chunkGrid(32);
const SECTION = 16;
const IDS = Array.from({ length: 8 }, (_, i) => i);
const M = 0.5;
/** The low tier's path-finding ms a simulation step (the frame budget table's row). */
const BUDGET_MS = frameBudgetMs(FRAME_BUDGET_BY_TIER.low, 'sim', 'pathfinding');

const q = (xs: number[], p: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.floor(p * s.length))]!.toFixed(3));
};

const store = pickStore(grid);
const feed = diskFeed(WORLD_DIR, store);
const sections = new Map<string, DerivedData | null>();
const deriveMs = new Map<string, number>();

async function deriveBox(min: readonly number[], max: readonly number[]): Promise<void> {
  const need: Array<[number, number, number]> = [];
  for (let cx = min[0]! - 1; cx <= max[0]! + 1; cx++) for (let cy = min[1]! - 1; cy <= max[1]! + 1; cy++) for (let cz = min[2]! - 1; cz <= max[2]! + 1; cz++) need.push([cx, cy, cz]);
  await feed.ensure(need);
  for (let cx = min[0]!; cx <= max[0]!; cx++) for (let cy = min[1]!; cy <= max[1]!; cy++) for (let cz = min[2]!; cz <= max[2]!; cz++) derive(cx, cy, cz);
}

function derive(cx: number, cy: number, cz: number): void {
  const t0 = performance.now();
  const results = deriveSectionsWithApron(grid, WORLD_RULES, buildApron(store, cx, cy, cz, jobRadius(WORLD_RULES)), (out) => store.exportChunk(cx, cy, cz, out), SECTION, IDS);
  deriveMs.set(`${cx},${cy},${cz}`, performance.now() - t0);
  for (const r of results) {
    const [lx, ly, lz] = sectionLocalOrigin(grid.edge, SECTION, r.id);
    sections.set(`${cx * 2 + lx / SECTION},${cy * 2 + ly / SECTION},${cz * 2 + lz / SECTION}`, r.assembly);
  }
}

const view: WalkGraphView = {
  grid,
  sections: { edge: 16, shift: 4, mask: 15 } as never,
  derivedOf: (sx, sy, sz) => {
    const a = sections.get(`${sx},${sy},${sz}`);
    return a === undefined ? null : ({ assembly: a } as DeriveOutput);
  },
};

/** The fixed queries with their roofs' heights found (what the Play part asks too). */
const resolved: PathQuery[] = [];

const cellOf = (p: readonly number[]): [number, number, number] => [Math.floor(p[0]! / M), Math.floor(p[1]! / M), Math.floor(p[2]! / M)];

/** One query served at the budget a step (its steps counted) and timed whole. */
function served(g: WalkGraph, query: PathQuery, options: WalkQueryOptions): Record<string, unknown> {
  const qs = new WalkQueries(g);
  let a: WalkPathAnswer | null = null;
  const t0 = performance.now();
  qs.path(cellOf(query.from), cellOf(query.to), options, (x) => (a = x));
  let steps = 0;
  let longest = 0;
  while (a === null) {
    const s = performance.now();
    qs.serve(BUDGET_MS);
    longest = Math.max(longest, performance.now() - s);
    steps++;
  }
  const ms = performance.now() - t0;
  const ans = a as WalkPathAnswer;
  const cells = ans.cells.length / 3;
  return { status: ans.status, ...(ans.reason !== undefined ? { reason: ans.reason } : {}), lengthM: Number(ans.cost.toFixed(2)), cells, levels: ans.hierarchy, corridor: ans.corridor, expanded: { ...ans.run, ms: undefined }, ms: Number(ms.toFixed(2)), steps, longestStepMs: Number(longest.toFixed(2)), end: cells > 0 ? [...ans.cells.slice(-3)] : null };
}

async function nodePart(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { world: WORLD_DIR, budgetMs: Number(BUDGET_MS.toFixed(2)) };
  // The town (−128 … 128 m) and the long query's way (to x −110, z 112): chunks x −8 … 1, z −2 … 8 (16 m), y −2 … 2;
  // the cave's hillside round (−406, 120, 558): chunks −29 … −22, 5 … 9, 32 … 38.
  const boxes: Array<[number[], number[]]> = [[[-8, -2, -2], [1, 2, 8]], [[-29, 5, 32], [-22, 9, 38]]];
  const t0 = performance.now();
  for (const [lo, hi] of boxes) await deriveBox(lo, hi);
  out['deriveS'] = Number(((performance.now() - t0) / 1000).toFixed(1));
  const g = new WalkGraph(view, M);
  const build: number[] = [];
  const buildEmpty: number[] = [];
  const share: number[] = [];
  let bytesWith = 0;
  let withCells = 0;
  for (const [lo, hi] of boxes) for (let cx = lo[0]!; cx <= hi[0]!; cx++) for (let cy = lo[1]!; cy <= hi[1]!; cy++) for (let cz = lo[2]!; cz <= hi[2]!; cz++) {
    g.touch(cx, cy, cz);
    g.update();
    const part = g.chunkAt(cx, cy, cz);
    if (part !== null && part.ys.length > 0) {
      build.push(g.lastBuildMs);
      share.push(g.lastBuildMs / deriveMs.get(`${cx},${cy},${cz}`)!);
      withCells++;
    } else buildEmpty.push(g.lastBuildMs);
  }
  const stats = g.stats();
  for (const c of g.parts()) if (c.ys.length > 0) bytesWith += c.ys.length;
  out['graph'] = {
    ...stats,
    chunksWithCells: withCells,
    buildMs: { p50: q(build, 0.5), p95: q(build, 0.95), max: q(build, 1) },
    emptyBuildMs: { p50: q(buildEmpty, 0.5), p95: q(buildEmpty, 0.95) },
    shareOfDerive: { p50: q(share, 0.5), p95: q(share, 0.95) },
    pairMsPerChunk: Number((stats.pairMs / Math.max(1, stats.paired)).toFixed(3)),
    bytes: g.bytes,
    bytesPerChunkWithCells: Math.round(g.bytes / Math.max(1, withCells)),
    cellsPerChunkWithCells: Math.round(bytesWith / Math.max(1, withCells)),
  };
  console.log(`graph: ${JSON.stringify(out['graph'])}`);
  // The fixed queries, each three ways (a roof's height found first: the top standable cell of its column).
  const rows: Record<string, unknown>[] = [];
  const top = (p: readonly [number, number, number]): [number, number, number] => {
    const [x, , z] = cellOf(p);
    for (let cy = 4; cy >= -2; cy--) {
      const c = g.chunkAt(x >> 5, cy, z >> 5);
      if (c === null) continue;
      const col = (x & 31) * 32 + (z & 31);
      const end = c.colStart[col + 1]!;
      if (end > c.colStart[col]!) return [p[0], (cy * 32 + c.ys[end - 1]! + 0.5) * M, p[2]];
    }
    return [p[0], p[1], p[2]];
  };
  resolved.length = 0;
  for (const q0 of PATH_QUERIES) resolved.push({ ...q0, from: q0.fromTop === true ? top(q0.from) : q0.from, to: q0.toTop === true ? top(q0.to) : q0.to });
  for (const query of resolved) {
    const row: Record<string, unknown> = { name: query.name, from: query.from, to: query.to, shows: query.shows };
    row['default'] = served(g, query, {});
    row['levels'] = served(g, query, { flatFirst: 0 });
    row['flat'] = served(g, query, { hierarchy: false });
    rows.push(row);
    console.log(`${query.name}: ${JSON.stringify({ default: row['default'], levels: row['levels'], flat: row['flat'] })}`);
  }
  out['queries'] = rows;
  // A hundred at once: the street queries' ends mixed, served a budget a step.
  const ends = resolved.filter((x) => x.town).flatMap((x) => [x.from, x.to]);
  const qs = new WalkQueries(g);
  const answers: WalkPathAnswer[] = [];
  for (let k = 0; k < 100; k++) qs.path(cellOf(ends[k % ends.length]!), cellOf(ends[(k * 7 + 3) % ends.length]!), {}, (a) => answers.push(a));
  const stepMs: number[] = [];
  while (qs.queued > 0) {
    const s = performance.now();
    qs.serve(BUDGET_MS);
    stepMs.push(performance.now() - s);
  }
  out['hundred'] = { steps: stepMs.length, stepMs: { p50: q(stepMs, 0.5), p95: q(stepMs, 0.95), max: q(stepMs, 1) }, statuses: answers.reduce<Record<string, number>>((m, a) => ({ ...m, [a.status]: (m[a.status] ?? 0) + 1 }), {}), slicesPerQuery: { p50: q(answers.map((a) => a.run.slices), 0.5), max: q(answers.map((a) => a.run.slices), 1) } };
  console.log(`100 queued: ${JSON.stringify(out['hundred'])}`);
  // An edit: the room house's door walled up (its cells set to wall), then dug again (openings), each to the answer.
  const room = resolved.find((x) => x.name === 'room-street')!;
  const edit = (v: ReturnType<typeof voxel>): Record<string, unknown> => {
    const touched = new Set<string>();
    for (let x = PATH_DOOR.min[0]; x <= PATH_DOOR.max[0]; x++) for (let y = PATH_DOOR.min[1]; y <= PATH_DOOR.max[1]; y++) for (let z = PATH_DOOR.min[2]; z <= PATH_DOOR.max[2]; z++) {
      store.setVoxel(x, y, z, v);
      // The chunks a derive's apron reaches from the cell (the streamer derives them again).
      const r = jobRadius(WORLD_RULES);
      for (const ox of [-r, 0, r]) for (const oy of [-r, 0, r]) for (const oz of [-r, 0, r]) touched.add([(x + ox) >> 5, (y + oy) >> 5, (z + oz) >> 5].join(','));
    }
    const before = g.stats();
    const t1 = performance.now();
    for (const k of touched) {
      const [cx, cy, cz] = k.split(',').map(Number) as [number, number, number];
      derive(cx, cy, cz);
      g.touch(cx, cy, cz);
    }
    const t2 = performance.now();
    g.update();
    const t3 = performance.now();
    const a = served(g, room, {});
    const after = g.stats();
    return { rederived: touched.size, built: after.built - before.built, kept: after.kept - before.kept, deriveMs: Number((t2 - t1).toFixed(1)), graphMs: Number((t3 - t2).toFixed(2)), answer: a };
  };
  out['edit'] = { walled: edit(voxel(5, VOXEL_ROLE.wall, 15)), dug: edit(voxel(5, VOXEL_ROLE.opening, 0)) };
  console.log(`edit: ${JSON.stringify(out['edit'])}`);
  return out;
}

const result: Record<string, unknown> = { bench: 'paths', start: host() };
try {
  result['node'] = await nodePart();
  if (args.includes('--play')) result['play'] = await pathsPlay(opt, resolved);
} catch (e) {
  result['error'] = String(e instanceof Error ? (e.stack ?? e.message) : e).slice(0, 1200);
  console.error(result['error']);
}
result['end'] = host();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(result, null, 1)}\n`);
console.log(`paths: ${OUT}`);
process.exit(result['error'] === undefined ? 0 : 1);
