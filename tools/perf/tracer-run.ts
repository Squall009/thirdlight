/**
 * The tracer on this host's GPU (`node tools/perf/run.mjs tracer …`): per
 * geometry kind a scene made from real engine data and a batch of
 * lighting-like rays (from surface points: toward the sun over its disc,
 * and over the hemisphere as bounce rays do), traced by the product's GPU
 * tracer in a page at the display's 60 Hz cap, one pass a frame,
 * timestamped. Every batch runs twice, in random order and grouped
 * (`groupRays`), and the GPU's hits are held to the CPU twin's.
 *
 *   --rays N     rays per batch (default 131072)
 *   --frames N   timed passes per batch (default 60)
 *   --kinds a,b  only these cases (blocks, terrain, mixed, arch, bricks)
 *
 * GPU ms are raw timestamps at the GPU's clock during the run; the report
 * gives the clock (ms × clock ÷ max clock is the time at full clock). The
 * report goes to ~/.cache/thirdlight-perf/reports/tracer-<time>.json.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BlockGrid, TerrainField, type BlockType, type TerrainComponent, type TerrainTile } from '@thirdlight/runtime';

import { traceRaysCpu } from '../../packages/three-adapter/src/tracer-cpu';
import { groupRays, reorderRays } from '../../packages/three-adapter/src/tracer-gpu';
import { HIT_WORDS, RAY_FLOATS, TRACE_BLOCKS, TRACE_TERRAIN, packTraceScene, type PackedTraceScene, type TraceSceneSource } from '../../packages/three-adapter/src/tracer-scene';
import { opaqueByBlockTypes, traceBlockLayerOf, traceTerrainOf } from '../../packages/three-adapter/src/tracer-sources';
import { PERF_ROOT, REPO } from './backend';
import { gpuClockSampler, gpuMaxMhz, launchGpuBrowser, serveStatic } from './frame-run';

type V3 = [number, number, number];

/** A seeded generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A surface point a lighting ray leaves from. */
export interface RaySource {
  p: V3;
  n: V3;
  kind: number;
}

/** One case: what it traces and the rays' sources. */
export interface TracerCaseSource {
  name: string;
  scene: TraceSceneSource;
  sources: RaySource[];
}

const SUN = ((): V3 => {
  const v: V3 = [0.42, 0.78, 0.31];
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
})();

/**
 * Rays as a cache texel casts them: half toward the sun over its disc
 * (0.02 rad), half over the hemisphere (cosine-weighted, 48 m), each from a
 * surface point lifted off its surface; the sources in texel order.
 */
export function lightingRays(sources: RaySource[], count: number, seed: number): { rays: Float32Array; kinds: Uint8Array } {
  const r = rng(seed);
  const rays = new Float32Array(count * RAY_FLOATS);
  const kinds = new Uint8Array(count);
  const perSource = 8;
  for (let i = 0; i < count; i += 1) {
    const s = sources[Math.floor(i / perSource) % sources.length]!;
    const o = s.p.map((v, k) => v + s.n[k]! * 0.003) as V3;
    let d: V3;
    if (i % 2 === 0) {
      const a = r() * 2 * Math.PI;
      const q = 0.02 * Math.sqrt(r());
      const t = Math.abs(SUN[1]) < 0.9 ? cross(SUN, [0, 1, 0]) : cross(SUN, [1, 0, 0]);
      const b = cross(SUN, t);
      d = norm([SUN[0] + (t[0] * Math.cos(a) + b[0] * Math.sin(a)) * q, SUN[1] + (t[1] * Math.cos(a) + b[1] * Math.sin(a)) * q, SUN[2] + (t[2] * Math.cos(a) + b[2] * Math.sin(a)) * q]);
    } else {
      const u1 = r();
      const u2 = r();
      const rr = Math.sqrt(u1);
      const phi = 2 * Math.PI * u2;
      const t = Math.abs(s.n[1]) < 0.9 ? norm(cross(s.n, [0, 1, 0])) : norm(cross(s.n, [1, 0, 0]));
      const b = cross(s.n, t);
      const z = Math.sqrt(Math.max(0, 1 - u1));
      d = norm([t[0] * rr * Math.cos(phi) + b[0] * rr * Math.sin(phi) + s.n[0] * z, t[1] * rr * Math.cos(phi) + b[1] * rr * Math.sin(phi) + s.n[1] * z, t[2] * rr * Math.cos(phi) + b[2] * rr * Math.sin(phi) + s.n[2] * z]);
    }
    rays.set([o[0], o[1], o[2], 0, d[0], d[1], d[2], i % 2 === 0 ? 1e4 : 48], i * RAY_FLOATS);
    kinds[i] = s.kind;
  }
  return { rays, kinds };
}

