/**
 * The village perf class: a neutral scene shaped like a kit-built 3D game's
 * town — the shape the engine is measured on before and after the render
 * path work. Deterministic from a seed (generated files, no game content).
 *
 * - ~1,000 entities: ~650 placed props (static: a town's props never move;
 *   model files with a root, parts and `_LOD0..2` levels; part of them recoloured by a project material, many
 *   with a box collider), ~50 instance sets of a scatter kit, 20 skinned
 *   figures playing an idle clip through an animator, 16 fire emitters whose
 *   effect lights (the effect light pool), a block-layer ground of 16 chunks,
 *   folders, triggers, separate colliders, a few scripts (some move their
 *   object) and empty markers — the logic-only entities a game also has.
 * - A shadowed sun, ambient light, exp2 fog and the full post stack
 *   (SSAO, bloom, SMAA, neutral tone mapping, grading).
 * - A fixed camera over the village; 3D physics.
 *
 * `buildVillage` applies the plan through the real command API, like the
 * editor or MCP would (the same helpers as the benchmark classes).
 */
import { BENCH_BEHAVIORS, prng, type BehaviorPlan, type EntityValue } from './generate';
import { publishBehaviorVia, publishBufferVia, publishFileVia, splitBySize } from './build';
import type { PerfBackend } from './backend';
import { FIGURE_CLIP_SECONDS, figureGlb, propGlb, scatterKitGlb, type PropSpec } from './village-assets';

/** Bump when the generated content changes (it keys the baseline). */
export const VILLAGE_VERSION = 2;
export const VILLAGE_SEED = 28;

/** The class's sizes (the plan below fills them exactly). */
export const VILLAGE_SPEC = {
  entities: 1000,
  propFiles: 60,
  props: 650,
  /** Props recoloured by a project material (`materials: {'*': …}`). */
  recoloured: 260,
  /** Props with a box collider of their own. */
  propColliders: 262,
  /** Colliders on entities of their own (a game's hand-placed blockers). */
  looseColliders: 110,
  instanceSets: 50,
  copiesPerSet: 60,
  figures: 20,
  /** Figures that move (a script owns their transform). */
  movingFigures: 12,
  fires: 16,
  folders: 20,
  triggers: 20,
  directors: 4,
  materials: 24,
  /** Texture edge for the textured prop files (every third file). */
  textureSize: 256,
  /** The block ground: cells (x, z) and its base height in rows. */
  ground: 64,
} as const;

const FIGURE_ASSET = 'village-figure';
const KIT_ASSET = 'village-scatter';
const KIT_PIECES = ['tuft', 'stone', 'shrub', 'flower'] as const;
const CONTROLLER = 'village-figure-idle';
const FIRE_EFFECT = 'village-fire';
/** The starter's objects the village does without (player, spawn, boxes, pillar). */
const STARTER_REMOVED = ['model-0001', 'spawn-0001', 'box-0001', 'box-0002', 'box-0003', 'box-0004', 'model-0002'];
/** The starter's built-ins the village keeps: camera, sun, ambient. */
const KEPT_BUILT_INS = 3;
/** Most entities one pasteEntities creates (commands' PASTE_ENTITIES_MAX). */
const PASTE_MAX = 256;
/** Ground height (m): base rows × the cell height. */
const GROUND_ROWS = 4;
const CELL_HEIGHT = 0.5;
const GROUND_Y = GROUND_ROWS * CELL_HEIGHT;

