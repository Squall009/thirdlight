/**
 * Connectivity culling measured, in Node (`node tools/voxel-bench/run.mjs connectivity …`): at fixed views over a
 * world's level 0, the units and chunks the connectivity flood (connectivity-flood.ts) would keep against the frustum
 * alone and against a reference by rays (every unit a sight line crosses before it stops at a solid cell, through a
 * grid of pixels); the flood's false culls against that reference (a unit a ray crosses that the flood drops); its
 * time a frame. With `--views FILE` (the page's lists, light-shots `--cull`), the chunks the page drew, the depth
 * pyramid kept and the occlusion oracle saw at each view are joined by chunk, and the flood's false culls are counted
 * against the oracle too. Nothing is drawn or stored; the world is read from its region files (staging's 8 km world,
 * the cave dug in it) or generated (the caves and vertical test worlds).
 *
 *   --world far|caves|vertical (default far)   --world-dir DIR (default staging's voxel-slice `far`)
 *   --reach M (default 96: past the farthest level-0 chunk the page draws at low)   --rays WxH (default 320x180)
 *   --views FILE   the page's per-view lists (light-shots --cull)   --only LIST   views by name
 *   --out DIR (default ~/.cache/thirdlight-voxel-bench/connectivity/<world>-<time>)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, loadavg, uptime } from 'node:os';
import { join } from 'node:path';
import { buildApron, chunkGrid, createDenseChunk, deriveSectionsWithApron, jobRadius, RegionChunkSource, sectionLocalOrigin, streamerWalkSource, walkRay, walkVoxels, WORLD_GRID_ID, WORLD_RULES, type DeriveOutput, type DerivedData, type OpenRegionsOut, type PaletteStore, type WalkStreamerView } from '@thirdlight/voxel';
import { importRead, pickStore } from '@thirdlight/workspace';

import { benchDir } from './bench-dirs';
import { boxInPlanes, CELL_M, connectivityFlood, frustumPlanes, segmentUnits, UNIT_CELLS, unitKey, unitOfKey } from './connectivity-flood';
import { diskFeed, generatedFeed, type ChunkFeed } from './chunk-feeds';
import { CULL_VIEWS, findCaveViews, type CullView } from './cull-views';
import { cavesWorld, verticalWorld } from './worlds';
import type { TestWorld } from './world-kit';

function arg(name: string, fallback: string | null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}

const WORLD = arg('world', 'far')!;
const WORLD_DIR = arg('world-dir', join(homedir(), 'thirdlight-staging-p45', 'projects', 'voxel-slice', 'voxels', 'far'))!;
const REACH = Number(arg('reach', '96'));
const [RW, RH] = arg('rays', '320x180')!.split('x').map(Number) as [number, number];
const VIEWS_FILE = arg('views', null);
const ONLY = arg('only', null)?.split(',') ?? null;
const OUT = arg('out', null) ?? benchDir('connectivity', `${WORLD}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`);
const FOV_Y = 60;
const ASPECT = 16 / 9;
const NEAR = 0.1;
/** Flood runs a view is timed over (the median is kept). */
const TIMED_RUNS = 21;

const grid = chunkGrid(32);
const SECTION = 16;
const IDS = Array.from({ length: 8 }, (_, i) => i);
const CHUNK_M = grid.edge * CELL_M;

const store = pickStore(grid);
const feed: ChunkFeed = WORLD === 'far' ? diskFeed(WORLD_DIR, store) : generatedFeed(WORLD === 'caves' ? cavesWorld() : verticalWorld(), store);
/** Derived sections by `sx,sy,sz` (null: the derive gave none), and each chunk's triangles and kit pieces. */
const sections = new Map<string, DerivedData | null>();
const chunkCost = new Map<string, { triangles: number; pieces: number }>();
const derivedChunks = new Set<string>();

