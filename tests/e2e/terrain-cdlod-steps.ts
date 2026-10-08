/**
 * The terrain e2e's backend helpers, fixtures and checks (`terrain-cdlod.e2e.ts` runs them against its one backend,
 * handed over with `useBackend`): the terrain and its objects built through commands, the frame checks, the Play
 * walks and streaming, and the editor's terrain tools, rules and scatter driven through the page.
 */
import { randomBytes } from 'node:crypto';

import { expect, test, type Page } from './pw';

import { layeredMaterial, riverMaterial } from '../../packages/editor/src/session/material-graph';
import { controls, publishBytes, publishScript, type E2EBackend } from './backend';
import { multiPieceGlb } from './multi-piece-glb';
import { decodeChunkScatter } from '../../packages/project-model/src/scatter';
import { gpuAvailable } from './browser-env.mjs';
import { ALBEDO_HEIGHT_LAYERS, isBlue, isMagenta, isRed, materials, packNormalAndOrm, packTexture, publishLayerSources, publishTexture, useArrays, type Pred } from './painted-layers';
import { makePng } from './png-make';
import { decodePng, type Image } from './png';
import { closeEditor, editorPane, menu, openEditor, openWindow } from './ui';
import { expectRendererBackend } from './renderer-variants';
import { count, frameShareNear, meanDiff, projectWith, share, type CameraView, type V3 } from './frame-reading';


let be: E2EBackend | null = null;
/** The backend the helpers talk to (the test's; null after it stopped). */
export function useBackend(b: E2EBackend | null): void {
  be = b;
}

export async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
export async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-terrain-cdlod' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}
export type Observation = { state: string; stepIndex?: number; player?: { x: number; y: number; z: number } };
export type TerrainDiag = { tilesDrawn: number; draws: number; perLevel: number[]; errors: string[]; uploadMsPeak?: number; uploadBytesPeak?: number; tilesUploaded?: number; cpuBytes?: number; decodeMs?: number; packMs?: number; macro?: { baked: number; waiting: number; bakes: number; bakeMsTotal: number; bakeMs: number; farNodes: number; draws: number } };
export type Diagnostics = { renderer?: { terrain?: TerrainDiag }; runtime?: { terrainMemory?: { tiles: number; bytes: number; colliders: number; tilesWithColliders: number; lastBuild: { tiles: number; ms: number } | null; waiting: number } } };

export async function relay(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/play/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

/** The terrain: 8 × 8 tiles of 64 cells, 0.5 m apart, its object at (−128, 0, −128). */
export const TILES = 8;
export const CELLS = 64;
export const SPACING = 0.5;
export const ORIGIN: V3 = [-128, 0, -128];
export const RANGE: [number, number] = [-32, 96];
/**
 * Rolling bumps with rough ones on top, a few samples across (metres above the object; 0.1–4.1 m: over the
 * editor's grid, under its camera): each level's grid shows a different shape, so a level not morphed into the
 * next where they meet leaves a crack wide enough to see.
 */
export const heightAt = (x: number, z: number): number => 2.1 + 1.2 * Math.sin(x / 5) * Math.cos(z / 7) + 0.3 * Math.sin(x / 2.3 + z / 3.1) + 0.5 * Math.sin(x * 2.1) * Math.sin(z * 1.7);
export const PAINTED: [number, number] = [-6, -8];
export const HOLE: [number, number] = [2, -12];
export const PLAIN: [number, number] = [-3, 2];
export const SKY = '#00d8ff';
export const isSky: Pred = (r, g, b) => b > 150 && g > 120 && r < 70;
/** The fifth layer (index 4: past the template's four slots), painted in a disc here. */
export const FIFTH: [number, number] = [3, 6];
export const isYellow: Pred = (r, g, b) => r > 80 && g > 70 && b < 0.65 * g && Math.abs(r - g) < 0.3 * r;
/** The player's start (on a strip flattened to 2.1 m) and the way it walks (−z) into the hole. */
export const PLAYER: [number, number] = [2, -5];
export const STRIP_HEIGHT = 2.1;
/**
 * A ramp steeper than the bumps ever get (rising 11 m over 3 m toward −z, so it faces the cameras), with a disc
 * painted by hand on it; and a block layer of 4 × 3 × 2 cells, its wall facing +z and a steep top cell. The
 * slope rule paints both layer 3 (magenta).
 */
export const RAMP_X = -13;
export const RAMP: { from: V3; to: V3 } = { from: [RAMP_X, 1, -13], to: [RAMP_X, 10, -16] };
export const RAMP_DISC: [number, number] = [RAMP_X, -15.2];
export const RAMP_MID: [number, number] = [RAMP_X, -13.8];
export const STEEP_DEG = 62;
/** Left of the painted disc (in every camera's view), clear of the tools' strokes. */
export const BLOCKS_AT: V3 = [-16, 3, -9];
/** The bumps' steepest (on the 0.5 m grid) is about 51°: the rule's threshold is well past it. */
export const STEEP_RULE = { layer: 3, slope: { min: STEEP_DEG, fade: 2 } };
/** Past this (m) the ground draws its tiles' macro textures in Play and the export: most of the frame there. */
export const MACRO_DISTANCE = 30;
/** The 1,025² tile's terrain: far out of view (its uploads are what is measured). */
export const BIG_ORIGIN: V3 = [3000, 0, 3000];
/** The disc painted layer 2 (green) the scatter rules read (after the first renderer's tools), clear of the other checks and the strokes. */
export const GROVE: [number, number] = [-2, 10];
export const GROVE_RADIUS = 3.5;
/** The block terrace the block layer's scatter dresses: 4 × 2 × 4 cells, one sloped top. */
export const TERRACE_AT: V3 = [12, 3, 4];
/** The scatter rules' models: an orange post, a white tuft. */
export const isOrange: Pred = (r, g, b) => r > 110 && g > 0.3 * r && g < 0.75 * r && b < 0.35 * r;
export const isWhite: Pred = (r, g, b) => Math.min(r, g, b) > 140 && Math.max(r, g, b) - Math.min(r, g, b) < 45;
/** The posts' impostor size from the dialog: far smaller than they are on any screen here (meshes, until a Play sets 1). */
export const POST_IMPOSTOR_SIZE = 0.001;
/**
 * A road (a spline) along the grove's north edge: the ground flattened to 2.6 m under its 2 m width (fading over
 * 1.5 m), painted the fifth layer (yellow), scatter kept 1.5 m clear of it (the posts that would stand there).
 */
export const ROAD_AT: V3 = [0, 2.6, 13];
export const ROAD = { points: [{ at: [-7, 0, 0] }, { at: [-2, 0, 0] }, { at: [3, 0, 0] }], width: 2, terrain: { falloff: 1.5, paint: { layer: 4, falloff: 0.3 } }, scatter: { margin: 1.5 } };
/** Points on the road's middle the frames look at (clear of its ends and of its object's icon at its origin). */
export const ROAD_LOOK: readonly [number, number][] = [[-4.5, 13], [1.5, 13]];
/**
 * A river (a spline) east of the strip: its bed flattened 2 m below its points at the middle, banks at their height,
 * water 0.3 m under the banks (the river template, its colours made blue), and posts (the scatter's post model,
 * colliding) every 3 m along its west bank.
 */
export const RIVER_AT: V3 = [14, 2, 0];
export const RIVER = { points: [{ at: [0, 0, -20] }, { at: [1, 0, -12] }, { at: [0, 0, -4] }], width: 5, terrain: { shape: 'flatten', depth: 2, falloff: 2 }, scatter: { margin: 1 }, mesh: { kind: 'water', offset: -0.3, foam: 1 }, pieces: [{ asset: { assetId: 'e2e-post' }, spacing: 3, offset: [3.6, 0] }] };
/** A cone stamped beside the terrace (its side 16 m, 20 m high: flanks of 68°, past the slope rule's 62°), and the square eroded round it, clear of every other check. */
export const STAMP_AT: [number, number] = [22, 24];
export const STAMP_RADIUS = 8;
export const STAMP_HEIGHT = 20;
export const ERODE_RADIUS = 10;
/** On the river's middle, where the water is deepest. */
export const RIVER_LOOK: V3 = [15, RIVER_AT[1] - 0.3, -12];
/** Hides every scatter copy near the middle on the jump key, by address; shows them again on the next. */
export const SCATTER_HIDE_SCRIPT = [
  'export default {',
  '  instantiate() { return { hidden: [] }; },',
  '  step(state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent' || ctx.scatter === undefined || !ctx.input.pressed('jump')) return;",
  '    if (state.hidden.length === 0) {',
  '      for (const c of ctx.scatter.near([0, 0, 0], 200, { limit: 1024 })) if (ctx.scatter.hide(c.address)) state.hidden.push(c.address);',
  '    } else {',
  '      for (const a of state.hidden) ctx.scatter.show(a);',
  '      state.hidden = [];',
  '    }',
  '  },',
  '};',
].join('\n');

/**
 * World streaming (the impostors' Play and the export): the ground's render ring (it reaches at least 72 m, where its
 * 32 m tiles draw only their coarsest level, past which they are drawn from the overview), a 1 m collision ring (a
 * tile's collider is built only as a player comes within a metre of it), the block layers' render ring.
 */
export const STREAM = { render: 40, collision: 1, scatter: 200, hysteresis: 8 };
export const BLOCK_STREAM = { render: 60, hysteresis: 8 };
/** The camera's place in the scene (and in Play), and far from the terrain (its nearest tile 272 m off). */
export const CAM_AT: V3 = [0, ORIGIN[1] + 22, 40];
export const AWAY: V3 = [0, ORIGIN[1] + 22, 400];
/** A strip west from the player's start along z −5, across the tile border at x = 0. */
export const WEST_TO = -9;
/** Moves an object on the `place {id, x, y, z}` debug command (the camera, flown away and back), the player on `player {x, y, z}`. */
export const PLACE_SCRIPT = [
  'export default {',
  '  instantiate() { return {}; },',
  '  step(_state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  "    for (const c of ctx.debug.command('place', { description: 'Move an object', args: [{ name: 'id', type: 'string' }, { name: 'x', type: 'number' }, { name: 'y', type: 'number' }, { name: 'z', type: 'number' }] })) {",
  "      ctx.entity(String(c.id))?.set('transform', { position: [Number(c.x), Number(c.y), Number(c.z)] });",
  '    }',
  "    for (const c of ctx.debug.command('player', { description: 'Place the player', args: [{ name: 'x', type: 'number' }, { name: 'y', type: 'number' }, { name: 'z', type: 'number' }] })) {",
  "      ctx.emit({ kind: 'character_place', position: [Number(c.x), Number(c.y), Number(c.z)] });",
  '    }',
  // The ground under a few points (`xs` along z, from height y down) as ctx.surface reads it, one log line: [x, source, object, height, layers, weights] each.
  "    for (const c of ctx.debug.command('surface', { description: 'Read the ground', args: [{ name: 'seq', type: 'number' }, { name: 'xs', type: 'string' }, { name: 'y', type: 'number' }, { name: 'z', type: 'number' }] })) {",
  "      const out = String(c.xs).split(',').map(Number).map((x) => { const s = ctx.surface.at([x, Number(c.y), Number(c.z)]); return s === null ? [x] : [x, s.source[0], s.object.slice(-4), Math.round(s.height * 1000), s.layers.slice(0, 2), s.weights.slice(0, 2).map((w) => Math.round(w * 100))]; });",
  "      ctx.log('info', 'surface ' + JSON.stringify({ seq: Number(c.seq), out }));",
  '    }',
  '  },',
  '};',
].join('\n');
/**
 * The plaza: a block layer of 8 × 8 cells of 1 m (its corner on the terrain's 2 m overview grid), one row whose sloped
 * tops rise from 2 m at its −x edge to 3 m at its +x edge, painted layer 2 (blue) over the red ground, left of the
 * cameras' view and clear of every other check (with its blend round it). The terrain's blocks layer meets it.
 */
export const PLAZA_AT: V3 = [-28, 0, -4];
export const PLAZA_SIDE = 8;
export const PLAZA_BLEND = 4;
/** The plaza's top at world x (its tops rise 1/8 of a cell a cell along +x). */
export const plazaTop = (x: number): number => 2 + Math.min(1, Math.max(0, (x - PLAZA_AT[0]) / PLAZA_SIDE));
/** The most the ground's colour just outside the plaza may differ from the blocks' just inside (0–255 a channel): the mean over the points, the worst. */
export const SEAM_DELTA_MEAN = 12;
export const SEAM_DELTA_MAX = 18;
/** The most the colour on the plaza's border may differ from the mean of the two sides round it (a lit or dark line along it). */
export const SEAM_LINE_MAX = 10;
/** The far ground's mean luminance with its horizon light must be at least this much under the same frame's without (0–255); the near ground's within the other. */
export const HORIZON_FAR_DARKER = 0.3;
export const HORIZON_NEAR_SAME = 1;

/** The heightmap as RAW 16-bit little-endian samples of the terrain's range. */
export function heightmap(): Uint8Array {
  const side = TILES * CELLS + 1;
  const out = new Uint8Array(side * side * 2);
  const dv = new DataView(out.buffer);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const h = heightAt(ORIGIN[0] + i * SPACING, ORIGIN[2] + j * SPACING);
      dv.setUint16((j * side + i) * 2, Math.round(((h - RANGE[0]) / (RANGE[1] - RANGE[0])) * 65535), true);
    }
  }
  return out;
}

export async function stage(bytes: Uint8Array): Promise<string> {
  const headers = { authorization: `Bearer ${be!.token}`, origin: be!.origin };
  const base = `${be!.origin}/api/v1/projects/${be!.projectId}/content/stages`;
  const s = (await (await fetch(base, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).json()) as { stageId: string };
  const put = await fetch(`${base}/${s.stageId}/bytes`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) }, body: bytes });
  expect(put.status).toBe(200);
  return s.stageId;
}

