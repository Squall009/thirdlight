/**
 * A heightfield terrain drawn by the renderer (CDLOD over its tiles' texture
 * arrays) against a real backend, in the Scene view, Play and the static
 * export, on WebGPU and WebGL 2 (one backend for both: each renderer is a
 * pass of the same test).
 *
 * The terrain: 8 × 8 tiles of 65 samples 0.5 m apart (256 m square), its
 * heights an uploaded RAW heightmap of rolling bumps (finer ones on top, so
 * the levels' shapes differ and morph); it wears the
 * height-blended layers material (the three texture arrays packed through the
 * pack route; layer 1 red, layer 3 blue), a disc painted layer 3 by
 * `editTerrain`, and the sky a cyan nothing on the terrain has.
 *
 * - Scene view: every tile read and uploaded and the quadtree's three levels
 *   drawn in one draw (its published `data-terrain`); red where unpainted,
 *   blue on the painted disc (world points
 *   projected through the view's published matrix); a holes stroke then cuts
 *   a disc while the page is open (its tile's layers uploaded again): the sky
 *   shows through it.
 * - Play and the export: the scene camera looks down at the terrain from 22 m
 *   with the sky out of frame, over the finest level's reach and the next
 *   (the levels meet in view, and 64 tiles' seams): red and blue show, and
 *   the only sky pixels are the hole's — one compact blob, no crack along a
 *   level or tile boundary.
 * - Any number of layers: the albedo array has a fifth layer (yellow), and a
 *   second disc is painted layer index 4; it shows yellow (the material reads
 *   each pixel's layer indices) in the Scene view and Play.
 * - Collision (3D, Play on both renderers): a player stands on the terrain at
 *   its height (a flattened strip), walks forward into the hole and falls
 *   through it; the simulation's terrain colliders and the page's decoded
 *   tiles show in Play's diagnostics.
 * - A 1,025² tile far out of view (its own terrain) is packed on a worker and
 *   uploaded over several frames in the Scene view and Play: no frame spends
 *   more than a few milliseconds of the page's time on it (the upload peak).
 * - The Terrain tools (the Inspector of a selected terrain, both renderers):
 *   raise, paint (and noise, smooth, a ramp: read back only) and a holes click previewed on the GPU
 *   while the pointer is held, then stored as one `editTerrain` each; the
 *   preview read back against the stored tiles (`?terrainCheck=1`: heights
 *   to a step, paint to a few weight bytes, holes exactly) and the pixels
 *   before and after the stored tiles replaced it; undo and redo; the brush
 *   cursor on the ground under the pointer. On the first renderer also a new
 *   terrain from the GameObject menu, the heightmap import dialog and a block
 *   layer converted (each undone). Then a 64 m raise on the 1,025² tile: the
 *   preview's main-thread time per frame, the page's frames meanwhile, the
 *   commit's round trip and how long until the stored tile replaced it.
 * - Material rules (first renderer, through the editor): the terrain's
 *   Material rules paint layer 3 (magenta) where the ground is steeper than
 *   the bumps ever get, so a steep ramp turns magenta while the disc painted
 *   by hand on it stays blue, through a second bake too; the block layer's
 *   Rules paint the same rule onto its walls and a steep top while its flat
 *   top keeps layer 0 (red). The layer table gives layer 5 settings of its
 *   own and sets layer 3's projection. Then the Scene view (second
 *   renderer), Play and the export (both) show the magenta ramp and walls
 *   beside the blue disc and red tops; along the ramp layer 3's checker
 *   repeats about three times as often projected by slope (the side plane:
 *   the ramp's 9 m height) or biplanar as from the top (its 3 m depth).
 * - Far ground: in Play and the export the ground's tiles past 30 m are
 *   drawn from their baked macro textures (every tile baked, far nodes drawn
 *   from them throughout the frame taken: Play's diagnostics); the frames
 *   show the same layers, discs, ramp and hole, without a crack.
 * - Scatter rules (first renderer, through the editor): on a disc painted
 *   layer 2 (green), the terrain's Scatter rules place orange posts where the
 *   ground is gentler than 30° (none on the disc's steep bumps, read back by
 *   position) and white tufts as ground cover; the Scatter brush takes the
 *   posts off a patch (undone after); a small block terrace's Scatter puts
 *   posts on its flat tops, none on its sloped cell. Play and the export
 *   (both renderers) show the posts and, near their camera, the tufts.
 * - Scatter copies in the game (Play, both renderers): the posts collide
 *   (their model's `_COL`, the rule's Collides box): posts put by hand across
 *   the player's strip stop the player walking into them; a script names the
 *   copies by address (`ctx.scatter.near`) and hides them on a key (the posts
 *   leave the frame, the simulation's and the renderer's counts follow), then
 *   shows them again. A second Play draws every terrain post as its impostor
 *   (the rule's Impostor below, set in the dialog): baked once, the copies at
 *   the impostor's level, the posts' pixels as many and as orange as the
 *   meshes'.
 * - Splines: a road (one command: the terrain flattened and painted under it,
 *   the posts' scatter kept off it) and a river (the terrain's bed carved, its
 *   water mesh made with the river template, posts along its bank). The
 *   Scene view (both renderers), Play and the export show the road yellow with
 *   no post on it and the river's water blue; Play draws the river's mesh and
 *   posts and the simulation has the posts' colliders. On the first renderer
 *   the road's point grip is dragged across the ground in the Scene view: one
 *   command moves it and shapes the terrain again; one undo puts it back.
 * - Edit layers (Scene view, both renderers): on the first renderer through the
 *   editor — the Stamp tool places a cone (a texture asset) 20 m high into a new
 *   stamps layer with a click (one command: the mountain stands where it was
 *   clicked, its steep flanks magenta from the rules baked after it), the Erode
 *   tool erodes the square round it (one command, its result an erosion layer),
 *   and the Layers list switches the erosion off and on. On both renderers the
 *   pictures with each layer on and off differ where the mountain and its
 *   channels are; the layers are then switched off for Play and the export.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from './pw';

import { layeredMaterial, riverMaterial } from '../../packages/editor/src/session/material-graph';
import { controls, publishBytes, publishScript, startBackend, type E2EBackend } from './backend';
import { multiPieceGlb } from './multi-piece-glb';
import { decodeChunkScatter } from '../../packages/project-model/src/scatter';
import { gpuAvailable } from './browser-env.mjs';
import { ALBEDO_HEIGHT_LAYERS, isBlue, isMagenta, isRed, materials, packNormalAndOrm, packTexture, publishLayerSources, publishTexture, useArrays, type Pred } from './painted-layers';
import { makePng } from './png-make';
import { decodePng, type Image } from './png';
import { closeEditor, editorPane, menu, openEditor, openWindow } from './ui';
import { expectRendererBackend } from './renderer-variants';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-terrain-cdlod' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}
type Observation = { state: string; stepIndex?: number; player?: { x: number; y: number; z: number } };
type TerrainDiag = { tilesDrawn: number; draws: number; perLevel: number[]; errors: string[]; uploadMsPeak?: number; uploadBytesPeak?: number; tilesUploaded?: number; cpuBytes?: number; decodeMs?: number; packMs?: number; macro?: { baked: number; waiting: number; bakes: number; bakeMsTotal: number; bakeMs: number; farNodes: number; draws: number } };
type Diagnostics = { renderer?: { terrain?: TerrainDiag }; runtime?: { terrainMemory?: { tiles: number; bytes: number; colliders: number; tilesWithColliders: number; lastBuild: { tiles: number; ms: number } | null; waiting: number } } };

async function relay(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/play/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

type V3 = [number, number, number];
/** The terrain: 8 × 8 tiles of 64 cells, 0.5 m apart, its object at (−128, 0, −128). */
const TILES = 8;
const CELLS = 64;
const SPACING = 0.5;
const ORIGIN: V3 = [-128, 0, -128];
const RANGE: [number, number] = [-32, 96];
/**
 * Rolling bumps with rough ones on top, a few samples across (metres above the object; 0.1–4.1 m: over the
 * editor's grid, under its camera): each level's grid shows a different shape, so a level not morphed into the
 * next where they meet leaves a crack wide enough to see.
 */