async function deriveBox(min: readonly number[], max: readonly number[]): Promise<number> {
  const need: Array<[number, number, number]> = [];
  for (let cx = min[0]! - 1; cx <= max[0]! + 1; cx++) for (let cy = min[1]! - 1; cy <= max[1]! + 1; cy++) for (let cz = min[2]! - 1; cz <= max[2]! + 1; cz++) need.push([cx, cy, cz]);
  await feed.ensure(need);
  const R = jobRadius(WORLD_RULES);
  let n = 0;
  for (let cx = min[0]!; cx <= max[0]!; cx++) for (let cy = min[1]!; cy <= max[1]!; cy++) for (let cz = min[2]!; cz <= max[2]!; cz++) {
    const ck = `${cx},${cy},${cz}`;
    if (derivedChunks.has(ck)) continue;
    derivedChunks.add(ck);
    n++;
    const results = deriveSectionsWithApron(grid, WORLD_RULES, buildApron(store, cx, cy, cz, R), (out) => store.exportChunk(cx, cy, cz, out), SECTION, IDS);
    let triangles = 0;
    let pieces = 0;
    for (const r of results) {
      const [lx, ly, lz] = sectionLocalOrigin(grid.edge, SECTION, r.id);
      sections.set(`${cx * 2 + lx / SECTION},${cy * 2 + ly / SECTION},${cz * 2 + lz / SECTION}`, r.assembly);
      if (r.assembly !== null) {
        triangles += (r.assembly.ground.indices.length + r.assembly.base.indices.length) / 3;
        pieces += r.assembly.instances.count;
      }
    }
    chunkCost.set(ck, { triangles, pieces });
  }
  return n;
}

/** A unit's regions: undefined when not derived (unknown), null when the derive made none (every cell solid). */
function unitRegions(ux: number, uy: number, uz: number): OpenRegionsOut | null | undefined {
  const a = sections.get(`${ux},${uy},${uz}`);
  if (a === undefined) return undefined;
  if (a === null) return null;
  return a.regions ?? undefined;
}

const view: WalkStreamerView = {
  sections: { shift: 4 },
  grid,
  derivedOf: (sx, sy, sz) => {
    const a = sections.get(`${sx},${sy},${sz}`);
    return a === undefined || a === null ? null : ({ assembly: a } as DeriveOutput);
  },
  mips: null,
  isResident: (cx, cy, cz) => derivedChunks.has(`${cx},${cy},${cz}`),
  voxelAt: (x, y, z, out) => store.voxelAt(x, y, z, out),
};
const walk = streamerWalkSource(view, null, { mips: false });

const chunkOfUnit = (k: number): string => {
  const [ux, uy, uz] = unitOfKey(k);
  return `${Math.floor(ux / 2)},${Math.floor(uy / 2)},${Math.floor(uz / 2)}`;
};

interface PageChunk {
  readonly chunk: string;
  readonly triangles: number;
  /** Drawn by the view with culling off (in the frustum), kept by the depth pyramid's last answer, seen by the oracle. */
  readonly frustum: boolean;
  readonly pyramid: boolean | null;
  readonly seen: boolean | null;
}
interface PageView {
  readonly name: string;
  readonly level0: readonly PageChunk[];
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
}