export async function buildTerrain(): Promise<{ ground: string; big: string; blocks: string; terrace: string; road: string; plaza: string }> {
  await cmd('setSettings', { settings: { camera_far_m: 400 } });
  for (const id of ['model-0001', 'spawn-0001', 'box-0001', 'box-0002', 'box-0003', 'box-0004', 'model-0002']) await cmd('deleteEntity', { entityId: id }).catch(() => undefined);
  // The arrays (through the pack route) and the layered template, made as the Materials tab makes it.
  await publishLayerSources(be!);
  await publishTexture(be!, new Uint8Array(makePng(16, 16, () => [230, 200, 40, 255])), 'alb-5', 'Albedo 5');
  await publishTexture(be!, new Uint8Array(makePng(16, 16, () => [230, 230, 230, 255])), 'hgt-5', 'Height 5');
  await packNormalAndOrm(be!);
  // Layer 3 (magenta, the slope rule's) a checker of two magentas: how its projection lies on the steep ramp shows.
  await publishTexture(be!, new Uint8Array(makePng(16, 16, (x, y) => (((x >> 3) + (y >> 3)) % 2 === 0 ? [230, 40, 230, 255] : [140, 24, 140, 255]))), 'alb-4c', 'Albedo 4 checker');
  const checker = [{ assetId: 'alb-4c', channel: 'r' as const }, { assetId: 'alb-4c', channel: 'g' as const }, { assetId: 'alb-4c', channel: 'b' as const }, ALBEDO_HEIGHT_LAYERS[3]![3]!];
  const five = [...ALBEDO_HEIGHT_LAYERS.slice(0, 3), checker, [{ assetId: 'alb-5', channel: 'r' as const }, { assetId: 'alb-5', channel: 'g' as const }, { assetId: 'alb-5', channel: 'b' as const }, { assetId: 'hgt-5', channel: 'r' as const }]];
  await packTexture(be!, five, 'color', 'terrain-albedo');
  // The stamp's shape: a cone (white at its centre, black at its rim).
  await publishTexture(be!, new Uint8Array(makePng(64, 64, (x, y) => {
    const v = Math.round(Math.max(0, 1 - Math.hypot(x - 31.5, y - 31.5) / 31.5) * 255);
    return [v, v, v, 255];
  })), 'e2e-cone', 'Cone');
  const mat = layeredMaterial('mat-terrain', 'Terrain layers');
  await cmd('setMaterial', { material: mat });
  await useArrays(be!, 'mat-terrain', { albedoHeight: 'terrain-albedo', normals: 'terrain-normals', orm: 'terrain-orm' });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: SKY } } });
  // 22 m over the terrain, looking down at 45° along −z: the sky out of frame, 22–85 m of ground in view.
  const pitch = (-45 * Math.PI) / 180;
  await cmd('setTransform', { entityId: 'cam-main', transform: { position: CAM_AT, rotation: [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)] } });
  const ground = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Ground', transform: { position: ORIGIN } }))['createdId']);
  const tiles: { x: number; z: number }[] = [];
  for (let z = 0; z < TILES; z++) for (let x = 0; x < TILES; x++) tiles.push({ x, z });
  await cmd('setComponent', { entityId: ground, component: 'terrain', value: { tileSamples: CELLS + 1, spacing: SPACING, heightRange: RANGE, tiles } });
  await cmd('setComponent', { entityId: ground, component: 'materials', value: { '*': 'mat-terrain' } });
  await cmd('editTerrain', { entityId: ground, kind: 'import', stageId: await stage(heightmap()), format: 'raw16', at: [0, 0] });
  await cmd('editTerrain', { entityId: ground, kind: 'paint', dabs: [PAINTED], radius: 4, strength: 1, falloff: 'constant', layer: 2 });
  await cmd('editTerrain', { entityId: ground, kind: 'paint', dabs: [FIFTH], radius: 2.5, strength: 1, falloff: 'constant', layer: 4 });
  // The models the scatter rules place, and the terrace a block layer's scatter dresses.
  await publishBytes(be!, multiPieceGlb([{ name: 'post', lods: [[0.3, 1.4, 0.3]], col: [0.3, 1.4, 0.3], colors: [[1, 0.35, 0.02]] }]), 'model', 'e2e-post', 'Post');
  await publishBytes(be!, multiPieceGlb([{ name: 'tuft', lods: [[0.3, 0.5, 0.3]], colors: [[1, 1, 1]] }]), 'model', 'e2e-tuft', 'Tuft');
  const terrace = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Terrace', transform: { position: TERRACE_AT } }))['createdId']);
  await cmd('setComponent', { entityId: terrace, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [4, 4, 4] } } });
  // A strip the player walks along into the hole: flat (the bumps are steeper than it climbs).
  const strip: [number, number][] = [];
  for (let z = PLAYER[1] + 2; z >= HOLE[1] + 1; z -= 1) strip.push([PLAYER[0], z]);
  await cmd('editTerrain', { entityId: ground, kind: 'flatten', dabs: strip, radius: 2.5, strength: 1, falloff: 'constant', height: STRIP_HEIGHT });
  // And one west across the tile border at x = 0 (the streamed Play walks it).
  const west: [number, number][] = [];
  for (let x = PLAYER[0]; x >= WEST_TO - 1; x -= 1) west.push([x, PLAYER[1]]);
  await cmd('editTerrain', { entityId: ground, kind: 'flatten', dabs: west, radius: 1.5, strength: 1, falloff: 'constant', height: STRIP_HEIGHT });
  // The steep ramp with a hand-painted disc (layer 2, blue) on it, and the block layer (the rules come later, from the editor).
  await cmd('editTerrain', { entityId: ground, kind: 'ramp', from: RAMP.from, to: RAMP.to, radius: 1.5, strength: 1, falloff: 'constant' });
  await cmd('editTerrain', { entityId: ground, kind: 'paint', dabs: [RAMP_DISC], radius: 0.5, strength: 1, falloff: 'constant', layer: 2 });
  await cmd('setBlockType', { block: { blockId: 'rock', name: 'Rock', variants: [{ color: '#808080' }], shape: 'full', materials: { '*': 'mat-terrain' } } });
  const blocks = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Blocks', transform: { position: BLOCKS_AT } }))['createdId']);
  await cmd('setComponent', { entityId: blocks, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [4, 4, 2] } } });
  await cmd('editBlocks', { entityId: blocks, edits: [{ kind: 'fill', box: [0, 0, 0, 4, 3, 2], cell: { block: 'rock' } }, { kind: 'cells', at: [1, 3, 0], cell: { block: 'rock', corners: [3, 3, 0, 0] } }] });
  // A 3D game with a player on the strip (its capsule's 0.9 m half height over the ground).
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  const player = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Player', transform: { position: [PLAYER[0], STRIP_HEIGHT + 0.95, PLAYER[1]] } }))['createdId']);
  await cmd('setComponent', { entityId: player, component: 'controller', value: {} });
  // One 1,025² tile of noise, far out of view.
  const big = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Far', transform: { position: BIG_ORIGIN } }))['createdId']);
  await cmd('setComponent', { entityId: big, component: 'terrain', value: { tileSamples: 1025, spacing: 1, heightRange: [-64, 64], tiles: [{ x: 0, z: 0 }] } });
  await bigNoise(big, 7);
  await cmd('editBlocks', { entityId: terrace, edits: [{ kind: 'fill', box: [0, 0, 0, 4, 2, 4], cell: { block: 'rock' } }, { kind: 'cells', at: [0, 1, 0], cell: { block: 'rock', corners: [0, 1, 1, 0] } }] });
  // The plaza: column strips whose corners rise 1/8 a cell along +x (2 m to 3 m over the row's cell).
  const plaza = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Plaza', transform: { position: PLAZA_AT } }))['createdId']);
  await cmd('setComponent', { entityId: plaza, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [PLAZA_SIDE, 4, PLAZA_SIDE] } } });
  await cmd('editBlocks', { entityId: plaza, edits: Array.from({ length: PLAZA_SIDE }, (_, i) => ({ kind: 'fill', box: [i, 0, 0, i + 1, 1, PLAZA_SIDE], cell: { block: 'rock', corners: [2 + i / 8, 2 + (i + 1) / 8, 2 + (i + 1) / 8, 2 + i / 8] } })) });
  // Its tops painted layer 2 (blue): the ground round it takes the paint across the border.
  await cmd('editBlocks', { entityId: plaza, edits: [{ kind: 'paint', at: [PLAZA_SIDE / 2, PLAZA_SIDE / 2], radius: PLAZA_SIDE, strength: 1, falloff: 'constant', channel: 2 }] });
  // The script that names the scatter copies by address and hides them on the jump key (shows them on the next).
  const switcher = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Scatter switch', transform: { position: [0, 0, 0] } }))['createdId']);
  await publishScript(be!, 'e2e-scatter-hide', SCATTER_HIDE_SCRIPT, switcher);
  const placer = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Placer', transform: { position: [0, 0, 0] } }))['createdId']);
  await publishScript(be!, 'e2e-place', PLACE_SCRIPT, placer);
  // The road: its object placed, then its spline — the same command shapes the terrain under it.
  const road = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Road', transform: { position: ROAD_AT } }))['createdId']);
  const made = await cmd('setComponent', { entityId: road, component: 'spline', value: ROAD });
  expect((made['change'] as { follows?: { entityId: string; component: string }[] }).follows?.map((f) => `${f.entityId}:${f.component}`), 'the terrain shaped in the same command').toEqual([`${ground}:terrain`]);
  // The river: its water wears the river template (deep and shallow colours blue), its mesh and posts made by the backend.
  const river = riverMaterial('mat-river', 'River');
  await cmd('setMaterial', { material: { ...river, parameters: river.parameters!.map((p) => (p.key === 'deepColor' || p.key === 'shallowColor' ? { ...p, default: '#1838ff' } : p)) } });
  const riverId = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'River', transform: { position: RIVER_AT } }))['createdId']);
  const flowing = await cmd('setComponent', { entityId: riverId, component: 'spline', value: RIVER });
  expect((flowing['change'] as { follows?: { entityId: string; component: string }[] }).follows?.map((f) => `${f.entityId}:${f.component}`).sort(), 'the terrain shaped and the river\'s mesh and posts made in the same command').toEqual([`${ground}:terrain`, `${riverId}:spline`].sort());
  await cmd('setComponent', { entityId: riverId, component: 'materials', value: { spline: 'mat-river' } });
  return { ground, big, blocks, terrace, road, plaza };
}


/**
 * The road on the terrain: flattened to its height and painted under it, no post within its scatter band (read back
 * from the stored tiles and copies); with a frame, yellow where the camera sees its middle, no post on it.
 */
export async function expectRoad(ground: string | null, what: string, frame?: { img: Image; cam: CameraView }): Promise<void> {
  if (ground === null) return expectRoadPixels(what, frame!);
  const pts = ((await query('queryTerrain', { entityId: ground, points: ROAD_LOOK.map(([x, z]) => [x, z]) }))['points'] as { height: number; layers: number[] }[]);
  for (const p of pts) {
    expect(p.height, `${what}: the road flattened to its height`).toBeCloseTo(ROAD_AT[1], 2);
    expect(p.layers[0], `${what}: the road painted the fifth layer`).toBe(4);
  }
  type Copy = { rule: string; x: number; z: number };
  const band = (((await query('queryTerrain', { entityId: ground, scatter: { box: [-8, ROAD_AT[2] - 4, 4, ROAD_AT[2] + 4] } }))['scatter'] as { copies: Copy[] } | undefined)?.copies ?? []);
  expect(band.filter((c) => Math.abs(c.z - ROAD_AT[2]) < 2.4 && c.x > -7 && c.x < 3), `${what}: no post on the road's band`).toEqual([]);
  if (frame !== undefined) expectRoadPixels(what, frame);
}

/** The road in a frame: yellow where the camera sees its middle, no post on it. */
export function expectRoadPixels(what: string, frame: { img: Image; cam: CameraView }): void {
  for (const [x, z] of ROAD_LOOK) {
    expect(frameShareNear(frame.img, frame.cam, [x, ROAD_AT[1], z], isYellow), `${what}: the road yellow at (${x}, ${z})`).toBeGreaterThan(0.5);
    expect(frameShareNear(frame.img, frame.cam, [x, ROAD_AT[1], z], isOrange), `${what}: no post on the road at (${x}, ${z})`).toBe(0);
  }
}

/** The river in a frame: blue water over its deepest part. */
export function expectRiver(img: Image, cam: CameraView, what: string): void {
  expect(frameShareNear(img, cam, RIVER_LOOK, isBlue), `${what}: the river's water`).toBeGreaterThan(0.5);
}

/**
 * The road's Scene-view handle (first renderer): a point dragged across the ground is one command that moves the
 * road and shapes the terrain again (flattened at the point's new place); one undo puts it back.
 */
