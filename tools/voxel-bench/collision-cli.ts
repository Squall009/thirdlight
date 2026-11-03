/**
 * What a voxel world's collision costs the physics engine, a body a 32³
 * storage chunk built from its 16³ derive sections joined (as the streamer
 * hands them over): how many chunks' ground collides as a heightfield (and
 * why the rest are meshes), the bytes handed to physics a body as a
 * heightfield and as a mesh, the main-thread ms adding a body, and the
 * Rapier WASM heap the bodies take, on the slice world (hilly ground and
 * the wall-beam-banister scene), the bench's hilly world and the town.
 *
 *   node tools/voxel-bench/run.mjs collision [--heightfields 1|level|0] [--out DIR]
 *
 * The WASM heap only grows, so one run measures one setting: run it once
 * with heightfields (default: every patch that is one), `level` (level
 * patches only) and `0` (all ground as meshes), each in its own process.
 * Ground chunks are also counted as whole-chunk heightfields (eligible: the
 * chunk's whole footprint one field), and the share of ground triangles the
 * patches stand for. Writes collision-<hf|level|mesh>.md/.json.
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
  WORLD_RULES,
  type HeightfieldUse,
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
  /** Ground chunks (some ground triangles) and of them those whose whole footprint is one heightfield. */
  groundChunks: number;
  eligible: number;
  /** Bodies with at least one heightfield patch, and the patches. */
  heightfields: number;
  patches: number;
  /** Ground triangles, and those a patch stands for. */
  groundTris: number;
  fieldTris: number;
  /** Bodies with a heightfield and triangles beside it. */
  banded: number;
  meshReasons: Record<string, number>;
  /** Bytes handed to physics a body: heightfield bodies as heightfields, and the same chunks as meshes. */
  hfBytes: { p50: number; mean: number };
  hfAsMeshBytes: { p50: number; mean: number };
  meshBytes: { p50: number; mean: number };
  totalBytes: number;
  addMs: { p50: number; p95: number; max: number };
  /** Slanted sphere sweeps (0.05–0.5 m, 30 m) from above the window's ground: µs each. */
  sweepUs: { p50: number; p95: number; n: number };
  heapMB: { before: number; after: number; perBodyKB: number };
}

/** Builds the bodies of every chunk within [x0, x1) × [z0, z1) cells into `physics` (a fresh one a world). */
function measure(name: string, store: PaletteStore, x0: number, z0: number, x1: number, z1: number, physics: VoxelCollision, use: HeightfieldUse): WorldRow {
  const list = new Set<string>();
  const c = { cx: 0, cy: 0, cz: 0 };
  for (const key of store.chunkKeys()) {
    chunkOfKey(grid, key, c);
    if (c.cx * E < x0 || (c.cx + 1) * E > x1 || c.cz * E < z0 || (c.cz + 1) * E > z1) continue;
    for (let dy = -1; dy <= 1; dy++) list.add(`${c.cx},${c.cy + dy},${c.cz}`);
  }
  const R = jobRadius(WORLD_RULES);
  const reasons: Record<string, number> = {};
  const hf: number[] = [];
  const hfAsMesh: number[] = [];
  const mesh: number[] = [];
  let banded = 0;
  let total = 0;
  let groundChunks = 0;
  let eligible = 0;
  let patches = 0;
  let groundTris = 0;
  let fieldTris = 0;
  const heap0 = physicsMemoryBytes3D() ?? 0;
  let key = 0;
  for (const id of [...list].sort()) {
    const [cx, cy, cz] = id.split(',').map(Number) as [number, number, number];
    const sections = deriveSectionsWithApron(grid, WORLD_RULES, buildApron(store, cx, cy, cz, R), (out) => store.exportChunk(cx, cy, cz, out), SECTION, IDS).map((r) => r.assembly);
    const d = joinSections(E, SECTION, sections);
    if (d.ground.indices.length === 0 && d.collision.boxes.length === 0) continue;
    const geo = collisionGeometry(d, {}, use);
    const tris = d.ground.indices.length / 3;
    if (tris > 0) {
      groundChunks++;
      groundTris += tris;
      if (typeof groundHeightfield(d.ground, E) !== 'string') eligible++;
    }
    if (geo.heightfields.length > 0) {
      hf.push(geo.bytes);
      hfAsMesh.push(collisionGeometry(d, {}, false).bytes);
      patches += geo.heightfields.length;
      fieldTris += tris - geo.meshes.reduce((a, m) => a + m.indices.length / 3, 0);
      if (geo.meshes.length > 0) banded++;
    } else {
      mesh.push(geo.bytes);
      const whole = groundHeightfield(d.ground, E);
      const why = tris === 0 ? 'boxes only' : typeof whole === 'string' ? whole : 'level only';
      reasons[why] = (reasons[why] ?? 0) + 1;
    }
    total += physics.set(key++, cx, cy, cz, d);
  }
  const heap1 = physicsMemoryBytes3D() ?? 0;
  const bodies = physics.count;
  // Sweeps as a camera boom or a projectile casts them, timed over the window's middle.
  let seed = 5;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const sweeps: number[] = [];
  const top = Math.max(...[...list].map((id) => (Number(id.split(',')[1]) + 1) * E));
  for (let t = 0; t < 2000; t++) {
    const from: [number, number, number] = [x0 + (x1 - x0) * (0.25 + 0.5 * rnd()), 0, z0 + (z1 - z0) * (0.25 + 0.5 * rnd())];
    const down = physics.castSphere([from[0], top, from[2]], [0, -1, 0], 0.01, top * 2);
    if (down === null) continue;
    from[1] = down.centre[1] + 6;
    const t0 = performance.now();
    physics.castSphere(from, [rnd() * 2 - 1, -(0.1 + rnd()), rnd() * 2 - 1], [0.05, 0.15, 0.3, 0.5][t % 4]!, 60);
    sweeps.push((performance.now() - t0) * 1000);
  }
  const st = (xs: number[]): { p50: number; mean: number } => ({ p50: pct(xs, 50), mean: Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)) });
  return {
    world: name,
    bodies,
    groundChunks,
    eligible,
    heightfields: hf.length,
    patches,
    groundTris,
    fieldTris,
    banded,
    meshReasons: reasons,
    hfBytes: st(hf),
    hfAsMeshBytes: st(hfAsMesh),
    meshBytes: st(mesh),
    totalBytes: total,
    sweepUs: { p50: Math.round(pct(sweeps, 50)), p95: Math.round(pct(sweeps, 95)), n: sweeps.length },
    addMs: { p50: Number(physics.addMs.quantile(0.5).toFixed(3)), p95: Number(physics.addMs.quantile(0.95).toFixed(3)), max: Number(physics.addMs.quantile(1).toFixed(3)) },
    heapMB: { before: heap0 / 2 ** 20, after: heap1 / 2 ** 20, perBodyKB: bodies === 0 ? 0 : (heap1 - heap0) / 1024 / bodies },
  };
}