export interface VillagePlan {
  version: number;
  seed: number;
  props: { assetId: string; spec: PropSpec; seed: number }[];
  materials: Record<string, unknown>[];
  behaviors: BehaviorPlan[];
  buffers: { key: string; floats: Float32Array }[];
  /** Pasted in order; a batch holds whole folders. */
  batches: EntityValue[][];
  /** Ground fills (editBlocks edits). */
  groundEdits: Record<string, unknown>[];
  camera: { position: [number, number, number]; rotation: [number, number, number, number] };
  counts: Record<string, number>;
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
/** Quaternion parts to 1e-6, so the rotation stays a unit quaternion within the model's 1e-4. */
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const yawQ = (deg: number): [number, number, number, number] => {
  const h = (deg * Math.PI) / 360;
  return [0, r6(Math.sin(h)), 0, r6(Math.cos(h))];
};
const T = (x: number, y: number, z: number, yawDeg = 0, s = 1): Record<string, unknown> => ({ position: [r3(x), r3(y), r3(z)], rotation: yawQ(yawDeg), scale: [r3(s), r3(s), r3(s)] });
const hex = (n: number): string => `#${Math.floor(n).toString(16).padStart(6, '0').slice(-6)}`;

/** A burning fire: additive sparks, the oldest one a point light (the effect light pool). */
function fireEffect(): Record<string, unknown> {
  const chains: Record<string, { type: string; data?: Record<string, unknown> }[]> = {
    spawn: [{ type: 'spawn.rate', data: { rate: 24 } }],
    initialize: [
      { type: 'init.position.sphere', data: { radius: 0.4 } },
      { type: 'init.velocity', data: { min: [-0.2, 1, -0.2], max: [0.2, 2, 0.2] } },
      { type: 'init.lifetime', data: { min: 0.8, max: 1.2 } },
      { type: 'init.color', data: { color: '#ff9030' } },
      { type: 'init.size', data: { min: 0.15, max: 0.3 } },
    ],
    update: [{ type: 'update.drag' }],
    output: [{ type: 'output.billboard', data: { blend: 'additive' } }, { type: 'output.light', data: { maxLights: 1, intensity: 6, range: 6 } }],
  };
  const nodes: Record<string, unknown>[] = ['spawn', 'initialize', 'update', 'output'].map((c, i) => ({ id: c, type: c, position: [0, i * 200] }));
  const edges: Record<string, unknown>[] = [];
  let k = 0;
  for (const [ctx, blocks] of Object.entries(chains)) {
    let prev = ctx;
    for (const b of blocks) {
      const id = `b${k++}`;
      nodes.push({ id, type: b.type, position: [250 * k, 0], ...(b.data !== undefined ? { data: b.data } : {}) });
      edges.push({ id: `e${edges.length}`, from: { node: prev, port: 'then' }, to: { node: id, port: 'in' } });
      prev = id;
    }
  }
  return { effectId: FIRE_EFFECT, name: 'Fire', duration: 1, loop: true, seed: 3, bounds: { center: [0, 1, 0], size: [3, 4, 3] }, systems: [{ systemId: 'sparks', name: 'Sparks', maxParticles: 48, space: 'world', graph: { nodes, edges } }] };
}

export function villagePlan(seed = VILLAGE_SEED): VillagePlan {
  const S = VILLAGE_SPEC;
  const rnd = prng(seed * 7919 + S.entities);
  const props = Array.from({ length: S.propFiles }, (_, i) => {
    const u = rnd();
    return { assetId: `village-prop-${String(i + 1).padStart(2, '0')}`, seed: Math.floor(rnd() * 2 ** 31), spec: { parts: u < 0.45 ? 1 : u < 0.85 ? 2 : 3, rings: 6 + Math.floor(rnd() * 4), sides: 10 + Math.floor(rnd() * 6), textureSize: i % 3 === 0 ? S.textureSize : 0 } };
  });
  const materials = Array.from({ length: S.materials }, (_, i) => ({
    materialId: `village-mat-${String(i + 1).padStart(2, '0')}`,
    name: `Village material ${i + 1}`,
    shader: 'standard',
    params: { color: hex(0x404040 + rnd() * 0xbfbfbf), roughness: r3(0.4 + rnd() * 0.6), metalness: 0 },
    textures: {},
  }));
  const bob = BENCH_BEHAVIORS.find((b) => b.behaviorId === 'bench-bob')!;
  const count = BENCH_BEHAVIORS.find((b) => b.behaviorId === 'bench-count')!;
  const behaviors = [bob, count].map((b) => ({ ...b, ownedTransforms: [...b.ownedTransforms], declaration: { properties: b.declaration.properties.map((p) => ({ ...p })) } }));

  // Positions: props in a disc (a dense centre, thinning out), on the flat ground.
  const disc = (rMin: number, rMax: number): [number, number] => {
    const a = rnd() * Math.PI * 2;
    const r = rMin + Math.sqrt(rnd()) * (rMax - rMin);
    return [Math.cos(a) * r, Math.sin(a) * r];
  };
  const folders: { folder: EntityValue; children: EntityValue[] }[] = Array.from({ length: S.folders }, (_, i) => ({ folder: { id: `folder-${i}`, name: `Quarter ${i + 1}`, components: { folder: {} } }, children: [] }));
  let next = 0;
  const into = (e: Omit<EntityValue, 'parentId'>): void => {
    const f = folders[next++ % folders.length]!;
    f.children.push({ ...e, parentId: f.folder.id });
  };
  const counts: Record<string, number> = { builtIns: KEPT_BUILT_INS, folders: S.folders, layer: 1, props: 0, recoloured: 0, propColliders: 0, looseColliders: 0, instanceSets: 0, copies: 0, figures: 0, fires: 0, triggers: 0, directors: 0, markers: 0 };
  for (let i = 0; i < S.props; i += 1) {
    const file = props[Math.floor(rnd() * props.length)]!;
    const [x, z] = disc(2, 30);
    const s = 0.7 + rnd() * 0.6;
    const components: Record<string, unknown> = { transform: T(x, GROUND_Y, z, rnd() * 360, s), model: { asset: { assetId: file.assetId } } };
    if (counts.recoloured! < S.recoloured && i % 5 < 2) {
      components['materials'] = { '*': materials[i % materials.length]!.materialId };
      counts.recoloured! += 1;
    }
    if (counts.propColliders! < S.propColliders && i % 5 >= 2) {
      components['collider'] = { shape: { type: 'box', hx: r3(0.5 * s), hy: r3(1 * s), hz: r3(0.5 * s) } };
      counts.propColliders! += 1;
    }
    into({ id: `prop-${i}`, name: `Prop ${i + 1}`, static: true, components });
    counts.props! += 1;
  }
  const buffers: VillagePlan['buffers'] = [];
  for (let i = 0; i < S.instanceSets; i += 1) {
    const [x, z] = disc(4, 34);
    const floats = new Float32Array(S.copiesPerSet * 10);
    for (let c = 0; c < S.copiesPerSet; c += 1) {
      const yaw = rnd() * Math.PI * 2;
      const sc = 0.6 + rnd() * 0.8;
      floats.set([r3((rnd() - 0.5) * 8), 0, r3((rnd() - 0.5) * 8), 0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2), sc, sc, sc], c * 10);
    }
    const key = `set-${i}`;
    buffers.push({ key, floats });
    // Ground cover: recoloured per set, casting no shadow, as a game's scatter is.
    into({ id: `inst-${i}`, name: `Scatter ${i + 1}`, components: { transform: T(x, GROUND_Y, z), instances: { asset: { assetId: KIT_ASSET, piece: KIT_PIECES[i % KIT_PIECES.length] }, buffer: `$buffer:${key}`, count: S.copiesPerSet, castShadow: false }, materials: { '*': materials[(i * 7) % materials.length]!.materialId } } });
    counts.instanceSets! += 1;
    counts.copies! += S.copiesPerSet;
  }
  for (let i = 0; i < S.figures; i += 1) {
    const [x, z] = disc(1, 10);
    const moving = i < S.movingFigures;
    into({ id: `figure-${i}`, name: `Figure ${i + 1}`, components: { transform: T(x, GROUND_Y, z, rnd() * 360), model: { asset: { assetId: FIGURE_ASSET } }, animator: { controller: CONTROLLER }, ...(moving ? { behavior: { behaviorId: bob.behaviorId, values: { height: 0.3 } } } : {}) } });
    counts.figures! += 1;
  }
  for (let i = 0; i < S.fires; i += 1) {
    const [x, z] = disc(3, 24);
    into({ id: `fire-${i}`, name: `Fire ${i + 1}`, components: { transform: T(x, GROUND_Y + 0.2, z), effect: { effectId: FIRE_EFFECT } } });
    counts.fires! += 1;
  }
  for (let i = 0; i < S.triggers; i += 1) {
    const [x, z] = disc(2, 26);
    into({ id: `trigger-${i}`, name: `Trigger ${i + 1}`, components: { transform: T(x, GROUND_Y + 0.5, z), trigger: { signal: `near_${i}`, exitSignal: `far_${i}`, shape: 'sphere', radius: 1.6 } } });
    counts.triggers! += 1;
  }
  for (let i = 0; i < S.looseColliders; i += 1) {
    const [x, z] = disc(6, 32);
    into({ id: `blocker-${i}`, name: `Blocker ${i + 1}`, components: { transform: T(x, GROUND_Y, z, rnd() * 360), collider: { shape: { type: 'box', hx: r3(0.3 + rnd()), hy: 1, hz: r3(0.3 + rnd()) } } } });
    counts.looseColliders! += 1;
  }
  for (let i = 0; i < S.directors; i += 1) {
    into({ id: `director-${i}`, name: `Director ${i + 1}`, components: { transform: T(0, 0, 0), behavior: { behaviorId: count.behaviorId, values: { every: 0.5 } } } });
    counts.directors! += 1;
  }
  const layer: EntityValue = { id: 'ground', name: 'Ground', components: { transform: T(-S.ground / 2, 0, -S.ground / 2), blockLayer: { cellSize: [1, CELL_HEIGHT, 1], bounds: { min: [0, 0, 0], max: [S.ground, 16, S.ground] }, maxSlope: 35, smoothAngle: 40, topSubdivision: 2 } } };
  // Empty markers (spawn points, path nodes, effect origins) fill up to the exact count.
  const made = (): number => KEPT_BUILT_INS + 1 + folders.reduce((a, f) => a + 1 + f.children.length, 0);
  for (let i = 0; made() < S.entities; i += 1) {
    const [x, z] = disc(0, 30);
    into({ id: `marker-${i}`, name: `Marker ${i + 1}`, components: { transform: T(x, GROUND_Y, z) } });
    counts.markers! += 1;
  }
  const batches: EntityValue[][] = [[layer]];
  let batch: EntityValue[] = [];
  for (const f of folders) {
    const unit = [f.folder, ...f.children];
    if (batch.length + unit.length > PASTE_MAX) {
      batches.push(batch);
      batch = [];
    }
    batch.push(...unit);
  }
  if (batch.length > 0) batches.push(batch);
  counts.total = made();
  if (counts.total !== S.entities) throw new Error(`village: ${counts.total} entities, expected ${S.entities}`);