const heightAt = (x: number, z: number): number => 2.1 + 1.2 * Math.sin(x / 5) * Math.cos(z / 7) + 0.3 * Math.sin(x / 2.3 + z / 3.1) + 0.5 * Math.sin(x * 2.1) * Math.sin(z * 1.7);
const PAINTED: [number, number] = [-6, -8];
const HOLE: [number, number] = [2, -12];
const PLAIN: [number, number] = [-3, 2];
const SKY = '#00d8ff';
const isSky: Pred = (r, g, b) => b > 150 && g > 120 && r < 70;
/** The fifth layer (index 4: past the template's four slots), painted in a disc here. */
const FIFTH: [number, number] = [3, 6];
const isYellow: Pred = (r, g, b) => r > 80 && g > 70 && b < 0.65 * g && Math.abs(r - g) < 0.3 * r;
/** The player's start (on a strip flattened to 2.1 m) and the way it walks (−z) into the hole. */
const PLAYER: [number, number] = [2, -5];
const STRIP_HEIGHT = 2.1;
/**
 * A ramp steeper than the bumps ever get (rising 11 m over 3 m toward −z, so it faces the cameras), with a disc
 * painted by hand on it; and a block layer of 4 × 3 × 2 cells, its wall facing +z and a steep top cell. The
 * slope rule paints both layer 3 (magenta).
 */
const RAMP_X = -13;
const RAMP: { from: V3; to: V3 } = { from: [RAMP_X, 1, -13], to: [RAMP_X, 10, -16] };
const RAMP_DISC: [number, number] = [RAMP_X, -15.2];
const RAMP_MID: [number, number] = [RAMP_X, -13.8];
const STEEP_DEG = 62;
/** Left of the painted disc (in every camera's view), clear of the tools' strokes. */
const BLOCKS_AT: V3 = [-16, 3, -9];
/** The bumps' steepest (on the 0.5 m grid) is about 51°: the rule's threshold is well past it. */
const STEEP_RULE = { layer: 3, slope: { min: STEEP_DEG, fade: 2 } };
/** Past this (m) the ground draws its tiles' macro textures in Play and the export: most of the frame there. */
const MACRO_DISTANCE = 30;
/** The 1,025² tile's terrain: far out of view (its uploads are what is measured). */
const BIG_ORIGIN: V3 = [3000, 0, 3000];
/** The disc painted layer 2 (green) the scatter rules read (after the first renderer's tools), clear of the other checks and the strokes. */
const GROVE: [number, number] = [-2, 10];
const GROVE_RADIUS = 3.5;
/** The block terrace the block layer's scatter dresses: 4 × 2 × 4 cells, one sloped top. */
const TERRACE_AT: V3 = [12, 3, 4];
/** The scatter rules' models: an orange post, a white tuft. */
const isOrange: Pred = (r, g, b) => r > 110 && g > 0.3 * r && g < 0.75 * r && b < 0.35 * r;
const isWhite: Pred = (r, g, b) => Math.min(r, g, b) > 140 && Math.max(r, g, b) - Math.min(r, g, b) < 45;
/** The posts' impostor size from the dialog: far smaller than they are on any screen here (meshes, until a Play sets 1). */
const POST_IMPOSTOR_SIZE = 0.001;
/**
 * A road (a spline) along the grove's north edge: the ground flattened to 2.6 m under its 2 m width (fading over
 * 1.5 m), painted the fifth layer (yellow), scatter kept 1.5 m clear of it (the posts that would stand there).
 */
const ROAD_AT: V3 = [0, 2.6, 13];
const ROAD = { points: [{ at: [-7, 0, 0] }, { at: [-2, 0, 0] }, { at: [3, 0, 0] }], width: 2, terrain: { falloff: 1.5, paint: { layer: 4, falloff: 0.3 } }, scatter: { margin: 1.5 } };
/** Points on the road's middle the frames look at (clear of its ends and of its object's icon at its origin). */
const ROAD_LOOK: readonly [number, number][] = [[-4.5, 13], [1.5, 13]];
/**
 * A river (a spline) east of the strip: its bed flattened 2 m below its points at the middle, banks at their height,
 * water 0.3 m under the banks (the river template, its colours made blue), and posts (the scatter's post model,
 * colliding) every 3 m along its west bank.
 */
const RIVER_AT: V3 = [14, 2, 0];
const RIVER = { points: [{ at: [0, 0, -20] }, { at: [1, 0, -12] }, { at: [0, 0, -4] }], width: 5, terrain: { shape: 'flatten', depth: 2, falloff: 2 }, scatter: { margin: 1 }, mesh: { kind: 'water', offset: -0.3, foam: 1 }, pieces: [{ asset: { assetId: 'e2e-post' }, spacing: 3, offset: [3.6, 0] }] };
/** A cone stamped beside the terrace (its side 16 m, 20 m high: flanks of 68°, past the slope rule's 62°), and the square eroded round it, clear of every other check. */
const STAMP_AT: [number, number] = [22, 24];
const STAMP_RADIUS = 8;
const STAMP_HEIGHT = 20;
const ERODE_RADIUS = 10;
/** On the river's middle, where the water is deepest. */
const RIVER_LOOK: V3 = [15, RIVER_AT[1] - 0.3, -12];
/** Hides every scatter copy near the middle on the jump key, by address; shows them again on the next. */
const SCATTER_HIDE_SCRIPT = [
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

/** The heightmap as RAW 16-bit little-endian samples of the terrain's range. */
function heightmap(): Uint8Array {
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

async function stage(bytes: Uint8Array): Promise<string> {
  const headers = { authorization: `Bearer ${be!.token}`, origin: be!.origin };
  const base = `${be!.origin}/api/v1/projects/${be!.projectId}/content/stages`;
  const s = (await (await fetch(base, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).json()) as { stageId: string };
  const put = await fetch(`${base}/${s.stageId}/bytes`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) }, body: bytes });
  expect(put.status).toBe(200);
  return s.stageId;
}

