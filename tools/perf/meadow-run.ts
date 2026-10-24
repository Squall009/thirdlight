/**
 * The meadow measurement (`node tools/perf/run.mjs meadow …`): the meadow class (meadow.ts) built through a
 * private backend and exported twice — with its grass cover and without (the same ground, the cover rule
 * removed) — each export measured on both renderers at the display's 60 Hz cap (frame-run.ts with vsync: frame
 * p95, missed refreshes, draws, triangles, main-thread time, GPU time per render pass from WebGPU's timestamps);
 * then the GPU density sweep: the plain three.js probe page (bare/grass.js) drawing the class's heights and
 * clump on the GPU for each of meadow.ts `SWEEP_CONFIGS`, also at the cap. The log ends with the sweep's rows and
 * the budget proposed from them.
 *
 *   --renderers webgpu,webgl2   (default both)
 *   --density N                 the cover rule's clumps per m² (default MEADOW_SPEC.grass.density)
 *   --cover-distance M          its reach (m; default MEADOW_SPEC.grass.coverDistance)
 *   --grass template            the 3D starter's grass (its setup pack's model, colour texture and foliage
 *                               material; one cover rule per piece, the density shared) in place of the stand-in
 *   --no-export                 the sweep only
 *   --no-sweep                  the exports only
 *   --sweep id,id               only these sweep configs (with `none`, the floor, always)
 *   --safety N                  the proposal keeps to 1/N of the triangles of the lightest config that missed the cap (default 2)
 *   --record-ms N --warmup-ms N --gpu-ms N --profile-ms N --keep
 *
 * The report goes to ~/.cache/thirdlight-perf/reports/meadow-<time>.json (latest-meadow.json too).
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FOLIAGE_NEAR_METRES } from '@thirdlight/project-model';

import { PERF_ROOT, REPO, startPerfBackend, type PerfBackend } from './backend';
import { publishFileVia } from './build';
import { launchGpuBrowser, measurePage, serveStatic, sourcesOf, type FrameRenderer, type FrameRunResult } from './frame-run';
import { LEVEL_LOOK, publishTerrainMaterial, STARTER_REMOVED } from './level';
import { MEADOW_KIT, MEADOW_SEED, MEADOW_SIDE, MEADOW_SPEC, MEADOW_VERSION, meadowCamera, meadowCoverRule, meadowHeights, meadowOrigin, meadowPaint, meadowSamples, meadowTerrainRaw, proposeSweepBudget, SWEEP_CONFIGS, sweepLoad, type SweepRow } from './meadow';
import { CLUMP_LEVELS, clumpKitGlb } from './village-assets';
import { frameLine } from './village-run';

const flagOf = (argv: readonly string[]) => (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const GRASS_MATERIAL = 'mat-meadow-grass';

type Cmd = (op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Which grass the cover draws: the generated stand-in clump, or the 3D starter template's grass asset. */
type MeadowGrass = 'stand-in' | 'template';
const TEMPLATE_SETUP = join(REPO, 'templates', 'starter-3d', 'setup');
const TEMPLATE_GRASS = 'meadow-grass';

/** The piece names of a GLB (its top-level node names without `_LODn`), in file order. */
function glbPieces(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true)))) as { nodes: { name: string }[] };
  return [...new Set(json.nodes.map((n) => n.name.replace(/_LOD\d+$/i, '')))];
}

/**
 * Publish the template's grass as its setup pack makes it (the model, its texture, the foliage material and the
 * mapping) and return the cover rules: one per piece, the density shared between them.
 */