async function measure(v: CullView, page: PageView | undefined): Promise<Record<string, unknown>> {
  const { planes, forward, right, up } = frustumPlanes(v.eye, v.yaw, v.pitch, FOV_Y, ASPECT, NEAR, REACH * 2);
  const c = v.eye.map((m) => Math.floor(m / CHUNK_M));
  const r = Math.ceil(REACH / CHUNK_M);
  const t0 = performance.now();
  const derived = await deriveBox([c[0]! - r, c[1]! - r, c[2]! - r], [c[0]! + r, c[1]! + r, c[2]! + r]);
  const deriveMs = performance.now() - t0;
  const opts = { eye: v.eye, planes, reachM: REACH, unit: unitRegions };
  const flood = connectivityFlood(opts);
  const times: number[] = [];
  for (let i = 0; i < TIMED_RUNS; i++) {
    const s = performance.now();
    connectivityFlood(opts);
    times.push(performance.now() - s);
  }
  // Frustum units: every unit in reach the frustum touches.
  const frustumUnits = new Set<number>();
  const u0 = v.eye.map((m) => Math.floor(m / (UNIT_CELLS * CELL_M)));
  const ur = Math.ceil(REACH / (UNIT_CELLS * CELL_M));
  for (let ux = u0[0]! - ur; ux <= u0[0]! + ur; ux++) for (let uy = u0[1]! - ur; uy <= u0[1]! + ur; uy++) for (let uz = u0[2]! - ur; uz <= u0[2]! + ur; uz++) {
    const m = UNIT_CELLS * CELL_M;
    const min = [ux * m, uy * m, uz * m];
    const max = [min[0]! + m, min[1]! + m, min[2]! + m];
    let d2 = 0;
    for (let a = 0; a < 3; a++) {
      const e = v.eye[a]!;
      const dd = e < min[a]! ? min[a]! - e : e > max[a]! ? e - max[a]! : 0;
      d2 += dd * dd;
    }
    if (d2 <= REACH * REACH && boxInPlanes(planes, min, max)) frustumUnits.add(unitKey(ux, uy, uz));
  }
  // The reference by rays: units each sight line crosses up to the solid cell it stops at (or the reach).
  const crossed = new Set<number>();
  const hitChunks = new Set<string>();
  const tr = performance.now();
  const ty = Math.tan((FOV_Y * Math.PI) / 360);
  for (let py = 0; py < RH; py++) for (let px = 0; px < RW; px++) {
    const sx = ((px + 0.5) / RW) * 2 - 1;
    const sy = 1 - ((py + 0.5) / RH) * 2;
    const d = [0, 1, 2].map((a) => forward[a]! + right[a]! * sx * ty * ASPECT + up[a]! * sy * ty);
    const l = Math.hypot(d[0]!, d[1]!, d[2]!);
    const dir = d.map((x) => x / l);
    const ray = walkRay(v.eye, dir);
    if (ray === null) continue;
    const w = walkVoxels(walk, ray, REACH, { far: false });
    const t = w.hit === null ? REACH : Math.min(REACH, w.hit.t + 0.01);
    segmentUnits(v.eye, v.eye.map((e, a) => e + dir[a]! * t), crossed);
    if (w.hit !== null) hitChunks.add(w.hit.cell.map((x) => Math.floor(x / grid.edge)).join(','));
  }
  const raysMs = performance.now() - tr;
  const inReach = (k: number): boolean => frustumUnits.has(k);
  const falseUnits = [...crossed].filter((k) => inReach(k) && !flood.kept.has(k));
  const chunksOf = (units: Iterable<number>): Set<string> => new Set([...units].map(chunkOfUnit));
  const keptChunks = chunksOf(flood.kept);
  const frustumChunks = chunksOf(frustumUnits);
  const cost = (set: Iterable<string>): { chunks: number; triangles: number; pieces: number } => {
    let triangles = 0;
    let pieces = 0;
    let chunks = 0;
    for (const k of set) {
      const cc = chunkCost.get(k);
      if (cc === undefined || cc.triangles + cc.pieces === 0) continue;
      chunks++;
      triangles += cc.triangles;
      pieces += cc.pieces;
    }
    return { chunks, triangles, pieces };
  };
  const falseHitChunks = [...hitChunks].filter((k) => frustumChunks.has(k) && !keptChunks.has(k));
  const out: Record<string, unknown> = {
    name: v.name,
    eye: v.eye,
    startOpen: flood.startOpen,
    units: { frustum: frustumUnits.size, flood: [...flood.kept].filter(inReach).length, crossedByRays: [...crossed].filter(inReach).length, falseCulls: falseUnits.length },
    chunks: { frustum: cost(frustumChunks), flood: cost([...keptChunks].filter((k) => frustumChunks.has(k))), seenByRays: cost(hitChunks), falseCulls: falseHitChunks },
    floodMs: { first: Number(times[0]!.toFixed(3)), median: Number(median(times).toFixed(3)), states: flood.states, pruned: flood.pruned },
    resident: { units: sections.size, derivedChunksNow: derived, deriveMs: Math.round(deriveMs) },
    raysMs: Math.round(raysMs),
  };
  if (page !== undefined) {
    // The page's level-0 chunk draws: what culling off drew, the pyramid kept, the oracle saw; the flood beside them.
    const rows = page.level0.filter((p) => p.frustum);
    const sum = (pred: (p: PageChunk) => boolean): { draws: number; triangles: number } => {
      const s = rows.filter(pred);
      return { draws: s.length, triangles: s.reduce((n, p) => n + p.triangles, 0) };
    };
    const kept = (p: PageChunk): boolean => keptChunks.has(p.chunk);
    out['page'] = {
      frustum: sum(() => true),
      pyramid: sum((p) => p.pyramid !== false),
      flood: sum(kept),
      floodAndPyramid: sum((p) => kept(p) && p.pyramid !== false),
      truth: sum((p) => p.seen === true),
      floodFalseCulls: rows.filter((p) => p.seen === true && !kept(p)).map((p) => p.chunk),
      pyramidFalseCulls: rows.filter((p) => p.seen === true && p.pyramid === false).map((p) => p.chunk),
      beyondPyramid: sum((p) => p.pyramid !== false && !kept(p)),
    };
  }
  return out;
}

