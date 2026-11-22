/**
 * The 8 km world's town with its houses placed four ways
 * (`node tools/voxel-bench/run.mjs town-grids --variant w|g0|g30|g45|restore`),
 * bench data for measuring structure grids against the world grid:
 *
 * - `w`: every house of the town's lots in the world grid at yaw 0 (the
 *   lots that hold a house in its own turned grid in the storage benches
 *   included, at yaw 0), the control;
 * - `g0`: no house in the world grid; each house in its own grid (one
 *   region file, by the anchor rule: its cell (0, 0, 0) the minimum corner
 *   of its plan box at its ground-floor row), placed at yaw 0 where `w` has
 *   it, cell for cell;
 * - `g30`, `g45`: the same grids turned 30° and 45° about their
 *   footprints' centres;
 * - `restore`: the world as it was before the first variant.
 *
 * The ground, the fences and the ponds stay in the world grid in all four.
 * Only the town's four region columns of the world grid are written again,
 * the structure grids' folders (`grid-<id>/`) written, and the manifest
 * (format 3) lists the grids at the revision it had: the far cache built for
 * the world as it was stays current, so the far field (past the mesh rings)
 * draws the town of the world as first written in every variant (its houses
 * where the lots put them, those of turned lots left out).
 *
 * `--far none|grids` builds the far cache's town again from the variant's
 * files (its kept levels and baked bricks over the town's chunks; the fine
 * levels are left as they are): `none` the world grid alone (a structure
 * grid then has no far field past its own rings), `grids` with each placed
 * grid resampled into the world's cells there (workspace `FarWorldSource`).
 * The far cache as it was is kept beside the world's stash until `restore`
 * puts it back.
 *
 * Where each grid stands is not stored: the placements go to Play as the
 * page's `voxelGrids` switch, written to `--out` (default
 * ~/.cache/thirdlight-voxel-bench/town-grids/<variant>.json, its `query`
 * the text to pass a bench as `--query`). Run it with the backend stopped
 * (staging: `tools/staging.sh stop`); the world's files as they were are
 * kept in `--stash` (default ~/.cache/thirdlight-voxel-bench/town-grids/stash-<world>/) until `restore`.
 *
 *   --project-dir DIR   (default ~/thirdlight-staging-p45/projects/voxel-slice)   --world NAME (default far)
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDenseChunk, gridPlacementsText, packRegionChunk, parseRegionFileName, regionFileName, writeRegion, type GridPlacement, type RegionEntry } from '@thirdlight/voxel';
import { farCacheDir, pickStore, rebuildFarCache, zstdCompress } from '@thirdlight/workspace';
import { FAR_WORLD_FOOTPRINT, FAR_WORLD_GRID, farWorldDirs, FAR_WORLD_NAME, FAR_TOWN_SHIFT_CELLS, writeFarWorldColumn } from './far-world';
import { TEST_WORLD_ID } from './test-world-id';
import { houseGrid, housePlacement, townHouses, TOWN_SEED } from './town';
import { chunkRange } from './world-kit';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}

const VARIANTS = ['w', 'g0', 'g30', 'g45', 'restore'] as const;
type Variant = (typeof VARIANTS)[number];
const variant = arg('variant', '') as Variant;
if (!VARIANTS.includes(variant)) {
  console.error(`town-grids: --variant is one of ${VARIANTS.join(', ')}`);
  process.exit(2);
}
const projectDir = arg('project-dir', join(homedir(), 'thirdlight-staging-p45', 'projects', 'voxel-slice'));
const world = arg('world', FAR_WORLD_NAME);
const benchRoot = join(homedir(), '.cache', 'thirdlight-voxel-bench', 'town-grids');
const stash = arg('stash', join(benchRoot, `stash-${world}`));
const out = arg('out', join(benchRoot, `${variant}.json`));
const far = arg('far', '');
if (far !== '' && far !== 'none' && far !== 'grids') {
  console.error('town-grids: --far is none or grids');
  process.exit(2);
}
const farDir = farCacheDir(projectDir, world);
const farStash = `${stash}-far`;
const { dir, gridDir } = farWorldDirs(projectDir, world);
const grid = FAR_WORLD_GRID;
/** The town's region columns (the town is the 256 m square round the world's origin). */
const TOWN_COLUMNS: ReadonlyArray<readonly [number, number]> = [[-1, -1], [-1, 0], [0, -1], [0, 0]];
const inTown = (name: string): boolean => {
  const a = parseRegionFileName('stacked', name);
  return a !== null && TOWN_COLUMNS.some(([rx, rz]) => a.rx === rx && a.rz === rz);
};

