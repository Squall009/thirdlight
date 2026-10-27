/**
 * The look-reference scenes (`node tools/perf/run.mjs look …`, look-run.ts):
 * four small scenes that each stress one thing a lighting model must get
 * right, built through the backend's commands so every run draws the same
 * content. They are the reference the lighting work is judged against, on
 * both renderers, by eye and by frame time.
 *
 * - `door`: a closed block room whose only opening is a door; the sun falls
 *   through it onto the floor, and everything else in the room is lit only by
 *   what bounces off that patch (and whatever leaks).
 * - `sunset`: a generated two-storey building on block ground under a low,
 *   warm sun and a physical sky: long shadows, a lit and an unlit face.
 * - `corridor`: a closed block corridor lit by rectangle area lights under
 *   emissive ceiling panels and a line light along an emissive strip on a
 *   wall.
 * - `sign`: an emissive sign standing on hilly terrain at night, under a faint
 *   moon: the sign is the only real light source the eye expects.
 *
 * Every surface is static. The lights are built `realtime`, or `baked` for a
 * run that bakes ("Bake lighting" keeps a baked light's direct light and
 * bounce), so one scene shows both ways of lighting it. Pure: the scenes are
 * fixed.
 */
import type { PerfBackend } from './backend';
import type { EntityValue } from './generate';
import { STARTER_REMOVED } from './level';

export const LOOK_SCENES = ['door', 'sunset', 'corridor', 'sign'] as const;
/**
 * The leak check (not run by default): generated rooms on a block floor, a
 * lamp in room C behind a door piece; `shut-off` and `shut-on` with the
 * door shut and the lamp off and on (nothing outside C may change),
 * `open-on` with no door piece (the lamp's light reaches the room in front).
 */
export const LEAK_SCENES = ['shut-off', 'shut-on', 'open-on'] as const;
export type LookScene = (typeof LOOK_SCENES)[number] | (typeof LEAK_SCENES)[number];

type Vec3 = [number, number, number];
type Cmd = (op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
/** How the scene's lights are set: drawn per frame, or baked into lightmaps and probes. */
export type LookLightMode = 'realtime' | 'baked';

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** A camera rotation (x, y, z, w) looking from `eye` at `at`: a yaw about y, then a pitch about the camera's own x (it looks along −z). */
export function lookRotation(eye: Vec3, at: Vec3): [number, number, number, number] {
  const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
  const len = Math.hypot(d[0]!, d[1]!, d[2]!);
  const yaw = Math.atan2(-d[0]!, -d[2]!);
  const pitch = Math.asin(d[1]! / len);
  const [sy, cy, sp, cp] = [Math.sin(yaw / 2), Math.cos(yaw / 2), Math.sin(pitch / 2), Math.cos(pitch / 2)];
  return [r6(cy * sp), r6(sy * cp), r6(-sy * sp), r6(cy * cp)];
}

/** One look scene's camera and what it is meant to show. */
export interface LookPlan {
  scene: LookScene;
  eye: Vec3;
  at: Vec3;
  /** What to look at in the screenshot, for the log and the plan. */
  shows: string;
}

export const LOOK_PLANS: Readonly<Record<LookScene, LookPlan>> = {
  door: { scene: 'door', eye: [10, 2.6, 9.6], at: [13, 1, 15], shows: 'the sun through the door onto the floor; the walls, ceiling and corners lit only by bounce' },
  sunset: { scene: 'sunset', eye: [32, 2.6, 31], at: [17, 3, 17], shows: 'the sunlit east face, the shaded north face, the house\'s long shadow on the ground, the warm sky' },
  corridor: { scene: 'corridor', eye: [11.5, 2.7, 3], at: [11.5, 2.5, 20], shows: 'three ceiling panels (rectangle lights) and a wall strip (a line light) lighting the floor and walls' },
  sign: { scene: 'sign', eye: [64, 1.7, 55], at: [64, 1.6, 64], shows: 'the glowing sign and the ground and post it should light at night' },
  'shut-off': { scene: 'shut-off', eye: [1.5, 1.6, 12], at: [1.5, 0.8, 4], shows: 'room R through its arch, the shut door to C at its back; the lamp in C off' },
  'shut-on': { scene: 'shut-on', eye: [1.5, 1.6, 12], at: [1.5, 0.8, 4], shows: 'the same, the lamp in C on: nothing outside C changes' },
  'open-on': { scene: 'open-on', eye: [1.5, 1.6, 12], at: [1.5, 0.8, 4], shows: 'the door piece gone, the lamp on: its light reaches R through the doorway' },
};

/** Post-processing of every look scene: the level classes' stack (SMAA, bloom, AO), neutral tone mapping. */
const POST = { antialias: 'smaa', bloom: { enabled: true, radius: 0.4, strength: 0.35, threshold: 1 }, exposure: 1, ssao: { enabled: true, intensity: 1, radius: 0.5 }, toneMapping: 'neutral' };

const fill = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, block: string | null): Record<string, unknown> => ({ kind: 'fill', box: [x0, y0, z0, x1, y1, z1], cell: block === null ? null : { block } });

