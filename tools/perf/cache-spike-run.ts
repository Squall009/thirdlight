/**
 * The surface-cache spike, measured (`node tools/perf/run.mjs cache-spike …`):
 * whether one block room's light can be re-lit by traced rays into a cache
 * within the lighting budget on this host's integrated GPU.
 *
 * The look scene `door` (a block room lit through its door) is built with a
 * lamp panel on its ceiling and hilly terrain round its slab, baked in the
 * editor (that gives the chunks their UV1 slots), exported, and served. The
 * page (cache-spike-page.ts) puts a cache atlas on the chunks and re-lights it
 * after light changes, a budget of texels per frame, at the display's 60 Hz
 * cap; the GPU's clock is sampled during every re-light (ms × clock ÷ max
 * clock is the time at full clock). The block grid comes from the export's
 * binary chunk data and the terrain from its height tiles, decoded here.
 *
 *   --P N            texels per slot side (default 12: 10 texels a metre inside the margin)
 *   --budgets a,b,c  texels lit per frame (default 4096,8192,16384,32768)
 *   --shots DIR      screenshots (default ~/.cache/thirdlight-phase42/acceptance)
 *   --keep           keep the run folder
 *
 * The report goes to ~/.cache/thirdlight-perf/reports/cache-spike-<time>.json.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { BlockGrid, decodeBlockChunks, decodeTerrainTile, readBlockChunkData, readTerrainTileBlob, terrainHeightOf, type BlockLayerComponent } from '@thirdlight/project-model';

import { PERF_ROOT, REPO, startPerfBackend } from './backend';
import { cacheSpikeFrames, cacheSpikeRelight, cacheSpikeSetup, installCacheSpikeHook, type SpikeRelight, type SpikeSetup } from './cache-spike-page';
import { CACHE_SPIKE_WGSL } from './cache-spike-wgsl';
import { FRAME_VIEWPORT, gpuClockSampler, gpuMaxMhz, launchGpuBrowser, serveStatic } from './frame-run';
import { buildLook } from './look';
import { bakeLightingInEditor } from './bake-run';

type V3 = [number, number, number];
const TERRAIN_AT: V3 = [-52, 0, -52];
const LAMP: V3 = [12.5, 3.92, 12.5];

/** The look scene's extras: a lamp panel on the room's ceiling, a pillar under it (the lamp's penumbrae) and hills round the slab (terrain at the slab's foot). */
async function addSpikeExtras(p: { command(op: string, a: Record<string, unknown>): Promise<Record<string, unknown>>; query(op: string, a?: Record<string, unknown>): Promise<Record<string, unknown>> }): Promise<void> {
  const panel = String((await p.command('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name: 'Lamp panel', static: true, transform: { position: [LAMP[0], 3.97, LAMP[2]] }, box: { size: [1.2, 0.04, 0.6] } }))['createdId']);
  await p.command('setComponent', { entityId: panel, component: 'surface', value: { roughness: 0.8, metalness: 0, color: '#ffffff', emissive: '#fff0d8', emissiveIntensity: 4 } });
  const tiles = [0, 1].flatMap((z) => [0, 1].map((x) => ({ x, z })));
  await p.command('pasteEntities', { sceneId: 'scene-main', entities: [{ id: 'terrain', name: 'Terrain', static: true, components: { transform: { position: TERRAIN_AT, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, terrain: { tileSamples: 65, spacing: 1, heightRange: [-16, 48], tiles } } }] });
  const listed = (await p.query('queryEntities', { limit: 100, offset: 0 }))['entities'] as { id: string; components: Record<string, unknown> }[];
  const layerId = listed.find((e) => e.components['blockLayer'] !== undefined)?.id;
  if (layerId === undefined) throw new Error('cache-spike: no block layer');
  await p.command('editBlocks', { entityId: layerId, edits: [{ kind: 'fill', box: [14, 1, 12, 15, 3, 13], cell: { block: 'rock' } }] });
  const terrainId = listed.find((e) => e.components['terrain'] !== undefined)?.id;
  if (terrainId === undefined) throw new Error('cache-spike: the terrain was not created');
  for (const [x, z, h] of [[64, 112, 12], [24, 40, 9], [108, 76, 10], [36, 104, 8], [100, 20, 7]] as const) await p.command('editTerrain', { entityId: terrainId, kind: 'raise', dabs: [[x, z]], radius: 20, strength: h, falloff: 'smooth' });
  await p.command('editTerrain', { entityId: terrainId, kind: 'noise', dabs: [[64, 64]], radius: 64, strength: 0.5, scale: 6, seed: 5, falloff: 'smooth' });
  await p.command('editTerrain', { entityId: terrainId, kind: 'flatten', dabs: [[64, 64]], radius: 24, strength: 1, height: 0, falloff: 'smooth' });
}

function walkJson(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walkJson(p, out);
    else if (f.endsWith('.json')) out.push(p);
  }
  return out;
}

function findAll(v: unknown, pick: (o: Record<string, unknown>) => boolean, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(v)) for (const x of v) findAll(x, pick, out);
  else if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (pick(o)) out.push(o);
    for (const x of Object.values(o)) findAll(x, pick, out);
  }
  return out;
}

/** The export's block layer and terrain, from their binary blobs. */
function readGeometry(exportDir: string): { grid: SpikeSetup['grid']; terrain: Omit<SpikeSetup['terrain'], 'patch'>; cellSize: number[]; minCell: number[] } {
  const docs = walkJson(exportDir).map((f) => JSON.parse(readFileSync(f, 'utf8')) as unknown);
  const blob = (digest: string): Uint8Array => {
    const f = join(exportDir, 'content', 'sha256', digest);
    if (!existsSync(f)) throw new Error(`cache-spike: no blob ${digest}`);
    return new Uint8Array(readFileSync(f));
  };
  const layer = docs.flatMap((d) => findAll(d, (o) => typeof o['chunkData'] === 'string'))[0];
  if (layer === undefined) throw new Error('cache-spike: no block layer with chunk data in the export');
  const comp = docs.flatMap((d) => findAll(d, (o) => typeof o['blockLayer'] === 'object' && o['blockLayer'] !== null))[0]?.['blockLayer'] as BlockLayerComponent | undefined;
  if (comp === undefined) throw new Error('cache-spike: no block layer component in the export');
  const data = readBlockChunkData(blob(String(layer['chunkData'])));
  const raw = data.compression === 'gzip' ? new Uint8Array(gunzipSync(data.stored)) : data.stored;
  const grid = BlockGrid.from(comp, { chunks: decodeBlockChunks(raw) } as never);
  const [min, max] = [grid.min, grid.max];
  const dims: V3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const bits = new Array<number>(Math.ceil((dims[0] * dims[1] * dims[2]) / 32)).fill(0);
  for (let y = 0; y < dims[1]; y++) for (let z = 0; z < dims[2]; z++) for (let x = 0; x < dims[0]; x++) {
    if (grid.get(x + min[0], y + min[1], z + min[2]) === null) continue;
    const i = (y * dims[2] + z) * dims[0] + x;
    bits[i >> 5] = (bits[i >> 5]! | (1 << (i & 31))) >>> 0;
  }
  const terr = docs.flatMap((d) => findAll(d, (o) => typeof o['tileSamples'] === 'number' && Array.isArray(o['tiles'])))[0];
  if (terr === undefined) throw new Error('cache-spike: no terrain in the export');
  const samples = Number(terr['tileSamples']);
  const spacing = Number(terr['spacing']);
  const range = terr['heightRange'] as number[];
  const tiles = terr['tiles'] as { x: number; z: number; data?: string }[];
  const tx = Math.max(...tiles.map((t) => t.x)) + 1;
  const cells = (samples - 1) * tx;
  const n = cells + 1;
  const heights = new Float32Array(n * n);
  for (const t of tiles) {
    let h: Uint16Array | null = null;
    if (t.data !== undefined) {
      const b = readTerrainTileBlob(blob(t.data));
      const payload = b.compression === 'gzip' ? new Uint8Array(gunzipSync(b.stored)) : b.stored;
      h = decodeTerrainTile(payload).heights;
    }
    for (let z = 0; z < samples; z++) for (let x = 0; x < samples; x++) heights[(t.z * (samples - 1) + z) * n + t.x * (samples - 1) + x] = h === null ? 0 : terrainHeightOf(range, h[z * samples + x]!);
  }
  // The max pyramid: level 0 is each cell's highest corner, every level above the highest of four.
  const out: number[] = [...heights];
  let prev: number[] = [];
  const levels = Math.log2(cells);
  for (let l = 0; l <= levels; l++) {
    const c = cells >> l;
    const lv: number[] = [];
    for (let z = 0; z < c; z++) for (let x = 0; x < c; x++) {
      if (l === 0) lv.push(Math.max(heights[z * n + x]!, heights[z * n + x + 1]!, heights[(z + 1) * n + x]!, heights[(z + 1) * n + x + 1]!));
      else lv.push(Math.max(prev[2 * z * 2 * c + 2 * x]!, prev[2 * z * 2 * c + 2 * x + 1]!, prev[(2 * z + 1) * 2 * c + 2 * x]!, prev[(2 * z + 1) * 2 * c + 2 * x + 1]!));
    }
    out.push(...lv);
    prev = lv;
  }
  return { grid: { dims, bits }, terrain: { origin: TERRAIN_AT, spacing, cells, levels, data: out }, cellSize: [...grid.cellSize], minCell: [...min] };
}

const srgb = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const norm = (v: V3): V3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const r2 = (x: number): number => Math.round(x * 100) / 100;

export async function runCacheSpikeCli(argv: readonly string[]): Promise<void> {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const P = Number(get('P') ?? 12);
  const budgets = (get('budgets') ?? '4096,8192,16384,32768').split(',').map(Number);
  const shots = get('shots') ?? join(homedir(), '.cache', 'thirdlight-phase42', 'acceptance');
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-');
  const runDir = join(PERF_ROOT, 'runs', `cache-spike-${stamp}`);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(shots, { recursive: true });
  const log = (s: string): void => console.log(`cache-spike: ${s}`);
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    /* not a git checkout */
  }
  const report: Record<string, unknown> = { startedAt, commit, P, uptime: execFileSync('uptime', { encoding: 'utf8' }).trim() };

  let exportDir = '';
  const be = await startPerfBackend(join(runDir, 'data'), join(runDir, 'exports'));
  try {
    const projectId = 'spike-door';
    const build = await buildLook(be, projectId, 'door', 'baked');
    await addSpikeExtras(be.project(projectId));
    log(`built in ${build.ms} ms`);
    report['bake'] = await bakeLightingInEditor(be, projectId, log);
    const res = await be.post(`/api/v1/admin/projects/${projectId}/export`, {});
    if (res.status !== 200) throw new Error(`export failed: ${JSON.stringify(res.json).slice(0, 400)}`);
    exportDir = join(be.exportRoot, String(res.json['outputDir']));
  } finally {
    await be.stop();
  }
  const geo = readGeometry(exportDir);
  if (geo.cellSize.some((c) => c !== 1) || geo.minCell.some((c) => c !== 0)) throw new Error(`cache-spike: the spike assumes 1 m cells from the origin (${geo.cellSize} / ${geo.minCell})`);
  const sunColor = [0xff, 0xf0, 0xdc].map((c) => srgb(c / 255) * 3) as V3;
  const lampColor = [1, 0.92, 0.8].map((c) => c * 20) as V3;
  const setup: SpikeSetup = {
    wgsl: CACHE_SPIKE_WGSL,
    P,
    margin: 0.08,
    grid: geo.grid,
    // A 64 m square of terrain cache at 25 cm next to the slab: the terrain kind's cost per texel.
    terrain: { ...geo.terrain, patch: { min: [-40, -40], texel: 0.25, texels: 256 } },
    sun: { toLight: norm([-0.15, 0.55, 0.82]), radius: 0.02, irradiance: sunColor, rays: 8 },
    rect: { centre: LAMP, eu: [0.6, 0, 0], ev: [0, 0, -0.3], radiance: lampColor, range: 8, rays: 16, on: false },
  };
  const maxMhz = gpuMaxMhz();
  const browser = await launchGpuBrowser({ vsync: true });
  const site = await serveStatic(exportDir);
  try {
    const context = await browser.newContext({ viewport: { ...FRAME_VIEWPORT }, deviceScaleFactor: 1 });
    await context.addInitScript(installCacheSpikeHook);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`.slice(0, 300)));
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`.slice(0, 300));
    });
    await page.goto(`${site.url}?renderer=webgpu`);
    await page.waitForFunction(() => {
      const S = (window as unknown as { __tlSpike?: { scenes: { children: { name: string }[] }[] } }).__tlSpike;
      return S?.scenes.some((s) => s.children.some((c) => c.name.startsWith('block:'))) === true;
    }, null, { timeout: 120_000 }).catch(async (e: unknown) => {
      const state = await page.evaluate(() => {
        const S = (window as unknown as { __tlSpike?: { renderer: unknown; scenes: { children: { name: string; type: string }[] }[] } }).__tlSpike;
        return { renderer: S?.renderer !== null && S?.renderer !== undefined, scenes: S?.scenes.map((s) => s.children.map((c) => `${c.type}:${c.name}`).slice(0, 30)) };
      });
      throw new Error(`cache-spike: no block layers drawn (${JSON.stringify(state)}; ${errors.slice(0, 5).join(' | ')}): ${String(e)}`);
    });
    await page.waitForTimeout(4000);
    const made = await page.evaluate(cacheSpikeSetup, setup);
    report['setup'] = made;
    log(`setup ${JSON.stringify(made)}`);
    if (made['error'] !== undefined) throw new Error(String(made['error']));
    const runs: Record<string, unknown>[] = [];
    const relight = async (name: string, r: Omit<SpikeRelight, 'seed'>, keep = true): Promise<Record<string, unknown>> => {
      const clock = gpuClockSampler();
      const res = await page.evaluate(cacheSpikeRelight, { ...r, seed: 0x9e3779b9 + runs.length * 7919 });
      const mhz = clock?.stop() ?? null;
      if (res['error'] !== undefined) throw new Error(String(res['error']));
      const gpu = res['gpu'] as number[];
      const iv = res['intervals'] as number[];
      const full = (ms: number): number => (mhz !== null && maxMhz !== null ? (ms * mhz) / maxMhz : ms);
      const sum = gpu.reduce((a, b) => a + b, 0);
      const row = { name, ...r, items: res['items'], blockSlots: res['blockSlots'], frames: res['dispatches'], settledMs: res['settledMs'], gpuMsPerFrame: { mean: r2(sum / Math.max(1, gpu.length)), p95: r2(pct(gpu, 0.95)), max: r2(Math.max(0, ...gpu)) }, gpuMsTotal: r2(sum), fullClock: { mean: r2(full(sum / Math.max(1, gpu.length))), max: r2(full(Math.max(0, ...gpu))), total: r2(full(sum)) }, nsPerTexel: r2((full(sum) * 1e6) / Number(res['items'])), mhz, maxMhz, missed: iv.filter((x) => x > 16.7 * 1.5).length, intervals: iv.length, intervalP95: r2(pct(iv, 0.95)) };
      if (keep) runs.push(row);
      log(`${name}: ${row.items} texels in ${row.frames} frames, settled ${row.settledMs} ms; GPU/frame mean ${row.gpuMsPerFrame.mean} max ${row.gpuMsPerFrame.max} ms raw at ${mhz} MHz, full clock mean ${row.fullClock.mean} max ${row.fullClock.max}; total ${row.fullClock.total} ms (${row.nsPerTexel} ns/texel); missed ${row.missed}/${row.intervals}`);
      return row;
    };
    const shot = async (name: string): Promise<void> => {
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(shots, `42.1-${name}.jpg`), type: 'jpeg', quality: 88 });
    };
    // First fill: the sun alone, every block texel and the terrain patch.
    await relight('fill', { stale: 'all', order: 'grouped', perFrame: 65536, rect: { on: false } }, false);
    await shot('door-sun-only-webgpu');
    // A switched lamp: its room's texels, at each budget (off again between, unmeasured).
    for (const b of budgets) {
      await relight(`lamp on, budget ${b}`, { stale: 'room', order: 'grouped', perFrame: b, rect: { on: true } });
      if (b !== budgets[budgets.length - 1]) await relight('lamp off', { stale: 'room', order: 'grouped', perFrame: 65536, rect: { on: false } }, false);
    }
    await shot('door-lamp-webgpu');
    // The sun moved: every block texel.
    const sunA = setup.sun.toLight;
    const sunB = norm([-0.3, 0.5, 0.8]);
    for (const b of budgets) await relight(`sun moved, budget ${b}`, { stale: 'blocks', order: 'grouped', perFrame: b, sun: { toLight: budgets.indexOf(b) % 2 === 1 ? sunA : sunB } });
    // Grouped against shuffled (Intel divergence): the same texels and rays, ordered by kind, facing and slot, or at random.
    const bMid = budgets[1] ?? budgets[0]!;
    for (const stale of ['blocks', 'terrain', 'all'] as const) for (const order of ['grouped', 'shuffled'] as const) await relight(`${stale} ${order}`, { stale, order, perFrame: bMid });
    // More rays per texel: the cost of softer, cleaner penumbrae.
    await relight('lamp, 64 rect rays + 16 sun rays', { stale: 'room', order: 'grouped', perFrame: bMid, rect: { on: true, rays: 64 }, sun: { toLight: setup.sun.toLight, rays: 16 } });
    await shot('door-lamp-64rays-webgpu');
    await relight('lamp, 16 rect rays + 8 sun rays', { stale: 'room', order: 'grouped', perFrame: bMid, rect: { on: true, rays: 16 }, sun: { toLight: setup.sun.toLight, rays: 8 } }, false);
    const idle = await page.evaluate(cacheSpikeFrames, 5000);
    report['settledFrames'] = { n: idle.length, p95: r2(pct(idle, 0.95)), missed: idle.filter((x) => x > 25).length };
    report['runs'] = runs;
    report['errors'] = errors.slice(0, 30);
    await context.close();
  } finally {
    await site.close();
    await browser.close();
  }
  const out = get('out') ?? join(PERF_ROOT, 'reports', `cache-spike-${stamp}.json`);
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  log(`report ${out}`);
  if (!argv.includes('--keep')) rmSync(runDir, { recursive: true, force: true });
}
