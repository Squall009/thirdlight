/**
 * One level built from every level-building part at once, against a real
 * backend, in Play and the static export, on WebGPU and WebGL 2 (one backend:
 * each renderer is a pass of the same test). Everything is made in the test
 * through commands (no game data).
 *
 * The scene: a terrain of 4 × 4 tiles 1 km a side (4 km square: flat round
 * the middle, hills past a few hundred metres) wearing the layered material,
 * a steep ramp the terrain's material rule paints magenta; a block area
 * (40 × 24 cells of soil, a paved part) the terrain meets (its blocks layer
 * cuts the ground away under it and follows its border), its raised dais's
 * walls magenta by the same rule on the block layer (one of them painted blue
 * by hand with wall paint); a row of edge walls with
 * a live door (its yellow leaf an object of the game); a connected rampart
 * (straight pieces yellow, its corner white); scatter rules placing chartreuse
 * posts on the terrain and teal bushes on the soil, with ground cover (white
 * tufts on the terrain, lavender sprigs on the soil); a road (painted green,
 * flattened) and a river (blue water) made by splines; an orange-peach height
 * fog thick at the horizon under a blue sky.
 *
 * Generated architecture on the paved part, drawn as outlines on the block
 * layer and made at load from parameters: a room, a building with a hip
 * roof whose interior is a scene of its own linked through its door, a fence
 * and a pipe, each from a preset deriving from the engine's starters and
 * wearing trim sheet A (every row green); a hand-placed pink prop between
 * them. A key makes a script swap every preset for its twin on trim sheet B
 * (every row purple): the walls, fence and pipe turn purple where they stood,
 * the prop stays where it was and pink; the outlines stored are unchanged. A
 * second key goes through the building's door (`ctx.grid.doorLink`) into the
 * interior scene, whose camera shows the inside of the front wall in a sheet's
 * colour.
 *
 * Each feature is read where the fixed camera sees it (world points projected
 * through its view), the scatter by colour over the whole frame; Play's
 * diagnostics count the terrain's tiles, the scatter and cover copies, the
 * splines' mesh pieces, the live objects and the architecture's chunks.
 *
 * TL_ACCEPTANCE_DIR=<dir> keeps the pictures.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from './pw';

import { riverMaterial, layeredMaterial } from '../../packages/editor/src/session/material-graph';
import { equalTrimRows, TRIM_STARTER_LAYOUT, type TrimSheet } from '../../packages/project-model/src/trim-sheet';
import { publishBytes, publishScript, startBackend, type E2EBackend } from './backend';
import { multiPieceGlb } from './multi-piece-glb';
import { ALBEDO_HEIGHT_LAYERS, isBlue, isGreenish, isMagenta, packNormalAndOrm, packTexture, publishLayerSources, publishTexture, useArrays, type Pred } from './painted-layers';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { expectRendererBackend } from './renderer-variants';
import { frameShareNear, projectWith, serveDir, type CameraView, type V3 } from './frame-reading';
import { BACKENDS, cmd, query, relay, useBackend } from './terrain-cdlod-steps';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
  useBackend(null);
});

const keep = (name: string, png: Buffer): void => {
  const dir = process.env['TL_ACCEPTANCE_DIR'];
  if (dir === undefined) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.png`), png);
};

// ---- The terrain: 4 × 4 tiles of 256 cells 4 m apart, centred on the origin, flat round the middle.
const TILES = 4;
const CELLS = 256;
const SPACING = 4;
const HALF = (TILES * CELLS * SPACING) / 2;
const RANGE: [number, number] = [-16, 240];
const BASE = 2;
const groundAt = (x: number, z: number): number => {
  const t = Math.min(1, Math.max(0, (Math.hypot(x, z) - 160) / 440));
  const s = t * t * (3 - 2 * t);
  return BASE + s * (25 + 15 * Math.sin(x / 310) * Math.cos(z / 270) + 5 * Math.sin(x / 90 + z / 120));
};
/** A ramp steeper than the material rule's 50° (the rule paints it magenta). */
const RAMP = { from: [48, BASE, -20] as V3, to: [48, BASE + 30, -32] as V3 };
const RAMP_LOOK: [number, number] = [48, -26];
const STEEP_RULE = { layer: 3, slope: { min: 50, fade: 5 } };

// ---- The block area: 40 × 24 cells of 1 m, its corner at (−20, 0, −14); two rows of soil (tops at y 2).
const AREA_AT: V3 = [-20, 0, -14];
const local = (x: number, y: number, z: number): V3 => [x - AREA_AT[0], y - AREA_AT[1], z - AREA_AT[2]];
/** The paved part (world x, z): the architecture stands here; the soil's scatter keeps off it. */
const PAVED = { x: [-19, 4], z: [-13, -2] } as const;
/** A dais of soil two rows high (world x 12–16, z 2–6): its walls magenta by the block layer's rule. */
const DAIS = { x: [12, 16], z: [2, 6] } as const;
/** Edge walls along the z = 4 line (world x −4 to 4, two rows), a live door at x 0–1 in the lower row. */
const WALL_X = [-4, 4] as const;
const DOOR_X = 0;
const WALL_Z = 4;
/** A connected rampart three rows high: a run along z −10 (x 12–18) and a turn toward −z at x 12. */
const RAMPART: readonly [number, number][] = [[12, -10], [13, -10], [14, -10], [15, -10], [16, -10], [17, -10], [18, -10], [12, -11], [12, -12]];