/** A static block layer at the origin (1 m cells), its block types and fills. */
async function blockLayer(be: PerfBackend, projectId: string, cmd: Cmd, size: Vec3, edits: Record<string, unknown>[]): Promise<string> {
  await cmd('setBlockType', { block: { blockId: 'soil', name: 'Soil', variants: [{ color: '#6f7a58' }], shape: 'full' } });
  await cmd('setBlockType', { block: { blockId: 'rock', name: 'Rock', variants: [{ color: '#b8b2a8' }, { color: '#aea89e' }], shape: 'full' } });
  const layer: EntityValue = { id: 'ground', name: 'Ground', static: true, components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, blockLayer: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [...size] } } } };
  await cmd('pasteEntities', { sceneId: 'scene-main', entities: [layer] });
  const listed = (await be.project(projectId).query('queryEntities', { limit: 100, offset: 0 }))['entities'] as { id: string; components: Record<string, unknown> }[];
  const layerId = listed.find((e) => e.components['blockLayer'] !== undefined)?.id;
  if (layerId === undefined) throw new Error('look: the block layer was not created');
  for (let i = 0; i < edits.length; i += 64) await cmd('editBlocks', { entityId: layerId, edits: edits.slice(i, i + 64) });
  return layerId;
}

/** A static box wearing a surface (an emissive one glows). */
async function box(cmd: Cmd, name: string, at: Vec3, size: Vec3, surface: Record<string, unknown>): Promise<void> {
  const id = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name, static: true, transform: { position: at }, box: { size } }))['createdId']);
  await cmd('setComponent', { entityId: id, component: 'surface', value: { roughness: 0.8, metalness: 0, ...surface } });
}

async function light(cmd: Cmd, name: string, at: Vec3, value: Record<string, unknown>, rotation?: readonly number[]): Promise<void> {
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name, transform: { position: at, ...(rotation !== undefined ? { rotation } : {}) }, components: { light: value } });
}

/** The room: rock walls round 8..16 × 8..16 on a soil slab, a ceiling 3 m over the floor, a 2 × 2 m door in the +z wall. */
async function doorScene(be: PerfBackend, projectId: string, cmd: Cmd, mode: LookLightMode): Promise<void> {
  await blockLayer(be, projectId, cmd, [24, 8, 24], [
    fill(0, 0, 0, 24, 1, 24, 'soil'),
    fill(8, 1, 8, 17, 5, 17, 'rock'),
    fill(9, 1, 9, 16, 4, 16, null),
    fill(12, 1, 16, 14, 3, 17, null),
  ]);
  // A sun from +z, low enough to reach well into the room through the door.
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#fff0dc', intensity: 3, direction: [0.15, -0.55, -0.82], castShadow: true, mode } });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'procedural', sunFromLight: true, cloudCoverage: 0.2 }, post: POST } });
}

/** A generated two-storey building (door, windows, gable roof) on a soil slab under a sunset. */
async function sunsetScene(be: PerfBackend, projectId: string, cmd: Cmd, mode: LookLightMode): Promise<void> {
  await blockLayer(be, projectId, cmd, [40, 4, 40], [fill(0, 0, 0, 40, 1, 40, 'soil')]);
  const [x0, z0, x1, z1] = [14, 14, 22, 20];
  const [w, d] = [x1 - x0, z1 - z0];
  const middles = [w / 2, w + d / 2, w + d + w / 2, 2 * w + d + d / 2];
  const openings: Record<string, unknown>[] = [{ id: 'door', at: middles[0], width: 1.2, bottom: 0, top: 2.2 }];
  for (let s = 0; s < 2; s += 1) for (let k = s === 0 ? 1 : 0; k < 4; k += 1) openings.push({ id: `window-${s}-${k}`, at: middles[k], width: 1, bottom: 0.9, top: 2, storey: s, pane: true });
  const building = { id: 'house', preset: 'starter-room', outside: 'starter-room', storeys: 2, roof: { shape: 'gable' }, openings, path: { points: [[x0, 1, z0], [x1, 1, z0], [x1, 1, z1], [x0, 1, z1]], closed: true } };
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'House', static: true, transform: { position: [0, 0, 0] }, components: { architecture: { elements: [], buildings: [building] } } });
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffb36b', intensity: 1.8, direction: [-0.55, -0.17, 0.82], castShadow: true, shadowExtent: 32, mode } });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'procedural', sunFromLight: true, turbidity: 9, rayleigh: 2.5, cloudCoverage: 0.35 }, post: { ...POST, grading: { tint: '#fff2e4' } } } });
}