  // Ground: a base of GROUND_ROWS everywhere; outside the village, hills of 4 × 4 columns.
  const groundEdits: Record<string, unknown>[] = [{ kind: 'fill', box: [0, 0, 0, S.ground, GROUND_ROWS, S.ground], cell: { block: 'soil' } }];
  for (let x = 0; x < S.ground; x += 4) {
    for (let z = 0; z < S.ground; z += 4) {
      const d = Math.hypot(x + 2 - S.ground / 2, z + 2 - S.ground / 2);
      if (d < 22) continue;
      const rows = 1 + Math.floor(rnd() * Math.min(8, (d - 20) / 2));
      groundEdits.push({ kind: 'fill', box: [x, GROUND_ROWS, z, x + 4, GROUND_ROWS + rows, z + 4], cell: { block: rnd() < 0.5 ? 'soil' : 'rock' } });
    }
  }
  // The camera over the village, looking down towards its centre.
  // The camera inside the village at roof height, looking across it: about half of it is in view.
  const pitch = -Math.atan2(4, 30);
  const camera: VillagePlan['camera'] = { position: [0, GROUND_Y + 5, -4], rotation: [r6(Math.sin(pitch / 2)), 0, 0, r6(Math.cos(pitch / 2))] };
  return { version: VILLAGE_VERSION, seed, props, materials, behaviors, buffers, batches, groundEdits, camera, counts };
}