// ---- Architecture (world): a room, a building (door on its front wall, its interior 400 m along −z), a fence, a pipe.
const ROOM = { x: [-18, -10], z: [-12, -6] } as const;
const HOUSE = { x: [-6, 2], z: [-12, -6] } as const;
const HOUSE_DOOR_AT = 4;
const INTERIOR_OFFSET: V3 = [0, 0, -400];
const FENCE: readonly [number, number][] = [[-16, 8], [-6, 8]];
const PIPE: readonly [number, number][] = [[6, 0], [10, 0]];
const PROP_AT: V3 = [-8, BASE + 0.5, -4];

// ---- The camera: over the area's south side, looking north across it to the horizon.
const CAM_POS: V3 = [0, 16, 30];
const PITCH = (-22 * Math.PI) / 180;
const CAMERA: CameraView = { position: [...CAM_POS], rotation: [Math.sin(PITCH / 2), 0, 0, Math.cos(PITCH / 2)], fovY: 60 };
/** The interior's camera: inside the building's interior, level, looking +z at the front wall left of the door. */
const INTERIOR_CAMERA: CameraView = { position: [-4.5, BASE + 1.5, -411.5], rotation: [0, 1, 0, 0], fovY: 70 };
const INTERIOR_WALL: V3 = [-4.5, BASE + 1.5, HOUSE.z[1] + INTERIOR_OFFSET[2] - 0.12];

const SKY = '#3050d0';
const FOG = { density: 0.0025, color: '#ffb070', height: 0, falloff: 0.03, start: 150 };
/** The far ground the fog hides (2 km ahead), and how far ahead the near reads and scatter counts stop (short of the fog's start). */
const FAR_GROUND: [number, number] = [0, -1970];
const NEAR_LIMIT = 110;
const RESTYLE_KEY = 'KeyR';
const ENTER_KEY = 'KeyB';

// ---- Colours (lit, tone mapped: ratios, not values).
const isYellow: Pred = (r, g, b) => r > 110 && g > 95 && b < 0.45 * Math.min(r, g) && Math.abs(r - g) < 0.35 * r;
const isChartreuse: Pred = (r, g, b) => g > 90 && r > 0.45 * g && r < 0.88 * g && b < 0.35 * g;
const isTeal: Pred = (r, g, b) => g > 35 && b > 35 && r < 0.4 * Math.min(g, b) && Math.abs(g - b) < 0.35 * Math.max(g, b);
const isWhite: Pred = (r, g, b) => Math.min(r, g, b) > 140 && Math.max(r, g, b) - Math.min(r, g, b) < 45;
const isLavender: Pred = (r, g, b) => b > 100 && b > 1.2 * r && b > 1.2 * g && Math.min(r, g) > 0.45 * b;
const isDarkGrey: Pred = (r, g, b) => Math.max(r, g, b) < 130 && Math.min(r, g, b) > 15 && Math.max(r, g, b) - Math.min(r, g, b) < 30;
const isPink: Pred = (r, g, b) => r > 140 && b > 1.4 * g && r > 1.25 * b;
const isPeach: Pred = (r, g, b) => r > 170 && g > 0.5 * r && g < 0.88 * r && b < 0.8 * g;
const isSkyBlue: Pred = (r, g, b) => b > 110 && b > 1.4 * r && b > 1.15 * g;
const isSheetA: Pred = (r, g, b) => g > 70 && g > 1.5 * r && g > 1.5 * b;
const isSheetB: Pred = (r, g, b) => b > 70 && r > 1.6 * g && b > 1.9 * g;

// ---- Trim sheets: the starter row layout, every row one colour (A green, B purple).
const SHEET: TrimSheet = { size: [256, 256], texelDensity: 64, padding: 4, rows: equalTrimRows(256, TRIM_STARTER_LAYOUT, 4) };
const SHEET_COLOURS = { a: [40, 200, 40], b: [150, 40, 220] } as const;
const PRESETS = ['room', 'fence', 'pipe'] as const;
/** The starter each preset derives from and the values it changes (the fence and pipe made big enough to read at 30 m). */
const PRESET_BASES: Record<(typeof PRESETS)[number], { base: string; values: Record<string, number> }> = {
  room: { base: 'starter-room', values: {} },
  fence: { base: 'starter-fence', values: { post_size: 0.5, rail_height: 1.4 } },
  pipe: { base: 'starter-pipe', values: { pipe_radius: 0.4, pipe_height: 1 } },
};
const presetGraph = (base: string, sheet: string, values: Record<string, number>): Record<string, unknown> => ({
  nodes: [{ id: 'preset', type: 'preset', position: [0, 0], data: { style: '', base, sheet } }, ...Object.entries(values).map(([parameter, value], i) => ({ id: `v-${parameter}`, type: 'value', position: [0, 150 * (i + 1)], data: { parameter, value } }))],
  edges: [],
});