export async function roadHandle(page: Page, ground: string, road: string): Promise<void> {
  type Grip = { component: string; kind: string; handle: string; x: number; y: number };
  const height = async (x: number, z: number): Promise<number> => ((await query('queryTerrain', { entityId: ground, points: [[x, z]] }))['points'] as { height: number }[])[0]!.height;
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${road}"]`).click();
  await page.keyboard.press('f');
  const gripOf = async (handle: string): Promise<Grip | undefined> => (JSON.parse((await page.locator('canvas[data-size-handles]').getAttribute('data-size-handles')) ?? '[]') as Grip[]).find((g) => g.component === 'spline' && g.kind === 'spline' && g.handle === handle);
  await expect.poll(async () => (await gripOf('p2')) !== undefined, { timeout: 30_000, message: 'the road\'s point grips' }).toBe(true);
  // Close enough that the point's grips (its height, width and tangent beside it) are apart on screen.
  const box = (await viewport(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 30; i++) {
    const [a, b] = [await gripOf('p0'), await gripOf('p2')];
    if (a !== undefined && b !== undefined && Math.hypot(a.x - b.x, a.y - b.y) > 300) break;
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(400);
  const g = (await gripOf('p2'))!;
  const rev0 = Number((await query('queryProject')).revision);
  const oldEnd: [number, number] = [ROAD_AT[0] + 2.5, ROAD_AT[2]];
  expect(await height(...oldEnd)).toBeCloseTo(ROAD_AT[1], 2);
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(g.x, g.y + (90 * i) / 8);
  await page.mouse.up();
  await expect.poll(async () => Number((await query('queryProject')).revision), { timeout: 30_000, message: 'the drag stored' }).toBe(rev0 + 1);
  const moved = ((await query('queryEntity', { entityId: road })) as { entity: { components: { spline: { points: { at: number[] }[] } } } }).entity.components.spline.points[2]!.at;
  expect(Math.hypot(moved[0]! - 3, moved[2]!), 'the point moved across the ground').toBeGreaterThan(1);
  expect(moved[1], 'its height kept').toBe(0);
  const newEnd: [number, number] = [ROAD_AT[0] + moved[0]!, ROAD_AT[2] + moved[2]!];
  expect(await height(...newEnd), 'the ground flattened where the point went').toBeCloseTo(ROAD_AT[1], 2);
  test.info().annotations.push({ type: 'road handle', description: JSON.stringify({ from: [3, 0, 0], to: moved, oldEndHeight: await height(...oldEnd) }) });
  console.log(`road handle: p2 dragged from [3, 0, 0] to ${JSON.stringify(moved)}, one command; the ground flattened there`);
  await cmd('undo', {});
  await expect.poll(async () => ((await query('queryEntity', { entityId: road })) as { entity: { components: { spline: { points: { at: number[] }[] } } } }).entity.components.spline.points[2]!.at, { timeout: 30_000, message: 'undone: the road back' }).toEqual([3, 0, 0]);
  await expect.poll(() => height(...oldEnd), { timeout: 30_000, message: 'undone: the ground flattened at the old end again' }).toBeCloseTo(ROAD_AT[1], 2);
  await selectEntity(page, ground);
}

export type TerrainLayerValue = { id: string; kind: string; enabled?: boolean; stamps?: unknown[]; tiles?: unknown[]; blockLayers?: string[]; mode?: string; blend?: number };
export const layersOf = async (ground: string): Promise<TerrainLayerValue[]> => (((await query('queryEntity', { entityId: ground })) as { entity: { components: { terrain: { layers?: TerrainLayerValue[] } } } }).entity.components.terrain.layers ?? []);

/**
 * The edit layers in the Scene view (see the file's head). `viaEditor`: the stamp placed, the square eroded and the
 * erosion switched with the editor's tools; else the layers made on the first renderer are switched on by command.
 * Each layer's picture on and off around the mountain; the layers are left off (Play and the export as before).
 */
export async function editLayers(page: Page, renderer: string, ground: string, road: string, viaEditor: boolean, plaza: string): Promise<void> {
  const height = async (x: number, z: number): Promise<number> => ((await query('queryTerrain', { entityId: ground, points: [[x, z]] }))['points'] as { height: number }[])[0]!.height;
  const revision = async (): Promise<number> => Number((await query('queryProject')).revision);
  const switchTo = async (on: Record<string, boolean>): Promise<void> => {
    const layers = await layersOf(ground);
    await cmd('setComponent', { entityId: ground, component: 'terrain', value: { layers: layers.map((l) => (on[l.id] === undefined ? l : { ...(({ enabled: _e, ...rest }) => rest)(l), ...(on[l.id] ? {} : { enabled: false }) })) } });
  };
  // The hand-made ground there (the layers off), then the layers this pass looks at.
  const handMade = await height(...STAMP_AT);
  if (!viaEditor) await switchTo({ stamps: true, erosion: true });
  const centre: V3 = [STAMP_AT[0], handMade + (viaEditor ? 0 : STAMP_HEIGHT / 2), STAMP_AT[1]];
  const look: V3 = [STAMP_AT[0], handMade + STAMP_HEIGHT / 2, STAMP_AT[1]];
  const corners: V3[] = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([dx, dz]) => [STAMP_AT[0] + dx! * ERODE_RADIUS, handMade, STAMP_AT[1] + dz! * ERODE_RADIUS]);
  const figures: Record<string, unknown> = {};
  // The view framed on the road (beside the mountain), then the terrain's tools.
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${road}"]`).click();
  await page.keyboard.press('f');
  await page.waitForTimeout(400);
  await selectEntity(page, ground);
  await zoomedOutTo(page, [centre, ...corners, [STAMP_AT[0], handMade + STAMP_HEIGHT, STAMP_AT[1]]], async () => {
    if (viaEditor) {
      await terrainPanel(page).getByRole('button', { name: /^Layers/ }).click();
      const list = terrainPanel(page).getByRole('group', { name: 'terrain layers' });
      await terrainTool(page, 'Stamp').click();
      const opts = terrainPanel(page).getByRole('group', { name: 'stamp options' });
      await opts.getByLabel('stamp heightmap', { exact: true }).selectOption('e2e-cone');
      await opts.getByLabel('stamp height', { exact: true }).fill(String(STAMP_HEIGHT));
      await opts.getByLabel('stamp falloff', { exact: true }).fill('0');
      await setNumber(page, 'terrain radius', STAMP_RADIUS);
      // One click: one command — the stamps layer made with the stamp, the ground combined again under it.
      const rev0 = await revision();
      const at = await screenOf(page, centre);
      const t0 = Date.now();
      await page.mouse.click(at.x, at.y);
      await expect.poll(revision, { timeout: 30_000, message: 'the stamp stored' }).toBe(rev0 + 1);
      figures['stampMs'] = Date.now() - t0;
      const [layer] = await layersOf(ground);
      expect(layer, 'a stamps layer with the stamp').toMatchObject({ id: 'stamps', kind: 'stamps', stamps: [{ asset: 'e2e-cone', size: 2 * STAMP_RADIUS, height: STAMP_HEIGHT }] });
      // The cone's centre is where the brush stood; its top 20 m over the ground there.
      const st = (layer!.stamps![0] as { at: [number, number] }).at;
      expect(Math.hypot(st[0] - STAMP_AT[0], st[1] - STAMP_AT[1]), 'the stamp where it was clicked').toBeLessThan(0.6);
      expect((await height(...st)) - handMade, 'the mountain\'s top').toBeGreaterThan(STAMP_HEIGHT - 1.5);
      await expect(list.getByRole('listitem', { name: 'layer stamps' })).toBeVisible();
      // The steep flanks painted by the slope rule, baked again after the stamp (on the side the view sees).
      await expect.poll(async () => {
        let best = 0;
        for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          const p: [number, number] = [STAMP_AT[0] + (dx * STAMP_RADIUS) / 2, STAMP_AT[1] + (dz * STAMP_RADIUS) / 2];
          best = Math.max(best, await shareNear(page, [p[0], await height(...p), p[1]], isMagenta, 6));
        }
        return (figures['flankMagenta'] = best);
      }, { timeout: 30_000, message: `${renderer} Scene view: the stamped mountain's steep flanks painted by the rules` }).toBeGreaterThan(0.5);
      // The Erode tool: the square round the mountain, one command (eroded on the backend's worker).
      await terrainTool(page, 'Erode').click();
      const erodeOpts = terrainPanel(page).getByRole('group', { name: 'erode options' });
      await erodeOpts.getByLabel('erode droplets', { exact: true }).fill('2');
      await erodeOpts.getByLabel('erode passes', { exact: true }).fill('20');
      await setNumber(page, 'terrain radius', ERODE_RADIUS);
      const probe: [number, number] = [STAMP_AT[0] + STAMP_RADIUS / 2, STAMP_AT[1]];
      const stamped = await height(...probe);
      const rev1 = await revision();
      const t1 = Date.now();
      await page.mouse.click(at.x, at.y);
      await expect.poll(revision, { timeout: 60_000, message: 'the erosion stored' }).toBe(rev1 + 1);
      figures['erodeMs'] = Date.now() - t1;
      const erosion = (await layersOf(ground)).find((l) => l.kind === 'erosion');
      expect(erosion?.id).toBe('erosion');
      expect(erosion!.tiles!.length, 'the eroded tiles').toBeGreaterThan(0);
      const eroded = await height(...probe);
      expect(eroded, 'the flank eroded').not.toBe(stamped);
      // The Layers list: the erosion off (the stamped flank back), and on again.
      await list.getByLabel('layer erosion on', { exact: true }).click();
      await expect.poll(() => height(...probe), { timeout: 30_000, message: 'erosion off' }).toBe(stamped);
      // The switch shows the stored state (it follows the command's result).
      await expect(list.getByLabel('layer erosion on', { exact: true })).not.toBeChecked();
      await list.getByLabel('layer erosion on', { exact: true }).click();
      await expect.poll(() => height(...probe), { timeout: 30_000, message: 'erosion on' }).toBe(eroded);
      await blocksLayer(list, ground, plaza);
      await terrainTool(page, 'Raise').click();
      await terrainPanel(page).getByRole('button', { name: /^Layers/ }).click();
    }
    // The pictures with the layers on, then each layer off: the channels, then the mountain, leave the frame.
    // The square round the eroded area as the view sees it (whatever the zoom).
    const span = await Promise.all([...corners, [STAMP_AT[0], handMade + STAMP_HEIGHT, STAMP_AT[1]] as V3].map((c) => screenOf(page, c)));
    const size = Math.max(48, Math.round(Math.max(Math.max(...span.map((q) => q.x)) - Math.min(...span.map((q) => q.x)), Math.max(...span.map((q) => q.y)) - Math.min(...span.map((q) => q.y)))));
    figures['shotPx'] = size;
    await page.waitForTimeout(500);
    const on = await shot(page, look, size);
    let diff = 0;
    await switchTo({ erosion: false });
    await expect.poll(async () => (diff = meanDiff(on, await shot(page, look, size))), { timeout: 30_000, message: `${renderer} Scene view: erosion off changes the mountain` }).toBeGreaterThan(3);
    figures['erosionOnOff'] = diff;
    await page.waitForTimeout(500);
    const noErosion = await shot(page, look, size);
    await switchTo({ stamps: false });
    await expect.poll(async () => (diff = meanDiff(noErosion, await shot(page, look, size))), { timeout: 30_000, message: `${renderer} Scene view: the mountain gone` }).toBeGreaterThan(8);
    figures['stampOnOff'] = diff;
  });
  test.info().annotations.push({ type: `${renderer} edit layers`, description: JSON.stringify(figures) });
  console.log(`${renderer} edit layers: ${JSON.stringify(figures)}`);
  expect(await height(...STAMP_AT), 'the layers off: the hand-made ground').toBe(handMade);
}

/**
 * The blocks layer through the Layers list (first renderer): added (one command: the ground meets every block layer),
 * its blend set, flattened and cut again; then narrowed to the plaza by command (the list has no picker); the plaza's
 * border, the cut under it and the texture origin read back.
 */
export async function blocksLayer(list: ReturnType<Page['getByRole']>, ground: string, plaza: string): Promise<void> {
  const revision = async (): Promise<number> => Number((await query('queryProject')).revision);
  const at = async (x: number, z: number): Promise<{ height: number | null; hole: boolean }> => ((await query('queryTerrain', { entityId: ground, points: [[x, z]] }))['points'] as { height: number | null; hole: boolean }[])[0]!;
  const centre: [number, number] = [PLAZA_AT[0] + PLAZA_SIDE / 2, PLAZA_AT[2] + PLAZA_SIDE / 2];
  const edge: [number, number] = [PLAZA_AT[0] + PLAZA_SIDE / 2, PLAZA_AT[2] + PLAZA_SIDE];
  const figures: Record<string, unknown> = { before: await at(...edge) };
  const rev0 = await revision();
  await list.getByLabel('add blocks layer', { exact: true }).click();
  await expect.poll(revision, { timeout: 30_000, message: 'the blocks layer stored' }).toBe(rev0 + 1);
  expect((await layersOf(ground)).find((l) => l.kind === 'blocks'), 'a blocks layer meeting every block layer').toEqual({ id: 'blocks', kind: 'blocks' });
  await expect(list.getByRole('listitem', { name: 'layer blocks' })).toBeVisible();
  // The plaza's border is its tops' height there, the cells under it cut away.
  await expect.poll(async () => (await at(...edge)).height ?? 0, { timeout: 30_000, message: 'the ground meets the plaza\'s border' }).toBeCloseTo(plazaTop(edge[0]), 2);
  expect(await at(...centre), 'cut away under the plaza').toMatchObject({ height: null, hole: true });
  // The blend through the list.
  const blend = list.getByLabel('layer blocks blend', { exact: true });
  await blend.fill(String(PLAZA_BLEND));
  await blend.blur();
  await expect.poll(async () => (await layersOf(ground)).find((l) => l.kind === 'blocks')?.blend, { timeout: 30_000, message: 'the blend stored' }).toBe(PLAZA_BLEND);
  // Flatten: whole ground just under the blocks; cut again.
  await list.getByLabel('layer blocks mode', { exact: true }).selectOption('flatten');
  await expect.poll(async () => (await at(...centre)).hole, { timeout: 30_000, message: 'flattened: no hole under the plaza' }).toBe(false);
  figures['flattened'] = await at(...centre);
  expect((await at(...centre)).height!, 'flattened just under the plaza').toBeCloseTo(plazaTop(centre[0]) - 0.02, 2);
  await list.getByLabel('layer blocks mode', { exact: true }).selectOption('cut');
  await expect.poll(async () => (await at(...centre)).hole, { timeout: 30_000, message: 'cut away again' }).toBe(true);
  // Narrowed to the plaza: the other block areas' ground as it was made by hand.
  await cmd('setComponent', { entityId: ground, component: 'terrain', value: { layers: (await layersOf(ground)).map((l) => (l.kind === 'blocks' ? { ...l, blockLayers: [plaza] } : l)) } });
  expect(await at(...edge)).toMatchObject({ hole: false });
  expect((await at(...edge)).height!).toBeCloseTo(plazaTop(edge[0]), 2);
  const comp = ((await query('queryEntity', { entityId: ground })) as { entity: { components: { terrain: { uvOrigin?: number[] } } } }).entity.components.terrain;
  expect(comp.uvOrigin, 'the terrain\'s textures count from the plaza\'s origin').toEqual([PLAZA_AT[0], PLAZA_AT[2]]);
  test.info().annotations.push({ type: 'blocks layer', description: JSON.stringify(figures) });
}