export interface VillageBuild {
  projectId: string;
  ms: number;
  commands: number;
  counts: Record<string, number>;
}

/** Build the village into a new project `projectId` through the backend's command API. */
export async function buildVillage(be: PerfBackend, projectId: string, plan = villagePlan(), log: (s: string) => void = () => undefined): Promise<VillageBuild> {
  const t0 = performance.now();
  const created = await be.post('/api/v1/admin/projects', { projectId, name: 'Perf village' });
  if (created.status !== 201 && created.status !== 200) throw new Error(`project create failed: ${created.status} ${JSON.stringify(created.json)}`);
  const p = be.project(projectId);
  let commands = 0;
  const cmd = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    commands += 1;
    return p.command(op, args);
  };
  for (const id of STARTER_REMOVED) await cmd('deleteEntity', { entityId: id }).catch(() => undefined);
  await cmd('setSettings', { settings: { physics_dimension: 3 } });

  for (const f of plan.props) await publishFileVia(be, projectId, cmd, { assetId: f.assetId, kind: 'model', displayName: f.assetId, bytes: propGlb(f.seed, f.spec) });
  await publishFileVia(be, projectId, cmd, { assetId: KIT_ASSET, kind: 'model', displayName: 'Village scatter', bytes: scatterKitGlb(plan.seed, KIT_PIECES) });
  await publishFileVia(be, projectId, cmd, { assetId: FIGURE_ASSET, kind: 'model', displayName: 'Village figure', bytes: figureGlb(plan.seed) });
  log(`village: ${plan.props.length + 2} model files`);
  for (const material of plan.materials) await cmd('setMaterial', { material });
  for (const b of plan.behaviors) {
    await publishBehaviorVia(be, p, cmd, b);
    commands += 1;
  }
  await cmd('setEffect', { effect: fireEffect() });
  await cmd('setAnimator', {
    controller: { controllerId: CONTROLLER, name: 'Figure idle', parameters: [], states: [{ id: 'idle', name: 'Idle', motion: { kind: 'clip', clip: { assetId: FIGURE_ASSET, clip: 'idle', duration: FIGURE_CLIP_SECONDS } }, speed: 1, loop: true }], transitions: [], entry: 'idle', events: [] },
  });
  await cmd('setBlockType', { block: { blockId: 'soil', name: 'Soil', variants: [{ color: '#6f8a4a' }, { color: '#7a9050' }], shape: 'full' } });
  await cmd('setBlockType', { block: { blockId: 'rock', name: 'Rock', variants: [{ color: '#8a8580' }], shape: 'full' } });

  const digests = new Map<string, string>();
  for (const b of plan.buffers) digests.set(b.key, await publishBufferVia(be, projectId, b.floats));
  const resolve = (e: EntityValue): EntityValue => {
    const inst = e.components['instances'] as { buffer?: string } | undefined;
    if (inst?.buffer?.startsWith('$buffer:') !== true) return e;
    return { ...e, components: { ...e.components, instances: { ...inst, buffer: digests.get(inst.buffer.slice('$buffer:'.length)) } } };
  };
  let layerId: string | null = null;
  for (const batch of plan.batches) {
    for (const part of splitBySize(batch.map(resolve))) {
      const res = await cmd('pasteEntities', { sceneId: 'scene-main', entities: part });
      if (part.some((e) => e.id === 'ground')) layerId = ((res['createdIds'] ?? res['ids'] ?? []) as string[])[0] ?? null;
    }
  }
  if (layerId === null) {
    const listed = (await p.query('queryEntities', { limit: 2000, offset: 0 }))['entities'] as { id: string; components: Record<string, unknown> }[];
    layerId = listed.find((e) => e.components['blockLayer'] !== undefined)?.id ?? null;
  }
  if (layerId === null) throw new Error('village: the ground layer was not created');
  // editBlocks: the fills in a few commands.
  for (let i = 0; i < plan.groundEdits.length; i += 64) await cmd('editBlocks', { entityId: layerId, edits: plan.groundEdits.slice(i, i + 64) });
  log(`village: ${plan.counts.total} entities, ground ${plan.groundEdits.length} fills`);

  await cmd('setTransform', { entityId: 'cam-main', transform: { position: plan.camera.position, rotation: plan.camera.rotation } });
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffd9a8', intensity: 2, direction: [0.55, -0.45, -0.7], castShadow: true } });
  await cmd('setEnvironment', {
    sceneId: 'scene-main',
    environment: {
      sky: { mode: 'color', color: '#b8c8e0' },
      fog: { color: '#ead9bd', density: 0.0014, mode: 'exp2' },
      post: { antialias: 'smaa', bloom: { enabled: true, radius: 0.4, strength: 0.25, threshold: 1.05 }, exposure: 1, grading: { contrast: 0.09, saturation: 0.05, tint: '#fff6ea' }, ssao: { enabled: true, intensity: 1, radius: 0.5 }, toneMapping: 'neutral' },
    },
  });
  return { projectId, ms: Math.round(performance.now() - t0), commands, counts: plan.counts };
}