/** On the restyle key every preset shows its sheet-B twin; on the enter key the building's door loads its interior. */
const LEVEL_SCRIPT = [
  'export default {',
  '  instantiate() { return { swapped: false, entered: false }; },',
  '  step(state, ctx) {',
  "    if (ctx.phase !== 'intent') return;",
  "    if (!state.swapped && ctx.input.pressed('restyle')) {",
  `      state.swapped = ${JSON.stringify(PRESETS)}.map((k) => ctx.grid.setArchitecturePreset('acc-' + k + '-a', 'acc-' + k + '-b')).every((ok) => ok);`,
  "      ctx.log('info', `restyled ${state.swapped}`);",
  '    }',
  "    if (!state.entered && ctx.input.pressed('enterDoor')) {",
  `      const link = ctx.grid.doorLink(${JSON.stringify([HOUSE.x[0] + HOUSE_DOOR_AT, BASE, HOUSE.z[1] + 1])}, 2);`,
  "      if (link === null) { ctx.log('warn', 'no door near'); return; }",
  '      ctx.scenes.load(link.to.scene);',
  '      state.entered = true;',
  '    }',
  '  },',
  '};',
].join('\n');

/** A rectangle outline (world x, z ranges) with its inside to the right of travel, in the block layer's frame. */
const rectangle = (r: { x: readonly number[]; z: readonly number[] }): { points: V3[]; closed: true } => ({
  points: [local(r.x[0]!, BASE, r.z[1]!), local(r.x[1]!, BASE, r.z[1]!), local(r.x[1]!, BASE, r.z[0]!), local(r.x[0]!, BASE, r.z[0]!)],
  closed: true,
});