export function cross(a: readonly number[], b: readonly number[]): V3 {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}
export function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** A block town: a ground slab, hollow houses with doors and windows, towers; 192 × 40 × 192 cells of 0.5 m. */
function blockTown(): { scene: TraceSceneSource; sources: RaySource[] } {
  const cellSize: V3 = [0.5, 0.5, 0.5];
  const origin: V3 = [-48, 0, -48];
  const grid = new BlockGrid({ cellSize, bounds: { min: [0, 0, 0], max: [192, 40, 192] } });
  const r = rng(42);
  for (let z = 0; z < 192; z += 1) for (let x = 0; x < 192; x += 1) for (let y = 0; y < 2; y += 1) grid.set(x, y, z, { block: 'rock' });
  for (let b = 0; b < 60; b += 1) {
    const w = 8 + Math.floor(r() * 16);
    const dpt = 8 + Math.floor(r() * 16);
    const h = 6 + Math.floor(r() * 24);
    const x0 = Math.floor(r() * (190 - w));
    const z0 = Math.floor(r() * (190 - dpt));
    for (let y = 2; y < 2 + h; y += 1) {
      for (let z = z0; z <= z0 + dpt; z += 1) {
        for (let x = x0; x <= x0 + w; x += 1) {
          const wall = x === x0 || x === x0 + w || z === z0 || z === z0 + dpt;
          const roof = y === 1 + h;
          const door = z === z0 && x >= x0 + 2 && x < x0 + 4 && y < 6;
          const window = wall && y % 6 === 4 && (x + z) % 5 < 2;
          if ((wall || roof) && !door && !window) grid.set(x, y, z, { block: 'rock' });
        }
      }
    }
  }
  const sources: RaySource[] = [];
  const solid = (x: number, y: number, z: number): boolean => grid.get(x, y, z) !== null;
  const N: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  // Exposed faces in cell order (a cache's texels are laid out by cell and face).
  grid.forEach((x, y, z) => {
    for (const n of N) {
      if (solid(x + n[0], y + n[1], z + n[2]) || y + n[1] < 0) continue;
      if (r() > 0.15) continue;
      const c: V3 = [x + 0.5 + n[0] * 0.5 + (n[0] === 0 ? r() - 0.5 : 0), y + 0.5 + n[1] * 0.5 + (n[1] === 0 ? r() - 0.5 : 0), z + 0.5 + n[2] * 0.5 + (n[2] === 0 ? r() - 0.5 : 0)];
      sources.push({ p: [origin[0] + c[0] * 0.5, origin[1] + c[1] * 0.5, origin[2] + c[2] * 0.5], n, kind: TRACE_BLOCKS });
    }
  });
  const types: BlockType[] = [{ blockId: 'rock', shape: 'full' } as BlockType];
  return { scene: { blocks: [traceBlockLayerOf(grid, origin, opaqueByBlockTypes(types))] }, sources };
}