/**
 * The plaza's seam in a frame: the sky nowhere round it (no crack); the ground's colour just outside each border
 * point against the blocks' just inside, and on the border itself against the two (a line along the seam: a lit
 * edge, a dark rim) — the mean of a small square each. Returns the figures.
 */
export function seamFigures(img: Image, cam: CameraView, outside: readonly { p: V3; q: V3; b: V3 }[]): { sky: number; deltas: number[]; mean: number; max: number; line: number[]; lineMax: number } {
  // The plaza and its blend, as the frame sees it.
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([dx, dz]) => projectWith(cam, img.width / img.height, [PLAZA_AT[0] + PLAZA_SIDE / 2 + (dx! * (PLAZA_SIDE + 2)) / 2, 2.5, PLAZA_AT[2] + PLAZA_SIDE / 2 + (dz! * (PLAZA_SIDE + 2)) / 2]));
  let sky = 0;
  if (corners.every((c) => c !== null)) {
    const xs = corners.map((c) => c![0] * img.width);
    const ys = corners.map((c) => c![1] * img.height);
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y < Math.min(img.height, Math.ceil(Math.max(...ys))); y++)
      for (let x = Math.max(0, Math.floor(Math.min(...xs))); x < Math.min(img.width, Math.ceil(Math.max(...xs))); x++) if (isSky(...img.pixel(x, y))) sky += 1;
  }
  const meanAt = (p: V3): [number, number, number] | null => {
    const uv = projectWith(cam, img.width / img.height, p);
    if (uv === null) return null;
    const cx = Math.round(uv[0] * img.width);
    const cy = Math.round(uv[1] * img.height);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const px = img.pixel(x, y);
      r += px[0];
      g += px[1];
      b += px[2];
      n += 1;
    }
    return n === 0 ? null : [r / n, g / n, b / n];
  };
  const deltas: number[] = [];
  const line: number[] = [];
  for (const { p, q, b } of outside) {
    const a = meanAt(p);
    const c = meanAt(q);
    const m = meanAt(b);
    if (a === null || c === null || m === null) continue;
    deltas.push((Math.abs(a[0] - c[0]) + Math.abs(a[1] - c[1]) + Math.abs(a[2] - c[2])) / 3);
    line.push((Math.abs(m[0] - (a[0] + c[0]) / 2) + Math.abs(m[1] - (a[1] + c[1]) / 2) + Math.abs(m[2] - (a[2] + c[2]) / 2)) / 3);
  }
  const r = (d: number): number => Math.round(d * 10) / 10;
  return { sky, deltas: deltas.map(r), mean: deltas.reduce((x, y) => x + y, 0) / Math.max(1, deltas.length), max: Math.max(0, ...deltas), line: line.map(r), lineMax: Math.max(0, ...line) };
}

/**
 * Points in pairs across the plaza's border (the +z side facing the cameras and the ±x sides): 0.6 m inside on its
 * tops, 0.6 m outside on the ground (heights read from the stored terrain).
 */
export async function seamPoints(ground: string): Promise<{ p: V3; q: V3; b: V3 }[]> {
  const [x0, , z0] = PLAZA_AT;
  const x1 = x0 + PLAZA_SIDE;
  const z1 = z0 + PLAZA_SIDE;
  const d = 0.6;
  const pairs: [[number, number], [number, number], [number, number]][] = [];
  for (const x of [x0 + 1.5, x0 + 3.5, x0 + 5.5, x0 + 6.5]) pairs.push([[x, z1 - d], [x, z1 + d], [x, z1]]);
  for (const z of [z0 + 4, z0 + 6.5]) {
    pairs.push([[x0 + d, z], [x0 - d, z], [x0, z]]);
    pairs.push([[x1 - d, z], [x1 + d, z], [x1, z]]);
  }
  const out: { p: V3; q: V3; b: V3 }[] = [];
  for (const [inside, outsideAt, on] of pairs) out.push({ p: [inside[0], plazaTop(inside[0]), inside[1]], q: await surface(ground, ...outsideAt), b: [on[0], plazaTop(on[0]), on[1]] });
  return out;
}

/** The seam's figures asserted (and logged). */
export function expectSeam(img: Image, cam: CameraView, pts: readonly { p: V3; q: V3; b: V3 }[], what: string): void {
  const f = seamFigures(img, cam, pts);
  test.info().annotations.push({ type: `${what} seam`, description: JSON.stringify(f) });
  console.log(`${what} seam: ${JSON.stringify(f)}`);
  expect(f.deltas.length, `${what}: the seam's points in the frame`).toBe(pts.length);
  expect(f.sky, `${what}: sky round the plaza (a crack at the seam)`).toBe(0);
  expect(f.mean, `${what}: the ground's colour outside the seam against the blocks' inside (mean of the points, 0–255)`).toBeLessThan(SEAM_DELTA_MEAN);
  expect(f.max, `${what}: the ground's colour outside the seam against the blocks' inside (the worst point)`).toBeLessThan(SEAM_DELTA_MAX);
  expect(f.lineMax, `${what}: the colour on the seam against the two sides (a line along it)`).toBeLessThan(SEAM_LINE_MAX);
}

/**
 * A band of posts put by hand across the player's strip behind it (the brush's stroke, as a command: every candidate
 * under it, whatever the conditions), three rows too close for the player to walk between; or taken off again (the
 * Scene view's tools then see the ground there). Returns the band's z range.
 */
export async function postBand(ground: string, on: boolean): Promise<[number, number]> {
  type Copy = { rule: string; x: number; y: number; z: number };
  const dabs: [number, number][] = [];
  for (const z of [-3.4, -2.6, -1.8]) for (let x = PLAYER[0] - 1.5; x <= PLAYER[0] + 1.5; x += 0.5) dabs.push([x, z]);
  await cmd('editTerrain', { entityId: ground, kind: 'scatter', rule: 'posts', dabs, radius: 0.5, ...(on ? {} : { erase: true }) });
  const band = (((await query('queryTerrain', { entityId: ground, scatter: { box: [PLAYER[0] - 2.5, -4.2, PLAYER[0] + 2.5, -1] } }))['scatter'] as { copies: Copy[] } | undefined)?.copies ?? []);
  if (!on) {
    expect(band.length, 'the band taken off').toBe(0);
    return [0, 0];
  }
  expect(band.length, 'posts across the strip').toBeGreaterThan(8);
  return [Math.min(...band.map((c) => c.z)), Math.max(...band.map((c) => c.z))];
}

/** The posts rule's impostor size (the rules baked again: the same copies). */
export async function setPostsImpostor(ground: string, size: number): Promise<void> {
  const rules = (((await query('queryEntity', { entityId: ground })) as { entity: { components: { terrain: { scatter: Record<string, unknown>[] } } } }).entity.components.terrain.scatter);
  await cmd('editTerrain', { entityId: ground, kind: 'bake', scatter: rules.map((r) => (r['id'] === 'posts' ? { ...r, impostorSize: size } : r)) });
}

/** Noise over the whole 1,025² tile (a new tile: read, packed and uploaded again). */
export async function bigNoise(big: string, seed: number): Promise<void> {
  await cmd('editTerrain', { entityId: big, kind: 'noise', dabs: [[BIG_ORIGIN[0] + 512, BIG_ORIGIN[2] + 512]], radius: 800, strength: 4, falloff: 'constant', scale: 16, seed });
}

/** World point of the terrain's surface at (x, z) (the stored heights). */
export async function surface(ground: string, x: number, z: number): Promise<V3> {
  const h = ((await query('queryTerrain', { entityId: ground, points: [[x, z]] }))['points'] as { height: number | null }[])[0]!.height;
  return [x, h ?? ORIGIN[1] + heightAt(x, z), z];
}

export const viewport = (page: Page) => page.locator('.tl-viewport');
export async function screenOf(page: Page, p: V3): Promise<{ x: number; y: number }> {
  const m = JSON.parse((await viewport(page).getAttribute('data-view-proj'))!) as number[];
  const box = (await viewport(page).boundingBox())!;
  const [x, y, z] = p;
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  const nx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w;
  const ny = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w;
  return { x: box.x + ((nx + 1) / 2) * box.width, y: box.y + ((1 - ny) / 2) * box.height };
}
/** Zoom the Scene view out until every point is in it (away from its edges), run `check`, and zoom back in. */
export async function zoomedOutTo(page: Page, points: readonly V3[], check: () => Promise<void>): Promise<void> {
  const box = (await viewport(page).boundingBox())!;
  const inView = async (): Promise<boolean> => {
    for (const p of points) {
      const q = await screenOf(page, p);
      if (!(q.x > box.x + 12 && q.x < box.x + box.width - 12 && q.y > box.y + 12 && q.y < box.y + box.height - 12)) return false;
    }
    return true;
  };
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  let zoomed = 0;
  for (; zoomed < 30 && !(await inView()); zoomed++) {
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(80);
  }
  expect(await inView(), 'the points in the Scene view').toBe(true);
  await check();
  for (let i = 0; i < zoomed; i++) {
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(80);
  }
}

/** The share of a small square of the Scene view around a world point passing `test`. */
export async function shareNear(page: Page, p: V3, test: Pred, size = 10): Promise<number> {
  const s = await screenOf(page, p);
  const img = decodePng(await page.screenshot({ clip: { x: s.x - size / 2, y: s.y - size / 2, width: size, height: size } }));
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (test(...img.pixel(x, y))) n += 1;
  return n / (img.width * img.height);
}


/**
 * The sky pixels (every one: a crack is a pixel wide) and how many of them lie
 * away from the hole: further than `near` of the frame from their median.
 */
export function skyPixels(img: Image, near = 0.08): { n: number; away: number; where: [number, number][] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (!isSky(...img.pixel(x, y))) continue;
    xs.push(x);
    ys.push(y);
  }
  if (xs.length === 0) return { n: 0, away: 0, where: [] };
  const mx = [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
  const my = [...ys].sort((a, b) => a - b)[ys.length >> 1]!;
  let away = 0;
  const where: [number, number][] = [];
  for (let i = 0; i < xs.length; i++) {
    if (Math.abs(xs[i]! - mx) <= near * img.width && Math.abs(ys[i]! - my) <= near * img.height) continue;
    away += 1;
    if (where.length < 8) where.push([xs[i]! / img.width, ys[i]! / img.height].map((v) => Math.round(v * 1000) / 1000) as [number, number]);
  }
  return { n: xs.length, away, where };
}

/** Layers and the hole in a frame from the scene camera: red and blue ground, and the sky only through the hole (no crack). */
export function frameOk(img: Image): boolean {
  const sky = skyPixels(img);
  return count(img, isRed) / ((img.width * img.height) / 4) > 0.5 && count(img, isBlue) > 20 && count(img, isYellow) > 20 && count(img, isMagenta) > 60 && count(img, isOrange) > 15 && count(img, isWhite) > 15 && sky.n > 40 && sky.away === 0;
}
export function expectFrame(img: Image, what: string): void {
  expect(count(img, isRed) / ((img.width * img.height) / 4), `${what}: red ground`).toBeGreaterThan(0.5);
  expect(count(img, isBlue), `${what}: the painted disc`).toBeGreaterThan(20);
  expect(count(img, isYellow), `${what}: the disc of the fifth layer`).toBeGreaterThan(20);
  expect(count(img, isMagenta), `${what}: the steep ramp and the block walls painted by the slope rule`).toBeGreaterThan(60);
  expect(count(img, isOrange), `${what}: the scatter rules' posts`).toBeGreaterThan(15);
  expect(count(img, isWhite), `${what}: the ground cover's tufts near the camera`).toBeGreaterThan(15);
  const sky = skyPixels(img);
  expect(sky.n, `${what}: the sky through the hole`).toBeGreaterThan(40);
  expect(sky.away, `${what}: sky pixels away from the hole (a crack between levels or tiles; frame fractions ${JSON.stringify(sky.where)})`).toBe(0);
}


// ---- the Terrain tools ----------------------------------------------------------------------------

export type PreviewDiff = { samples: number; stepsMax: number; stepsDiffering: number; normalMax: number; weightMax: number; holesDiffering: number; indicesDiffering: number };
export type StrokeInfo = { serial: number; tool: string; dabs: number; commitMs: number | null; stored: boolean | null; preview?: { active: boolean; settling: boolean; dabs: number; passes: number; tiles: number; msMax: number; msMean: number; frames: number; msMaxAfterFirst: number; settleMs: number | null; diff: PreviewDiff | null } };
export const strokeInfo = async (page: Page): Promise<StrokeInfo | null> => JSON.parse((await viewport(page).getAttribute('data-terrain-stroke')) ?? 'null') as StrokeInfo | null;
export const terrainPanel = (page: Page) => page.getByLabel('terrain tools');
export const terrainTool = (page: Page, name: string) => terrainPanel(page).getByRole('toolbar', { name: 'terrain tool' }).getByRole('button', { name, exact: true });
export async function selectEntity(page: Page, id: string): Promise<void> {
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
  await expect(terrainPanel(page)).toBeVisible();
  await expect(viewport(page)).toHaveAttribute('data-terrain-tool', /\w/);
}
export async function setNumber(page: Page, label: string, value: number): Promise<void> {
  const f = terrainPanel(page).getByLabel(label, { exact: true });
  await f.fill(String(value));
  await f.blur();
}
/** The ground the brush cursor finds under a screen point (null: no terrain there). */
export async function cursorAt(page: Page, s: { x: number; y: number }): Promise<V3 | null> {
  await page.mouse.move(s.x + 1, s.y);
  await page.mouse.move(s.x, s.y);
  // The cursor follows each pointer move at once.
  const at = (await viewport(page).getAttribute('data-terrain-brush')) ?? '';
  return at === '' ? null : (at.split(',').map(Number) as V3);
}
/** The first of `candidates` (x, z) the view sees: the cursor lands on it. */
export async function visibleSpot(page: Page, ground: string, candidates: readonly [number, number][]): Promise<V3> {
  for (const [x, z] of candidates) {
    const p = await surface(ground, x, z);
    const hit = await cursorAt(page, await screenOf(page, p));
    if (hit !== null && Math.hypot(hit[0] - x, hit[2] - z) < 0.3) return p;
  }
  throw new Error(`none of ${JSON.stringify(candidates)} is in view`);
}
/** A square of the Scene view around a world point. */
export async function shot(page: Page, p: V3, size: number): Promise<Image> {
  const s = await screenOf(page, p);
  return decodePng(await page.screenshot({ clip: { x: s.x - size / 2, y: s.y - size / 2, width: size, height: size } }));
}
/**
 * A stroke through world points with the pointer held until every dab is drawn
 * (the preview's picture taken then), released, and stored: the stroke's
 * figures once the stored tiles replaced the preview, with the pictures
 * around `look` before, during and after.
 */