/** Bytes into a new upload stage in frames of at most 1 MiB (the route's frame); returns its id. */
async function stage(bytes: Uint8Array): Promise<string> {
  const headers = { authorization: `Bearer ${be!.token}`, origin: be!.origin };
  const base = `${be!.origin}/api/v1/projects/${be!.projectId}/content/stages`;
  const s = (await (await fetch(base, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).json()) as { stageId: string };
  for (let offset = 0; offset < bytes.length; offset += 1 << 20) {
    const put = await fetch(`${base}/${s.stageId}/bytes`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': String(offset), 'x-thirdlight-total': String(bytes.length) }, body: bytes.subarray(offset, Math.min(bytes.length, offset + (1 << 20))) });
    expect(put.status, await put.text()).toBe(200);
  }
  return s.stageId;
}

interface Built {
  ground: string;
  architecture: string;
  outlines: unknown;
  /** Terrain heights (world y) at the points the frames read on it. */
  heights: { ramp: number; road: number[]; far: number };
}

async function buildLevel(): Promise<Built> {
  await cmd('setSettings', { settings: { camera_far_m: 5000, physics_dimension: 3 } });
  for (const id of ['model-0001', 'spawn-0001', 'box-0001', 'box-0002', 'box-0003', 'box-0004', 'model-0002']) await cmd('deleteEntity', { entityId: id }).catch(() => undefined);
  // The layered material's arrays (layers red, green, blue, magenta), packed through the route.
  await publishLayerSources(be!);
  await packTexture(be!, ALBEDO_HEIGHT_LAYERS, 'color', 'terrain-albedo');
  await packNormalAndOrm(be!);
  await cmd('setMaterial', { material: layeredMaterial('mat-terrain', 'Terrain layers') });
  await useArrays(be!, 'mat-terrain', { albedoHeight: 'terrain-albedo', normals: 'terrain-normals', orm: 'terrain-orm' });
  const river = riverMaterial('mat-river', 'River');
  await cmd('setMaterial', { material: { ...river, parameters: river.parameters!.map((p) => (p.key === 'deepColor' || p.key === 'shallowColor' ? { ...p, default: '#1838ff' } : p)) } });
  // The scatter's models.
  await publishBytes(be!, multiPieceGlb([{ name: 'post', lods: [[0.4, 1.6, 0.4]], colors: [[0.45, 1, 0.0]] }]), 'model', 'acc-post', 'Post');
  await publishBytes(be!, multiPieceGlb([{ name: 'bush', lods: [[0.7, 0.9, 0.7]], colors: [[0.0, 0.45, 0.45]] }]), 'model', 'acc-bush', 'Bush');
  await publishBytes(be!, multiPieceGlb([{ name: 'tuft', lods: [[0.3, 0.45, 0.3]], colors: [[1, 1, 1]] }]), 'model', 'acc-tuft', 'Tuft');
  await publishBytes(be!, multiPieceGlb([{ name: 'sprig', lods: [[0.3, 0.45, 0.3]], colors: [[0.55, 0.25, 1]] }]), 'model', 'acc-sprig', 'Sprig');

  // The look: a blue sky, the height fog thick at the horizon; the sun from behind the camera.
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: SKY }, fog: { mode: 'none', color: '#000000' }, heightFog: FOG } });
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffffff', intensity: 2, direction: [0.3, -1, -0.6], castShadow: true } });
  await cmd('setTransform', { entityId: 'cam-main', transform: { position: CAMERA.position, rotation: CAMERA.rotation } });
  const lens = ((await query('queryEntity', { entityId: 'cam-main' }))['entity'] as { components: { virtualCamera?: Record<string, unknown> } }).components.virtualCamera;
  await cmd('setComponent', { entityId: 'cam-main', component: 'virtualCamera', value: { ...(lens ?? {}), rig: 'fixed', fovY: CAMERA.fovY, near: 0.1, far: 5000 } });

  // ---- The block area: types, the live door's prefab (a logic-only root with a yellow leaf), the rampart's pieces.
  await cmd('setBlockType', { block: { blockId: 'soil', name: 'Soil', variants: [{ color: '#808080' }], shape: 'full', materials: { '*': 'mat-terrain' } } });
  await cmd('setBlockType', { block: { blockId: 'paving', name: 'Paving', variants: [{ color: '#606060' }], shape: 'full' } });
  await cmd('setBlockType', { block: { blockId: 'wall', name: 'Wall', variants: [{ color: '#505050' }], shape: 'full', placement: 'edge' } });
  await cmd('createScene', { sceneId: 'scene-kit', name: 'Kit' });
  const gate = String((await cmd('createEntity', { sceneId: 'scene-kit', parentId: null, kind: 'group', name: 'Door', transform: { position: [0, 0, 0] } }))['createdId']);
  await cmd('createEntity', { sceneId: 'scene-kit', parentId: gate, kind: 'box', name: 'Door leaf', transform: { position: [0, 0.45, 0] }, box: { size: [0.9, 0.9, 0.12], material: { color: '#f0dc00' } } });
  await cmd('createPrefab', { prefabId: 'acc-door', displayName: 'Door', sourceEntityId: gate });
  await cmd('setBlockType', { block: { blockId: 'door', name: 'Door', variants: [{ prefab: 'acc-door' }], shape: 'full', placement: 'edge', live: true } });
  await cmd('setBlockType', { block: { blockId: 'rampart', name: 'Rampart', variants: [{ color: '#606060', weight: 1000 }, { color: '#f0e000', weight: 0.001 }, { color: '#f0f0f0', weight: 0.001 }], shape: 'full', connect: { pieces: { straight: { variant: 1 }, corner: { variant: 2 } } } } });
  const area = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Area', transform: { position: AREA_AT } }))['createdId']);
  // Rules and scatter first: every edit after bakes the chunks it touches.
  await cmd('setComponent', {
    entityId: area,
    component: 'blockLayer',
    value: {
      cellSize: [1, 1, 1],
      bounds: { min: [0, 0, 0], max: [40, 8, 24] },
      rules: [STEEP_RULE],
      wallPaint: true,
      scatter: [
        { id: 'bushes', asset: { assetId: 'acc-bush' }, density: 0.04, spacing: 2.5, scale: [1, 1], blocks: ['soil'], slope: { max: 30, fade: 5 } },
        { id: 'sprigs', asset: { assetId: 'acc-sprig' }, density: 0.4, scale: [1, 1.5], blocks: ['soil'], slope: { max: 30, fade: 5 }, cover: true, coverDistance: 60 },
      ],
    },
  });
  const [px0, , pz0] = local(PAVED.x[0], 0, PAVED.z[0]);
  const [px1, , pz1] = local(PAVED.x[1], 0, PAVED.z[1]);
  const [dx0, , dz0] = local(DAIS.x[0], 0, DAIS.z[0]);
  const [dx1, , dz1] = local(DAIS.x[1], 0, DAIS.z[1]);
  const wallEdges: number[] = [];
  for (let x = WALL_X[0]; x < WALL_X[1]; x++) for (const y of [BASE, BASE + 1]) if (x !== DOOR_X || y !== BASE) wallEdges.push(...local(x, y, WALL_Z), 1);
  const door = [...local(DOOR_X, BASE, WALL_Z), 1];
  const rampart = RAMPART.flatMap(([x, z]) => [BASE, BASE + 1, BASE + 2].flatMap((y) => [x - AREA_AT[0], y, z - AREA_AT[2]]));
  await cmd('editBlocks', {
    entityId: area,
    edits: [
      { kind: 'fill', box: [0, 0, 0, 40, BASE, 24], cell: { block: 'soil' } },
      { kind: 'fill', box: [px0, 0, pz0, px1, BASE, pz1], cell: { block: 'paving' } },
      { kind: 'fill', box: [dx0, BASE, dz0, dx1, BASE + 2, dz1], cell: { block: 'soil' } },
      { kind: 'edges', at: wallEdges, edge: { block: 'wall' } },
      { kind: 'edges', at: door, edge: { block: 'door' } },
      { kind: 'cells', at: rampart, cell: { block: 'rampart' } },
      // The dais's west wall painted blue by hand (wall paint, over the rule).
      { kind: 'paint', at: [dx0 - 0.05, (dz0 + dz1) / 2], y: BASE + 1, radius: 1.5, strength: 1, falloff: 'constant', channel: 2, target: 'walls' },
      { kind: 'bakeScatter' },
    ],
  });

  // ---- The terrain: tiles, heights, the ramp, the blocks layer meeting the area, the material rule, splines, scatter.
  const ground = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Ground', transform: { position: [-HALF, 0, -HALF] } }))['createdId']);
  const tiles: { x: number; z: number }[] = [];
  for (let z = 0; z < TILES; z++) for (let x = 0; x < TILES; x++) tiles.push({ x, z });
  await cmd('setComponent', { entityId: ground, component: 'terrain', value: { tileSamples: CELLS + 1, spacing: SPACING, heightRange: RANGE, tiles } });
  await cmd('setComponent', { entityId: ground, component: 'materials', value: { '*': 'mat-terrain' } });
  const side = TILES * CELLS + 1;
  const raw = new Uint8Array(side * side * 2);
  const dv = new DataView(raw.buffer);
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) dv.setUint16((j * side + i) * 2, Math.round(((groundAt(-HALF + i * SPACING, -HALF + j * SPACING) - RANGE[0]) / (RANGE[1] - RANGE[0])) * 65535), true);
  await cmd('editTerrain', { entityId: ground, kind: 'import', stageId: await stage(raw), format: 'raw16', at: [0, 0] });
  await cmd('editTerrain', { entityId: ground, kind: 'ramp', from: RAMP.from, to: RAMP.to, radius: 8, strength: 1, falloff: 'constant' });
  await cmd('setComponent', { entityId: ground, component: 'terrain', value: { layers: [{ id: 'blocks', kind: 'blocks', blockLayers: [area], mode: 'cut', blend: 8 }] } });
  await cmd('editTerrain', { entityId: ground, kind: 'bake', rules: [STEEP_RULE] });
  const road = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Road', transform: { position: [30, BASE, 0] } }))['createdId']);
  await cmd('setComponent', { entityId: road, component: 'spline', value: { points: [{ at: [0, 0, 40] }, { at: [0, 0, -40] }, { at: [4, 0, -120] }], width: 10, terrain: { falloff: 4, paint: { layer: 1, falloff: 1 } }, scatter: { margin: 2 } } });
  const riverId = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'River', transform: { position: [-34, BASE, 0] } }))['createdId']);
  await cmd('setComponent', { entityId: riverId, component: 'spline', value: { points: [{ at: [0, 0, 40] }, { at: [-2, 0, -40] }, { at: [-8, 0, -120] }], width: 14, terrain: { shape: 'carve', depth: 2.5, falloff: 4 }, scatter: { margin: 2 }, mesh: { kind: 'water', offset: -0.4 } } });
  await cmd('setComponent', { entityId: riverId, component: 'materials', value: { spline: 'mat-river' } });
  await cmd('editTerrain', {
    entityId: ground,
    kind: 'bake',
    scatter: [
      { id: 'posts', asset: { assetId: 'acc-post' }, density: 0.003, spacing: 6, scale: [1, 1], slope: { max: 20, fade: 5 }, height: { max: 6, fade: 1 } },
      { id: 'tufts', asset: { assetId: 'acc-tuft' }, density: 0.25, scale: [1, 1.5], slope: { max: 20, fade: 5 }, height: { max: 6, fade: 1 }, cover: true, coverDistance: 60 },
    ],
  });

  // ---- Architecture: trim sheets A and B, presets A (deriving from the starters) and their sheet-B twins.
  for (const k of ['a', 'b'] as const) {
    const [r, g, b] = SHEET_COLOURS[k];
    await publishTexture(be!, new Uint8Array(makePng(256, 256, () => [r, g, b, 255])), `acc-sheet-${k}`, `Sheet ${k.toUpperCase()}`);
    await cmd('setMaterial', { material: { materialId: `acc-trim-${k}`, name: `Trim ${k.toUpperCase()}`, shader: 'trim', params: {}, textures: { map: `acc-sheet-${k}` }, trim: SHEET } });
  }
  for (const p of PRESETS) {
    const { base, values } = PRESET_BASES[p];
    await cmd('setGraph', { graph: { graphId: `acc-${p}-a`, kind: 'architecture-preset', name: `${p} A`, graph: presetGraph(base, 'acc-trim-a', values) } });
    await cmd('setGraph', { graph: { graphId: `acc-${p}-b`, kind: 'architecture-preset', name: `${p} B`, graph: presetGraph(`acc-${p}-a`, 'acc-trim-b', {}) } });
  }
  await cmd('createScene', { sceneId: 'acc-interior', name: 'Interior' });
  await cmd('createEntity', { sceneId: 'acc-interior', parentId: null, kind: 'group', name: 'Interior camera', transform: { position: INTERIOR_CAMERA.position, rotation: INTERIOR_CAMERA.rotation }, components: { virtualCamera: { rig: 'fixed', priority: 10, blend: 'cut', fovY: INTERIOR_CAMERA.fovY, near: 0.05, far: 60 } } });
  // The interior's own light: the building's walls keep the sun out.
  await cmd('createEntity', { sceneId: 'acc-interior', parentId: null, kind: 'group', name: 'Interior light', transform: { position: [0, 0, 0] }, components: { light: { type: 'ambient', color: '#ffffff', intensity: 1.2 } } });
  const architecture = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Architecture', transform: { position: AREA_AT } }))['createdId']);
  const outlines = {
    layer: area,
    elements: [],
    outlines: [
      { id: 'room-1', preset: 'acc-room-a', path: rectangle(ROOM) },
      { id: 'fence-1', preset: 'acc-fence-a', path: { points: FENCE.map(([x, z]) => local(x, BASE, z)) } },
      { id: 'pipe-1', preset: 'acc-pipe-a', path: { points: PIPE.map(([x, z]) => local(x, BASE, z)) } },
    ],
    buildings: [{ id: 'building-1', preset: 'acc-room-a', outside: 'acc-room-a', storeys: 1, roof: { shape: 'hip' }, interior: { scene: 'acc-interior', offset: INTERIOR_OFFSET }, openings: [{ id: 'door-1', at: HOUSE_DOOR_AT, width: 1.2, bottom: 0, top: 2.2 }], path: rectangle(HOUSE) }],
  };
  await cmd('setComponent', { entityId: architecture, component: 'architecture', value: outlines });
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name: 'Prop', transform: { position: PROP_AT }, box: { size: [1, 1, 1], material: { color: '#ff40a0' } } });
  await cmd('setInput', { input: { actions: [{ name: 'restyle', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: RESTYLE_KEY }] }, { name: 'enterDoor', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: ENTER_KEY }] }] } });
  await publishScript(be!, 'acc-level', LEVEL_SCRIPT, architecture);

  const at = async (pts: [number, number][]): Promise<number[]> => ((await query('queryTerrain', { entityId: ground, points: pts }))['points'] as { height: number }[]).map((p) => p.height);
  const [ramp, road0, road1, far] = await at([RAMP_LOOK, [30, -10], [30, -30], FAR_GROUND]);
  const stored = ((await query('queryEntity', { entityId: architecture })) as { entity: { components: { architecture: unknown } } }).entity.components.architecture;
  return { ground, architecture, outlines: stored, heights: { ramp: ramp!, road: [road0!, road1!], far: far! } };
}