if (!existsSync(join(dir, 'world.json'))) {
  console.error(`town-grids: no world at ${dir}`);
  process.exit(2);
}
// The world as it was, kept once: the manifest and the town columns' files.
if (!existsSync(join(stash, 'world.json'))) {
  mkdirSync(join(stash, 'grid-0'), { recursive: true });
  for (const f of readdirSync(gridDir)) if (inTown(f)) copyFileSync(join(gridDir, f), join(stash, 'grid-0', f));
  copyFileSync(join(dir, 'world.json'), join(stash, 'world.json'));
}
// Every variant starts from it: the town columns and the manifest put back, the structure grids gone.
for (const f of readdirSync(gridDir)) if (inTown(f)) rmSync(join(gridDir, f));
for (const f of readdirSync(join(stash, 'grid-0'))) copyFileSync(join(stash, 'grid-0', f), join(gridDir, f));
for (const f of readdirSync(dir)) if (/^grid-[1-9]\d*$/.test(f)) rmSync(join(dir, f), { recursive: true, force: true });
copyFileSync(join(stash, 'world.json'), join(dir, 'world.json'));
if (variant === 'restore') {
  rmSync(stash, { recursive: true, force: true });
  if (existsSync(farStash)) {
    rmSync(farDir, { recursive: true, force: true });
    cpSync(farStash, farDir, { recursive: true });
    rmSync(farStash, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ variant, world: dir, restored: true }));
  process.exit(0);
}

const t0 = performance.now();
const manifest = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8')) as Record<string, unknown> & { regions: string[]; revision: number };
// The town columns again, its houses in the world grid (w) or none (the grids hold them).
for (const f of readdirSync(gridDir)) if (inTown(f)) rmSync(join(gridDir, f));
const written: string[] = [];
for (const [rx, rz] of TOWN_COLUMNS) written.push(...writeFarWorldColumn(gridDir, rx, rz, { townHouses: variant === 'w' ? 'world' : 'none' }).files);
const regions = [...new Set([...manifest.regions.filter((n) => !inTown(n)), ...written])].sort();