/** Hilly terrain: 4 × 4 tiles of 129 samples, 1 m apart (512 m square). */
function hills(): { scene: TraceSceneSource; sources: RaySource[]; field: TerrainField } {
  const comp = { tileSamples: 129, spacing: 1, heightRange: [-16, 48], tiles: [] as { x: number; z: number }[] } as unknown as TerrainComponent;
  const tiles = new Map<string, TerrainTile>();
  const H = (gx: number, gz: number): number => 6 + 14 * Math.sin(gx * 0.021) * Math.cos(gz * 0.017) + 4 * Math.sin(gx * 0.09 + gz * 0.05) + 1.2 * Math.sin(gx * 0.37) * Math.sin(gz * 0.29);
  for (let tz = 0; tz < 4; tz += 1) {
    for (let tx = 0; tx < 4; tx += 1) {
      comp.tiles.push({ x: tx, z: tz });
      const heights = new Uint16Array(129 * 129);
      for (let z = 0; z < 129; z += 1) for (let x = 0; x < 129; x += 1) heights[z * 129 + x] = Math.round(((H(tx * 128 + x, tz * 128 + z) + 16) / 64) * 65535);
      tiles.set(`${tx},${tz}`, { samples: 129, heights, weights: null, holes: null, paint: null });
    }
  }
  const origin: V3 = [-256, 0, -256];
  const field = new TerrainField(comp, origin, tiles);
  const r = rng(9);
  const sources: RaySource[] = [];
  // Texels in rows over the height grid.
  for (let z = 0; z < 512; z += 4) {
    for (let x = 0; x < 512; x += 4) {
      const wx = origin[0] + x + r();
      const wz = origin[2] + z + r();
      const s = field.sample(wx, wz);
      if (s === null) continue;
      sources.push({ p: [wx, s.height, wz], n: s.normal as V3, kind: TRACE_TERRAIN });
    }
  }
  return { scene: { terrain: [traceTerrainOf(field, comp.heightRange)!] }, sources, field };
}

/** The cases, by name. */
function cases(): TracerCaseSource[] {
  const town = blockTown();
  const land = hills();
  // The town stands on the hills' flat middle: both kinds in one scene.
  const mixedSources = [...town.sources.filter((_, i) => i % 2 === 0), ...land.sources.filter((_, i) => i % 2 === 0)];
  return [
    { name: 'blocks', scene: town.scene, sources: town.sources },
    { name: 'terrain', scene: land.scene, sources: land.sources },
    { name: 'mixed', scene: { ...town.scene, ...land.scene }, sources: mixedSources },
  ];
}

interface CaseResult {
  name: string;
  order: 'random' | 'grouped';
  rays: number;
  bytes: PackedTraceScene['bytes'];
  gpuMsMedian: number | null;
  nsPerRay: number | null;
  hitShare: number;
  mismatches: number;
}

/** GPU and CPU hits that disagree (kind, distance or normal). */
function mismatchesOf(gpu: Uint32Array, cpu: Uint32Array): number {
  const gf = new Float32Array(gpu.buffer, gpu.byteOffset, gpu.length);
  const cf = new Float32Array(cpu.buffer, cpu.byteOffset, cpu.length);
  let bad = 0;
  for (let i = 0; i < cpu.length; i += HIT_WORDS) {
    const kg = gpu[i + 4]! & 0xff;
    const kc = cpu[i + 4]! & 0xff;
    if (kg !== kc) {
      bad += 1;
      continue;
    }
    if (kc === 0) continue;
    const t = cf[i]!;
    const dot = gf[i + 1]! * cf[i + 1]! + gf[i + 2]! * cf[i + 2]! + gf[i + 3]! * cf[i + 3]!;
    if (Math.abs(gf[i]! - t) > 1e-3 * Math.max(1, t) || dot < 0.99) bad += 1;
  }
  return bad;
}