async function publishTemplateGrass(be: PerfBackend, projectId: string, cmd: Cmd, density: number, coverDistance: number): Promise<Record<string, unknown>[]> {
  const pack = JSON.parse(readFileSync(join(TEMPLATE_SETUP, 'pack.json'), 'utf8')) as { assets: { assetId: string; kind: 'model' | 'texture'; displayName: string; file: string; materials?: Record<string, string> }[]; commands: { op: string; args: Record<string, unknown> }[] };
  const model = pack.assets.find((a) => a.assetId === TEMPLATE_GRASS);
  if (model === undefined) throw new Error(`meadow: the 3D starter has no ${TEMPLATE_GRASS} model`);
  const materialIds = new Set(Object.values(model.materials ?? {}));
  const materials = pack.commands.filter((c) => c.op === 'setMaterial' && materialIds.has((c.args['material'] as { materialId: string }).materialId)).map((c) => c.args['material'] as { textures?: Record<string, string> });
  const textures = new Set(materials.flatMap((m) => Object.values(m.textures ?? {})));
  for (const a of pack.assets.filter((x) => textures.has(x.assetId))) await publishFileVia(be, projectId, cmd, { assetId: a.assetId, kind: a.kind, displayName: a.displayName, bytes: readFileSync(join(TEMPLATE_SETUP, 'assets', a.file)) });
  const bytes = readFileSync(join(TEMPLATE_SETUP, 'assets', model.file));
  await publishFileVia(be, projectId, cmd, { assetId: MEADOW_KIT, kind: 'model', displayName: model.displayName, bytes });
  for (const material of materials) await cmd('setMaterial', { material });
  await cmd('setAssetOptions', { assetId: MEADOW_KIT, materials: model.materials ?? {} });
  const pieces = glbPieces(bytes);
  return pieces.map((piece) => ({ ...meadowCoverRule(density / pieces.length, coverDistance), id: piece, asset: { assetId: MEADOW_KIT, piece } }));
}

/** Build the meadow into a new project; returns the terrain's id (its cover is baked by the caller). */
async function buildMeadow(be: PerfBackend, projectId: string, log: (s: string) => void, grass: MeadowGrass, density: number, coverDistance: number): Promise<{ terrainId: string; cmd: Cmd; cover: Record<string, unknown>[] }> {
  const t0 = performance.now();
  const created = await be.post('/api/v1/admin/projects', { projectId, name: 'Perf meadow' });
  if (created.status !== 201 && created.status !== 200) throw new Error(`project create failed: ${created.status} ${JSON.stringify(created.json)}`);
  const p = be.project(projectId);
  const cmd: Cmd = (op, args) => p.command(op, args);
  for (const id of STARTER_REMOVED) await cmd('deleteEntity', { entityId: id }).catch(() => undefined);
  await cmd('setSettings', { settings: { physics_dimension: 3, camera_far_m: MEADOW_SPEC.farPlane } });
  let cover = [meadowCoverRule(density, coverDistance)];
  if (grass === 'template') cover = await publishTemplateGrass(be, projectId, cmd, density, coverDistance);
  else {
    await publishFileVia(be, projectId, cmd, { assetId: MEADOW_KIT, kind: 'model', displayName: 'Meadow grass (stand-in clump)', bytes: clumpKitGlb(MEADOW_SEED, MEADOW_SPEC.grass.clumpHeight) });
    // The foliage material with the engine's foliage policy (wind near the camera only), as the level classes' kits wear it.
    await cmd('setMaterial', { material: { materialId: GRASS_MATERIAL, name: 'Meadow grass', shader: 'foliage', params: { color: '#4d7a2e', roughness: 0.8, windDistance: FOLIAGE_NEAR_METRES }, textures: {} } });
    await cmd('setAssetOptions', { assetId: MEADOW_KIT, materials: { grass: GRASS_MATERIAL } });
  }
  const material = await publishTerrainMaterial(be, projectId, cmd, MEADOW_SEED, { rules: false, projection: 0 });
  const T = MEADOW_SPEC.terrain;
  const tiles: { x: number; z: number }[] = [];
  for (let z = 0; z < T.tiles; z += 1) for (let x = 0; x < T.tiles; x += 1) tiles.push({ x, z });
  await cmd('pasteEntities', { sceneId: 'scene-main', entities: [{ id: 'terrain', name: 'Terrain', static: true, components: { transform: { position: meadowOrigin() }, terrain: { tileSamples: T.tileSamples, spacing: T.spacing, heightRange: [...T.heightRange], tiles }, materials: { '*': material } } }] });
  const listed = (await p.query('queryEntities', { limit: 100, offset: 0 }))['entities'] as { id: string; components: Record<string, unknown> }[];
  const terrainId = listed.find((e) => e.components['terrain'] !== undefined)?.id;
  if (terrainId === undefined) throw new Error('meadow: the terrain was not created');
  const stageId = await be.stage(projectId, meadowTerrainRaw());
  await cmd('editTerrain', { entityId: terrainId, kind: 'import', stageId, format: 'raw16', at: [0, 0] });
  await be.discardStage(projectId, stageId);
  for (const d of meadowPaint()) await cmd('editTerrain', { entityId: terrainId, kind: 'paint', dabs: [d.at], radius: d.radius, strength: d.strength, falloff: 'smooth', layer: d.layer });
  const camera = meadowCamera();
  await cmd('setTransform', { entityId: 'cam-main', transform: { position: camera.position, rotation: camera.rotation } });
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffe2bd', intensity: 2, direction: [0.5, -0.55, -0.65], castShadow: true } });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: LEVEL_LOOK });
  log(`meadow: ground built in ${Math.round(performance.now() - t0)} ms (${MEADOW_SIDE} m square, ${tiles.length} tiles, ${meadowPaint().length} painted patches)`);
  return { terrainId, cmd, cover };
}