export async function terrainStroke(page: Page, points: readonly V3[], look: V3, size: number, held = true): Promise<{ info: StrokeInfo; before: Image; preview: Image; after: Image }> {
  const first = await screenOf(page, points[0]!);
  await page.mouse.move(first.x, first.y);
  const before = await shot(page, look, size);
  const was = (await strokeInfo(page))?.serial ?? 0;
  await page.mouse.down();
  for (const p of points.slice(1)) {
    const s = await screenOf(page, p);
    await page.mouse.move(s.x, s.y, { steps: 6 });
  }
  // Every dab sent to the preview drawn: the figures are published after the frame that drew them (a ramp is drawn at its release).
  if (held) await expect.poll(async () => {
    const i = await strokeInfo(page);
    return i !== null && i.serial > was && i.preview !== undefined && i.preview.active && i.preview.dabs === i.dabs && i.dabs > 0;
  }, { timeout: 15_000, message: 'the stroke previewed' }).toBe(true);
  const preview = await shot(page, look, size);
  await page.mouse.up();
  let info: StrokeInfo | null = null;
  await expect.poll(async () => {
    info = await strokeInfo(page);
    return info !== null && info.serial > was && info.stored === true && info.preview?.settleMs != null && info.preview.diff != null;
  }, { timeout: 30_000, message: 'the stroke stored and its tiles replacing the preview' }).toBe(true);
  const after = await shot(page, look, size);
  return { info: info!, before, preview, after };
}

/** WebGPU and WebGL 2 on a GPU host; WebGL 2 alone where there is no WebGPU adapter. */
export const BACKENDS: readonly ('webgpu' | 'webgl2')[] = gpuAvailable() ? ['webgpu', 'webgl2'] : ['webgl2'];

export async function expectHorizonLight(game: Page, url: string, renderer: string, cam: CameraView): Promise<void> {
  const settled = async (p: Page): Promise<Image> => {
    const c = p.locator('canvas').first();
    await expect.poll(async () => frameOk(decodePng(await c.screenshot())), { timeout: 60_000, message: `${renderer} export: the frame drawn` }).toBe(true);
    // Every far tile baked (a tile or more a frame).
    await p.waitForTimeout(2500);
    return decodePng(await c.screenshot());
  };
  const on = await settled(game);
  const other = await game.context().newPage();
  let off: Image;
  try {
    await other.goto(`${url}?renderer=${renderer}&terrainHorizon=off`);
    await expectRendererBackend(other.locator('canvas').first(), renderer);
    off = await settled(other);
  } finally {
    await other.close();
  }
  const rowOf = (ahead: number): number => Math.round(projectWith(cam, on.width / on.height, [0, STRIP_HEIGHT, CAM_AT[2] - ahead])![1] * on.height);
  const luma = (img: Image, y0: number, y1: number): number => {
    let sum = 0;
    let n = 0;
    for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y += 2) for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      n += 1;
    }
    return sum / Math.max(1, n);
  };
  // Near: the ground within 25 m ahead (from its layers); far: past 70 m ahead (from the macro textures past 30 m).
  const nearRow = rowOf(25);
  const farRow = rowOf(70);
  const f = { near: [luma(on, nearRow, on.height), luma(off, nearRow, on.height)], far: [luma(on, 0, farRow), luma(off, 0, farRow)], rows: [nearRow, farRow] };
  test.info().annotations.push({ type: `${renderer} export horizon light`, description: JSON.stringify(f) });
  console.log(`${renderer} export horizon light (mean luminance 0-255, on / off): near ${f.near.map((v) => v.toFixed(2)).join(' / ')}, far ${f.far.map((v) => v.toFixed(2)).join(' / ')}`);
  expect(f.far[1]! - f.far[0]!, `${renderer} export: the far ground darker with its horizon`).toBeGreaterThan(HORIZON_FAR_DARKER);
  expect(Math.abs(f.near[1]! - f.near[0]!), `${renderer} export: the near ground the same`).toBeLessThan(HORIZON_NEAR_SAME);
}

/**
 * The ground read by a script across the plaza's two seams (`ctx.surface` in the simulation's worker, Play): on the
 * plaza its block tops (their height, the blue paint's layer), round it the terrain (the stored heights, the blue
 * carried across its border); the backend's `querySurface` answers the same at the same points.
 */
export async function surfaceAcrossPlaza(psid: string, ground: string, plaza: string, renderer: string): Promise<void> {
  const z = PLAZA_AT[2] + PLAZA_SIDE / 2 + 0.25;
  const y = 10;
  const xs: number[] = [];
  for (let x = PLAZA_AT[0] - 3.25; x <= PLAZA_AT[0] + PLAZA_SIDE + 3.25; x += 0.5) xs.push(x);
  type Row = [number, string?, string?, number?, number[]?, number[]?];
  const rows: Row[] = [];
  for (let k = 0, seq = 1; k < xs.length; k += 5, seq++) {
    const r = await relay(`${psid}/control`, { command: 'debugCommand', name: 'surface', args: { seq, xs: xs.slice(k, k + 5).join(','), y, z } });
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
    let got: Row[] | null = null;
    await expect
      .poll(async () => {
        const d = (await relay(`${psid}/diagnostics`, {})).json as { diagnostics?: { runtime?: { errors?: { message: string }[] } } };
        const lines = (d.diagnostics?.runtime?.errors ?? []).map((e) => e.message).filter((m) => m.startsWith('surface ')).map((m) => JSON.parse(m.slice('surface '.length)) as { seq: number; out: Row[] });
        got = lines.find((l) => l.seq === seq)?.out ?? null;
        return got !== null;
      }, { timeout: 30_000, message: `${renderer} Play: the script's surface reading ${seq}` })
      .toBe(true);
    rows.push(...got!);
  }
  const asked = (await query('querySurface', { points: xs.map((x) => [x, y, z]) }))['points'] as { surface: { source: string; object: string; height: number; layers: number[] } | null }[];
  const stored = (await query('queryTerrain', { entityId: ground, points: xs.map((x) => [x, z]) }))['points'] as { height: number | null }[];
  const inside = (x: number): boolean => x > PLAZA_AT[0] && x < PLAZA_AT[0] + PLAZA_SIDE;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    const [, src, obj, mm, layers] = rows[i]!;
    const what = `${renderer} Play: ctx.surface at x ${x}`;
    expect(src, what).toBe(inside(x) ? 'b' : 't');
    expect(obj, what).toBe((inside(x) ? plaza : ground).slice(-4));
    if (inside(x)) {
      expect(Math.abs(mm! / 1000 - plazaTop(x)), `${what}: the plaza's sloped top`).toBeLessThan(0.02);
      expect(layers![0], `${what}: the plaza's blue paint`).toBe(2);
    } else {
      expect(Math.abs(mm! / 1000 - stored[i]!.height!), `${what}: the stored terrain`).toBeLessThan(0.002);
      // The blocks' paint carried across the border onto the ground just outside.
      if (Math.min(Math.abs(x - PLAZA_AT[0]), Math.abs(x - PLAZA_AT[0] - PLAZA_SIDE)) < 0.5) expect(layers, `${what}: the blue carried across`).toContain(2);
    }
    const b = asked[i]!.surface!;
    expect([b.source[0], b.object.slice(-4), b.layers[0]], `${what}: the backend's querySurface`).toEqual([src, obj, layers![0]]);
    expect(Math.abs(b.height - mm! / 1000), `${what}: the backend's querySurface height`).toBeLessThan(0.0011);
  }
  test.info().annotations.push({ type: `${renderer} Play: ctx.surface across the plaza`, description: JSON.stringify(rows) });
  console.log(`${renderer} Play ctx.surface across the plaza (x, source, object, mm, layers, weights %): ${JSON.stringify(rows)}`);
}

/**
 * The player put on the ground west of the plaza walks east across it and off again (Play): sampled as it walks, it
 * never sinks below the ground under it (the terrain's, then the plaza's tops, then the terrain's) and is never
 * caught at a seam (it gets past the plaza's far side).
 */
export async function walkAcrossPlaza(psid: string, ground: string, renderer: string): Promise<void> {
  const z = PLAZA_AT[2] + PLAZA_SIDE / 2;
  const from = PLAZA_AT[0] - 4;
  const to = PLAZA_AT[0] + PLAZA_SIDE + 3;
  // The ground along the way: the stored terrain's, the plaza's tops where it is cut away.
  const xs: number[] = [];
  for (let x = from - 1; x <= to + 3; x += 0.25) xs.push(x);
  const pts = ((await query('queryTerrain', { entityId: ground, points: xs.map((x) => [x, z]) }))['points'] as { height: number | null; hole: boolean }[]);
  const groundAt = (x: number): number => {
    const k = Math.max(0, Math.min(xs.length - 1, Math.round((x - xs[0]!) / 0.25)));
    return pts[k]!.height ?? plazaTop(xs[k]!);
  };
  const read = async (): Promise<Observation | null> => {
    const r = await relay(`${psid}/observe`, {});
    return r.status === 200 ? (r.json as unknown as Observation) : null;
  };
  const placed = await relay(`${psid}/control`, { command: 'debugCommand', name: 'player', args: { x: from, y: groundAt(from) + 1.2, z } });
  expect(placed.status, JSON.stringify(placed.json).slice(0, 300)).toBe(200);
  let rest: Observation | null = null;
  await expect
    .poll(async () => {
      const o = await read();
      const same = o?.player !== undefined && rest?.player !== undefined && Math.abs(o.player.x - from) < 0.5 && Math.abs(o.player.y - rest.player.y) < 1e-4 && (o.stepIndex ?? 0) > (rest.stepIndex ?? 0);
      rest = o;
      return same;
    }, { timeout: 30_000, intervals: [250], message: `${renderer} Play: the player put west of the plaza, at rest` })
    .toBe(true);
  const start = rest!.player!;
  expect(Math.abs(start.y - 0.9 - groundAt(start.x)), `${renderer} Play: standing on the ground west of the plaza (y ${start.y})`).toBeLessThan(0.1);
  // Short legs (a quarter second, about half a metre at the walking speed), the player read after each.
  const east = Array.from({ length: 30 }, (_, k) => ({ stepOffset: k, ...controls(1, 'none', 0) }));
  let worst = 0;
  const samples: [number, number][] = [];
  for (let leg = 0; leg < 48 && ((await read())?.player?.x ?? from) < to; leg++) {
    const r = await relay(`${psid}/input`, { mode: 'exclusive-test', frames: east });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    await new Promise((done) => setTimeout(done, 300));
    const p = (await read())?.player;
    if (p === undefined) continue;
    samples.push([Math.round(p.x * 100) / 100, Math.round((p.y - 0.9 - groundAt(p.x)) * 1000) / 1000]);
    worst = Math.min(worst, p.y - 0.9 - groundAt(p.x));
  }
  const end = (await read())!.player!;
  test.info().annotations.push({ type: `${renderer} Play: across the plaza`, description: JSON.stringify({ start, end, worst, samples }) });
  console.log(`${renderer} Play across the plaza: x ${start.x.toFixed(2)} → ${end.x.toFixed(2)}, the most it sank below the ground ${(-worst).toFixed(3)} m; [x, above the ground] ${JSON.stringify(samples)}`);
  expect(end.x, `${renderer} Play: across the plaza and off its far side (not caught at a seam)`).toBeGreaterThan(to - 1);
  expect(-worst, `${renderer} Play: never sank below the ground crossing the seams`).toBeLessThan(0.1);
}

/** Streaming on (the rings above) or off for terrains and block layers. */
export async function streamed(terrains: readonly string[], layers: readonly string[], on: boolean): Promise<void> {
  for (const id of terrains) await cmd('setComponent', { entityId: id, component: 'terrain', value: { streaming: on ? STREAM : null } });
  for (const id of layers) await cmd('setComponent', { entityId: id, component: 'blockLayer', value: { streaming: on ? BLOCK_STREAM : null } });
}

export type StreamDiag = {
  renderer?: {
    terrain?: TerrainDiag & { streamed?: { resident: number; overviewTiles: number; overviewDrawn: number; ringMetres: number } };
    blocks?: { chunks: number };
    streaming?: { budgetBytes: number; residentBytes: number; overBudget: boolean; kinds: Record<string, { resident: number; bytes: number; inRing: number; kept: number; evicted: number }> };
  };
  runtime?: { worldStream?: { sources: number; collision: { resident: number; pending: number } }; terrainMemory?: { tilesWithColliders: number; waiting: number } };
};

/**
 * The streamed Play (both renderers): only the tiles round the camera are resident, the overview drawn past them;
 * the player walks west across a tile border with a 1 m collision ring and never falls; the camera flies 400 m off
 * (every ground tile and block chunk let go, as the diagnostics count) and back (the same picture).
 */