type Reads = Record<string, number>;
type Judged = { reads: Reads; ok: boolean; note?: string };

/** Shares of a test near world points as `cam` sees them, each point's centre colour and screen place kept for the log. */
function reader(img: Image, cam: CameraView): { near: (label: string, p: V3, t: Pred, size?: number) => number; note: () => string } {
  const seen: string[] = [];
  return {
    near: (label, p, t, size = 8) => {
      const uv = projectWith(cam, img.width / img.height, p);
      if (uv !== null) {
        const x = Math.round(uv[0] * img.width);
        const y = Math.round(uv[1] * img.height);
        if (x >= 0 && y >= 0 && x < img.width && y < img.height) seen.push(`${label} (${x},${y}) ${img.pixel(x, y).slice(0, 3).join(',')}`);
      }
      return frameShareNear(img, cam, p, t, size);
    },
    note: () => seen.join('; '),
  };
}

/** Every feature in a frame of the main camera: shares near its world points, counts of the scatter's colours over the near ground. */
function judgeLevel(img: Image, b: Built): Judged {
  const { near, note } = reader(img, CAMERA);
  const s = img.width / 1024;
  const reads: Reads = {
    terrainRuleRamp: near('ramp', [RAMP_LOOK[0], b.heights.ramp, RAMP_LOOK[1]], isMagenta),
    blockRuleDais: near('dais', [(DAIS.x[0] + DAIS.x[1]) / 2, BASE + 1, DAIS.z[1] + 0.01], isMagenta),
    blockWallPaint: near('wall paint', [DAIS.x[0] - 0.01, BASE + 1, (DAIS.z[0] + DAIS.z[1]) / 2], isBlue, 6),
    road: Math.min(near('road near', [30, b.heights.road[0]!, -10], isGreenish), near('road far', [30, b.heights.road[1]!, -30], isGreenish)),
    river: near('river', [-35, BASE - 0.4, -15], isBlue),
    edgeWall: near('edge wall', [-2.5, BASE + 1.4, WALL_Z + 0.07], isDarkGrey, 6),
    liveDoor: near('door', [DOOR_X + 0.5, BASE + 0.5, WALL_Z + 0.07], isYellow, 4),
    rampartStraight: near('rampart straight', [15.5, BASE + 1.5, -8.99], isYellow),
    rampartCorner: near('rampart corner', [12.5, BASE + 1.5, -8.99], isWhite, 4),
    // Fog: the far ground straight ahead peach, the sky at the top of the frame blue.
    fogHorizon: near('far ground', [FAR_GROUND[0], b.heights.far, FAR_GROUND[1]], isPeach),
    skyTop: isSkyBlue(...img.pixel(Math.round(img.width / 2), Math.round(4 * s))) ? 1 : 0,
    // Scatter: pixels of each rule's colour (every second one) over the near ground.
    terrainPosts: countNear(img, isChartreuse),
    blockBushes: countNear(img, isTeal),
    terrainCover: countNear(img, isWhite),
    blockCover: countNear(img, isLavender),
    ...judgeArchitecture(img, isSheetA, near),
  };
  const min = (k: string): number => (/Posts|Bushes|Cover/.test(k) ? 20 * s * s : k === 'liveDoor' || k === 'rampartCorner' || k.startsWith('arch') ? 0.3 : 0.5);
  return { reads, ok: Object.entries(reads).every(([k, v]) => v >= min(k)), note: note() };
}