async function buildTerrain(): Promise<{ ground: string; big: string; blocks: string; terrace: string; road: string }> {
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
  await cmd('setTransform', { entityId: 'cam-main', transform: { position: [0, ORIGIN[1] + 22, 40], rotation: [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)] } });
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
  // The script that names the scatter copies by address and hides them on the jump key (shows them on the next).
  const switcher = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Scatter switch', transform: { position: [0, 0, 0] } }))['createdId']);
  await publishScript(be!, 'e2e-scatter-hide', SCATTER_HIDE_SCRIPT, switcher);
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
  return { ground, big, blocks, terrace, road };
}

/** The Play camera's view of world points: screen fractions [u, v] (null: behind it). */
type CameraView = { position: number[]; rotation: number[]; fovY: number };
function projectWith(cam: CameraView, aspect: number, p: V3): [number, number] | null {
  const [qx, qy, qz, qw] = cam.rotation as [number, number, number, number];
  const v = [p[0] - cam.position[0]!, p[1] - cam.position[1]!, p[2] - cam.position[2]!];
  // The inverse rotation (the conjugate quaternion) takes the point into the camera's frame.
  const [x, y, z] = [-qx, -qy, -qz];
  const tx = 2 * (y * v[2]! - z * v[1]!);
  const ty = 2 * (z * v[0]! - x * v[2]!);
  const tz = 2 * (x * v[1]! - y * v[0]!);
  const cx = v[0]! + qw * tx + (y * tz - z * ty);
  const cy = v[1]! + qw * ty + (z * tx - x * tz);
  const cz = v[2]! + qw * tz + (x * ty - y * tx);
  if (cz >= -0.01) return null;
  const f = 1 / Math.tan((cam.fovY * Math.PI) / 360);
  return [((f / aspect) * (cx / -cz) + 1) / 2, (1 - f * (cy / -cz)) / 2];
}
/** The share of a square of a frame around a world point (as the camera sees it) passing `test`. */
function frameShareNear(img: Image, cam: CameraView, p: V3, test: Pred, size = 8): number {
  const uv = projectWith(cam, img.width / img.height, p);
  if (uv === null) return 0;
  const cx = Math.round(uv[0] * img.width);
  const cy = Math.round(uv[1] * img.height);
  let n = 0;
  let all = 0;
  for (let y = cy - size / 2; y < cy + size / 2; y++) for (let x = cx - size / 2; x < cx + size / 2; x++) {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
    all += 1;
    if (test(...img.pixel(x, y))) n += 1;
  }
  return all === 0 ? 0 : n / all;
}

/**
 * The road on the terrain: flattened to its height and painted under it, no post within its scatter band (read back
 * from the stored tiles and copies); with a frame, yellow where the camera sees its middle, no post on it.
 */