export async function streamingPlay(psid: string, renderer: string): Promise<void> {
  const diag = async (): Promise<StreamDiag> => ((await relay(`${psid}/diagnostics`, {})).json as { diagnostics?: StreamDiag }).diagnostics ?? {};
  const read = async (): Promise<Observation | null> => {
    const r = await relay(`${psid}/observe`, {});
    return r.status === 200 ? (r.json as unknown as Observation) : null;
  };
  /** Settled round the camera: the ring's tiles all drawn, their macro textures baked, the overview everywhere else. */
  const settled = async (): Promise<StreamDiag | null> => {
    const d = await diag();
    const t = d.renderer?.terrain;
    const s = t?.streamed;
    // Every resident tile drawn (and the far 1,025² tile, its own terrain, which does not stream).
    return s !== undefined && s.resident > 0 && t!.tilesDrawn === s.resident + 1 && s.overviewTiles === TILES * TILES && s.overviewDrawn === TILES * TILES - s.resident && (t!.macro?.waiting ?? 0) === 0 && (d.renderer?.blocks?.chunks ?? 0) >= 2 ? d : null;
  };
  let first: StreamDiag | null = null;
  await expect
    .poll(async () => (first = await settled()) !== null, { timeout: 60_000, message: `${renderer} streamed Play: the ring's tiles drawn, the overview past it` })
    .toBe(true)
    .catch(async (e: Error) => {
      const d = await diag();
      console.log(`${renderer} streamed Play (not settled): ${JSON.stringify({ terrain: { ...d.renderer?.terrain, perLevel: undefined }, blocks: d.renderer?.blocks?.chunks, streaming: d.renderer?.streaming, sim: d.runtime?.worldStream })}`);
      throw e;
    });
  const s0 = first!.renderer!.terrain!.streamed!;
  test.info().annotations.push({ type: `${renderer} streamed Play`, description: JSON.stringify({ terrain: s0, streaming: first!.renderer!.streaming, sim: first!.runtime?.worldStream, colliders: first!.runtime?.terrainMemory }) });
  console.log(`${renderer} streamed Play: ${JSON.stringify({ terrain: s0, streaming: first!.renderer!.streaming?.kinds, sim: first!.runtime?.worldStream })}`);
  expect(s0.ringMetres, 'the ring reaches where tiles draw only their coarsest level').toBe(72);
  expect(s0.resident).toBeLessThan(TILES * TILES);
  expect(first!.renderer!.streaming!.overBudget).toBe(false);
  expect(first!.runtime!.worldStream!.collision.resident).toBeLessThan(TILES * TILES);

  // The player walks west along the strip, across the tile border at x = 0; the tile past it gets its collider only
  // as the player comes within a metre. Sampled while it walks: it never sinks.
  // At rest on the strip first (its tile's collider built round it before its first step).
  let rest: Observation | null = null;
  await expect
    .poll(async () => {
      const o = await read();
      const same = o?.player !== undefined && rest?.player !== undefined && Math.abs(o.player.y - rest.player.y) < 1e-4 && (o.stepIndex ?? 0) > (rest.stepIndex ?? 0);
      rest = o;
      return same;
    }, { timeout: 30_000, intervals: [250], message: `${renderer} streamed Play: the player at rest` })
    .toBe(true);
  const start = rest!.player!;
  expect(Math.abs(start.y - (STRIP_HEIGHT + 0.9)), `${renderer} streamed Play: standing on the strip (at y ${start.y})`).toBeLessThan(0.05);
  const west = Array.from({ length: 120 }, (_, k) => ({ stepOffset: k, ...controls(-1, 'none', 0) }));
  let lowest = start.y;
  for (let leg = 0; leg < 4 && ((await read())?.player?.x ?? 0) > WEST_TO + 2; leg++) {
    const r = await relay(`${psid}/input`, { mode: 'exclusive-test', frames: west });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    for (let k = 0; k < 6; k++) {
      await new Promise((done) => setTimeout(done, 200));
      lowest = Math.min(lowest, (await read())?.player?.y ?? lowest);
    }
  }
  const walked = (await read())!.player!;
  const after = await diag();
  test.info().annotations.push({ type: `${renderer} streamed Play: the walk west`, description: JSON.stringify({ from: start, to: walked, lowest, colliders: after.runtime?.terrainMemory, sim: after.runtime?.worldStream }) });
  console.log(`${renderer} streamed Play: walked from x ${start.x.toFixed(2)} to ${walked.x.toFixed(2)} (across x = 0), lowest y ${lowest.toFixed(3)} (start ${start.y.toFixed(3)})`);
  expect(walked.x, `${renderer} streamed Play: across the tile border`).toBeLessThan(-4);
  expect(start.y - lowest, `${renderer} streamed Play: never fell through (lowest y ${lowest})`).toBeLessThan(0.1);
  expect(after.runtime?.terrainMemory?.waiting ?? 0).toBe(0);

  // The camera flies away: every ground tile and block chunk is let go (the overview drawn instead); then back.
  // Full size: a crack between a full tile and the overview's is a pixel wide.
  const frame = async (): Promise<Image | null> => {
    const r = await relay(`${psid}/screenshot`, { maxWidth: 2048 });
    return r.status === 200 ? decodePng(Buffer.from(String(r.json['dataUrl'] ?? '').split(',')[1] ?? '', 'base64')) : null;
  };
  const place = async (p: V3): Promise<void> => {
    const r = await relay(`${psid}/control`, { command: 'debugCommand', name: 'place', args: { id: 'cam-main', x: p[0], y: p[1], z: p[2] } });
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
  };
  /** Away: every ground tile and streamed block chunk let go (the overview drawn everywhere; the plaza, not streamed, keeps its one chunk). */
  const flyAway = async (): Promise<StreamDiag> => {
    await place(AWAY);
    let away: StreamDiag = {};
    await expect
      .poll(async () => {
        away = await diag();
        return `${away.renderer?.terrain?.streamed?.resident} ${away.renderer?.streaming?.kinds['terrain-tile']?.resident} ${away.renderer?.blocks?.chunks}`;
      }, { timeout: 60_000, message: `${renderer} streamed Play: flown away, the tiles and chunks let go` })
      .toBe('0 0 1');
    expect(away.renderer!.terrain!.streamed!.overviewDrawn).toBe(TILES * TILES);
    return away;
  };
  /** Back: settled round the camera again, its picture. */
  const flyBack = async (): Promise<Image> => {
    await place(CAM_AT);
    let img: Image | null = null;
    await expect
      .poll(async () => {
        if ((await settled()) === null) return false;
        img = await frame();
        return img !== null;
      }, { timeout: 60_000, message: `${renderer} streamed Play: back home, settled` })
      .toBe(true);
    return img!;
  };
  // The picture where the camera starts can hold a few more tiles at full detail (kept by the hysteresis from the
  // first frames' eye); a return from far holds exactly the ring's: two returns are compared.
  const away = await flyAway();
  test.info().annotations.push({ type: `${renderer} streamed Play: flown away`, description: JSON.stringify({ terrain: away.renderer?.terrain?.streamed, streaming: away.renderer?.streaming }) });
  console.log(`${renderer} streamed Play flown away: ${JSON.stringify(away.renderer?.streaming)}`);
  const once = await flyBack();
  // The ground as before streaming (its layers, discs, ramp, posts, tufts and hole), no crack where the ring's
  // tiles meet the overview's.
  expectFrame(once, `${renderer} streamed Play`);
  await flyAway();
  const twice = await flyBack();
  // The same ground, scatter and blocks: what still differs is what moves with time (the river's flow, the wind).
  const diff = meanDiff(once, twice);
  let changed = 0;
  for (let y = 0; y < once.height; y++) for (let x = 0; x < once.width; x++) {
    const p = once.pixel(x, y);
    const q = twice.pixel(x, y);
    if (Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2])) > 48) changed += 1;
  }
  const share = changed / (once.width * once.height);
  test.info().annotations.push({ type: `${renderer} streamed Play: back`, description: JSON.stringify({ meanDiff: diff, changedShare: share }) });
  console.log(`${renderer} streamed Play back home: mean difference ${diff.toFixed(3)} (0–255), ${(share * 100).toFixed(3)} % of pixels changed by more than 48, between two returns`);
  expect(diff, `${renderer} streamed Play: the same picture after each return`).toBeLessThan(1.5);
  expect(share, `${renderer} streamed Play: the same picture after each return (pixels that changed)`).toBeLessThan(0.01);
}

/**
 * The Terrain tools in the Scene view (see the file's header). Leaves the ground as it was (every stroke undone) and
 * the 1,025² tile raised.
 */
/** Ground points for the strokes: a grid round the view's middle, away from the painted discs, the hole and the plain point. */
export function spots(away: readonly V3[]): [number, number][] {
  const keep: [number, number, number][] = [[...PAINTED, 6], [...FIFTH, 4.5], [...HOLE, 5], [...PLAIN, 2.5], ...away.map((p) => [p[0], p[2], 3.5] as [number, number, number])];
  const out: [number, number][] = [];
  for (let z = -10; z <= 4; z += 1.5) for (let x = -8; x <= 6; x += 1.5) if (keep.every(([kx, kz, r]) => Math.hypot(x - kx, z - kz) > r)) out.push([x, z]);
  return out.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
}