/** The generated architecture's colour (sheet A or B) where the camera sees it, and the prop's pink. */
function judgeArchitecture(img: Image, sheet: Pred, near = reader(img, CAMERA).near): Reads {
  return {
    archRoom: near('room', [(ROOM.x[0] + ROOM.x[1]) / 2, BASE + 1.5, ROOM.z[1] + 0.12], sheet),
    archFacade: near('facade', [HOUSE.x[0] + 1.5, BASE + 1.5, HOUSE.z[1] + 0.12], sheet),
    archFence: Math.max(near('fence post 2', [FENCE[0]![0] + 2, BASE + 0.7, FENCE[0]![1] + 0.26], sheet, 4), near('fence post 3', [FENCE[0]![0] + 4, BASE + 0.7, FENCE[0]![1] + 0.26], sheet, 4)),
    archPipe: near('pipe', [(PIPE[0]![0] + PIPE[1]![0]) / 2, BASE + 1.2, PIPE[0]![1] + 0.3], sheet, 4),
    prop: near('prop', [PROP_AT[0], PROP_AT[1], PROP_AT[2] + 0.51], isPink),
  };
}

/** Pixels passing `test` (every second one) below the ground's line NEAR_LIMIT metres ahead: fogged ground beyond it may pass a colour test. */
function countNear(img: Image, test: Pred): number {
  const v = projectWith(CAMERA, img.width / img.height, [0, BASE, CAM_POS[2] - NEAR_LIMIT])![1];
  let n = 0;
  for (let y = Math.ceil(v * img.height); y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) if (test(...img.pixel(x, y))) n += 1;
  return n;
}