async function expectRoad(ground: string | null, what: string, frame?: { img: Image; cam: CameraView }): Promise<void> {
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
function expectRoadPixels(what: string, frame: { img: Image; cam: CameraView }): void {
  for (const [x, z] of ROAD_LOOK) {
    expect(frameShareNear(frame.img, frame.cam, [x, ROAD_AT[1], z], isYellow), `${what}: the road yellow at (${x}, ${z})`).toBeGreaterThan(0.5);
    expect(frameShareNear(frame.img, frame.cam, [x, ROAD_AT[1], z], isOrange), `${what}: no post on the road at (${x}, ${z})`).toBe(0);
  }
}

/** The river in a frame: blue water over its deepest part. */
function expectRiver(img: Image, cam: CameraView, what: string): void {
  expect(frameShareNear(img, cam, RIVER_LOOK, isBlue), `${what}: the river's water`).toBeGreaterThan(0.5);
}

/**
 * The road's Scene-view handle (first renderer): a point dragged across the ground is one command that moves the
 * road and shapes the terrain again (flattened at the point's new place); one undo puts it back.
 */
async function roadHandle(page: Page, ground: string, road: string): Promise<void> {
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

type TerrainLayerValue = { id: string; kind: string; enabled?: boolean; stamps?: unknown[]; tiles?: unknown[] };
const layersOf = async (ground: string): Promise<TerrainLayerValue[]> => (((await query('queryEntity', { entityId: ground })) as { entity: { components: { terrain: { layers?: TerrainLayerValue[] } } } }).entity.components.terrain.layers ?? []);

/**
 * The edit layers in the Scene view (see the file's head). `viaEditor`: the stamp placed, the square eroded and the
 * erosion switched with the editor's tools; else the layers made on the first renderer are switched on by command.
 * Each layer's picture on and off around the mountain; the layers are left off (Play and the export as before).
 */
async function editLayers(page: Page, renderer: string, ground: string, road: string, viaEditor: boolean): Promise<void> {
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
 * A band of posts put by hand across the player's strip behind it (the brush's stroke, as a command: every candidate
 * under it, whatever the conditions), three rows too close for the player to walk between; or taken off again (the
 * Scene view's tools then see the ground there). Returns the band's z range.
 */
async function postBand(ground: string, on: boolean): Promise<[number, number]> {
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
async function setPostsImpostor(ground: string, size: number): Promise<void> {
  const rules = (((await query('queryEntity', { entityId: ground })) as { entity: { components: { terrain: { scatter: Record<string, unknown>[] } } } }).entity.components.terrain.scatter);
  await cmd('editTerrain', { entityId: ground, kind: 'bake', scatter: rules.map((r) => (r['id'] === 'posts' ? { ...r, impostorSize: size } : r)) });
}

/** Noise over the whole 1,025² tile (a new tile: read, packed and uploaded again). */
async function bigNoise(big: string, seed: number): Promise<void> {
  await cmd('editTerrain', { entityId: big, kind: 'noise', dabs: [[BIG_ORIGIN[0] + 512, BIG_ORIGIN[2] + 512]], radius: 800, strength: 4, falloff: 'constant', scale: 16, seed });
}

/** World point of the terrain's surface at (x, z) (the stored heights). */
async function surface(ground: string, x: number, z: number): Promise<V3> {
  const h = ((await query('queryTerrain', { entityId: ground, points: [[x, z]] }))['points'] as { height: number | null }[])[0]!.height;
  return [x, h ?? ORIGIN[1] + heightAt(x, z), z];
}

const viewport = (page: Page) => page.locator('.tl-viewport');
async function screenOf(page: Page, p: V3): Promise<{ x: number; y: number }> {
  const m = JSON.parse((await viewport(page).getAttribute('data-view-proj'))!) as number[];
  const box = (await viewport(page).boundingBox())!;
  const [x, y, z] = p;
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  const nx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w;
  const ny = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w;
  return { x: box.x + ((nx + 1) / 2) * box.width, y: box.y + ((1 - ny) / 2) * box.height };
}
/** Zoom the Scene view out until every point is in it (away from its edges), run `check`, and zoom back in. */
async function zoomedOutTo(page: Page, points: readonly V3[], check: () => Promise<void>): Promise<void> {
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
async function shareNear(page: Page, p: V3, test: Pred, size = 10): Promise<number> {
  const s = await screenOf(page, p);
  const img = decodePng(await page.screenshot({ clip: { x: s.x - size / 2, y: s.y - size / 2, width: size, height: size } }));
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (test(...img.pixel(x, y))) n += 1;
  return n / (img.width * img.height);
}

/** Pixels passing `test` (every second one). */
function count(img: Image, test: Pred): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) if (test(...img.pixel(x, y))) n += 1;
  return n;
}

/**
 * The sky pixels (every one: a crack is a pixel wide) and how many of them lie
 * away from the hole: further than `near` of the frame from their median.
 */
function skyPixels(img: Image, near = 0.08): { n: number; away: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (!isSky(...img.pixel(x, y))) continue;
    xs.push(x);
    ys.push(y);
  }
  if (xs.length === 0) return { n: 0, away: 0 };
  const mx = [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
  const my = [...ys].sort((a, b) => a - b)[ys.length >> 1]!;
  let away = 0;
  for (let i = 0; i < xs.length; i++) if (Math.abs(xs[i]! - mx) > near * img.width || Math.abs(ys[i]! - my) > near * img.height) away += 1;
  return { n: xs.length, away };
}

/** Layers and the hole in a frame from the scene camera: red and blue ground, and the sky only through the hole (no crack). */
function frameOk(img: Image): boolean {
  const sky = skyPixels(img);
  return count(img, isRed) / ((img.width * img.height) / 4) > 0.5 && count(img, isBlue) > 20 && count(img, isYellow) > 20 && count(img, isMagenta) > 60 && count(img, isOrange) > 15 && count(img, isWhite) > 15 && sky.n > 40 && sky.away === 0;
}
function expectFrame(img: Image, what: string): void {
  expect(count(img, isRed) / ((img.width * img.height) / 4), `${what}: red ground`).toBeGreaterThan(0.5);
  expect(count(img, isBlue), `${what}: the painted disc`).toBeGreaterThan(20);
  expect(count(img, isYellow), `${what}: the disc of the fifth layer`).toBeGreaterThan(20);
  expect(count(img, isMagenta), `${what}: the steep ramp and the block walls painted by the slope rule`).toBeGreaterThan(60);
  expect(count(img, isOrange), `${what}: the scatter rules' posts`).toBeGreaterThan(15);
  expect(count(img, isWhite), `${what}: the ground cover's tufts near the camera`).toBeGreaterThan(15);
  const sky = skyPixels(img);
  expect(sky.n, `${what}: the sky through the hole`).toBeGreaterThan(40);
  expect(sky.away, `${what}: sky pixels away from the hole (a crack between levels or tiles)`).toBe(0);
}

function serveDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

// ---- the Terrain tools ----------------------------------------------------------------------------

type PreviewDiff = { samples: number; stepsMax: number; stepsDiffering: number; normalMax: number; weightMax: number; holesDiffering: number; indicesDiffering: number };
type StrokeInfo = { serial: number; tool: string; dabs: number; commitMs: number | null; stored: boolean | null; preview?: { active: boolean; settling: boolean; dabs: number; passes: number; tiles: number; msMax: number; msMean: number; frames: number; msMaxAfterFirst: number; settleMs: number | null; diff: PreviewDiff | null } };
const strokeInfo = async (page: Page): Promise<StrokeInfo | null> => JSON.parse((await viewport(page).getAttribute('data-terrain-stroke')) ?? 'null') as StrokeInfo | null;
const terrainPanel = (page: Page) => page.getByLabel('terrain tools');
const terrainTool = (page: Page, name: string) => terrainPanel(page).getByRole('toolbar', { name: 'terrain tool' }).getByRole('button', { name, exact: true });
async function selectEntity(page: Page, id: string): Promise<void> {
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
  await expect(terrainPanel(page)).toBeVisible();
  await expect(viewport(page)).toHaveAttribute('data-terrain-tool', /\w/);
}
async function setNumber(page: Page, label: string, value: number): Promise<void> {
  const f = terrainPanel(page).getByLabel(label, { exact: true });
  await f.fill(String(value));
  await f.blur();
}
/** The ground the brush cursor finds under a screen point (null: no terrain there). */
async function cursorAt(page: Page, s: { x: number; y: number }): Promise<V3 | null> {
  await page.mouse.move(s.x + 1, s.y);
  await page.mouse.move(s.x, s.y);
  // The cursor follows each pointer move at once.
  const at = (await viewport(page).getAttribute('data-terrain-brush')) ?? '';
  return at === '' ? null : (at.split(',').map(Number) as V3);
}
/** The first of `candidates` (x, z) the view sees: the cursor lands on it. */
async function visibleSpot(page: Page, ground: string, candidates: readonly [number, number][]): Promise<V3> {
  for (const [x, z] of candidates) {
    const p = await surface(ground, x, z);
    const hit = await cursorAt(page, await screenOf(page, p));
    if (hit !== null && Math.hypot(hit[0] - x, hit[2] - z) < 0.3) return p;
  }
  throw new Error(`none of ${JSON.stringify(candidates)} is in view`);
}
/** A square of the Scene view around a world point. */
async function shot(page: Page, p: V3, size: number): Promise<Image> {
  const s = await screenOf(page, p);
  return decodePng(await page.screenshot({ clip: { x: s.x - size / 2, y: s.y - size / 2, width: size, height: size } }));
}
/** The mean absolute difference of two equal-sized pictures (0–255 per channel). */
function meanDiff(a: Image, b: Image): number {
  let sum = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const p = a.pixel(x, y);
    const q = b.pixel(x, y);
    sum += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
  }
  return sum / (a.width * a.height * 3);
}
function share(img: Image, test: Pred): number {
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (test(...img.pixel(x, y))) n += 1;
  return n / (img.width * img.height);
}
/**
 * A stroke through world points with the pointer held until every dab is drawn
 * (the preview's picture taken then), released, and stored: the stroke's
 * figures once the stored tiles replaced the preview, with the pictures
 * around `look` before, during and after.
 */
async function terrainStroke(page: Page, points: readonly V3[], look: V3, size: number, held = true): Promise<{ info: StrokeInfo; before: Image; preview: Image; after: Image }> {
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
const BACKENDS: readonly ('webgpu' | 'webgl2')[] = gpuAvailable() ? ['webgpu', 'webgl2'] : ['webgl2'];

test('terrain: CDLOD heights, layered material, paint and a hole in the Scene view, Play and the export, without cracks (WebGPU and WebGL 2)', async ({ page }) => {
  test.skip(test.info().project.name === 'webgpu', 'one pass covers both renderers');
  test.setTimeout(420_000);
  be = await startBackend('terrain-cdlod');
  const { ground, big, blocks, terrace, road } = await buildTerrain();
  const plain = await surface(ground, ...PLAIN);
  const painted = await surface(ground, ...PAINTED);
  const holeAt: V3 = [HOLE[0], (await surface(ground, ...HOLE))[1], HOLE[1]];
  const fifth = await surface(ground, ...FIFTH);
  let holed = false;
  let roadCam: CameraView | null = null;

  for (const renderer of BACKENDS) {
    await page.goto(be.editorUrl.replace('#', `&renderer=${renderer}&terrainCheck=1#`));
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    const canvas = page.locator('canvas.tl-viewport');
    await expect.poll(() => canvas.evaluate((c) => `${c.getAttribute('data-tl-renderer')}/${c.getAttribute('data-tl-renderer-state')}`), { timeout: 30_000 }).toBe(`${renderer}/ready`);
    await expect(viewport(page)).toHaveAttribute('data-view-proj', /\[/);
    // Every tile read and uploaded, one draw for the page of tiles, nothing failed to read.
    const terrain = async (): Promise<TerrainDiag> => JSON.parse((await viewport(page).getAttribute('data-terrain')) ?? '{"tilesDrawn":0,"draws":0,"perLevel":[],"errors":[]}');
    // The 64 tiles and the far 1,025² one.
    await expect.poll(async () => (await terrain()).tilesDrawn, { timeout: 60_000 }).toBe(TILES * TILES + 1);
    const t = await terrain();
    // One page per terrain: the 64 tiles' and the far tile's (a tile's root is always selected: shadow maps draw it).
    expect(t.draws).toBe(2);
    expect(t.errors).toEqual([]);
    // Packed on a worker, uploaded a layer texture at a time: no frame spent more than a few milliseconds of the page's time on it.
    test.info().annotations.push({ type: `${renderer} Scene view terrain`, description: JSON.stringify({ uploadMsPeak: t.uploadMsPeak, uploadBytesPeak: t.uploadBytesPeak, decodeMs: t.decodeMs, packMs: t.packMs, cpuBytes: t.cpuBytes }) });
    expect(t.uploadMsPeak!, 'the most a frame spent uploading').toBeLessThan(8);
    expect(t.uploadBytesPeak!, 'the most a frame uploaded (one 1,025² layer texture)').toBeLessThanOrEqual(1025 * 1025 * 4);
    // The quadtree's three levels (8, 16, 32 m nodes) are all drawn; the far tile (seven levels) only at its root.
    expect(t.perLevel.length).toBe(7);
    expect(t.perLevel.slice(0, 3).every((n) => n > 0)).toBe(true);
    // The Scene view: the layered material's layer 1 where unpainted, layer 3 on the painted disc.
    await expect.poll(() => shareNear(page, plain, isRed), { timeout: 60_000, message: `${renderer} Scene view: red ground` }).toBeGreaterThan(0.8);
    await expect.poll(() => shareNear(page, painted, isBlue), { timeout: 30_000, message: `${renderer} Scene view: the painted disc` }).toBeGreaterThan(0.8);
    // Layer index 4: past the template's four slots, drawn from the array's fifth layer.
    await expect.poll(() => shareNear(page, fifth, isYellow), { timeout: 30_000, message: `${renderer} Scene view: the fifth layer's disc` }).toBeGreaterThan(0.8);
    // The road the spline flattened and painted (yellow), and the river's water (blue): the view zooms out until both are
    // in it, then back.
    await zoomedOutTo(page, [...ROAD_LOOK.map(([x, z]) => [x, ROAD_AT[1], z] as V3), RIVER_LOOK], async () => {
      for (const [x, z] of ROAD_LOOK) await expect.poll(() => shareNear(page, [x, ROAD_AT[1], z], isYellow, 6), { timeout: 30_000, message: `${renderer} Scene view: the road at (${x}, ${z})` }).toBeGreaterThan(0.6);
      await expect.poll(() => shareNear(page, RIVER_LOOK, isBlue, 6), { timeout: 30_000, message: `${renderer} Scene view: the river's water` }).toBeGreaterThan(0.6);
    });
    if (!holed) {
      expect(await shareNear(page, holeAt, (r, g, b) => isRed(r, g, b) || isBlue(r, g, b))).toBeGreaterThan(0.8);
      // A holes stroke with the page open: its tile's layers are uploaded again and the ground there is cut away.
      await cmd('editTerrain', { entityId: ground, kind: 'holes', dabs: [HOLE], radius: 3 });
      holed = true;
    }
    await expect.poll(() => shareNear(page, holeAt, (r, g, b) => !isRed(r, g, b) && !isBlue(r, g, b)), { timeout: 30_000, message: `${renderer} Scene view: the hole` }).toBeGreaterThan(0.6);

    // The 1,025² tile sculpted with the page open: packed on the worker, its 12.6 MB of texels uploaded over a few frames.
    // The page's frames meanwhile (a rAF loop beside the view's) are recorded; what the uploads took of each is asserted.
    const uploaded = (await terrain()).tilesUploaded!;
    await page.evaluate(() => {
      const w = window as unknown as { __tlFrames?: number[] };
      const frames: number[] = (w.__tlFrames = []);
      let last = performance.now();
      const tick = (now: number): void => {
        frames.push(now - last);
        last = now;
        if (frames.length < 2000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await bigNoise(big, renderer === 'webgpu' ? 8 : 9);
    await expect.poll(async () => (await terrain()).tilesUploaded!, { timeout: 30_000, message: `${renderer} Scene view: the sculpted 1,025² tile uploaded again` }).toBeGreaterThan(uploaded);
    const rafFrames = await page.evaluate(() => (window as unknown as { __tlFrames: number[] }).__tlFrames.splice(0));
    const after = await terrain();
    test.info().annotations.push({ type: `${renderer} Scene view 1,025² re-upload`, description: JSON.stringify({ frames: rafFrames.length, maxMs: Math.round(Math.max(...rafFrames) * 10) / 10, missedVsync: rafFrames.filter((f) => f > 25).length, uploadMsPeak: after.uploadMsPeak, uploadBytesPeak: after.uploadBytesPeak, decodeMs: after.decodeMs, packMs: after.packMs }) });
    expect(after.uploadMsPeak!, 'the most a frame spent uploading').toBeLessThan(8);
    expect(after.errors).toEqual([]);

    if (renderer === BACKENDS[0]) {
      // The terrain tools (their previews against the stored tiles), then the material rules from the editor.
      await terrainTools(page, renderer, ground, big, true);
      await materialRules(page, ground, blocks);
      await scatterRules(page, ground, terrace);
      await expectRoad(ground, `${renderer} (stored)`);
      await roadHandle(page, ground, road);
      await editLayers(page, renderer, ground, road, true);
    } else {
      // The rules baked on the first renderer: the steep ramp and the block walls magenta, the hand-painted disc on
      // the ramp blue, the layer's flat top red (layer 0). The view zooms out until they are all in it, then back.
      const checks: [string, V3, Pred][] = [
        ['the steep ramp', [RAMP_MID[0], (await surface(ground, ...RAMP_MID))[1], RAMP_MID[1]], isMagenta],
        ['the disc painted by hand on the ramp', [RAMP_DISC[0], (await surface(ground, ...RAMP_DISC))[1], RAMP_DISC[1]], isBlue],
        ['the block wall', [BLOCKS_AT[0] + 2.5, BLOCKS_AT[1] + 2.4, BLOCKS_AT[2] + 2], isMagenta],
        ['the block layer\'s steep top', [BLOCKS_AT[0] + 1.5, BLOCKS_AT[1] + 4.5, BLOCKS_AT[2] + 0.5], isMagenta],
        ['the block layer\'s flat top', [BLOCKS_AT[0] + 3, BLOCKS_AT[1] + 3, BLOCKS_AT[2] + 1], isRed],
      ];
      const box = (await viewport(page).boundingBox())!;
      const inView = async (): Promise<boolean> => {
        for (const [, p] of checks) {
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
      expect(await inView(), `${renderer} Scene view: the ramp and the block layer in view`).toBe(true);
      for (const [what, p, test] of checks) {
        await expect.poll(() => shareNear(page, p, test, 6), { timeout: 30_000, message: `${renderer} Scene view: ${what}` }).toBeGreaterThan(0.6);
      }
      // Layer 3's projection on the ramp: checks counted along its middle, top against by slope and biplanar.
      const crossings: Record<string, number> = {};
      for (const [name, mode] of [['top', 0], ['by slope', 1], ['biplanar', 2]] as const) {
        await setLayer3(mode, 2);
        let n = -1;
        await expect.poll(async () => (n = await checkCrossings(page, ground)), { timeout: 30_000, message: `${renderer} Scene view: the ramp's checker, ${name}` }).toBeGreaterThan(name === 'top' ? 0 : 2 * Math.max(1, crossings['top'] ?? 1));
        crossings[name] = n;
      }
      test.info().annotations.push({ type: `${renderer} layer 3 checker crossings along the ramp`, description: JSON.stringify(crossings) });
      console.log(`${renderer} layer 3 checker crossings along the ramp: ${JSON.stringify(crossings)}`);
      for (let i = 0; i < zoomed; i++) {
        await page.mouse.wheel(0, -200);
        await page.waitForTimeout(80);
      }
      await terrainTools(page, renderer, ground, big, false);
      await editLayers(page, renderer, ground, road, false);
    }

    // In Play (and the export), tiles past MACRO_DISTANCE are drawn from their baked macro textures.
    await cmd('setComponent', { entityId: ground, component: 'terrain', value: { macroDistance: MACRO_DISTANCE } });
    // The posts across the player's strip, for this renderer's Plays.
    const band = await postBand(ground, true);
    // Play: the scene camera's frame.
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
    {
      // Every tile of the ground baked, and the far nodes drawn from them, before the frame is judged.
      let m: TerrainDiag['macro'] | undefined;
      await expect
        .poll(async () => {
          m = (((await relay(`${psid}/diagnostics`, {})).json as { diagnostics?: Diagnostics }).diagnostics ?? {}).renderer?.terrain?.macro;
          return m !== undefined && m.baked >= TILES * TILES && m.farNodes > 0;
        }, { timeout: 60_000, message: `${renderer} Play: the macro textures baked and drawn` })
        .toBe(true);
      test.info().annotations.push({ type: `${renderer} Play macro`, description: JSON.stringify(m) });
      console.log(`${renderer} Play macro: ${JSON.stringify(m)}`);
    }
    {
      // The scatter: the posts drawn from their stored copies, the tufts made near the camera (on the view worker).
      let d: Record<string, unknown> | undefined;
      await expect
        .poll(async () => {
          d = (((await relay(`${psid}/diagnostics`, {})).json as { diagnostics?: { renderer?: Record<string, unknown> } }).diagnostics ?? {}).renderer;
          const sc = d?.['scatter'] as { copies?: number } | undefined;
          const cv = d?.['cover'] as { copies?: number } | undefined;
          return (sc?.copies ?? 0) > 10 && (cv?.copies ?? 0) > 10;
        }, { timeout: 60_000, message: `${renderer} Play: the scatter drawn and the ground cover made` })
        .toBe(true)
        .catch((e: Error) => {
          console.log(`${renderer} Play scatter: ${JSON.stringify({ scatter: d?.['scatter'], cover: d?.['cover'] })}`);
          throw e;
        });
      console.log(`${renderer} Play scatter: ${JSON.stringify({ scatter: d?.['scatter'], cover: d?.['cover'] })}`);
    }
    let last: Image | null = null;
    // A frame counts only while every tile's bake is current and far nodes are drawn from them throughout.
    const macroNow = async (): Promise<string> => {
      const m = (((await relay(`${psid}/diagnostics`, {})).json as { diagnostics?: Diagnostics }).diagnostics ?? {}).renderer?.terrain?.macro;
      return m !== undefined && m.waiting === 0 && m.baked >= TILES * TILES && m.farNodes > 0 ? `${m.bakes}` : 'not drawn from macro textures';
    };
    await expect
      .poll(async () => {
        const before = await macroNow();
        // Full size: a crack is a pixel wide.
        const shot = await relay(`${psid}/screenshot`, { maxWidth: 2048 });
        if (shot.status !== 200) return false;
        last = decodePng(Buffer.from(String(shot.json['dataUrl'] ?? '').split(',')[1] ?? '', 'base64'));
        if (before.startsWith('not') || (await macroNow()) !== before) return false;
        return frameOk(last);
      }, { timeout: 90_000, message: `${renderer} Play: the terrain with its layers and hole` })
      .toBe(true)
      .catch((e: Error) => {
        if (last !== null) expectFrame(last, `${renderer} Play`);
        throw e;
      });
    expectFrame(last!, `${renderer} Play`);
    // The road and the river in Play's frame, where the scene camera sees them.
    roadCam = ((await relay(`${psid}/observe`, {})).json as { camera?: CameraView }).camera ?? null;
    expect(roadCam, `${renderer} Play: the camera observed`).not.toBeNull();
    await expectRoad(ground, `${renderer} Play`, { img: last!, cam: roadCam! });
    expectRiver(last!, roadCam!, `${renderer} Play`);
    {
      // The river's mesh pieces and posts drawn, the posts' colliders in the simulation (the water has none).
      type SplineDiag = { renderer?: { splines?: { meshPieces: number; triangles: number; copies: number; errors: string[] } }; runtime?: { splines?: { colliders: number; waiting: number } } };
      let sd: SplineDiag = {};
      await expect
        .poll(async () => {
          sd = ((await relay(`${psid}/diagnostics`, {})).json as { diagnostics?: SplineDiag }).diagnostics ?? {};
          return `${(sd.renderer?.splines?.meshPieces ?? 0) > 0} ${sd.renderer?.splines?.copies ?? 0} ${sd.runtime?.splines?.colliders ?? 0}`;
        }, { timeout: 30_000, message: `${renderer} Play: the river's mesh, posts and their colliders` })
        .toBe('true 6 6');
      const shown = { renderer: sd.renderer?.splines, runtime: sd.runtime?.splines };
      test.info().annotations.push({ type: `${renderer} Play splines`, description: JSON.stringify(shown) });
      console.log(`${renderer} Play splines: ${JSON.stringify(shown)}`);
    }

    // Play's diagnostics: the tiles drawn (the far one too), the page's decoded copy, the simulation's colliders.
    let diag: Diagnostics = {};
    await expect
      .poll(async () => {
        diag = ((await relay(`${psid}/diagnostics`, {})).json as { diagnostics?: Diagnostics }).diagnostics ?? {};
        return `${diag.renderer?.terrain?.tilesDrawn ?? 0} ${diag.runtime?.terrainMemory?.waiting ?? -1}`;
      }, { timeout: 60_000, message: `${renderer} Play: every tile drawn and every collider built` })
      .toBe(`${TILES * TILES + 1} 0`);
    const mem = diag.runtime!.terrainMemory!;
    test.info().annotations.push({ type: `${renderer} Play terrain`, description: JSON.stringify({ renderer: diag.renderer!.terrain, collision: mem }) });
    // Every tile has colliders (the holed one in patches); the page holds one decoded copy (65 tiles' worth).
    expect(mem.tilesWithColliders).toBe(TILES * TILES + 1);
    expect(mem.colliders).toBeGreaterThan(TILES * TILES + 1);
    expect(diag.renderer!.terrain!.cpuBytes!).toBeGreaterThan(1025 * 1025 * 2);
    expect(diag.renderer!.terrain!.uploadMsPeak!).toBeLessThan(8);

    // The script names the scatter copies by address and hides them (the jump key): the posts leave the frame (the
    // pixels orange before and not after are theirs), the simulation and the renderer count them hidden; the key
    // again shows them.
    const frameNow = async (sid: string): Promise<Image | null> => {
      const s = await relay(`${sid}/screenshot`, { maxWidth: 1024 });
      return s.status === 200 ? decodePng(Buffer.from(String(s.json['dataUrl'] ?? '').split(',')[1] ?? '', 'base64')) : null;
    };
    const jump = async (sid: string): Promise<void> => {
      const r = await relay(`${sid}/input`, { mode: 'exclusive-test', frames: [{ stepOffset: 0, ...controls(0, 'pressed') }] });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    };
    type ScatterDiag = { runtime?: { scatterCopies?: { hidden: number; colliders: number; copies: number } }; renderer?: { scatter?: { hidden: number; copies: number; instances: { byLevel: number[] }; impostors?: { baked: number; bytes: number; bakeMsMax: number } } } };
    const sdiag = async (sid: string): Promise<ScatterDiag> => ((await relay(`${sid}/diagnostics`, {})).json as { diagnostics?: ScatterDiag }).diagnostics ?? {};
    /** The posts' pixels: orange with them shown, not with them hidden (the frame's other orange stays), and their mean colour. */
    const posts = async (sid: string, what: string): Promise<{ n: number; tint: [number, number, number] }> => {
      const shownImg = (await frameNow(sid))!;
      await jump(sid);
      let d: ScatterDiag = {};
      await expect.poll(async () => {
        d = await sdiag(sid);
        return (d.runtime?.scatterCopies?.hidden ?? 0) > 0 && d.renderer?.scatter?.hidden === d.runtime?.scatterCopies?.hidden;
      }, { timeout: 30_000, message: `${what}: the hidden copies counted by the simulation and the renderer` }).toBe(true);
      let out = { n: 0, tint: [0, 0, 0] as [number, number, number] };
      await expect.poll(async () => {
        const hiddenImg = await frameNow(sid);
        if (hiddenImg === null) return 0;
        const sum = [0, 0, 0];
        let n = 0;
        for (let y = 0; y < shownImg.height; y++) for (let x = 0; x < shownImg.width; x++) {
          const p = shownImg.pixel(x, y);
          if (!isOrange(...p) || isOrange(...hiddenImg.pixel(x, y))) continue;
          sum[0] += p[0];
          sum[1] += p[1];
          sum[2] += p[2];
          n += 1;
        }
        out = { n, tint: [sum[0]! / Math.max(1, n), sum[1]! / Math.max(1, n), sum[2]! / Math.max(1, n)] };
        return n;
      }, { timeout: 30_000, message: `${what}: the script hid the posts` }).toBeGreaterThan(60);
      test.info().annotations.push({ type: `${what} scatter hidden`, description: JSON.stringify({ postPixels: out.n, runtime: d.runtime?.scatterCopies, renderer: d.renderer?.scatter?.hidden }) });
      console.log(`${what}: the script hid ${d.runtime?.scatterCopies?.hidden} copies by address (the renderer ${d.renderer?.scatter?.hidden}), ${out.n} post pixels left the frame`);
      await jump(sid);
      await expect.poll(async () => (await sdiag(sid)).renderer?.scatter?.hidden ?? -1, { timeout: 30_000, message: `${what}: the script showed the posts again` }).toBe(0);
      return out;
    };
    const meshPosts = await posts(psid, `${renderer} Play`);

    // The player stands on the terrain, walks back (+z) into the posts across the strip (they collide), then forward
    // (−z) into the hole and falls through it.
    const read = async (): Promise<Observation | null> => {
      const r = await relay(`${psid}/observe`, {});
      return r.status === 200 ? (r.json as unknown as Observation) : null;
    };
    const standing: { o: Observation | null } = { o: null };
    await expect
      .poll(async () => {
        const o = await read();
        const before = standing.o;
        const same = o?.player !== undefined && before?.player !== undefined && Math.abs(o.player.y - before.player.y) < 1e-4 && (o.stepIndex ?? 0) > (before.stepIndex ?? 0);
        standing.o = o;
        return same;
      }, { timeout: 30_000, intervals: [250], message: `${renderer} Play: the player at rest` })
      .toBe(true);
    const at = standing.o!.player!;
    expect(Math.abs(at.y - (STRIP_HEIGHT + 0.9)), `${renderer} Play: standing on the terrain (at y ${at.y})`).toBeLessThan(0.05);
    {
      // Two seconds back toward the band of posts (a second a request: the relay's body bound): about 8 m at the
      // walking speed, through it were it not solid.
      const back = Array.from({ length: 120 }, (_, k) => ({ stepOffset: k, ...controls(0, 'none', -1) }));
      for (let leg = 0; leg < 2; leg++) {
        const r = await relay(`${psid}/input`, { mode: 'exclusive-test', frames: back });
        expect(r.status, JSON.stringify(r.json)).toBe(200);
        await page.waitForTimeout(1200);
      }
      await expect.poll(async () => (await read())?.player?.z ?? at.z, { timeout: 30_000, message: `${renderer} Play: walking back` }).toBeGreaterThan(at.z + 0.5);
      await page.waitForTimeout(1000);
      const stopped = (await read())!.player!;
      const colliders = (await sdiag(psid)).runtime?.scatterCopies?.colliders ?? 0;
      test.info().annotations.push({ type: `${renderer} Play scatter collision`, description: JSON.stringify({ from: at.z, stopped: stopped.z, band, colliders }) });
      console.log(`${renderer} Play scatter collision: from z ${at.z.toFixed(2)} stopped at ${stopped.z.toFixed(2)}, the band z ${band[0].toFixed(2)}–${band[1].toFixed(2)}, ${colliders} copy colliders`);
      expect(stopped.z, `${renderer} Play: the posts across the strip (z ${band[0].toFixed(2)}–${band[1].toFixed(2)}) stopped the player`).toBeLessThan(band[1]);
      expect(colliders, `${renderer} Play: the posts' colliders`).toBeGreaterThan(8);
    }
    // A second of forward a request (the relay's body bound), until it is in the hole (about 5 m at the walking speed).
    const frames = Array.from({ length: 120 }, (_, k) => ({ stepOffset: k, ...controls(0, 'none', 1) }));
    for (let leg = 0; leg < 4 && ((await read())?.player?.y ?? 0) > STRIP_HEIGHT - 0.5; leg++) {
      const from = (await read())!.player!.z;
      const walk = await relay(`${psid}/input`, { mode: 'exclusive-test', frames });
      expect(walk.status, JSON.stringify(walk.json)).toBe(200);
      // The leg walked (or the ground gave way).
      await expect.poll(async () => {
        const p = (await read())?.player;
        return p !== undefined && (p.z < from - 1.5 || p.y < STRIP_HEIGHT - 0.5);
      }, { timeout: 30_000, message: `${renderer} Play: walking forward (leg ${leg + 1})` }).toBe(true);
      await page.waitForTimeout(1200);
    }
    await expect.poll(async () => (await read())?.player?.y ?? Infinity, { timeout: 30_000, message: `${renderer} Play: fell through the hole` }).toBeLessThan(STRIP_HEIGHT - 3);
    const fell = (await read())!.player!;
    expect(fell.z, `${renderer} Play: it went forward into the hole`).toBeLessThan(HOLE[1] + 3.5);

    // A second Play with every post drawn as its impostor (the rule's size 1: smaller than the whole view, so at any
    // distance): baked once, every copy at the impostor's level, the posts' pixels as many and as orange as the
    // meshes' were (both found the same way: shown against hidden by the script).
    await setPostsImpostor(ground, 1);
    await page.getByTitle('Stop the play preview').click();
    await expect(page.getByTitle('Start an isolated play preview')).toBeVisible({ timeout: 30_000 });
    const restarted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    const psid2 = String(((await (await restarted).json()) as { playSessionId: string }).playSessionId);
    let far: ScatterDiag = {};
    await expect
      .poll(async () => {
        far = await sdiag(psid2);
        const sc = far.renderer?.scatter;
        // The terrain's posts at the impostor's level (the terrace's own rule keeps its meshes).
        return (sc?.impostors?.baked ?? 0) >= 1 && (sc?.instances.byLevel[1] ?? 0) > 10;
      }, { timeout: 60_000, message: `${renderer} Play: the posts drawn as impostors` })
      .toBe(true)
      .catch((e: Error) => {
        console.log(`${renderer} Play impostors: ${JSON.stringify(far.renderer?.scatter)}`);
        throw e;
      });
    // The frame once the impostors are in (settled: two frames alike).
    await page.waitForTimeout(1000);
    const farPosts = await posts(psid2, `${renderer} Play (impostors)`);
    const ratio = farPosts.n / meshPosts.n;
    test.info().annotations.push({ type: `${renderer} Play impostors`, description: JSON.stringify({ meshPixels: meshPosts.n, impostorPixels: farPosts.n, meshTint: meshPosts.tint.map(Math.round), impostorTint: farPosts.tint.map(Math.round), impostors: far.renderer?.scatter?.impostors }) });
    console.log(`${renderer} Play impostors: post pixels ${meshPosts.n} → ${farPosts.n}, tint ${meshPosts.tint.map(Math.round)} → ${farPosts.tint.map(Math.round)}, ${JSON.stringify(far.renderer?.scatter?.impostors)}`);
    expect(ratio, `${renderer} Play: the impostors' posts' pixels against the meshes'`).toBeGreaterThan(0.6);
    expect(ratio, `${renderer} Play: the impostors' posts' pixels against the meshes'`).toBeLessThan(1.6);
    for (let k = 0; k < 3; k++) expect(Math.abs(farPosts.tint[k]! - meshPosts.tint[k]!), `${renderer} Play: the impostors' orange against the meshes' (channel ${k})`).toBeLessThan(40);
    await setPostsImpostor(ground, POST_IMPOSTOR_SIZE);
    await postBand(ground, false);
    // The next renderer's Scene view draws the layers everywhere again (its checks count one draw per page); the last keeps far ground for the export.
    if (renderer !== BACKENDS[BACKENDS.length - 1]) await cmd('setComponent', { entityId: ground, component: 'terrain', value: { macroDistance: null } });
  }

  // The static export with the backend stopped, on each renderer.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
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
        let last: Image | null = null;
        await expect
          .poll(async () => {
            last = decodePng(await c.screenshot());
            return frameOk(last);
          }, { timeout: 60_000, message: `${renderer} export: the terrain with its layers and hole` })
          .toBe(true)
          .catch((e: Error) => {
            if (last !== null) expectFrame(last, `${renderer} export`);
            throw e;
          });
        expectFrame(last!, `${renderer} export`);
        // The backend is stopped: the export's frame alone.
        await expectRoad(null, `${renderer} export`, { img: last!, cam: roadCam! });
        expectRiver(last!, roadCam!, `${renderer} export`);
        expect(errors).toEqual([]);
      } finally {
        await game.close();
      }
    }
  } finally {
    await site.close();
  }
});

/**
 * The Terrain tools in the Scene view (see the file's header). Leaves the ground as it was (every stroke undone) and
 * the 1,025² tile raised.
 */
/** Ground points for the strokes: a grid round the view's middle, away from the painted discs, the hole and the plain point. */
function spots(away: readonly V3[]): [number, number][] {
  const keep: [number, number, number][] = [[...PAINTED, 6], [...FIFTH, 4.5], [...HOLE, 5], [...PLAIN, 2.5], ...away.map((p) => [p[0], p[2], 3.5] as [number, number, number])];
  const out: [number, number][] = [];
  for (let z = -10; z <= 4; z += 1.5) for (let x = -8; x <= 6; x += 1.5) if (keep.every(([kx, kz, r]) => Math.hypot(x - kx, z - kz) > r)) out.push([x, z]);
  return out.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
}

async function terrainTools(page: Page, renderer: string, ground: string, big: string, first: boolean): Promise<void> {
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
async function materialRules(page: Page, ground: string, blocks: string): Promise<void> {
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
async function setLayer3(mode: number, tiling: number): Promise<void> {
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
async function checkCrossings(page: Page, ground: string): Promise<number> {
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
async function scatterRules(page: Page, ground: string, terrace: string): Promise<void> {
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
