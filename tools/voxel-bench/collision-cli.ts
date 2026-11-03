/**
 * What a voxel world's collision costs the physics engine, a body a 32³
 * storage chunk built from its 16³ derive sections joined (as the streamer
 * hands them over): how many chunks' ground collides as a heightfield (and
 * why the rest are meshes), the bytes handed to physics a body as a
 * heightfield and as a mesh, the main-thread ms adding a body, and the
 * Rapier WASM heap the bodies take, on the slice world (hilly ground and
 * the wall-beam-banister scene), the bench's hilly world and the town.
 *
 *   node tools/voxel-bench/run.mjs collision [--heightfields 1|0] [--out DIR]
 *
 * The WASM heap only grows, so one run measures one setting: run it once
 * with heightfields (default) and once with `--heightfields 0` (all ground
 * as meshes), each in its own process. Writes collision-<hf|mesh>.md/.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, homedir, loadavg } from 'node:os';
import { join } from 'node:path';
import { benchDir } from './bench-dirs';
import { physicsMemoryBytes3D } from '@thirdlight/physics-rapier';
import {
  buildApron,
  chunkGrid,
  chunkOfKey,
  collisionGeometry,
  createWorldStore,
  deriveSectionsWithApron,
  FloatingOrigin,
  groundHeightfield,
  jobRadius,
  joinSections,
  PLACEHOLDER_RULES,
  type PaletteStore,
} from '@thirdlight/voxel';
import { VoxelCollision } from '../../packages/editor/src/voxel-world/collision';
import { loadArea } from './regions';
import { buildSliceWorld } from './slice-world';
import { townWorld } from './town';
import { hillyWorld } from './worlds';

const grid = chunkGrid(32);
const E = grid.edge;
const SECTION = 16;
const IDS = Array.from({ length: (E / SECTION) ** 3 }, (_, i) => i);

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : dflt;
}

const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

interface WorldRow {
  world: string;
  bodies: number;
  heightfields: number;
  /** Heightfields that start a node in from a face (the face's triangles a mesh). */
  banded: number;
  meshReasons: Record<string, number>;
  /** Bytes handed to physics a body: heightfield bodies as heightfields, and the same chunks as meshes. */
  hfBytes: { p50: number; mean: number };
  hfAsMeshBytes: { p50: number; mean: number };
  meshBytes: { p50: number; mean: number };
  totalBytes: number;
  addMs: { p50: number; p95: number; max: number };
  heapMB: { before: number; after: number; perBodyKB: number };
}

/** Builds the bodies of every chunk within [x0, x1) × [z0, z1) cells into `physics` (a fresh one a world). */
function measure(name: string, store: PaletteStore, x0: number, z0: number, x1: number, z1: number, physics: VoxelCollision): WorldRow {
  const list = new Set<string>();
  const c = { cx: 0, cy: 0, cz: 0 };
  for (const key of store.chunkKeys()) {
    chunkOfKey(grid, key, c);
    if (c.cx * E < x0 || (c.cx + 1) * E > x1 || c.cz * E < z0 || (c.cz + 1) * E > z1) continue;
    for (let dy = -1; dy <= 1; dy++) list.add(`${c.cx},${c.cy + dy},${c.cz}`);
  }
  const R = jobRadius(PLACEHOLDER_RULES);
  const reasons: Record<string, number> = {};
  const hf: number[] = [];
  const hfAsMesh: number[] = [];
  const mesh: number[] = [];
  let banded = 0;
  let total = 0;
  const heap0 = physicsMemoryBytes3D() ?? 0;
  let key = 0;
  for (const id of [...list].sort()) {
    const [cx, cy, cz] = id.split(',').map(Number) as [number, number, number];
    const sections = deriveSectionsWithApron(grid, PLACEHOLDER_RULES, buildApron(store, cx, cy, cz, R), (out) => store.exportChunk(cx, cy, cz, out), SECTION, IDS).map((r) => r.assembly);
    const d = joinSections(E, SECTION, sections);
    if (d.ground.indices.length === 0 && d.collision.boxes.length === 0) continue;
    const geo = collisionGeometry(d);
    if (geo.heightfield !== null) {
      hf.push(geo.bytes);
      hfAsMesh.push(collisionGeometry(d, {}, false).bytes);
      if (geo.meshes.length > 0) banded++;
    } else {
      mesh.push(geo.bytes);
      const why = d.collision.boxes.length > 0 ? 'boxes' : (groundHeightfield(d.ground, E) as string);
      reasons[why] = (reasons[why] ?? 0) + 1;
    }
    total += physics.set(key++, cx, cy, cz, d);
  }
  const heap1 = physicsMemoryBytes3D() ?? 0;
  const bodies = physics.count;
  const st = (xs: number[]): { p50: number; mean: number } => ({ p50: pct(xs, 50), mean: Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)) });
  return {
    world: name,
    bodies,
    heightfields: hf.length,
    banded,
    meshReasons: reasons,
    hfBytes: st(hf),
    hfAsMeshBytes: st(hfAsMesh),
    meshBytes: st(mesh),
    totalBytes: total,
    addMs: { p50: Number(physics.addMs.quantile(0.5).toFixed(3)), p95: Number(physics.addMs.quantile(0.95).toFixed(3)), max: Number(physics.addMs.quantile(1).toFixed(3)) },
    heapMB: { before: heap0 / 2 ** 20, after: heap1 / 2 ** 20, perBodyKB: bodies === 0 ? 0 : (heap1 - heap0) / 1024 / bodies },
  };
}