const fmt = (r: Reads): string => Object.entries(r).map(([k, v]) => `${k} ${Number.isInteger(v) ? v : v.toFixed(2)}`).join(', ');

/** Polls a frame source until `judge` passes; keeps the picture; logs the reads either way. */
async function until(shot: () => Promise<Buffer | null>, judge: (img: Image) => Judged, what: string): Promise<Reads> {
  let last: Judged = { reads: {}, ok: false };
  let png: Buffer | null = null;
  await expect
    .poll(async () => {
      png = await shot();
      if (png === null) return false;
      return (last = judge(decodePng(png))).ok;
    }, { timeout: 90_000, intervals: [1000], message: what })
    .toBe(true)
    .catch((e: unknown) => {
      console.log(`${what} (failed): ${fmt(last.reads)} | ${last.note ?? ''}`);
      if (png !== null) keep(`${what.replace(/\W+/g, '-')}-failed`, png);
      throw e;
    });
  if (png !== null) keep(what.replace(/\W+/g, '-'), png);
  console.log(`${what}: ${fmt(last.reads)}`);
  test.info().annotations.push({ type: what, description: fmt(last.reads) });
  return last.reads;
}

const restyled = (img: Image): Judged => {
  const { near, note } = reader(img, CAMERA);
  const reads = judgeArchitecture(img, isSheetB, near);
  return { reads, ok: Object.entries(reads).every(([k, v]) => v >= (k === 'prop' ? 0.5 : 0.3)), note: note() };
};
const inside = (img: Image): Judged => {
  const a = frameShareNear(img, INTERIOR_CAMERA, INTERIOR_WALL, isSheetA, 16);
  const b = frameShareNear(img, INTERIOR_CAMERA, INTERIOR_WALL, isSheetB, 16);
  return { reads: { interiorSheetA: a, interiorSheetB: b }, ok: Math.max(a, b) > 0.5 };
};

/** The page's generated-architecture marks: chunks made (how many, where, the slowest's ms) and the first object drawn (ms from its parameters). */
async function archTimes(target: Page | ReturnType<ReturnType<Page['frameLocator']>['locator']>): Promise<{ list?: string; chunks: number; where: string[]; worstMs: number; firstReadyMs: number | null }> {
  return (target as Page).evaluate(() => {
    const marks = performance.getEntriesByType('mark') as PerformanceMark[];
    const chunks = marks.filter((m) => m.name === 'tl:arch:chunk').map((m) => m.detail as { ms: number; where: string });
    const ready = marks.filter((m) => m.name === 'tl:arch:ready').map((m) => (m.detail as { ms: number }).ms);
    return { list: chunks.map((c) => `${c.where}:${Math.round(c.ms)}`).join(" "), chunks: chunks.length, where: [...new Set(chunks.map((c) => c.where))], worstMs: Math.round(Math.max(0, ...chunks.map((c) => c.ms)) * 10) / 10, firstReadyMs: ready.length > 0 ? Math.round(ready[0]! * 10) / 10 : null };
  });
}