const houses = townHouses(TOWN_SEED);
const yaw = variant === 'g30' ? 30 : variant === 'g45' ? 45 : 0;
const places: GridPlacement[] = [];
const perHouse: Array<{ grid: number; lot: [number, number]; files: number; bytes: number; chunks: number }> = [];
const grids: Array<{ id: number; regions: string[] }> = [];
if (variant !== 'w') {
  const cells = createDenseChunk(grid);
  houses.forEach((h, k) => {
    const id = k + 1;
    const g = houseGrid(h.house, `house-${h.i}-${h.j}`);
    const store = pickStore(grid);
    const byRegion = new Map<string, { at: readonly [number, number, number]; entries: RegionEntry[] }>();
    const [x0, x1] = chunkRange(grid, g.bounds.min[0], g.bounds.max[0]);
    const [y0, y1] = chunkRange(grid, g.bounds.min[1], g.bounds.max[1]);
    const [z0, z1] = chunkRange(grid, g.bounds.min[2], g.bounds.max[2]);
    let chunks = 0;
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) for (let cz = z0; cz <= z1; cz++) {
      if (!g.fill(grid, cx, cy, cz, cells)) continue;
      store.importChunk(cx, cy, cz, cells);
      const bytes = store.encodeChunk(cx, cy, cz);
      store.dropChunk(cx, cy, cz);
      if (bytes === null) continue;
      const side = FAR_WORLD_FOOTPRINT / grid.edge;
      const at = [Math.floor(cx / side), Math.floor(cy / side), Math.floor(cz / side)] as const;
      const name = regionFileName('stacked', at[0], at[1], at[2]);
      let r = byRegion.get(name);
      if (r === undefined) byRegion.set(name, (r = { at, entries: [] }));
      r.entries.push(packRegionChunk(grid, cx, cy, cz, bytes, 'zstd', zstdCompress));
      chunks++;
    }
    const folder = join(dir, `grid-${id}`);
    mkdirSync(folder, { recursive: true });
    let bytes = 0;
    for (const [name, r] of byRegion) {
      const b = writeRegion({ worldId: TEST_WORLD_ID, gridId: id, layout: 'stacked', grid, footprint: FAR_WORLD_FOOTPRINT, rx: r.at[0], ry: r.at[1], rz: r.at[2], compressor: 'zstd' }, r.entries);
      writeFileSync(join(folder, name), b);
      bytes += b.length;
    }
    grids.push({ id, regions: [...byRegion.keys()].sort() });
    places.push(housePlacement(h, yaw, id, FAR_TOWN_SHIFT_CELLS));
    perHouse.push({ grid: id, lot: [h.i, h.j], files: byRegion.size, bytes, chunks });
  });
}
// The manifest in format 3 at the revision it had: the far cache built for that revision stays current.
const next = { format: 3, worldId: manifest.worldId, edge: manifest.edge, layout: manifest.layout, footprint: manifest.footprint, regions, grids, revision: manifest.revision };
writeFileSync(join(dir, 'world.json'), `${JSON.stringify(next, null, 2)}\n`);
const query = places.length === 0 ? '' : `&voxelGrids=${gridPlacementsText(world, places)}`;
// The far cache's town built again from these files (the cache as it was kept once, for `restore`).
let farReport: Record<string, unknown> | null = null;
if (far !== '') {
  if (!existsSync(farStash)) cpSync(farDir, farStash, { recursive: true });
  const side = FAR_WORLD_FOOTPRINT / grid.edge;
  const chunks: Array<{ cx: number; cy: number; cz: number }> = [];
  for (const name of written) {
    const a = parseRegionFileName('stacked', name)!;
    for (let x = 0; x < side; x++) for (let y = 0; y < side; y++) for (let z = 0; z < side; z++) chunks.push({ cx: a.rx * side + x, cy: a.ry * side + y, cz: a.rz * side + z });
  }
  const r = rebuildFarCache(dir, farDir, chunks, far === 'grids' ? places : []);
  const bytesOf = (prefix: string): number => r.files.filter((f) => f.startsWith(prefix)).reduce((n, f) => n + (existsSync(join(farDir, f)) ? statSync(join(farDir, f)).size : 0), 0);
  farReport = { mode: far, grids: far === 'grids' ? places.length : 0, ms: Math.round(r.ms), nodes: r.rebuilt.length, files: r.files.length, levelBytes: bytesOf('L'), brickBytes: bytesOf('B'), bricks: r.bricks ?? null };
}
const sum = (k: 'files' | 'bytes' | 'chunks'): number => perHouse.reduce((n, h) => n + h[k], 0);
const report = {
  variant,
  world: dir,
  houses: houses.length,
  yawDeg: variant === 'w' ? null : yaw,
  grids: grids.length,
  files: perHouse.length === 0 ? null : { total: sum('files'), perHouseMax: Math.max(...perHouse.map((h) => h.files)), bytes: sum('bytes'), bytesPerHouse: { mean: Math.round(sum('bytes') / perHouse.length), min: Math.min(...perHouse.map((h) => h.bytes)), max: Math.max(...perHouse.map((h) => h.bytes)) }, chunksPerHouse: { mean: sum('chunks') / perHouse.length, max: Math.max(...perHouse.map((h) => h.chunks)) } },
  townColumns: written,
  far: farReport,
  ms: Math.round(performance.now() - t0),
  query,
  perHouse,
};
mkdirSync(join(out, '..'), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, perHouse: undefined, query: `${query.slice(0, 80)}… (${query.length} chars)` }, null, 2));