export async function terrainTools(page: Page, renderer: string, ground: string, big: string, first: boolean): Promise<void> {
  // Once the scatter rules dress the green disc (after the first renderer's tools), the strokes keep off it.
  const grove: V3[] = first ? [] : [[GROVE[0], 0, GROVE[1]], [GROVE[0] + 2, 0, GROVE[1]], [GROVE[0] - 2, 0, GROVE[1]], [GROVE[0], 0, GROVE[1] + 2], [GROVE[0], 0, GROVE[1] - 2]];
  const height = async (x: number, z: number): Promise<number> => ((await query('queryTerrain', { entityId: ground, points: [[x, z]] }))['points'] as { height: number }[])[0]!.height;
  await selectEntity(page, ground);
  await expect(terrainPanel(page).getByLabel('terrain size')).toContainText(`${TILES * TILES} tiles of ${CELLS * SPACING} m`);
  const rev0 = Number((await query('queryProject')).revision);

  // ---- raise: a short drag, the ground up where it went.
  await terrainTool(page, 'Raise').click();
  await expect(viewport(page)).toHaveAttribute('data-terrain-tool', 'raise');
  await setNumber(page, 'terrain radius', 1.5);
  await setNumber(page, 'terrain strength', 0.4);
  const raiseAt = await visibleSpot(page, ground, spots([...grove]));
  const h0 = await height(raiseAt[0], raiseAt[2]);
  // The cursor sits on the ground under the pointer (the stored surface).
  const cursor = await cursorAt(page, await screenOf(page, raiseAt));
  expect(Math.abs(cursor![1] - h0), 'the brush cursor on the ground').toBeLessThan(0.1);
  const raise = await terrainStroke(page, [[raiseAt[0] - 0.5, raiseAt[1], raiseAt[2]], [raiseAt[0] + 0.5, raiseAt[1], raiseAt[2]]], raiseAt, 140);
  const h1 = await height(raiseAt[0], raiseAt[2]);
  expect(h1 - h0, `${renderer}: the ground raised (from ${h0} to ${h1})`).toBeGreaterThan(0.3);
  expect(Number((await query('queryProject')).revision), 'one command for the stroke').toBe(rev0 + 1);
  const rd = raise.info.preview!.diff!;
  expect(rd.samples).toBeGreaterThan(50);
  expect(rd.stepsMax, `${renderer} raise: preview heights against the stored tiles ${JSON.stringify(rd)}`).toBeLessThanOrEqual(1);
  expect(rd.stepsDiffering / rd.samples).toBeLessThan(0.01);
  expect(rd.normalMax).toBeLessThanOrEqual(2);
  const raisePx = { previewVsBefore: meanDiff(raise.preview, raise.before), previewVsStored: meanDiff(raise.preview, raise.after) };
  expect(raisePx.previewVsStored, `${renderer} raise: the stored tiles drawn as the preview was ${JSON.stringify(raisePx)}`).toBeLessThan(Math.max(2, raisePx.previewVsBefore / 3));

  // ---- paint: layer 2 (blue) over the red ground.
  await terrainTool(page, 'Paint').click();
  await terrainPanel(page).getByRole('radio', { name: 'layer 2' }).click();
  await setNumber(page, 'terrain radius', 1.2);
  await setNumber(page, 'terrain blend', 0.6);
  await terrainPanel(page).getByLabel('terrain falloff').selectOption('constant');
  const paintAt = await visibleSpot(page, ground, spots([...grove, raiseAt]));
  const paint = await terrainStroke(page, [[paintAt[0] - 0.3, paintAt[1], paintAt[2]], [paintAt[0] + 0.3, paintAt[1], paintAt[2]]], paintAt, 30);
  expect(share(paint.before, isRed), `${renderer}: red before the paint`).toBeGreaterThan(0.6);
  expect(share(paint.preview, isBlue), `${renderer}: the paint previewed`).toBeGreaterThan(0.6);
  expect(share(paint.after, isBlue), `${renderer}: the paint stored`).toBeGreaterThan(0.6);
  const pd = paint.info.preview!.diff!;
  expect(pd.weightMax, `${renderer} paint: preview weights against the stored tiles ${JSON.stringify(pd)}`).toBeLessThanOrEqual(4);
  expect(pd.indicesDiffering).toBe(0);
  expect(meanDiff(paint.preview, paint.after)).toBeLessThan(6);

  // ---- noise, smooth and a ramp over the raised ground: their previews against the stored tiles.
  const others: Record<string, PreviewDiff> = {};
  await terrainTool(page, 'Noise').click();
  await setNumber(page, 'noise size', 1.5);
  others['noise'] = (await terrainStroke(page, [[raiseAt[0], raiseAt[1], raiseAt[2] - 0.4], [raiseAt[0], raiseAt[1], raiseAt[2] + 0.4]], raiseAt, 40)).info.preview!.diff!;
  await terrainTool(page, 'Smooth').click();
  others['smooth'] = (await terrainStroke(page, [[raiseAt[0] - 0.5, raiseAt[1], raiseAt[2]], [raiseAt[0] + 0.5, raiseAt[1], raiseAt[2]]], raiseAt, 40)).info.preview!.diff!;
  await terrainTool(page, 'Ramp').click();
  others['ramp'] = (await terrainStroke(page, [[raiseAt[0] - 1, raiseAt[1], raiseAt[2] + 1], [raiseAt[0] + 1, raiseAt[1], raiseAt[2] - 1]], raiseAt, 40, false)).info.preview!.diff!;
  for (const [kind, d] of Object.entries(others)) {
    expect(d.samples, `${renderer} ${kind}: compared`).toBeGreaterThan(20);
    expect(d.stepsMax, `${renderer} ${kind}: preview heights against the stored tiles ${JSON.stringify(d)}`).toBeLessThanOrEqual(1);
    expect(d.normalMax, `${renderer} ${kind}: normals ${JSON.stringify(d)}`).toBeLessThanOrEqual(2);
  }

  // ---- holes: one click, the sky through it.
  await terrainTool(page, 'Holes').click();
  await setNumber(page, 'terrain radius', 1);
  const holeAt = await visibleSpot(page, ground, spots([...grove, raiseAt, paintAt]));
  const hole = await terrainStroke(page, [holeAt], holeAt, 16);
  expect(share(hole.before, isSky), `${renderer}: ground before the hole`).toBeLessThan(0.05);
  expect(share(hole.preview, isSky), `${renderer}: the hole previewed`).toBeGreaterThan(0.5);
  expect(share(hole.after, isSky), `${renderer}: the hole stored`).toBeGreaterThan(0.5);
  expect(hole.info.preview!.diff!.holesDiffering, `${renderer} holes: ${JSON.stringify(hole.info.preview!.diff)}`).toBe(0);
  test.info().annotations.push({ type: `${renderer} terrain tools: preview against stored`, description: JSON.stringify({ raise: { diff: rd, px: raisePx, msMax: raise.info.preview!.msMax, commitMs: raise.info.commitMs, settleMs: raise.info.preview!.settleMs }, paint: { diff: pd, commitMs: paint.info.commitMs, settleMs: paint.info.preview!.settleMs }, hole: { diff: hole.info.preview!.diff, settleMs: hole.info.preview!.settleMs }, others }) });
  console.log(`${renderer} terrain tools: ${JSON.stringify({ raise: { diff: rd, px: raisePx, msMax: raise.info.preview!.msMax, commitMs: raise.info.commitMs, settleMs: raise.info.preview!.settleMs }, paint: { diff: pd, commitMs: paint.info.commitMs, settleMs: paint.info.preview!.settleMs }, hole: { diff: hole.info.preview!.diff, settleMs: hole.info.preview!.settleMs }, others })}`);

  // ---- undo and redo: the hole goes and comes back; then everything is undone.
  const holeShare = async (): Promise<number> => share(await shot(page, holeAt, 16), isSky);
  await page.keyboard.press('Control+z');
  await expect.poll(holeShare, { timeout: 30_000, message: `${renderer}: the hole undone` }).toBeLessThan(0.05);
  await page.keyboard.press('Control+y');
  await expect.poll(holeShare, { timeout: 30_000, message: `${renderer}: the hole redone` }).toBeGreaterThan(0.5);
  for (let i = 0; i < 6; i++) await page.keyboard.press('Control+z');
  await expect.poll(holeShare, { timeout: 30_000 }).toBeLessThan(0.05);
  await expect.poll(async () => share(await shot(page, paintAt, 30), isRed), { timeout: 30_000, message: `${renderer}: the paint undone` }).toBeGreaterThan(0.6);
  await expect.poll(() => height(raiseAt[0], raiseAt[2]), { timeout: 30_000 }).toBe(h0);

  if (first) {
    // ---- a new terrain from the GameObject menu: selected, its tools show (then undone).
    const newRows = page.locator('.tl-hierarchy__list li.tl-row').filter({ has: page.locator('.tl-row__name', { hasText: /^Terrain$/ }) });
    await menu(page, 'GameObject', 'Terrain');
    await expect(terrainPanel(page).getByLabel('terrain size')).toContainText('4 tiles of 256 m');
    await expect(newRows).toHaveCount(1);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await expect(newRows).toHaveCount(0, { timeout: 30_000 });
    await selectEntity(page, ground);

    // ---- the heightmap import dialog: a 33² RAW of 10 m on tile [7, 7] (then undone).
    const at: [number, number] = [ORIGIN[0] + 7 * CELLS * SPACING + 4, ORIGIN[2] + 7 * CELLS * SPACING + 4];
    const was = await height(...at);
    const raw = new Uint8Array(33 * 33 * 2);
    const v = Math.round(((10 - RANGE[0]) / (RANGE[1] - RANGE[0])) * 65535);
    for (let i = 0; i < 33 * 33; i++) new DataView(raw.buffer).setUint16(i * 2, v, true);
    await terrainPanel(page).getByRole('button', { name: 'Import heightmap…' }).click();
    const dialog = page.getByRole('dialog', { name: 'import heightmap' });
    await dialog.getByLabel('heightmap file').setInputFiles({ name: 'patch.raw', mimeType: 'application/octet-stream', buffer: Buffer.from(raw) });
    await expect(dialog.getByLabel('heightmap format')).toHaveValue('raw16');
    await expect(dialog.getByLabel('raw width')).toHaveValue('33');
    await dialog.getByLabel('import tile x').fill('7');
    await dialog.getByLabel('import tile z').fill('7');
    await dialog.getByRole('button', { name: 'import', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect.poll(() => height(...at), { timeout: 30_000 }).toBeCloseTo(10, 1);
    await page.keyboard.press('Control+z');
    await expect.poll(() => height(...at), { timeout: 30_000 }).toBe(was);

    // ---- a block layer converted onto the 1,025² tile (then undone): its top, 3 m over the layer's object.
    await cmd('setBlockType', { block: { blockId: 'stone', name: 'Stone', variants: [{ color: '#808080' }], shape: 'full' } });
    const layer = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Blocks', transform: { position: [BIG_ORIGIN[0] + 100, 0, BIG_ORIGIN[2] + 100] } }))['createdId']);
    await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [8, 8, 8] } } });
    await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [0, 0, 0, 8, 3, 8], cell: { block: 'stone' } }] });
    await selectEntity(page, big);
    await terrainPanel(page).getByLabel('convert source').selectOption(layer);
    const bigAt: [number, number] = [BIG_ORIGIN[0] + 104, BIG_ORIGIN[2] + 104];
    const bigHeight = async (): Promise<number> => ((await query('queryTerrain', { entityId: big, points: [bigAt] }))['points'] as { height: number }[])[0]!.height;
    const bigWas = await bigHeight();
    await terrainPanel(page).getByRole('button', { name: 'convert block layer' }).click();
    await expect.poll(bigHeight, { timeout: 30_000 }).toBeCloseTo(3, 1);
    await page.keyboard.press('Control+z');
    await expect.poll(bigHeight, { timeout: 30_000 }).toBe(bigWas);
    await cmd('deleteEntity', { entityId: layer });
  }

  // ---- a 64 m raise on the 1,025² tile: the preview's cost per frame and the page's frames while dragging, the commit.
  await selectEntity(page, big);
  await page.keyboard.press('f');
  const box = (await viewport(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Out to about 130 m from the tile's corner (the view looks down at it from +x +z).
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 500);
  await page.waitForTimeout(300);
  await terrainTool(page, 'Raise').click();
  await setNumber(page, 'terrain radius', 64);
  await setNumber(page, 'terrain strength', 0.5);
  // Two loops of 15 m round a point of the tile the view sees (all in view), projected to the screen.
  let loop: { x: number; y: number }[] = [];
  const inBox = (q: { x: number; y: number }): boolean => q.x > box.x + 10 && q.x < box.x + box.width - 10 && q.y > box.y + 10 && q.y < box.y + box.height - 10;
  for (const d of [60, 50, 40, 30, 25, 20]) {
    const c: V3 = [BIG_ORIGIN[0] + d, 0, BIG_ORIGIN[2] + d];
    const s0 = await screenOf(page, c);
    const at = s0.x > box.x && s0.x < box.x + box.width && s0.y > box.y && s0.y < box.y + box.height ? await cursorAt(page, s0) : null;
    if (at === null || Math.hypot(at[0] - c[0], at[2] - c[2]) > 20) continue;
    loop = [];
    for (let i = 0; i <= 150; i++) {
      const a = (i / 150) * 4 * Math.PI;
      loop.push(await screenOf(page, [c[0] + 15 * Math.cos(a), 0, c[2] + 15 * Math.sin(a)]));
    }
    if (loop.every(inBox)) break;
    loop = [];
  }
  expect(loop.length, `${renderer}: a part of the 1,025² tile in view`).toBeGreaterThan(0);
  const hit = await cursorAt(page, loop[0]!);
  expect(hit, `${renderer}: the 1,025² tile under the pointer`).not.toBeNull();
  const serial = (await strokeInfo(page))?.serial ?? 0;
  const rafStart = async (): Promise<void> => page.evaluate(() => {
    const w = window as unknown as { __tlFrames?: number[] };
    const frames: number[] = (w.__tlFrames = []);
    let last = performance.now();
    const tick = (now: number): void => {
      frames.push(now - last);
      last = now;
      if (frames.length < 4000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await rafStart();
  const t0 = Date.now();
  await page.mouse.down();
  // About 3 s of drag, a pointer move a frame or so.
  for (const s of loop.slice(1)) {
    await page.mouse.move(s.x, s.y);
    await page.waitForTimeout(16);
  }
  const strokeFrames = await page.evaluate(() => (window as unknown as { __tlFrames: number[] }).__tlFrames.splice(0));
  const dragMs = Date.now() - t0;
  await page.mouse.up();
  let info: StrokeInfo | null = null;
  await expect.poll(async () => {
    info = await strokeInfo(page);
    return info !== null && info.serial > serial && info.stored === true && info.preview?.settleMs != null && info.preview.diff != null;
  }, { timeout: 60_000, message: `${renderer}: the 64 m stroke stored and settled` }).toBe(true).catch((e: Error) => {
    throw new Error(`${e.message}: ${JSON.stringify(info)}`);
  });
  const st = info!.preview!;
  const sorted = [...strokeFrames].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const report = { dabs: info!.dabs, passes: st.passes, tiles: st.tiles, previewMsMax: st.msMax, previewMsMaxAfterFirst: st.msMaxAfterFirst, previewMsMean: st.msMean, previewFrames: st.frames, rafFrames: strokeFrames.length, rafMaxMs: Math.round(Math.max(...strokeFrames) * 10) / 10, rafP95Ms: Math.round(p95 * 10) / 10, over16_7: strokeFrames.filter((f) => f > 16.7).length, over25: strokeFrames.filter((f) => f > 25).length, dragMs, commitMs: info!.commitMs, settleMs: st.settleMs, diff: st.diff };
  test.info().annotations.push({ type: `${renderer} 64 m raise on a 1,025² tile`, description: JSON.stringify(report) });
  console.log(`${renderer} 64 m raise on a 1,025² tile: ${JSON.stringify(report)}`);
  expect(info!.dabs).toBeGreaterThan(3);
  // The preview's own main-thread time stays well inside a frame.
  expect(st.msMax, `${renderer}: the preview's main-thread time per frame`).toBeLessThan(16.7);
  expect(st.msMean).toBeLessThan(4);
  expect(st.diff!.stepsMax, `${renderer} 64 m raise: preview against stored ${JSON.stringify(st.diff)}`).toBeLessThanOrEqual(1);
}

/**
 * The material rules from the editor (see the file's header): the terrain's baked twice (the hand paint on the ramp
 * survives both), the block layer's stored on its component, and layer 5's own settings in the layer table.
 */
export async function materialRules(page: Page, ground: string, blocks: string): Promise<void> {
  type Point = { layers: number[]; weights: number[] };
  const layersAt = async (p: [number, number]): Promise<Point> => ((await query('queryTerrain', { entityId: ground, points: [p] }))['points'] as Point[])[0]!;
  await selectEntity(page, ground);
  await terrainPanel(page).getByRole('button', { name: /^Material rules/ }).click();
  const rules = terrainPanel(page).getByRole('group', { name: 'material rules' });
  await rules.getByRole('button', { name: 'add rule' }).click();
  const fill = async (scope: typeof rules, label: string, value: number): Promise<void> => {
    const f = scope.getByLabel(label, { exact: true });
    await f.fill(String(value));
    await f.blur();
  };
  await fill(rules, 'rule 1 layer', STEEP_RULE.layer);
  await fill(rules, 'rule 1 slope min', STEEP_RULE.slope.min);
  await fill(rules, 'rule 1 slope fade', 1);
  const rev0 = Number((await query('queryProject')).revision);
  await rules.getByRole('button', { name: 'apply rules' }).click();
  await expect.poll(async () => (await layersAt(RAMP_MID)).layers, { timeout: 30_000, message: 'the steep ramp baked layer 3' }).toEqual([STEEP_RULE.layer]);
  expect(Number((await query('queryProject')).revision), 'one command for the bake').toBe(rev0 + 1);
  expect(await layersAt(RAMP_DISC), 'the hand paint over the rules').toMatchObject({ layers: [2], weights: [255] });
  expect((await layersAt(PLAIN)).layers, 'gentle ground keeps layer 0').toEqual([0]);
  // A second bake (the fade changed): the hand paint is still there.
  await fill(rules, 'rule 1 slope fade', STEEP_RULE.slope.fade);
  await rules.getByRole('button', { name: 'apply rules' }).click();
  const terrainRules = async (): Promise<unknown> => (((await query('queryEntities', { limit: 200, offset: 0 })) as { entities: { id: string; components: { terrain?: { rules?: unknown } } }[] }).entities.find((e) => e.id === ground)?.components.terrain?.rules ?? null);
  await expect.poll(terrainRules, { timeout: 30_000 }).toEqual([STEEP_RULE]);
  expect(await layersAt(RAMP_DISC), 'the hand paint after a second bake').toMatchObject({ layers: [2], weights: [255] });
  expect((await layersAt(RAMP_MID)).layers).toEqual([STEEP_RULE.layer]);

  // The block layer's Rules: the same slope rule.
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${blocks}"]`).click();
  await openWindow(page, 'Blocks');
  const panel = page.getByLabel('blocks panel');
  await expect(panel.getByLabel('block layer')).toHaveValue(blocks);
  await panel.getByRole('button', { name: /^Rules/ }).click();
  const blockRules = panel.getByRole('group', { name: 'material rules' });
  await blockRules.getByRole('button', { name: 'add rule' }).click();
  await fill(blockRules, 'rule 1 layer', STEEP_RULE.layer);
  await fill(blockRules, 'rule 1 slope min', STEEP_RULE.slope.min);
  await fill(blockRules, 'rule 1 slope fade', STEEP_RULE.slope.fade);
  await blockRules.getByRole('button', { name: 'apply rules' }).click();
  const blockRulesStored = async (): Promise<unknown> => (((await query('queryEntities', { limit: 200, offset: 0 })) as { entities: { id: string; components: { blockLayer?: { rules?: unknown } } }[] }).entities.find((e) => e.id === blocks)?.components.blockLayer?.rules ?? null);
  await expect.poll(blockRulesStored, { timeout: 30_000 }).toEqual([STEEP_RULE]);

  // Layer 5 (index 4) gets settings of its own in the material's layer table.
  await openEditor(page, 'Material', 'Terrain layers');
  const doc = editorPane(page, 'Material', 'Terrain layers');
  await doc.getByRole('button', { name: 'add layer column' }).click();
  const tiling = doc.getByLabel('layer 5 tiling (m)', { exact: true });
  await expect(tiling).toHaveValue('1');
  await tiling.fill('2');
  await tiling.blur();
  const tilingParam = async (): Promise<unknown> => ((await materials(be!)).find((m) => m.materialId === 'mat-terrain')?.parameters as { key: string; extraLayers?: number[] }[] | undefined)?.find((x) => x.key === 'layerTiling')?.extraLayers ?? null;
  await expect.poll(tilingParam, { timeout: 15_000 }).toEqual([2]);
  // Layer 4 (index 3) projected by slope; then biplanar, whose cost the table states.
  const projectionParam = async (): Promise<unknown> => ((await materials(be!)).find((m) => m.materialId === 'mat-terrain')?.parameters ?? []).find((x) => x.key === 'layerProjection')?.default ?? null;
  await expect(doc.getByLabel('texture reads')).toHaveText('Texture reads a pixel: 12.');
  await doc.getByLabel('layer 4 projection', { exact: true }).selectOption('by slope');
  await expect.poll(projectionParam, { timeout: 15_000 }).toEqual([0, 0, 0, 1]);
  await doc.getByLabel('layer 4 projection', { exact: true }).selectOption('biplanar');
  await expect.poll(projectionParam, { timeout: 15_000 }).toEqual([0, 0, 0, 2]);
  await expect(doc.getByLabel('texture reads')).toContainText('within 60 m, 3 more for it (1 biplanar layer: up to 15)');
  await closeEditor(page);
}

/** Layer 3's projection (0 top, 1 by slope, 2 biplanar) and tiling (m) on the terrain's material. */
export async function setLayer3(mode: number, tiling: number): Promise<void> {
  const m = (await materials(be!)).find((x) => x.materialId === 'mat-terrain')!;
  const parameters = (m.parameters ?? []).map((p) => {
    if (p.key === 'layerProjection') return { ...p, default: [0, 0, 0, mode] };
    if (p.key === 'layerTiling') return { ...p, default: [1, 1, 1, tiling] };
    return p;
  });
  await cmd('setMaterial', { material: { ...m, parameters } });
}

/**
 * Light–dark changes of layer 3's checker along the ramp's middle line in the Scene view (its magenta pixels only;
 * a change counted where the brightness crosses the line's running mean by a margin).
 */
export async function checkCrossings(page: Page, ground: string): Promise<number> {
  const a = await screenOf(page, await surface(ground, RAMP_X, RAMP.from[2] - 0.2));
  const b = await screenOf(page, await surface(ground, RAMP_X, RAMP.to[2] + 0.2));
  const x0 = Math.min(a.x, b.x) - 2;
  const y0 = Math.min(a.y, b.y) - 2;
  const img = decodePng(await page.screenshot({ clip: { x: x0, y: y0, width: Math.abs(a.x - b.x) + 4, height: Math.abs(a.y - b.y) + 4 } }));
  const values: number[] = [];
  for (let i = 0; i <= 200; i++) {
    const t = i / 200;
    const [r, g, bl] = img.pixel(Math.round(a.x - x0 + (b.x - a.x) * t), Math.round(a.y - y0 + (b.y - a.y) * t));
    if (isMagenta(r, g, bl)) values.push(r + bl);
  }
  let n = 0;
  let side = 0;
  for (let i = 0; i < values.length; i++) {
    const w = values.slice(Math.max(0, i - 12), i + 13);
    const mean = w.reduce((x, y) => x + y, 0) / w.length;
    const now = values[i]! > mean * 1.08 ? 1 : values[i]! < mean * 0.92 ? -1 : 0;
    if (now !== 0 && side !== 0 && now !== side) n += 1;
    if (now !== 0) side = now;
  }
  return n;
}

/**
 * The scatter rules from the editor (see the file's header): the terrain's posts (stored) and tufts (ground cover)
 * on the green disc, the brush taking posts off a patch (undone), the terrace's posts on its flat tops.
 */
export async function scatterRules(page: Page, ground: string, terrace: string): Promise<void> {
  type Copy = { rule: string; x: number; y: number; z: number; cell: [number, number] };
  const box: [number, number, number, number] = [GROVE[0] - GROVE_RADIUS - 1, GROVE[1] - GROVE_RADIUS - 1, GROVE[0] + GROVE_RADIUS + 1, GROVE[1] + GROVE_RADIUS + 1];
  const copies = async (): Promise<Copy[]> => (((await query('queryTerrain', { entityId: ground, scatter: { box } }))['scatter'] as { copies: Copy[] } | undefined)?.copies ?? []);
  const fill = async (scope: ReturnType<Page['getByRole']>, label: string, value: number | string): Promise<void> => {
    const f = scope.getByLabel(label, { exact: true });
    await f.fill(String(value));
    await f.blur();
  };
  // The disc the rules read (layer 2, green), painted now: the first renderer's tools ran on the ground as it was.
  await cmd('editTerrain', { entityId: ground, kind: 'paint', dabs: [GROVE], radius: GROVE_RADIUS, strength: 1, falloff: 'constant', layer: 1 });
  await selectEntity(page, ground);
  await terrainPanel(page).getByRole('button', { name: /^Scatter rules/ }).click();
  const rules = terrainPanel(page).getByRole('group', { name: 'scatter rules' });
  // Posts: on the disc (layer 2's share over 0.5), on ground gentler than 30°.
  await rules.getByRole('button', { name: 'add scatter rule' }).click();
  await fill(rules, 'scatter 1 name', 'posts');
  await rules.getByLabel('scatter 1 model', { exact: true }).selectOption('e2e-post');
  await fill(rules, 'scatter 1 density', 1.5);
  await fill(rules, 'scatter 1 spacing', 0.6);
  await fill(rules, 'scatter 1 slope max', 30);
  await fill(rules, 'scatter 1 slope fade', 0.5);
  await rules.getByLabel('scatter 1 layers', { exact: true }).check();
  await fill(rules, 'scatter 1 layers of layer', 1);
  // Each post carries its model's collider; far below the test's screen sizes it would turn into its impostor.
  await rules.getByLabel('scatter 1 collide', { exact: true }).check();
  await fill(rules, 'scatter 1 impostor size', POST_IMPOSTOR_SIZE);
  // Tufts: ground cover on the same disc, reaching the Play camera (about 45 m away).
  await rules.getByRole('button', { name: 'add scatter rule' }).click();
  await fill(rules, 'scatter 2 name', 'tufts');
  await rules.getByLabel('scatter 2 model', { exact: true }).selectOption('e2e-tuft');
  await fill(rules, 'scatter 2 density', 6);
  await fill(rules, 'scatter 2 spacing', 0);
  await fill(rules, 'scatter 2 slope max', 40);
  await rules.getByLabel('scatter 2 layers', { exact: true }).check();
  await fill(rules, 'scatter 2 layers of layer', 1);
  await rules.getByLabel('scatter 2 cover', { exact: true }).check();
  await fill(rules, 'scatter 2 cover distance', 100);
  const rev0 = Number((await query('queryProject')).revision);
  await rules.getByRole('button', { name: 'apply scatter rules' }).click();
  await expect.poll(async () => (await copies()).length, { timeout: 30_000, message: 'the posts baked' }).toBeGreaterThan(10);
  expect(Number((await query('queryProject')).revision), 'one command for the bake').toBe(rev0 + 1);
  const stored = (((await query('queryEntity', { entityId: ground })) as { entity: { components: { terrain: { scatter: Record<string, unknown>[] } } } }).entity.components.terrain.scatter);
  expect(stored[0], 'the dialog wrote the collider and the impostor size').toMatchObject({ id: 'posts', collide: true, impostorSize: POST_IMPOSTOR_SIZE });
  // Every post on the disc and on gentle ground (its slope read where it stands); ground cover is never stored.
  const posts = await copies();
  expect(posts.every((c) => c.rule === 'posts')).toBe(true);
  const slopes = ((await query('queryTerrain', { entityId: ground, points: posts.map((c) => [c.x, c.z]) }))['points'] as { slope: number; layers: number[] }[]);
  slopes.forEach((p, i) => {
    expect(p.slope, `post ${i} stands on ground under 30.5°`).toBeLessThan(30.5);
    expect(p.layers[0], `post ${i} stands on the disc`).toBe(1);
  });
  // Some of the disc is steeper than that (its bumps): those places carry none.
  const grid: [number, number][] = [];
  for (let z = GROVE[1] - 3; z <= GROVE[1] + 3; z += 0.5) for (let x = GROVE[0] - 3; x <= GROVE[0] + 3; x += 0.5) grid.push([x, z]);
  const steep = ((await query('queryTerrain', { entityId: ground, points: grid }))['points'] as { slope: number }[]).filter((p) => p.slope > 35).length;
  expect(steep, 'the disc has steep places').toBeGreaterThan(5);
  test.info().annotations.push({ type: 'terrain scatter', description: JSON.stringify({ posts: posts.length, steepSamples: steep }) });

  // The Scatter brush (Ctrl: take off) over a patch of the disc: no post left there; undone, they are back. The view
  // frames a marker on the disc first (the tools left it over the far tile), and the marker goes before the stroke.
  const marker = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name: 'Grove', transform: { position: [GROVE[0], (await surface(ground, ...GROVE))[1] + 1, GROVE[1]] }, box: { size: [6, 2, 6], material: { color: '#00ff00' } } }))['createdId']);
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${marker}"]`).click();
  await page.keyboard.press('f');
  await page.waitForTimeout(300);
  await cmd('deleteEntity', { entityId: marker });
  await selectEntity(page, ground);
  await terrainTool(page, 'Scatter').click();
  await expect(terrainPanel(page).getByLabel('scatter brush rule')).toHaveValue('posts');
  await setNumber(page, 'terrain radius', 1.5);
  const center = await visibleSpot(page, ground, posts.slice(0, 12).map((c) => [c.x, c.z] as [number, number]));
  const s = await screenOf(page, center);
  const near = (list: Copy[]): number => list.filter((c) => Math.hypot(c.x - center[0], c.z - center[2]) < 1.2).length;
  expect(near(posts), 'posts under the brush before').toBeGreaterThan(0);
  await page.keyboard.down('Control');
  await page.mouse.move(s.x, s.y);
  await page.mouse.down();
  await page.mouse.move(s.x + 2, s.y, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up('Control');
  await expect.poll(async () => near(await copies()), { timeout: 30_000, message: 'the brush took the posts off' }).toBe(0);
  await cmd('undo', {});
  await expect.poll(async () => near(await copies()), { timeout: 30_000, message: 'undone: the posts are back' }).toBe(near(posts));
  await terrainTool(page, 'Raise').click();

  // The terrace's Scatter: posts on its flat tops (rows 2), none over its sloped cell (0, 1, 0).
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${terrace}"]`).click();
  await openWindow(page, 'Blocks');
  const panel = page.getByLabel('blocks panel');
  await expect(panel.getByLabel('block layer')).toHaveValue(terrace);
  await panel.getByRole('button', { name: /^Scatter.*…$/ }).click();
  const blockRules = panel.getByRole('group', { name: 'scatter rules' });
  await blockRules.getByRole('button', { name: 'add scatter rule' }).click();
  await fill(blockRules, 'scatter 1 name', 'posts');
  await blockRules.getByLabel('scatter 1 model', { exact: true }).selectOption('e2e-post');
  await fill(blockRules, 'scatter 1 density', 2);
  await fill(blockRules, 'scatter 1 spacing', 0.4);
  await fill(blockRules, 'scatter 1 slope max', 10);
  await blockRules.getByRole('button', { name: 'apply scatter rules' }).click();
  type Chunk = { chunk: { scatter?: string } | null };
  const terraceCopies = async (): Promise<[number, number, number][]> => {
    const chunks = ((await query('queryBlocks', { entityId: terrace }))['chunks'] as Chunk[] | undefined) ?? [];
    const out: [number, number, number][] = [];
    for (const c of chunks) {
      const cell = decodeChunkScatter(c.chunk?.scatter);
      const t = cell?.get('posts');
      for (let i = 0; i < (t?.copies.length ?? 0); i += 10) out.push([t!.copies[i]!, t!.copies[i + 1]!, t!.copies[i + 2]!]);
    }
    return out;
  };
  await expect.poll(async () => (await terraceCopies()).length, { timeout: 30_000, message: 'the terrace\'s posts baked' }).toBeGreaterThan(8);
  for (const [x, y, z] of await terraceCopies()) {
    expect(x >= 1 || z >= 1, `a post at (${x}, ${z}) not over the sloped cell`).toBe(true);
    expect(y, 'a post on the flat tops').toBeCloseTo(2, 3);
  }

  await page.locator('.tl-hierarchy__list li[data-entity-id="' + ground + '"]').click();
}