async function press(page: Page, code: string): Promise<void> {
  await page.keyboard.down(code);
  await page.waitForTimeout(200);
  await page.keyboard.up(code);
}

test('level acceptance: blocks on a few km of terrain with rules, scatter, splines, fog and generated architecture restyled by a sheet swap, in Play and the export (WebGPU and WebGL 2)', async ({ page }) => {
  test.skip(test.info().project.name === 'webgpu', 'one pass covers both renderers');
  test.setTimeout(420_000);
  be = await startBackend('level-acceptance');
  useBackend(be);
  const built = await buildLevel();
  if (process.env['ACC_BUILD_ONLY'] === '1') return;

  for (const renderer of BACKENDS) {
    await page.goto(be.editorUrl.replace('#', `&renderer=${renderer}#`));
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
    const canvas = page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first();
    await expectRendererBackend(canvas, renderer);
    // Play's diagnostics: every tile drawn, stored scatter and ground cover, the river's mesh, the live door's objects.
    type Diag = { renderer?: { terrain?: { tilesDrawn: number }; scatter?: { copies: number }; cover?: { copies: number }; splines?: { meshPieces: number } }; runtime?: { blockMemory?: { liveObjects?: number } } };
    let d: Diag = {};
    await expect
      .poll(async () => {
        d = ((await relay(`${psid}/diagnostics`, {})).json as { diagnostics?: Diag }).diagnostics ?? {};
        return `${d.renderer?.terrain?.tilesDrawn ?? 0} ${(d.renderer?.scatter?.copies ?? 0) > 0} ${(d.renderer?.cover?.copies ?? 0) > 0} ${(d.renderer?.splines?.meshPieces ?? 0) > 0} ${d.runtime?.blockMemory?.liveObjects ?? 0}`;
      }, { timeout: 60_000, message: `${renderer} Play: terrain, scatter, cover, river and live door` })
      .toBe(`${TILES * TILES} true true true 2`);
    const diag = { terrain: d.renderer?.terrain?.tilesDrawn, scatter: d.renderer?.scatter?.copies, cover: d.renderer?.cover?.copies, splines: d.renderer?.splines?.meshPieces, live: d.runtime?.blockMemory?.liveObjects };
    console.log(`${renderer} Play diagnostics: ${JSON.stringify(diag)}`);
    const frame = async (): Promise<Buffer | null> => {
      const s = await relay(`${psid}/screenshot`, { maxWidth: 2048 });
      return s.status === 200 ? Buffer.from(String(s.json['dataUrl'] ?? '').split(',')[1] ?? '', 'base64') : null;
    };
    await until(frame, (img) => judgeLevel(img, built), `${renderer} Play level`);
    // Generated at load from the parameters: chunks made on the generator workers (or the page while they start).
    const chunks = await archTimes(canvas);
    console.log(`${renderer} Play architecture: ${JSON.stringify(chunks)}`);
    expect(chunks.chunks, `${renderer} Play: architecture chunks generated`).toBeGreaterThan(0);
    // The swap: every preset shows its sheet-B twin; the outlines and the prop stay.
    const input = async (action: string): Promise<void> => {
      const r = await relay(`${psid}/input`, { mode: 'exclusive-test', frames: [{ stepOffset: 0, actions: { [action]: { v: 1, p: 'pressed' } } }] });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    };
    await input('restyle');
    await until(frame, restyled, `${renderer} Play restyled`);
    await input('enterDoor');
    await until(frame, inside, `${renderer} Play interior`);
    await page.getByTitle('Stop the play preview').click();
    await expect(page.getByTitle('Start an isolated play preview')).toBeVisible({ timeout: 30_000 });
  }
  // The outlines as stored, untouched by the run's restyle.
  const after = ((await query('queryEntity', { entityId: built.architecture })) as { entity: { components: { architecture: unknown } } }).entity.components.architecture;
  expect(after).toEqual(built.outlines);

  // ---- The static export, served with the backend stopped, on each renderer.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(join(be.exportRoot, String(res.json['outputDir'])));
  try {
    for (const renderer of BACKENDS) {
      const game = await page.context().newPage();
      const errors: string[] = [];
      game.on('pageerror', (e) => errors.push(e.message));
      try {
        await game.goto(`${site.url}?renderer=${renderer}`);
        const c = game.locator('canvas').first();
        await expectRendererBackend(c, renderer);
        const shot = async (): Promise<Buffer> => c.screenshot();
        await until(shot, (img) => judgeLevel(img, built), `${renderer} export level`);
        const marks = await archTimes(game);
        console.log(`${renderer} export architecture: ${JSON.stringify(marks)}`);
        expect(marks.chunks, `${renderer} export: architecture chunks generated`).toBeGreaterThan(0);
        const box = (await c.boundingBox())!;
        await game.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await press(game, RESTYLE_KEY);
        await until(shot, restyled, `${renderer} export restyled`);
        await press(game, ENTER_KEY);
        await until(shot, inside, `${renderer} export interior`);
        expect(errors).toEqual([]);
      } finally {
        await game.close();
      }
    }
  } finally {
    await site.close();
  }
});