/** The generated worlds' views: tunnels found in the middle of the caves tile; in the vertical world a cavern and the tower's ground storey looking up its 300 m. */
async function generatedViews(): Promise<CullView[]> {
  const v = { material: 0, role: 0, shape: 0, wetness: 0 };
  const solid = (x: number, y: number, z: number): boolean => {
    store.voxelAt(x, y, z, v);
    return v.material !== 0 && (v.shape & 0x0f) >= 8;
  };
  const area = WORLD === 'caves' ? { x0: 128, x1: 384, z0: 128, z1: 384, y0: -110, y1: 40 } : { x0: 160, x1: 352, z0: 160, z1: 352, y0: -1900, y1: -300 };
  const chunks: Array<[number, number, number]> = [];
  for (let cx = Math.floor(area.x0 / 32) - 1; cx <= Math.floor(area.x1 / 32) + 1; cx++) for (let cz = Math.floor(area.z0 / 32) - 1; cz <= Math.floor(area.z1 / 32) + 1; cz++) for (let cy = Math.floor(area.y0 / 32) - 1; cy <= Math.floor((area.y1 + 32) / 32); cy++) chunks.push([cx, cy, cz]);
  await feed.ensure(chunks);
  const views = findCaveViews(WORLD as 'caves' | 'vertical', solid, area);
  if (WORLD === 'vertical') {
    // The tower (worlds.ts: 32 cells square from cell 31): the first open cell over its ground floor at its middle.
    const tx = 47;
    let y = -600;
    await feed.ensure(Array.from({ length: 64 }, (_, k) => [1, -20 + k, 1] as [number, number, number]));
    while (y < 600 && !(solid(tx, y - 1, tx) && !solid(tx, y, tx))) y++;
    views.push({ name: 'vertical-tower-up', world: 'vertical', eye: [(tx + 0.5) * 0.5, (y + 3) * 0.5, (tx + 0.5) * 0.5], yaw: 0, pitch: -1.2, shows: 'in the tower’s ground storey looking up its shaft of floors' });
  }
  return views;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const pages = VIEWS_FILE === null ? new Map<string, PageView>() : new Map((JSON.parse(readFileSync(VIEWS_FILE, 'utf8')) as PageView[]).map((p) => [p.name, p]));
  const views = (WORLD === 'far' ? CULL_VIEWS.filter((v) => v.world === WORLD) : await generatedViews()).filter((v) => ONLY === null || ONLY.includes(v.name));
  const host = { uptimeS: Math.round(uptime()), load: loadavg().map((l) => Number(l.toFixed(2))) };
  const rows: Record<string, unknown>[] = [];
  for (const v of views) {
    const row = await measure(v, pages.get(v.name));
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  writeFileSync(join(OUT, 'connectivity.json'), JSON.stringify({ world: WORLD, reachM: REACH, rays: [RW, RH], fovY: FOV_Y, host, views: rows }, null, 1));
  console.log(`connectivity: ${views.length} views → ${join(OUT, 'connectivity.json')}`);
}

await main();
