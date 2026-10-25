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
 *   --wind S                    the scene's wind strength S (gusts 0.8 S, from the side of the view; default: the
 *                               engine's light breeze)
 *   --wind-zone                 with a calm wind zone (a 25 m sphere, 10 m blend) 40 m ahead of the camera
 *   --walker                    a 1.8 m box walking across the view 7 m ahead (a mover), named the view's subject by a script
 *                               with see-through off: the grass gives way round it
 *   --walker-strength S         its foliageBend strength (default: the engine's; 0: it parts nothing)
 *   --walker-radius R           its foliageBend radius in metres (default: the engine's, from its body)
 *   --walker-speed V            metres per second it walks (default 1.2; 0: it stands at the middle of its path)
 *   --walk V                    the camera walks at V m/s (eye height over the ground) 60 m into the field and back, so the
 *                               cover's rings, patches and masks follow a moving eye (the player walking through it)
 *   --walk-from X,Z             where the walk starts (world metres; default: the class's camera); 0,0 is where the 4 tiles meet
 *   --starter                   on the 3D starter: its player walks (W held, twice 8 s) through the cover, its follow camera behind,
 *                               its block ground (at the origin, where the tiles meet) under a cover rule too
 *   --moss-ahead M              on the starter: its block ground M metres along the walk (default 8: beside the start)
 *   --moss-right R              and its corner R metres to the right of the walk (default 10; -17 centres it on the walk, so
 *                               with --moss-ahead 40 the walk starts out of the moss rule's reach and crosses every ring)
 *   --spacing S                 the cover rules keep S metres between copies
 *   --blocks-layer              the terrain meets the scene's block layers (a blocks layer: holes under them; the cover reads masks)
 *   --no-post                   no post stack: the scene draws with MSAA (a new project's default)
 *   --query Q                   added to the exports' page URL (e.g. cover=cpu)
 *   --clouds C                  under the physical sky with cloud cover C (density 0.6), drifting with the wind
 *   --root-colour K             the grass material's `rootColour` K (its bases blend toward the terrain under them)
 *   --root-colour-height H      and its `rootColourHeight` H (default: the material's)
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

import { DEFAULT_FIXED_STEP_HZ, FOLIAGE_NEAR_METRES } from '@thirdlight/project-model';

import { PERF_ROOT, REPO, startPerfBackend, type PerfBackend } from './backend';
import { publishBehaviorVia, publishFileVia } from './build';
import { seeThroughBehavior } from './see-through-run';
import { launchGpuBrowser, measurePage, serveStatic, sourcesOf, type FrameRenderer, type FrameRunResult } from './frame-run';
import { LEVEL_LOOK, publishTerrainMaterial, STARTER_REMOVED } from './level';
import { MEADOW_KIT, MEADOW_SEED, MEADOW_SIDE, MEADOW_SPEC, MEADOW_VERSION, meadowCamera, meadowHeight, meadowCoverRule, meadowHeights, meadowOrigin, meadowPaint, meadowSamples, meadowTerrainRaw, proposeSweepBudget, SWEEP_CONFIGS, sweepLoad, type SweepRow } from './meadow';
import { EYE_HEIGHT_M, type BehaviorPlan } from './generate';
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
async function publishTemplateGrass(be: PerfBackend, projectId: string, cmd: Cmd, density: number, coverDistance: number, extra: Record<string, unknown>, published = false): Promise<Record<string, unknown>[]> {
  const pack = JSON.parse(readFileSync(join(TEMPLATE_SETUP, 'pack.json'), 'utf8')) as { assets: { assetId: string; kind: 'model' | 'texture'; displayName: string; file: string; materials?: Record<string, string> }[]; commands: { op: string; args: Record<string, unknown> }[] };
  const model = pack.assets.find((a) => a.assetId === TEMPLATE_GRASS);
  if (model === undefined) throw new Error(`meadow: the 3D starter has no ${TEMPLATE_GRASS} model`);
  const materialIds = new Set(Object.values(model.materials ?? {}));
  const materials = pack.commands.filter((c) => c.op === 'setMaterial' && materialIds.has((c.args['material'] as { materialId: string }).materialId)).map((c) => c.args['material'] as { textures?: Record<string, string> });
  const textures = new Set(materials.flatMap((m) => Object.values(m.textures ?? {})));
  if (!published) for (const a of pack.assets.filter((x) => textures.has(x.assetId))) await publishFileVia(be, projectId, cmd, { assetId: a.assetId, kind: a.kind, displayName: a.displayName, bytes: readFileSync(join(TEMPLATE_SETUP, 'assets', a.file)) });
  const bytes = readFileSync(join(TEMPLATE_SETUP, 'assets', model.file));
  if (!published) await publishFileVia(be, projectId, cmd, { assetId: MEADOW_KIT, kind: 'model', displayName: model.displayName, bytes });
  for (const material of materials) await cmd('setMaterial', { material: { ...material, params: { ...((material as { params?: Record<string, unknown> }).params ?? {}), ...extra } } });
  await cmd('setAssetOptions', { assetId: MEADOW_KIT, materials: model.materials ?? {} });
  const pieces = glbPieces(bytes);
  return pieces.map((piece) => ({ ...meadowCoverRule(density / pieces.length, coverDistance), id: piece, asset: { assetId: MEADOW_KIT, piece } }));
}

/** Build the meadow into a new project; returns the terrain's id (its cover is baked by the caller). */
async function buildMeadow(be: PerfBackend, projectId: string, log: (s: string) => void, grass: MeadowGrass, density: number, coverDistance: number, wind: { strength: number | null; zone: boolean; clouds?: number | null; walker?: WalkerOptions; walk?: number | null; walkFrom?: [number, number] | null; starter?: boolean; mossAhead?: number | null; mossRight?: number | null; blocksLayer?: boolean; noPost?: boolean; rootColour?: number | null; rootColourHeight?: number | null } = { strength: null, zone: false }): Promise<{ terrainId: string; cmd: Cmd; cover: Record<string, unknown>[] }> {
  const t0 = performance.now();
  const starter = wind.starter === true;
  const created = await be.post('/api/v1/admin/projects', { projectId, name: 'Perf meadow', ...(starter ? { template: 'starter-3d' } : {}) });
  if (created.status !== 201 && created.status !== 200) throw new Error(`project create failed: ${created.status} ${JSON.stringify(created.json)}`);
  const p = be.project(projectId);
  const cmd: Cmd = (op, args) => p.command(op, args);
  if (starter) await starterOnMeadow(p, cmd, wind.mossAhead ?? 8, wind.mossRight ?? 10);
  else for (const id of STARTER_REMOVED) await cmd('deleteEntity', { entityId: id }).catch(() => undefined);
  await cmd('setSettings', { settings: { physics_dimension: 3, camera_far_m: MEADOW_SPEC.farPlane } });
  let cover = [meadowCoverRule(density, coverDistance)];
  const extra = { ...(wind.rootColour == null ? {} : { rootColour: wind.rootColour }), ...(wind.rootColourHeight == null ? {} : { rootColourHeight: wind.rootColourHeight }) };
  if (grass === 'template') cover = await publishTemplateGrass(be, projectId, cmd, density, coverDistance, extra, starter);
  else {
    await publishFileVia(be, projectId, cmd, { assetId: MEADOW_KIT, kind: 'model', displayName: 'Meadow grass (stand-in clump)', bytes: clumpKitGlb(MEADOW_SEED, MEADOW_SPEC.grass.clumpHeight) });
    // The foliage material with the engine's foliage policy (wind near the camera only), as the level classes' kits wear it.
    await cmd('setMaterial', { material: { materialId: GRASS_MATERIAL, name: 'Meadow grass', shader: 'foliage', params: { color: '#4d7a2e', roughness: 0.8, windDistance: FOLIAGE_NEAR_METRES, ...extra }, textures: {} } });
    await cmd('setAssetOptions', { assetId: MEADOW_KIT, materials: { grass: GRASS_MATERIAL } });
  }
  const material = await publishTerrainMaterial(be, projectId, cmd, MEADOW_SEED, { rules: false, projection: 0 });
  const T = MEADOW_SPEC.terrain;
  const tiles: { x: number; z: number }[] = [];
  for (let z = 0; z < T.tiles; z += 1) for (let x = 0; x < T.tiles; x += 1) tiles.push({ x, z });
  await cmd('pasteEntities', { sceneId: 'scene-main', entities: [{ id: 'terrain', name: 'Terrain', static: true, components: { transform: { position: meadowOrigin() }, terrain: { tileSamples: T.tileSamples, spacing: T.spacing, heightRange: [...T.heightRange], tiles, ...(wind.blocksLayer === true ? { layers: [{ id: 'blocks', kind: 'blocks' }] } : {}) }, materials: { '*': material } } }] });
  const listed = (await p.query('queryEntities', { limit: 100, offset: 0 }))['entities'] as { id: string; components: Record<string, unknown> }[];
  const terrainId = listed.find((e) => e.components['terrain'] !== undefined)?.id;
  if (terrainId === undefined) throw new Error('meadow: the terrain was not created');
  const stageId = await be.stage(projectId, meadowTerrainRaw());
  await cmd('editTerrain', { entityId: terrainId, kind: 'import', stageId, format: 'raw16', at: [0, 0] });
  await be.discardStage(projectId, stageId);
  for (const d of meadowPaint()) await cmd('editTerrain', { entityId: terrainId, kind: 'paint', dabs: [d.at], radius: d.radius, strength: d.strength, falloff: 'smooth', layer: d.layer });
  const camera = meadowCamera();
  if (!starter) await cmd('setTransform', { entityId: 'cam-main', transform: { position: camera.position, rotation: camera.rotation } });
  await cmd('setComponent', { entityId: starter ? 'light-000001' : 'light-0001', component: 'light', value: { type: 'directional', color: '#ffe2bd', intensity: 2, direction: [0.5, -0.55, -0.65], castShadow: true } });
  const sky = wind.clouds === undefined || wind.clouds === null ? {} : { sky: { mode: 'procedural', cloudCoverage: wind.clouds, cloudDensity: 0.6 } };
  // Without a post stack the scene draws with the renderer's MSAA (a new project's default), as the 3D starter does.
  const look: Record<string, unknown> = { ...LEVEL_LOOK };
  if (wind.noPost === true) delete look['post'];
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: wind.strength === null ? { ...look, ...sky } : { ...look, ...sky, wind: { direction: [0.6, 0.8], strength: wind.strength, gust: Math.min(10, wind.strength * 0.8), gustFrequency: 0.3, turbulence: 0.3 } } });
  if (wind.zone) {
    const ahead: [number, number] = [camera.position[0] + 40 * Math.SQRT1_2, camera.position[2] - 40 * Math.SQRT1_2];
    const calm = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Calm', transform: { position: [ahead[0], meadowHeight(ahead[0], ahead[1]), ahead[1]] } }))['createdId']);
    await cmd('setComponent', { entityId: calm, component: 'windZone', value: { shape: 'sphere', radius: 25, blend: 10, strength: 0, gust: 0.05 } });
  }
  if (wind.walker !== undefined) await addWalker(be, projectId, cmd, camera, wind.walker);
  if (wind.walk != null && wind.walk > 0) {
    const from = wind.walkFrom ?? [camera.position[0], camera.position[2]];
    const walk = walkBehavior({ ...camera, position: [from[0], meadowHeight(from[0], from[1]) + EYE_HEIGHT_M, from[1]] }, wind.walk);
    await publishBehaviorVia(be, be.project(projectId), cmd, walk);
    await cmd('setBehaviorProperties', { entityId: 'cam-main', behaviorId: walk.behaviorId, values: {} });
  }
  log(`meadow: ground built in ${Math.round(performance.now() - t0)} ms (${MEADOW_SIDE} m square, ${tiles.length} tiles, ${meadowPaint().length} painted patches)`);
  return { terrainId, cmd, cover };
}

/**
 * The 3D starter as a user builds the meadow on it: its small terrain gives way to the meadow's, its player starts
 * where the class's camera stands, facing the same way, its follow camera behind, and its block ground stands
 * beside the walk under a moss rule (cover on a block layer).
 */
async function starterOnMeadow(p: ReturnType<PerfBackend['project']>, cmd: Cmd, ahead: number, right: number): Promise<void> {
  const listed = (await p.query('queryEntities', { limit: 100, offset: 0 }))['entities'] as { id: string; name?: string; components: Record<string, unknown> }[];
  const cam = meadowCamera();
  for (const e of listed) {
    const pos = (e.components['transform'] as { position?: number[] } | undefined)?.position ?? [0, 0, 0];
    if (e.components['terrain'] !== undefined) await cmd('deleteEntity', { entityId: e.id });
    else if (e.components['blockLayer'] !== undefined) {
      // `ahead` metres along the walk (the view looks to +x, -z) and `right` to its right, on the highest ground under it.
      const x0 = Math.round(cam.position[0] + (ahead + right) * Math.SQRT1_2);
      const z0 = Math.round(cam.position[2] + (right - ahead) * Math.SQRT1_2);
      let top = -Infinity;
      for (let i = 0; i <= STARTER_BLOCKS_SIDE; i += 2) for (let k = 0; k <= STARTER_BLOCKS_SIDE; k += 2) top = Math.max(top, meadowHeight(x0 + i, z0 + k));
      await cmd('setTransform', { entityId: e.id, transform: { position: [x0, Math.ceil(top) - 1, z0] } });
      await cmd('setComponent', { entityId: e.id, component: 'blockLayer', value: { ...(e.components['blockLayer'] as object), scatter: [STARTER_MOSS] } });
    } else if (e.components['controller'] !== undefined || e.components['playerSpawn'] !== undefined) await cmd('setTransform', { entityId: e.id, transform: { position: [cam.position[0], meadowHeight(cam.position[0], cam.position[2]) + 1.2, cam.position[2]] } });
    else if (e.components['virtualCamera'] !== undefined) await cmd('setComponent', { entityId: e.id, component: 'virtualCamera', value: { ...(e.components['virtualCamera'] as object), distance: 8, pitch: 18, yaw: Math.round((cam.yaw * 180) / Math.PI) } });
  }
}

/** On the starter: the block ground's side (cells) and the moss its floor wears (cover on a block layer). */
const STARTER_BLOCKS_SIDE = 24;
const STARTER_MOSS = { id: 'moss', asset: { assetId: MEADOW_KIT, piece: 'grass_c' }, density: 10, scale: [0.25, 0.4], align: 1, cover: true, coverDistance: 30 };

/** On the starter, while the frames are recorded: the player walks (W held) 8 s, stands 3 s and walks on 8 s more. */
const STARTER_WALKS = [{ wait: 1000 }, { down: 'w' }, { wait: 8000 }, { up: 'w' }, { wait: 3000 }, { down: 'w' }, { wait: 8000 }, { up: 'w' }] as const;

/** How far (m) the walking camera goes into the field before it turns back. */
const WALK_METRES = 60;

/** The walking camera's script: at eye height over the ground, along the view into the field and back, looking the way the meadow camera does. */
function walkBehavior(camera: ReturnType<typeof meadowCamera>, speed: number): BehaviorPlan {
  const [x0, , z0] = camera.position;
  const [qx, qy, qz, qw] = camera.rotation;
  return {
    behaviorId: 'meadow-walk',
    displayName: 'Meadow walk',
    ownedTransforms: ['@self'],
    declaration: { properties: [] },
    source: [
      'export default {',
      '  instantiate() { return {}; },',
      '  step(state: any, ctx: any) {',
      "    if (ctx.phase !== 'transform') return;",
      `    const lap = ${(2 * WALK_METRES) / speed} * ${DEFAULT_FIXED_STEP_HZ};`,
      '    const u = (ctx.stepIndex % lap) / lap;',
      `    const d = (u < 0.5 ? u * 2 : 2 - u * 2) * ${WALK_METRES};`,
      `    const x = ${x0} + d * Math.SQRT1_2, z = ${z0} - d * Math.SQRT1_2;`,
      '    const hit = ctx.physics.raycast3d([x, 1000, z], [0, -1, 0], 2000);',
      `    const y = hit === null ? ${camera.position[1]} : hit.point[1] + ${EYE_HEIGHT_M};`,
      `    ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { x, y, z }, quaternion: [${qx}, ${qy}, ${qz}, ${qw}] });`,
      '  },',
      '};',
    ].join('\n'),
  };
}

/**
 * A subject walking through the grass: a box going to and fro across the view 7 m ahead (a mover, its points on the
 * ground), named the view's subject by a script with see-through left off, so the grass gives way round it.
 */
interface WalkerOptions {
  strength: number | null;
  radius: number | null;
  speed: number;
}

async function addWalker(be: PerfBackend, projectId: string, cmd: Cmd, camera: ReturnType<typeof meadowCamera>, w: WalkerOptions): Promise<void> {
  const [cx, , cz] = camera.position;
  const ahead = (d: number, side: number): [number, number] => [cx + d * Math.SQRT1_2 + side * Math.SQRT1_2, cz - d * Math.SQRT1_2 + side * Math.SQRT1_2];
  const start = ahead(7, w.speed > 0 ? -3 : 0);
  const y0 = meadowHeight(start[0], start[1]) + 0.9;
  const points: [number, number, number][] = [];
  for (let k = 1; k <= 6; k += 1) {
    const [x, z] = ahead(7, -3 + k);
    points.push([x - start[0], meadowHeight(x, z) + 0.9 - y0, z - start[1]]);
  }
  const id = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Walker', transform: { position: [start[0], y0, start[1]] } }))['createdId']);
  await cmd('setComponent', { entityId: id, component: 'box', value: { size: [0.5, 1.8, 0.5], material: { color: '#c8c2b8' } } });
  if (w.speed > 0) await cmd('setComponent', { entityId: id, component: 'mover', value: { waypoints: points, speed: w.speed, mode: 'pingpong' } });
  const bend = { ...(w.strength !== null ? { strength: w.strength } : {}), ...(w.radius !== null ? { radius: w.radius } : {}) };
  if (Object.keys(bend).length > 0) await cmd('setComponent', { entityId: id, component: 'foliageBend', value: bend });
  const p = be.project(projectId);
  const b = seeThroughBehavior([id]);
  await publishBehaviorVia(be, p, cmd, b);
  const driver = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Subjects', transform: { position: [0, 0, 0] } }))['createdId']);
  await cmd('setBehaviorProperties', { entityId: driver, behaviorId: b.behaviorId, values: {} });
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
      const { terrainId, cmd, cover } = await buildMeadow(be, 'meadow', log, grass, density, coverDistance, { strength: get('wind') === undefined ? null : Number(get('wind')), zone: has('wind-zone'), clouds: get('clouds') === undefined ? null : Number(get('clouds')), walk: get('walk') === undefined ? null : Number(get('walk')), walkFrom: get('walk-from') === undefined ? null : (get('walk-from')!.split(',').map(Number) as [number, number]), starter: has('starter'), mossAhead: get('moss-ahead') === undefined ? null : Number(get('moss-ahead')), mossRight: get('moss-right') === undefined ? null : Number(get('moss-right')), blocksLayer: has('blocks-layer'), noPost: has('no-post'), rootColour: get('root-colour') === undefined ? null : Number(get('root-colour')), rootColourHeight: get('root-colour-height') === undefined ? null : Number(get('root-colour-height')), ...(has('walker') ? { walker: { strength: get('walker-strength') === undefined ? null : Number(get('walker-strength')), radius: get('walker-radius') === undefined ? null : Number(get('walker-radius')), speed: get('walker-speed') === undefined ? 1.2 : Number(get('walker-speed')) } } : {}) });
      // A spacing between copies (the rule card's default) keeps a rule on the CPU path.
      if (get('spacing') !== undefined) for (const r of cover) r['spacing'] = Number(get('spacing'));
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
          const res = await measurePage(browser, { url: `${site.url}?renderer=${r}${get('query') !== undefined ? `&${get('query')}` : ''}`, warmupMs, recordMs, gpuMs, profileMs, frameCalls: has('walk') || has('starter'), ...(get('walk') !== undefined || has('starter') ? { settleMs: 5000 } : {}), ...(has('starter') ? { steps: [{ click: [960, 540] as [number, number] }], during: STARTER_WALKS } : {}), sourceOf: sourcesOf(site), shot: join(runDir, `meadow-${variant}-${r}.png`) });
          (report.exports[variant] ??= {})[r] = res;
          log(`${frameLine(`meadow ${variant} ${r}`, res)}, ${res.frames.missed ?? 0} missed a 60 Hz refresh`);
          log(`  heavy calls in ${res.heavyCalls?.frames ?? 0} frames: ${Object.entries(res.heavyCalls?.calls ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}`);
          for (const e of res.heavyCalls?.builds ?? []) log(`  build at ${e.at} ms (${e.dt} ms): ${Object.entries(e.calls).filter(([k]) => !k.startsWith('buffer')).map(([k, v]) => `${k} ${v}`).join(', ')}`);
          for (const e of res.missedCalls ?? []) log(`  frame at ${e.at} ms took ${e.dt} ms: ${Object.entries(e.calls).map(([k, v]) => `${k} ${v}`).join(', ') || 'no heavy calls'}`);
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