export interface MeadowReport {
  reportVersion: 1;
  startedAt: string;
  version: number;
  seed: number;
  grass: { density: number; coverDistance: number; asset?: MeadowGrass };
  exports: Partial<Record<'grass' | 'ground', Partial<Record<FrameRenderer, FrameRunResult>>>>;
  sweep: (SweepRow & { load: { clumps: number; triangles: number }; runs: Partial<Record<FrameRenderer, FrameRunResult>> })[];
  proposed: ReturnType<typeof proposeSweepBudget>;
  errors: string[];
}

/** One line of the sweep for the log: per renderer p95, missed refreshes, GPU ms, draws and triangles. */
function sweepLine(row: MeadowReport['sweep'][number]): string {
  const parts = Object.entries(row.runs).map(([r, res]) => `${r} p95 ${res.frames.p95} ms, ${res.frames.missed ?? 0} missed, gpu ${res.gpu?.available === true ? `${res.gpu.msPerFrame} ms` : '-'}, ${res.draws.p50} draws, ${Math.round(res.tris.p50 / 1000)}k tris, main ${res.mainThread.taskMsPerFrame} ms`);
  return `meadow sweep ${row.id} (${row.load.clumps} clumps / ${Math.round(row.load.triangles / 1000)}k tris all round): ${parts.join('; ')}`;
}