export async function runTracerCli(argv: readonly string[]): Promise<void> {
  const arg = (k: string, d: string): string => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1]! : d;
  };
  const count = Number(arg('--rays', '131072'));
  const frames = Number(arg('--frames', '60'));
  const only = arg('--kinds', '').split(',').filter((s) => s !== '');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = join(PERF_ROOT, 'runs', `tracer-${stamp}`);
  mkdirSync(root, { recursive: true });
  const esbuild = await import('esbuild');
  await esbuild.build({ entryPoints: [join(REPO, 'tools', 'perf', 'tracer-page.ts')], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', outfile: join(root, 'tracer.js'), logLevel: 'warning' });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>tracer</title><script src="tracer.js"></script>');
  const list = cases().filter((c) => only.length === 0 || only.includes(c.name));
  const prepared = list.flatMap((c) => {
    const scene = packTraceScene(c.scene);
    const { rays, kinds } = lightingRays(c.sources, count, 7);
    // Random order: the same rays shuffled.
    const r = rng(3);
    const shuffle = new Uint32Array(count);
    for (let i = 0; i < count; i += 1) shuffle[i] = i;
    for (let i = count - 1; i > 0; i -= 1) {
      const j = Math.floor(r() * (i + 1));
      [shuffle[i], shuffle[j]] = [shuffle[j]!, shuffle[i]!];
    }
    return (['random', 'grouped'] as const).map((order) => {
      const batch = reorderRays(rays, order === 'random' ? shuffle : groupRays(rays, kinds));
      return { name: c.name, order, scene, rays: batch, cpu: traceRaysCpu(scene, batch) };
    });
  });
  const b64 = (u: ArrayBufferView): string => Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString('base64');
  const site = await serveStatic(root);
  const browser = await launchGpuBrowser({ vsync: true });
  const maxMhz = gpuMaxMhz();
  const clock = gpuClockSampler();
  let page: Record<string, unknown>;
  try {
    const p = await (await browser.newContext()).newPage();
    await p.goto(`${site.url}/index.html`);
    page = (await p.evaluate(
      (input) => (window as unknown as { __tlTracer: { run(c: unknown): Promise<Record<string, unknown>> } }).__tlTracer.run(input),
      prepared.map((c) => ({ name: `${c.name}:${c.order}`, words: b64(c.scene.words), rays: b64(c.rays), frames })),
    )) as Record<string, unknown>;
  } finally {
    await browser.close();
    await site.close();
  }
  const mhz = clock?.stop() ?? null;
  rmSync(root, { recursive: true, force: true });
  if (page['error'] !== undefined) throw new Error(`tracer: ${String(page['error'])}`);
  const got = page['cases'] as { name: string; hits: string; ns: number[] }[];
  const results: CaseResult[] = prepared.map((c, i) => {
    const g = got[i]!;
    const hb = Buffer.from(g.hits, 'base64');
    const gpu = new Uint32Array(hb.buffer, hb.byteOffset, hb.byteLength / 4);
    const ns = [...g.ns].sort((a, b) => a - b);
    const med = ns.length > 0 ? ns[Math.floor(ns.length / 2)]! : null;
    let hit = 0;
    for (let k = 0; k < c.cpu.length; k += HIT_WORDS) if ((c.cpu[k + 4]! & 0xff) !== 0) hit += 1;
    return { name: c.name, order: c.order, rays: count, bytes: c.scene.bytes, gpuMsMedian: med === null ? null : med / 1e6, nsPerRay: med === null ? null : med / count, hitShare: hit / count, mismatches: mismatchesOf(gpu, c.cpu) };
  });
  const report = { at: new Date().toISOString(), adapter: page['adapter'], timed: page['timed'], gpuMhz: mhz, gpuMaxMhz: maxMhz, rays: count, frames, results };
  const out = join(PERF_ROOT, 'reports', `tracer-${stamp}.json`);
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  for (const r of results) {
    const full = r.nsPerRay !== null && mhz !== null && maxMhz !== null ? (r.nsPerRay * mhz) / maxMhz : null;
    console.log(`${r.name.padEnd(8)} ${r.order.padEnd(8)} ${r.gpuMsMedian?.toFixed(2) ?? '-'} ms  ${r.nsPerRay?.toFixed(2) ?? '-'} ns/ray (${full?.toFixed(2) ?? '-'} at full clock)  hits ${(r.hitShare * 100).toFixed(1)} %  GPU≠CPU ${r.mismatches}  scene ${JSON.stringify(r.bytes)}`);
  }
  console.log(`tracer: GPU clock ${mhz ?? '-'} of ${maxMhz ?? '-'} MHz; report ${out}`);
  const worst = Math.max(...results.map((r) => r.mismatches / r.rays));
  if (worst > 0.002) {
    console.log(`tracer: GPU and CPU disagree on ${(worst * 100).toFixed(2)} % of rays`);
    process.exitCode = 1;
  }
}