async function main(): Promise<void> {
  const heightfields = arg('--heightfields', '1') !== '0';
  const outDir = arg('--out', benchDir('collision'));
  mkdirSync(outDir, { recursive: true });
  const started = new Date().toISOString();
  const load0 = loadavg();
  const rows: WorldRow[] = [];
  // One physics world a test world; the WASM heap is the module's, so each world's growth is on top of the ones before.
  const make = (): Promise<VoxelCollision> => VoxelCollision.create(grid, new FloatingOrigin({ grid, origin: { x: 0, y: 0, z: 0 } }), heightfields);
  {
    const physics = await make();
    const slice = buildSliceWorld();
    const [sx, , sz] = slice.scene;
    rows.push(measure('slice', slice.store, sx - 192, sz - 192, sx + 192, sz + 192, physics));
  }
  {
    const physics = await make();
    const store = createWorldStore(grid);
    loadArea(hillyWorld({ footprint: 512 }).grids[0]!, store, -256, -256, 256, 256);
    rows.push(measure('hilly', store, -192, -192, 192, 192, physics));
  }
  {
    const physics = await make();
    const store = createWorldStore(grid);
    loadArea(townWorld({ footprint: 512 }).grids[0]!, store, 0, 0, 512, 512);
    rows.push(measure('town', store, 0, 0, 512, 512, physics));
  }
  const tag = heightfields ? 'hf' : 'mesh';
  const json = { started, node: process.version, host: { cpus: `${cpus().length} × ${cpus()[0]?.model ?? '?'}`, loadavg: [load0, loadavg()] }, heightfields, sectionEdge: SECTION, rows };
  writeFileSync(join(outDir, `collision-${tag}.json`), JSON.stringify(json, null, 2));
  const kb = (b: number): string => (b / 1024).toFixed(1);
  const md = [
    `# Voxel collision a chunk, ${heightfields ? 'heightfields where the ground is one' : 'all ground as meshes'} (${started})`,
    '',
    `Node ${process.version}, ${json.host.cpus}, load ${load0.map((l) => l.toFixed(1)).join(' / ')}; 16³ sections joined a 32³ chunk.`,
    '',
    '| World | Bodies | Heightfields (banded) | Meshes: why | KB a body: hf / same as mesh / mesh p50 | KB to physics | Add ms p50 / p95 / max | WASM heap MB before → after (KB a body) |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.world} | ${r.bodies} | ${r.heightfields} (${r.banded}) | ${Object.entries(r.meshReasons).map(([k, v]) => `${k} ${v}`).join(', ')} | ${kb(r.hfBytes.p50)} / ${kb(r.hfAsMeshBytes.p50)} / ${kb(r.meshBytes.p50)} | ${kb(r.totalBytes)} | ${r.addMs.p50} / ${r.addMs.p95} / ${r.addMs.max} | ${r.heapMB.before.toFixed(1)} → ${r.heapMB.after.toFixed(1)} (${r.heapMB.perBodyKB.toFixed(1)}) |`),
    '',
  ].join('\n');
  writeFileSync(join(outDir, `collision-${tag}.md`), md);
  console.log(md);
}

void main();