/** A closed block corridor 3 m wide, 3 m high, 28 m long, its floor polished; rectangle and line area lights. */
async function corridorScene(be: PerfBackend, projectId: string, cmd: Cmd, mode: LookLightMode): Promise<void> {
  // A polished floor (a standard material): the lamps' highlights show on it.
  await cmd('setMaterial', { material: { materialId: 'mat-tile', name: 'Tile', shader: 'standard', params: { color: '#8a8478', roughness: 0.3, metalness: 0 }, textures: {} } });
  await cmd('setBlockType', { block: { blockId: 'tile', name: 'Tile', variants: [{ color: '#8a8478' }], shape: 'full', materials: { '*': 'mat-tile' } } });
  await blockLayer(be, projectId, cmd, [24, 8, 34], [
    fill(0, 0, 0, 24, 1, 34, 'soil'),
    fill(9, 1, 1, 14, 5, 32, 'rock'),
    fill(10, 1, 2, 13, 4, 31, null),
    fill(10, 0, 2, 13, 1, 31, 'tile'),
  ]);
  // Rectangles: a panel on the ceiling and an area light of its size just under it, shining down.
  for (const [i, z] of [6, 14, 22].entries()) {
    await box(cmd, `Panel ${i + 1}`, [11.5, 3.97, z], [1.2, 0.04, 0.6], { color: '#ffffff', emissive: '#fff4e0', emissiveIntensity: 4 });
    await light(cmd, `Rect ${i + 1}`, [11.5, 3.94, z], { type: 'area', shape: 'rect', width: 1.2, height: 0.6, color: '#fff4e0', intensity: 40, range: 8, castShadow: true, mode });
  }
  // A line: an emissive strip low on the west wall and a line light along it (local X turned along +z, facing +x into the corridor).
  await box(cmd, 'Strip', [10.04, 1.6, 18], [0.06, 0.05, 8], { color: '#ffffff', emissive: '#9fd0ff', emissiveIntensity: 4 });
  await light(cmd, 'Line', [10.1, 1.6, 18], { type: 'area', shape: 'line', width: 8, color: '#9fd0ff', intensity: 20, range: 4, castShadow: true, mode }, [0.5, -0.5, 0.5, 0.5]);
  // The corridor is closed: the sun only lights its outside.
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffffff', intensity: 1.5, direction: [0.4, -1, -0.3], castShadow: true, mode } });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'procedural', sunFromLight: true }, post: POST } });
}

/** Hilly terrain (128 m square, flat round the sign) at night; the sign's face glows. */
async function signScene(be: PerfBackend, projectId: string, cmd: Cmd, mode: LookLightMode): Promise<void> {
  const tiles = [0, 1].flatMap((z) => [0, 1].map((x) => ({ x, z })));
  const terrain: EntityValue = { id: 'terrain', name: 'Terrain', static: true, components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, terrain: { tileSamples: 65, spacing: 1, heightRange: [-16, 48], tiles } } };
  await cmd('pasteEntities', { sceneId: 'scene-main', entities: [terrain] });
  const listed = (await be.project(projectId).query('queryEntities', { limit: 100, offset: 0 }))['entities'] as { id: string; components: Record<string, unknown> }[];
  const terrainId = listed.find((e) => e.components['terrain'] !== undefined)?.id;
  if (terrainId === undefined) throw new Error('look: the terrain was not created');
  // Hills round the sign's flat; the ground in front of it stays level.
  for (const [x, z, h] of [[40, 90, 8], [90, 96, 10], [100, 60, 6], [30, 50, 5], [70, 100, 7]] as const) await cmd('editTerrain', { entityId: terrainId, kind: 'raise', dabs: [[x, z]], radius: 18, strength: h, falloff: 'smooth' });
  await cmd('editTerrain', { entityId: terrainId, kind: 'noise', dabs: [[64, 64]], radius: 64, strength: 0.4, scale: 6, seed: 3, falloff: 'smooth' });
  await cmd('editTerrain', { entityId: terrainId, kind: 'flatten', dabs: [[64, 62]], radius: 7, strength: 1, height: 0, falloff: 'smooth' });
  await box(cmd, 'Sign post', [62.2, 0.9, 64], [0.12, 1.8, 0.12], { color: '#3a3632' });
  await box(cmd, 'Sign post 2', [65.8, 0.9, 64], [0.12, 1.8, 0.12], { color: '#3a3632' });
  await box(cmd, 'Sign', [64, 1.9, 64], [4, 1, 0.12], { color: '#20303a', emissive: '#40c8ff', emissiveIntensity: 4 });
  // A faint moon; the night sky gives almost no light.
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#8fa6ff', intensity: 0.15, direction: [0.3, -0.6, 0.5], castShadow: true, mode } });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#070a14', environmentIntensity: 0.15 }, post: POST } });
}