export async function runMeadowCli(argv: readonly string[]): Promise<void> {
  const get = flagOf(argv);
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const log = (s: string): void => console.log(s);
  const renderers = (get('renderers') ?? 'webgpu,webgl2').split(',') as FrameRenderer[];
  for (const r of renderers) if (r !== 'webgpu' && r !== 'webgl2') throw new Error(`--renderers: webgpu or webgl2, not ${r}`);
  const density = Number(get('density') ?? MEADOW_SPEC.grass.density);
  const coverDistance = Number(get('cover-distance') ?? MEADOW_SPEC.grass.coverDistance);
  const grass = (get('grass') ?? 'stand-in') as MeadowGrass;
  if (grass !== 'stand-in' && grass !== 'template') throw new Error(`--grass: stand-in or template, not ${grass}`);
  const recordMs = Number(get('record-ms') ?? 10000);
  const warmupMs = Number(get('warmup-ms') ?? 3000);
  const gpuMs = Number(get('gpu-ms') ?? 3000);
  const profileMs = Number(get('profile-ms') ?? 5000);
  const safety = Number(get('safety') ?? 2);
  const only = get('sweep')?.split(',');
  // `--cover cpu`: the terrain's cover made on the CPU, as before the GPU placed it (a comparison).
  const coverFlag = get('cover') === 'cpu' ? '&cover=cpu' : '';
  const configs = SWEEP_CONFIGS.filter((c) => only === undefined || c.id === 'none' || only.includes(c.id));

  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-');
  const runDir = join(PERF_ROOT, 'runs', `meadow-${stamp}`);
  const reportsDir = join(PERF_ROOT, 'reports');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });
  const report: MeadowReport = { reportVersion: 1, startedAt, version: MEADOW_VERSION, seed: MEADOW_SEED, grass: { density, coverDistance, asset: grass }, exports: {}, sweep: [], proposed: null, errors: [] };

  // Both exports from one backend, measured with it stopped (one backend or one browser at a time).
  const exportDirs: Partial<Record<'grass' | 'ground', string>> = {};
  if (!has('no-export')) {
    const be = await startPerfBackend(join(runDir, 'data'), join(runDir, 'exports'));
    try {
      const { terrainId, cmd, cover } = await buildMeadow(be, 'meadow', log, grass, density, coverDistance);
      for (const variant of ['grass', 'ground'] as const) {
        const t = performance.now();
        await cmd('editTerrain', { entityId: terrainId, kind: 'bake', scatter: variant === 'grass' ? cover : [] });
        const res = await be.post('/api/v1/admin/projects/meadow/export', {});
        if (res.status !== 200) throw new Error(`export failed: ${JSON.stringify(res.json).slice(0, 400)}`);
        exportDirs[variant] = join(be.exportRoot, String(res.json['outputDir']));
        log(`meadow ${variant}: baked and exported in ${Math.round(performance.now() - t)} ms`);
      }
    } finally {
      await be.stop();
    }
  }

  // Always at the display's rate: the targets are held at the 60 Hz cap, and uncapped runs throttle.
  const browser = await launchGpuBrowser({ vsync: true });
  try {
    for (const variant of ['grass', 'ground'] as const) {
      if (exportDirs[variant] === undefined) continue;
      const site = await serveStatic(exportDirs[variant]!);
      try {
        for (const r of renderers) {
          const res = await measurePage(browser, { url: `${site.url}?renderer=${r}${coverFlag}`, warmupMs, recordMs, gpuMs, profileMs, sourceOf: sourcesOf(site), shot: join(runDir, `meadow-${variant}-${r}.png`) });
          (report.exports[variant] ??= {})[r] = res;
          log(`${frameLine(`meadow ${variant} ${r}`, res)}, ${res.frames.missed ?? 0} missed a 60 Hz refresh`);
        }
      } finally {
        await site.close();
      }
    }
    if (!has('no-sweep')) {
      // The probe's data: the class's heights, its clump, the camera.
      const data = join(runDir, 'probe');
      mkdirSync(data, { recursive: true });
      const heights = meadowHeights();
      writeFileSync(join(data, 'heights.bin'), Buffer.from(heights.buffer, heights.byteOffset, heights.byteLength));
      writeFileSync(join(data, 'clump.glb'), clumpKitGlb(MEADOW_SEED, MEADOW_SPEC.grass.clumpHeight));
      writeFileSync(join(data, 'meta.json'), JSON.stringify({ samples: meadowSamples(), spacing: MEADOW_SPEC.terrain.spacing, origin: meadowOrigin() }));
      const c = meadowCamera();
      const cam = [...c.position, ...c.rotation].join(',');
      const page = await serveStatic(join(REPO, 'tools', 'perf', 'bare'), { 'three/': join(REPO, 'node_modules', 'three'), 'meadow/': data });
      try {
        for (const cfg of configs) {
          const row: MeadowReport['sweep'][number] = { id: cfg.id, clumps: 0, byRenderer: {}, load: sweepLoad(cfg, CLUMP_LEVELS), runs: {} };
          row.clumps = row.load.clumps;
          for (const r of renderers) {
            const res = await measurePage(browser, { url: `${page.url}grass.html?renderer=${r}&cam=${cam}&rings=${encodeURIComponent(JSON.stringify(cfg.rings))}`, warmupMs: 2000, recordMs: Math.min(recordMs, 6000), gpuMs, profileMs: 0, shot: join(runDir, `sweep-${cfg.id.replace(/[^a-z0-9-]/gi, '_')}-${r}.png`) });
            row.runs[r] = res;
            row.byRenderer[r] = { p95: res.frames.p95, missed: res.frames.missed ?? 0, gpuMs: res.gpu?.available === true ? res.gpu.msPerFrame : null, tris: res.tris.p50 };
            if (res.errors.length > 0) report.errors.push(`sweep ${cfg.id} ${r}: ${res.errors[0]}`);
          }
          report.sweep.push(row);
          log(sweepLine(row));
        }
      } finally {
        await page.close();
      }
      report.proposed = proposeSweepBudget(report.sweep, safety);
      const p = report.proposed;
      log(`meadow sweep: ${p === null ? 'no config held the cap' : `proposed ${p.id} (${p.clumps} clumps all round, ${Math.round(p.tris / 1000)}k tris in view); ${p.brokeAt === null ? 'no config missed the cap' : `the lightest that missed the cap: ${p.brokeAt.id} (${Math.round(p.brokeAt.tris / 1000)}k tris in view), safety ${safety}`}`}`);
    }
  } finally {
    await browser.close();
  }

  const out = join(reportsDir, `meadow-${stamp}.json`);
  writeFileSync(out, JSON.stringify(report, null, 1));
  copyFileSync(out, join(reportsDir, 'latest-meadow.json'));
  for (const e of report.errors) log(`meadow error: ${e}`);
  log(`meadow: report ${out}${has('keep') ? `, run folder ${runDir}` : ''}`);
  if (!has('keep')) rmSync(runDir, { recursive: true, force: true });
}