async function main(): Promise<void> {
  const flag = arg('--heightfields', '1');
  const heightfields: HeightfieldUse = flag === 'level' ? 'level' : flag !== '0';
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
    rows.push(measure('slice', slice.store, sx - 192, sz - 192, sx + 192, sz + 192, physics, heightfields));
  }
  {
    const physics = await make();
    const store = createWorldStore(grid);
    loadArea(hillyWorld({ footprint: 512 }).grids[0]!, store, -256, -256, 256, 256);
    rows.push(measure('hilly', store, -192, -192, 192, 192, physics, heightfields));
  }
  {
    const physics = await make();
    const store = createWorldStore(grid);
    loadArea(townWorld({ footprint: 512 }).grids[0]!, store, 0, 0, 512, 512);
    rows.push(measure('town', store, 0, 0, 512, 512, physics, heightfields));
  }
  const tag = heightfields === 'level' ? 'level' : heightfields ? 'hf' : 'mesh';
  const json = { started, node: process.version, host: { cpus: `${cpus().length} × ${cpus()[0]?.model ?? '?'}`, loadavg: [load0, loadavg()] }, heightfields, sectionEdge: SECTION, rows };
  writeFileSync(join(outDir, `collision-${tag}.json`), JSON.stringify(json, null, 2));
  const kb = (b: number): string => (b / 1024).toFixed(1);
  const md = [
    `# Voxel collision a chunk, ${heightfields === 'level' ? 'level heightfield patches' : heightfields ? 'heightfield patches where the ground is one' : 'all ground as meshes'} (${started})`,
    '',
    `Node ${process.version}, ${json.host.cpus}, load ${load0.map((l) => l.toFixed(1)).join(' / ')}; 16³ sections joined a 32³ chunk.`,
    '',
    '| World | Bodies | Ground chunks: eligible whole / with patches (patches, banded) | Ground triangles under patches | Meshes: why | KB a body: hf / same as mesh / mesh p50 | KB to physics | Add ms p50 / p95 / max | Sweep µs p50 / p95 | WASM heap MB before → after (KB a body) |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.world} | ${r.bodies} | ${r.groundChunks}: ${r.eligible} (${((100 * r.eligible) / Math.max(1, r.groundChunks)).toFixed(0)} %) / ${r.heightfields} (${((100 * r.heightfields) / Math.max(1, r.groundChunks)).toFixed(0)} %) (${r.patches}, ${r.banded}) | ${r.fieldTris} of ${r.groundTris} (${((100 * r.fieldTris) / Math.max(1, r.groundTris)).toFixed(0)} %) | ${Object.entries(r.meshReasons).map(([k, v]) => `${k} ${v}`).join(', ')} | ${kb(r.hfBytes.p50)} / ${kb(r.hfAsMeshBytes.p50)} / ${kb(r.meshBytes.p50)} | ${kb(r.totalBytes)} | ${r.addMs.p50} / ${r.addMs.p95} / ${r.addMs.max} | ${r.sweepUs.p50} / ${r.sweepUs.p95} | ${r.heapMB.before.toFixed(1)} → ${r.heapMB.after.toFixed(1)} (${r.heapMB.perBodyKB.toFixed(1)}) |`),
    '',
  ].join('\n');
  writeFileSync(join(outDir, `collision-${tag}.md`), md);
  console.log(md);
}

void main();