/** Rooms R (an arch toward the camera, a doorway to C) and C (closed but for that doorway) on a block floor; a lamp in C. */
async function leakScene(be: PerfBackend, projectId: string, cmd: Cmd, mode: LookLightMode, doorShut: boolean, lampOn: boolean): Promise<void> {
  await cmd('setBlockType', { block: { blockId: 'door', name: 'Door', variants: [{ color: '#6b4a2b' }], shape: 'full', placement: 'edge' } });
  const layer = await blockLayer(be, projectId, cmd, [7, 4, 9], [fill(0, 0, 0, 7, 1, 9, 'soil')]);
  // The door piece on the cell edges across the doorway's foot (the line z = 4, column x 1, rows 1–2).
  if (doorShut) await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'edges', at: [1, 1, 4, 1, 1, 2, 4, 1], edge: { block: 'door' } }] });
  const box4 = (x0: number, z0: number, x1: number, z1: number): number[][] => [[x0, 1, z0], [x1, 1, z0], [x1, 1, z1], [x0, 1, z1]];
  const outlines = [
    { id: 'r', preset: 'starter-room', path: { points: box4(0, 4, 3, 8), closed: true }, openings: [{ id: 'arch', at: 8.5, width: 2.4, bottom: 0, top: 2.4 }, { id: 'door', at: 1.5, width: 1, bottom: 0, top: 2.1 }] },
    { id: 'c', preset: 'starter-room', path: { points: box4(0, 0, 3, 4), closed: true } },
  ];
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Rooms', static: true, transform: { position: [0, 0, 0] }, components: { architecture: { elements: [], layer, outlines } } });
  if (lampOn) await light(cmd, 'Lamp in C', [1.5, 1.6, 2], { type: 'point', color: '#fff2d8', intensity: 30, range: 6, castShadow: true, mode });
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffffff', intensity: 0.6, direction: [0.3, -0.8, -0.5], castShadow: true, mode } });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#202634', environmentIntensity: 0.3 }, post: POST } });
}

const BUILDERS: Readonly<Record<LookScene, (be: PerfBackend, projectId: string, cmd: Cmd, mode: LookLightMode) => Promise<void>>> = {
  door: doorScene,
  sunset: sunsetScene,
  corridor: corridorScene,
  sign: signScene,
  'shut-off': (be, id, cmd, mode) => leakScene(be, id, cmd, mode, true, false),
  'shut-on': (be, id, cmd, mode) => leakScene(be, id, cmd, mode, true, true),
  'open-on': (be, id, cmd, mode) => leakScene(be, id, cmd, mode, false, true),
};

/** Build one look scene into a new project through the backend's commands. */
export async function buildLook(be: PerfBackend, projectId: string, scene: LookScene, mode: LookLightMode): Promise<{ ms: number; commands: number }> {
  const t0 = performance.now();
  const created = await be.post('/api/v1/admin/projects', { projectId, name: `Look ${scene}` });
  if (created.status !== 201 && created.status !== 200) throw new Error(`project create failed: ${created.status} ${JSON.stringify(created.json)}`);
  const p = be.project(projectId);
  let commands = 0;
  const cmd: Cmd = async (op, args) => {
    commands += 1;
    return p.command(op, args);
  };
  for (const id of STARTER_REMOVED) await cmd('deleteEntity', { entityId: id }).catch(() => undefined);
  await BUILDERS[scene](be, projectId, cmd, mode);
  const plan = LOOK_PLANS[scene];
  await cmd('setTransform', { entityId: 'cam-main', transform: { position: plan.eye, rotation: lookRotation(plan.eye, plan.at) } });
  return { ms: Math.round(performance.now() - t0), commands };
}
