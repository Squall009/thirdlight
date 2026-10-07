/**
 * Block layers against a real backend.
 *
 * A small map is built with the bulk commands over HTTP (the commands MCP's
 * tl_command sends): a 3D project, block types (coloured stand-ins), a cell
 * metadata schema, a block layer entity, and `editBlocks` edits — a stone
 * slab from a box fill, a heightmap PNG import with a colour map, a region
 * and painted metadata. The cells are read back with `queryBlocks` (MCP's
 * tl_content_query target "blocks"), and each chunk lies in its own file.
 *
 * The editor's Scene view meshes the layer. In Play (the simulation worker)
 * a player capsule falls onto the blocks and rests on them; a script clears
 * the cells under it at 3 s and it falls through the hole onto a floor
 * below. The blocks are seen in the Play screenshot (grass-green pixels).
 * The static export, served with the backend stopped, does the same.
 *
 * A beacon block type shows a prefab: its root's base model is drawn in the
 * chunk; the Blocks panel's block type form turns it live, so in Play and
 * the export each beacon cell also spawns the prefab's magenta post as an
 * object of the game (counted in Play's diagnostics, seen in the pictures
 * on both renderers), and the dug column's beacon goes with its cell.
 *
 * Edge pieces stand on cell edges: a cyan wall two rows high along a grid
 * line, and a live gate whose prefab's orange leaf is an object of the
 * game; both are seen in Play and the export on both renderers.
 *
 * A connected wall resolves its pieces from its neighbours: its straight
 * runs, its corner and its T-join each show their own look (yellow, red,
 * blue) in Play and the export on both renderers.
 *
 * Two roofs are cut-aways: a lavender one over the spawn hidden (with a fade)
 * while the camera's target, the player, is inside the pit region below the
 * floor, and a pink one elsewhere, cut only while the target stands under
 * it (never here). Before the dig both are drawn; once the player has fallen
 * into the pit the lavender roof is gone and the pink one stays — in Play and
 * the export, on both renderers.
 *
 * A white banner (a slab beside the pink roof) has a burnt kit: the digger
 * shows the kit over the layer when it digs, and the banner turns violet —
 * re-meshed in the background, in Play and the export, on both renderers.
 *
 * A new project stores the chunk as a binary file; turning the project's
 * `block_chunk_storage` to 0 rewrites it as JSON text (the same cells
 * through queryBlocks). The export ships the cells as binary chunk data the
 * game reads back, on WebGPU and (on a GPU host) WebGL 2.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from './pw';

import { publishBytes, startBackend, type E2EBackend } from './backend';
import { gpuAvailable } from './browser-env.mjs';
import { multiPieceGlb } from './multi-piece-glb';
import { closeProjectSettings, openProjectSettings, openWindow } from './ui';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

type Observation = { state: string; stepIndex?: number; player?: { x: number; y: number; z: number } };

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-blocks' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}

async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function relay(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return api(`play/${path}`, body);
}

/** Publish a behavior with this source and attach it to `entityId`. */
async function script(behaviorId: string, source: string, entityId: string): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  const declaration = { properties: [{ key: 'at_step', label: 'At step', type: 'number', default: 720, min: 1, max: 100000, step: 1 }] };
  await cmd('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId, behaviorId, values: { at_step: DIG_STEP } });
}

/**
 * 3 s into the run: the player lands within its first second, which leaves two to see it resting on the blocks
 * first (the observation polls the simulation, not the drawn frames, so a slowly rendering Play does not eat it).
 */
const DIG_STEP = 360;

/** Clears the cells of the column under the player (every layer) at one step. */
const DIGGER = [
  'export default {',
  '  instantiate() { return {}; },',
  '  step(state, ctx) {',
  "    if (ctx.phase !== 'intent' || ctx.stepIndex !== ctx.properties.at_step) return;",
  "    const player = ctx.world.find('Player');",
  '    const p = ctx.world.transform(player).position;',
  '    for (const layer of ctx.grid.layers()) {',
  '      const c = ctx.grid.worldToCell(layer, [p[0], p[1], p[2]]);',
  '      const top = ctx.grid.columnTop(layer, c.x, c.z);',
  "      if (top !== null) for (let y = top; y >= 0; y--) ctx.grid.clear(layer, c.x, y, c.z);",
  "      ctx.log('info', `dug ${c.x},${c.z} below ${top}: walkable ${ctx.grid.meta(layer, c.x, 0, c.z, 'walkable')}`);",
  "      ctx.grid.setKit(layer, 'burnt');",
  '    }',
  '  },',
  '};',
].join('\n');

/** Grass-green pixels: green well above red and blue (the stand-in's Lambert shading keeps the hue). */
function greenPixels(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (g > r + 35 && g > b + 35 && g > 60) n += 1;
    }
  }
  return n;
}

/** Magenta pixels (red and blue well above green; shaded posts are dark): the live beacons' posts. */
function magentaPixels(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (r > 70 && b > 70 && g < Math.min(r, b) * 0.6) n += 1;
    }
  }
  return n;
}

/** Cyan pixels (green and blue well above red): the edge wall. */
function cyanPixels(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (g > r + 50 && b > r + 50 && Math.abs(g - b) < 60) n += 1;
    }
  }
  return n;
}

/** Orange pixels (red above green above blue): the live gate's leaf. */
function orangePixels(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (r > 90 && r > g + 40 && g > b + 25) n += 1;
    }
  }
  return n;
}

/**
 * The edge pieces: a wall on the x = 1 grid line over z 3-8, rows 3 and 4 (on the grass tops there, 1 m
 * high), and a live gate on the z = 14 line over x = 10, row 5.
 */
const WALL_EDGES: readonly number[] = [3, 4].flatMap((y) => [3, 4, 5, 6, 7, 8].flatMap((z) => [1, y, z, 0]));
const GATE_EDGE: readonly number[] = [10, 5, 14, 1];

/** Yellow pixels (red and green high, blue low): the connected wall's straight pieces. */
function yellowPixels(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (r > 120 && g > 110 && b < Math.min(r, g) * 0.4 && Math.abs(r - g) < 60) n += 1;
    }
  }
  return n;
}

/** Red pixels (green and blue well below red): the connected wall's corner. */
function redPixels(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (r > 100 && g < r * 0.3 && b < r * 0.3) n += 1;
    }
  }
  return n;
}

/** Deep blue pixels (red and green well below blue): the connected wall's T-join. */
function bluePixels(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (b > 100 && r < b * 0.3 && g < b * 0.4) n += 1;
    }
  }
  return n;
}

/**
 * A connected wall three rows high over the far side of the map (rows 9-11, where neither it nor its shadow hides
 * the other pieces): a run along z = 2 from x = 2 to 8 that turns toward +z at x = 2 (a corner) and branches toward
 * +z at x = 5 (a T-join). Its straight pieces are yellow, the corner red, the T blue;
 * its ordinary look (the ends here, and what every cell would show unresolved: the pieces weigh almost nothing) is grey.
 */
const RAMPART: readonly number[] = [9, 10, 11].flatMap((y) => ([[2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [2, 3], [2, 4], [5, 3], [5, 4]] as const).flatMap(([x, z]) => [x, y, z]));

/**
 * Beacon cells on the grass tops (row = the column's height): one in the dug column under the player, two
 * elsewhere. Each spawns the beacon prefab in the game: its root's base model is merged into the chunk, its
 * magenta post is a live object.
 */
const BEACONS: readonly [number, number, number][] = [[8, 5, 8], [3, 4, 12], [13, 6, 4]];

/** Lavender pixels (blue well above red and green, which stay well above none): the roof over the spawn. */
function lavenderPixels(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (b > 110 && b > r + 35 && b > g + 35 && r > b * 0.4 && g > b * 0.4) n += 1;
    }
  }
  return n;
}

/** Violet pixels (blue high, red about half of it, no green): the banner under the burnt kit. */
function violetPixels(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (b > 80 && r > b * 0.3 && r < b * 0.75 && g < b * 0.25) n += 1;
    }
  }
  return n;
}

/** Pale pink pixels (red high, green below blue): the roof elsewhere. */
function pinkPixels(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (r > 120 && r > g + 25 && b > g + 6 && r > b + 6 && g > r * 0.45) n += 1;
    }
  }
  return n;
}

/**
 * The cut-away roofs, one row at the top of the layer (7.5 m, clear of the falling player): lavender over the spawn,
 * cut while the player is in the pit (the region below the floor it falls into); pink over the near corner, cut
 * while the player stands under it.
 */
const ROOF_A = [6, 15, 6, 10, 16, 10];
const ROOF_B = [12, 15, 13, 15, 16, 16];
/** The banner: a white slab level with the pink roof, on the map's other side (violet under the burnt kit). */
const BANNER = [2, 15, 13, 5, 16, 16];
const PIT = [0, -16, 0, 24, 0, 24];

/** The map: stone under grass, raised by a heightmap, a lower floor 5 m below, a player above the middle. */
async function buildMap(): Promise<{ layer: string; player: string }> {
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  await cmd('setCellFields', { fields: [{ key: 'walkable', type: 'bool', color: '#20c020' }, { key: 'cost', type: 'int', default: 1, min: 0, max: 9 }] });
  await cmd('setBlockType', { block: { blockId: 'stone', name: 'Stone', variants: [{ color: '#6b7280' }], shape: 'full' } });
  await cmd('setBlockType', { block: { blockId: 'grass', name: 'Grass', variants: [{ color: '#3fa34d' }], shape: 'full', metadata: { walkable: true } } });
  // The beacon prefab, kept in a scene the game never loads: a base model on its root, a magenta post as its child.
  await publishBytes(be!, new Uint8Array(multiPieceGlb([{ name: 'base', lods: [[0.8, 0.1, 0.8]] }], { centred: true })), 'model', 'beacon-base', 'Beacon base');
  await cmd('createScene', { sceneId: 'scene-kit', name: 'Kit' });
  const beacon = String((await cmd('createEntity', { sceneId: 'scene-kit', parentId: null, kind: 'group', name: 'Beacon', transform: { position: [0, 0, 0] } }))['createdId']);
  await cmd('setComponent', { entityId: beacon, component: 'model', value: { asset: { assetId: 'beacon-base' } } });
  await cmd('createEntity', { sceneId: 'scene-kit', parentId: beacon, kind: 'box', name: 'Beacon post', transform: { position: [0, 0.85, 0] }, box: { size: [0.4, 1.5, 0.4], material: { color: '#ff00ff' } } });
  await cmd('createPrefab', { prefabId: 'beacon', displayName: 'Beacon', sourceEntityId: beacon });
  // Not live yet: the Blocks panel's block type form turns it live.
  await cmd('setBlockType', { block: { blockId: 'beacon', name: 'Beacon', variants: [{ prefab: 'beacon' }], shape: 'none' } });
  // Edge pieces: a cyan wall (a stand-in slab) and a live gate (a logic-only root with an orange leaf).
  await cmd('setBlockType', { block: { blockId: 'wall', name: 'Wall', variants: [{ color: '#00d8f0' }], shape: 'full', placement: 'edge' } });
  const gate = String((await cmd('createEntity', { sceneId: 'scene-kit', parentId: null, kind: 'group', name: 'Gate', transform: { position: [0, 0, 0] } }))['createdId']);
  await cmd('createEntity', { sceneId: 'scene-kit', parentId: gate, kind: 'box', name: 'Gate leaf', transform: { position: [0, 0.45, 0] }, box: { size: [0.9, 0.9, 0.12], material: { color: '#ff8a00' } } });
  await cmd('createPrefab', { prefabId: 'gate', displayName: 'Gate', sourceEntityId: gate });
  await cmd('setBlockType', { block: { blockId: 'gate', name: 'Gate', variants: [{ prefab: 'gate' }], shape: 'full', placement: 'edge', live: true } });
  await cmd('setBlockType', { block: { blockId: 'roof-a', name: 'Roof A', variants: [{ color: '#9090ff' }], shape: 'full' } });
  await cmd('setBlockType', { block: { blockId: 'roof-b', name: 'Roof B', variants: [{ color: '#ffb4d2' }], shape: 'full' } });
  await cmd('setBlockType', { block: { blockId: 'banner-burnt', name: 'Banner (burnt)', variants: [{ color: '#5a00b4' }], shape: 'full' } });
  await cmd('setBlockType', { block: { blockId: 'banner', name: 'Banner', variants: [{ color: '#f2f2f2' }], shape: 'full', kits: { burnt: { block: 'banner-burnt' } } } });
  await cmd('setBlockType', { block: { blockId: 'rampart', name: 'Rampart', variants: [{ color: '#303030', weight: 1000 }, { color: '#f0e000', weight: 0.001 }, { color: '#e01010', weight: 0.001 }, { color: '#1020ff', weight: 0.001 }], shape: 'full', connect: { pieces: { straight: { variant: 1 }, corner: { variant: 2 }, t: { variant: 3 } } } } });
  // The camera looks down at the map from its south side.
  const camEntity = ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities.find((e) => e.components['virtualCamera'] !== undefined)!;
  const cam = camEntity.id;
  const pitch = (-35 * Math.PI) / 180;
  await cmd('setTransform', { entityId: cam, transform: { position: [8, 11, 26], rotation: [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)] } });
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Ground', transform: { position: [0, 0, 0] } });
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name: 'Lower floor', transform: { position: [8, -5.5, 8] }, box: { size: [40, 1, 40], material: { color: '#404650' } }, components: { collider: { shape: { type: 'box', hx: 20, hy: 0.5, hz: 20 } } } });
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Player', transform: { position: [8.5, 6, 8.5] } });
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Digger', transform: { position: [0, 0, 0] } });
  const ents = ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; name?: string }[] }).entities;
  const id = (name: string): string => ents.find((e) => e.name === name)!.id;
  await cmd('setComponent', { entityId: id('Player'), component: 'controller', value: {} });
  await cmd('setComponent', { entityId: id('Ground'), component: 'blockLayer', value: { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [24, 16, 24] }, cutaway: { regions: [{ region: 'roof.a', when: 'pit' }, { region: 'roof.b' }], fade: 3 } } });
  // The player is the camera's target (what the cut-aways test): a track rig whose framed point is held at the spawn,
  // so the view stays where it was.
  await cmd('setComponent', { entityId: cam, component: 'virtualCamera', value: { ...(camEntity.components['virtualCamera'] as object), rig: 'track', target: id('Player'), boundsMin: [8.5, 6, 8.5], boundsMax: [8.5, 6, 8.5] } });
  // A 16 × 16 heightmap: a gentle rise toward +x (1–4 cells of grass-topped columns); its colour map
  // is all green (grass) — the whole map in one request.
  const height = makePng(16, 16, (x) => [48 + x * 8, 48 + x * 8, 48 + x * 8, 255]);
  const colors = makePng(16, 16, () => [60, 170, 80, 255]);
  const res = await cmd('editBlocks', {
    entityId: id('Ground'),
    edits: [
      { kind: 'fill', box: [0, 0, 0, 16, 2, 16], cell: { block: 'stone' } },
      { kind: 'heightmap', png: height.toString('base64'), origin: [0, 0], y: 2, scale: 6, cell: { block: 'grass' }, colors: { png: colors.toString('base64'), map: [{ color: '#3caa50', cell: { block: 'grass' } }] } },
      { kind: 'region', regionId: 'spawn.area', op: 'set', boxes: [[6, 0, 6, 10, 16, 10]] },
      { kind: 'meta', box: [0, 1, 0, 16, 2, 16], set: { cost: 2 }, occupiedOnly: true },
      ...BEACONS.map(([x, y, z]) => ({ kind: 'fill', box: [x, y, z, x + 1, y + 1, z + 1], cell: { block: 'beacon' } })),
      { kind: 'edges', at: [...WALL_EDGES], edge: { block: 'wall' } },
      { kind: 'edges', at: [...GATE_EDGE], edge: { block: 'gate' } },
      { kind: 'cells', at: [...RAMPART], cell: { block: 'rampart' } },
      { kind: 'fill', box: [...ROOF_A], cell: { block: 'roof-a' } },
      { kind: 'fill', box: [...ROOF_B], cell: { block: 'roof-b' } },
      { kind: 'fill', box: [...BANNER], cell: { block: 'banner' } },
      { kind: 'region', regionId: 'roof.a', op: 'set', boxes: [[...ROOF_A]] },
      { kind: 'region', regionId: 'roof.b', op: 'set', boxes: [[...ROOF_B]] },
      { kind: 'region', regionId: 'pit', op: 'set', boxes: [[...PIT]] },
    ],
  });
  expect((res.change as { chunks: number[][] }).chunks).toEqual([[0, 0]]);
  await script('digger', DIGGER, id('Digger'));
  return { layer: id('Ground'), player: id('Player') };
}

/** The connected wall's straight (yellow), corner (red) and T-join (blue) pieces in a full-size picture. */
async function expectConnectedWall(shoot: () => Promise<Buffer>, where: string): Promise<void> {
  const count = async (f: (img: Image) => number): Promise<number> => f(decodePng(await shoot()));
  await expect.poll(() => count(yellowPixels), { timeout: 30_000, message: `the connected wall's straight pieces in ${where}` }).toBeGreaterThan(250);
  await expect.poll(() => count(redPixels), { timeout: 30_000, message: `the connected wall's corner in ${where}` }).toBeGreaterThan(50);
  await expect.poll(() => count(bluePixels), { timeout: 30_000, message: `the connected wall's T-join in ${where}` }).toBeGreaterThan(50);
  console.log(`connected wall in ${where}: yellow ${await count(yellowPixels)}, red ${await count(redPixels)}, blue ${await count(bluePixels)}`);
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

/** The player rests on the blocks: the default capsule's origin 0.9 m above the column top, plus the skin. */
async function expectRestsOnBlocks(read: () => Promise<Observation | null>, what: string, topY: number): Promise<void> {
  await expect
    .poll(async () => {
      const o = await read();
      return o?.player !== undefined && (o.stepIndex ?? 0) < DIG_STEP && o.player.y > topY + 0.9 - 1e-3 && o.player.y < topY + 0.9 + 0.02;
    }, { timeout: 60_000, intervals: [100], message: `${what}: the player rests on the blocks` })
    .toBe(true);
}

/** After the dig: through the hole onto the lower floor (top at -5 m), where it rests. */
async function expectFallsThrough(read: () => Promise<Observation | null>, what: string): Promise<void> {
  let last: Observation | null = null;
  try {
    await expect
      .poll(async () => {
        const o = await read();
        last = o;
        return o?.player !== undefined && o.player.y > -5 + 0.9 - 1e-3 && o.player.y < -5 + 0.9 + 0.02;
      }, { timeout: 240_000, intervals: [250], message: `${what}: the player fell through the hole onto the lower floor` })
      .toBe(true);
  } catch (e) {
    throw new Error(`${(e as Error).message}\nlast observation: ${JSON.stringify(last)}`);
  }
}

/**
 * The roofs once the player lies in the pit: the lavender one fades out (the counts on the way are logged) and the pink
 * one stays. Before the dig both were drawn when a picture made it in time (`before`: the lavender count then).
 */
/** After the dig the burnt kit is shown: the banner is violet (none was before: `before` the count then, null: not seen in time). */
async function expectBurntBanner(shoot: () => Promise<Buffer>, where: string): Promise<void> {
  await expect.poll(async () => violetPixels(decodePng(await shoot())), { timeout: 30_000, message: `the banner under the burnt kit in ${where}` }).toBeGreaterThan(30);
  console.log(`kit in ${where}: violet banner ${violetPixels(decodePng(await shoot()))}`);
}

async function expectRoofsCut(shoot: () => Promise<Buffer>, where: string, before: number | null): Promise<void> {
  const counts: number[] = [];
  await expect
    .poll(async () => {
      const n = lavenderPixels(decodePng(await shoot()));
      counts.push(n);
      return n;
    }, { timeout: 30_000, intervals: [100], message: `the lavender roof cut away in ${where}` })
    .toBeLessThan(5);
  const pink = pinkPixels(decodePng(await shoot()));
  console.log(`cut-away in ${where}: lavender roof before the dig ${before ?? 'not seen in time'}, while fading ${counts.join(' ')}; pink roof ${pink}`);
  expect(pink).toBeGreaterThan(20);
  if (before !== null) expect(before).toBeGreaterThan(40);
}

/** The lavender roof's pixels in a picture taken before the dig (null: none was in time). */
async function roofBeforeDig(shoot: () => Promise<Buffer>, read: () => Promise<Observation | null>): Promise<number | null> {
  for (let i = 0; i < 40; i += 1) {
    const step = (await read())?.stepIndex ?? 0;
    if (step >= DIG_STEP - 24) return null;
    const n = lavenderPixels(decodePng(await shoot()));
    // A picture is taken after the step read: still before the dig only if the run has not got there since.
    if (n > 40 && ((await read())?.stepIndex ?? DIG_STEP) < DIG_STEP) return n;
  }
  return null;
}

async function startPlay(page: Page): Promise<string> {
  await page.goto(be!.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect.poll(async () => (await relay(`${psid}/observe`, {})).status, { timeout: 30_000 }).toBe(200);
  return psid;
}

test('a block map built with bulk commands renders in the Scene view, Play and the export; a script digs the player through', async ({ page }) => {
  test.setTimeout(720_000);
  be = await startBackend('block-layers-e2e');
  const { layer } = await buildMap();

  // Read back through queryBlocks: the layer list, a box of cells with their effective metadata, a region.
  const list = (await query('queryBlocks')) as { layers: { entityId: string; cells: number; chunks: number[][]; regions: string[] }[] };
  expect(list.layers).toEqual([expect.objectContaining({ entityId: layer, chunks: [[0, 0]], regions: ['pit', 'roof.a', 'roof.b', 'spawn.area'], edges: WALL_EDGES.length / 4 + 1 })]);
  const cells16 = list.layers[0]!.cells;
  expect(cells16).toBeGreaterThan(16 * 16 * 2);
  const box = (await query('queryBlocks', { entityId: layer, box: [0, 0, 0, 1, 16, 1] })) as { box: { cells: number[][]; palette: { block?: string }[]; meta: { walkable: boolean; cost: number }[] } };
  const column = box.box.cells.map((c) => [c[1], box.box.palette[c[3]!]!.block, box.box.meta[c[3]!]!.cost]);
  expect(column.slice(0, 3)).toEqual([[0, 'stone', 1], [1, 'stone', 2], [2, 'grass', 1]]);
  const region = (await query('queryBlocks', { entityId: layer, region: 'spawn.area' })) as { region: { cells: number[][] } };
  expect(region.region.cells.length).toBe(4 * 16 * 4);
  // One file per chunk, listed by the scene file: binary in a new project…
  const sceneDir = join(be.projectDir, 'scenes');
  const blocksDir = readdirSync(sceneDir).find((n) => n.endsWith('.blocks'))!;
  const sceneFile = (): Record<string, unknown> => JSON.parse(readFileSync(join(sceneDir, blocksDir.replace(/\.blocks$/, '.json')), 'utf8')) as Record<string, unknown>;
  expect(readdirSync(join(sceneDir, blocksDir))).toEqual([`${layer}.0.0.bin`]);
  expect(readFileSync(join(sceneDir, blocksDir, `${layer}.0.0.bin`)).subarray(0, 4).toString('latin1')).toBe('TLBK');
  expect(sceneFile()['blockChunkFormat']).toBe('binary');

  // The Scene view meshes the layer (merged chunk meshes: a few per chunk).
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const viewport = page.locator('.tl-viewport');
  await expect.poll(async () => JSON.parse((await viewport.getAttribute('data-block-layers')) ?? '{"meshes":0}').meshes as number, { timeout: 30_000 }).toBeGreaterThan(0);
  const stats = JSON.parse((await viewport.getAttribute('data-block-layers'))!) as { layers: number; chunks: number; meshes: number; triangles: number };
  expect(stats).toEqual(expect.objectContaining({ layers: 1, chunks: 1 }));
  // One per look: stone, grass, the beacon base, the wall, the connected wall's four pieces, the two roofs (each
  // a cut-away zone's own mesh) and the banner.
  expect(stats.meshes).toBeLessThanOrEqual(11);
  // The Scene view has no camera target: nothing is cut.
  expect((stats as { cutaway?: unknown }).cutaway).toEqual({ zones: 2, cut: 0, fading: 0, meshes: 2 });
  // Hidden faces left out: far fewer triangles than 12 per cell.
  expect(stats.triangles).toBeLessThan(cells16 * 12 * 0.25);

  // The Blocks panel's block type form turns the beacon live (one setBlockType), read back over HTTP.
  await openWindow(page, 'Blocks');
  const blocksPanel = page.getByLabel('blocks panel');
  await blocksPanel.getByRole('button', { name: 'block beacon', exact: true }).click();
  const liveBox = blocksPanel.getByLabel('block type form').getByLabel('blockType live', { exact: true });
  await expect(liveBox).not.toBeChecked();
  await liveBox.click();
  await expect.poll(async () => ((await query('queryGameConfig')) as { blockTypes?: { blockId: string; live?: boolean }[] }).blockTypes?.find((t) => t.blockId === 'beacon')?.live).toBe(true);
  await expect(liveBox).toBeChecked();

  // …and JSON text, one column per line (a diff shows the columns that changed), once the project asks for it
  // in its settings: the chunk file is rewritten in the same save.
  await openProjectSettings(page, 'Gameplay');
  await page.locator('.tl-gameplay__tabs').getByRole('button', { name: 'settings', exact: true }).click();
  const storage = page.getByLabel('gameplay settings').getByLabel('settings block_chunk_storage', { exact: true });
  await expect(storage).toHaveValue('1');
  await storage.selectOption('0');
  await expect.poll(() => readdirSync(join(sceneDir, blocksDir))).toEqual([`${layer}.0.0.json`]);
  await closeProjectSettings(page);
  expect(sceneFile()['blockChunkFormat']).toBeUndefined();
  const chunkFile = readFileSync(join(sceneDir, blocksDir, `${layer}.0.0.json`), 'utf8');
  expect(chunkFile).toContain('"type": "block-chunk"');
  // 256 column lines, then one line per edge piece.
  expect(chunkFile.split('\n').filter((l) => l.startsWith('    [')).length).toBe(256 + WALL_EDGES.length / 4 + 1);
  expect(chunkFile).toContain('"edges": [');
  // The same cells either way.
  expect(((await query('queryBlocks', { entityId: layer, box: [0, 0, 0, 1, 16, 1] })) as typeof box).box).toEqual(box.box);

  // Play (the simulation worker): lands on the grass top under x = 8 (height 2 + round((48 + 64) / 255 × 6) = 5 cells → 2.5 m).
  const topY = 0.5 * (2 + Math.round(((48 + 8 * 8) / 255) * 6));
  const psid = await startPlay(page);
  const read = async (): Promise<Observation | null> => {
    const r = await relay(`${psid}/observe`, {});
    return r.status === 200 ? (r.json as unknown as Observation) : null;
  };
  await expectRestsOnBlocks(read, 'Play', topY);
  const playShot = async (): Promise<Buffer> => {
    const shot = await relay(`${psid}/screenshot`, { maxWidth: 480 });
    return Buffer.from(String(shot.json.dataUrl ?? '').split(',')[1] ?? '', 'base64');
  };
  const roofInPlay = await roofBeforeDig(playShot, read);
  // Before the dig no kit is shown: the banner is white. The cached static shadow's draws so far (the kit's restyle
  // draws it once more).
  const staticDraws = async (): Promise<number | undefined> => ((await relay(`${psid}/diagnostics`, {})).json as { diagnostics?: { renderer?: { shadowMaps?: { staticTotal?: number } } } }).diagnostics?.renderer?.shadowMaps?.staticTotal;
  const beforeDig = ((await read())?.stepIndex ?? DIG_STEP) < DIG_STEP - 60;
  const staticBefore = beforeDig ? await staticDraws() : undefined;
  if (beforeDig) expect(violetPixels(decodePng(await playShot()))).toBeLessThan(5);
  // Each beacon cell spawned its prefab (a root and its post) as objects of the game, the posts drawn.
  const liveObjects = async (): Promise<number | undefined> => ((await relay(`${psid}/diagnostics`, {})).json as { diagnostics?: { runtime?: { blockMemory?: { liveObjects?: number } } } }).diagnostics?.runtime?.blockMemory?.liveObjects;
  // …and the gate its root and leaf.
  await expect.poll(liveObjects, { timeout: 30_000, message: 'the beacon cells\' and the gate\'s objects in Play' }).toBe(BEACONS.length * 2 + 2);
  const inPlay = async (count: (img: Image) => number): Promise<number> => {
    const shot = await relay(`${psid}/screenshot`, { maxWidth: 480 });
    return shot.status === 200 ? count(decodePng(Buffer.from(String(shot.json.dataUrl ?? '').split(',')[1] ?? '', 'base64'))) : 0;
  };
  await expect.poll(() => inPlay(cyanPixels), { timeout: 60_000, message: 'the edge wall in the Play screenshot' }).toBeGreaterThan(40);
  await expect.poll(() => inPlay(orangePixels), { timeout: 60_000, message: "the live gate's leaf in the Play screenshot" }).toBeGreaterThan(15);
  // The connected wall: straight runs, the corner and the T-join each show their own piece.
  await expect.poll(() => inPlay(yellowPixels), { timeout: 60_000, message: "the connected wall's straight pieces in the Play screenshot" }).toBeGreaterThan(20);
  await expect.poll(() => inPlay(redPixels), { timeout: 60_000, message: "the connected wall's corner in the Play screenshot" }).toBeGreaterThan(3);
  await expect.poll(() => inPlay(bluePixels), { timeout: 60_000, message: "the connected wall's T-join in the Play screenshot" }).toBeGreaterThan(3);
  console.log(`connected wall in Play: yellow ${await inPlay(yellowPixels)}, red ${await inPlay(redPixels)}, blue ${await inPlay(bluePixels)}`);
  await expect
    .poll(async () => {
      const shot = await relay(`${psid}/screenshot`, { maxWidth: 480 });
      if (shot.status !== 200) return 0;
      return magentaPixels(decodePng(Buffer.from(String(shot.json.dataUrl ?? '').split(',')[1] ?? '', 'base64')));
    }, { timeout: 60_000, message: 'the beacons\' magenta posts in the Play screenshot' })
    .toBeGreaterThan(15);
  // The blocks are in the Play screenshot.
  await expect
    .poll(async () => {
      const shot = await relay(`${psid}/screenshot`, { maxWidth: 480 });
      if (shot.status !== 200) return 0;
      const b64 = String(shot.json.dataUrl ?? '').split(',')[1] ?? '';
      return greenPixels(decodePng(Buffer.from(b64, 'base64')));
    }, { timeout: 60_000, message: 'grass-green pixels in the Play screenshot' })
    .toBeGreaterThan(500);
  await expectFallsThrough(read, 'Play');
  await expectRoofsCut(playShot, 'Play', roofInPlay);
  await expectBurntBanner(playShot, 'Play');
  // The kit was one restyle of the layer's chunk, in the background.
  const restyles = async (): Promise<unknown> => ((await relay(`${psid}/diagnostics`, {})).json as { diagnostics?: { renderer?: { blocks?: { restyles?: unknown } } } }).diagnostics?.renderer?.blocks?.restyles;
  await expect.poll(restyles, { timeout: 30_000 }).toEqual(expect.objectContaining({ count: 1, active: false, last: expect.objectContaining({ chunks: 1 }) }));
  const staticAfter = await staticDraws();
  console.log(`restyle in Play: ${JSON.stringify(await restyles())}; static shadow drawn ${staticBefore ?? '?'} → ${staticAfter ?? '?'} times`);
  // The dig's chunk and the kit's restyle draw the cached static shadow once (held while the chunk was re-meshed).
  if (staticBefore !== undefined && staticAfter !== undefined) expect(staticAfter - staticBefore).toBe(1);
  const cutawayDiag = async (): Promise<unknown> => ((await relay(`${psid}/diagnostics`, {})).json as { diagnostics?: { renderer?: { blocks?: { cutaway?: unknown } } } }).diagnostics?.renderer?.blocks?.cutaway;
  await expect.poll(cutawayDiag, { timeout: 30_000 }).toEqual({ zones: 2, cut: 1, fading: 0, meshes: 2 });
  // The dug column's beacon went with its cell.
  await expect.poll(liveObjects, { timeout: 30_000 }).toBe((BEACONS.length - 1) * 2 + 2);

  // The static export with the backend stopped. Its scene files hold no cells: each layer names its
  // binary chunk data (gzip), a digest-addressed buffer, whatever form the project stores them in.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const dir = join(be.exportRoot, String(res.json.outputDir));
  const exported = (path: string): { blocks: { entityId: string; chunks?: unknown; chunkData?: string }[] } => JSON.parse(readFileSync(join(dir, path), 'utf8')) as { blocks: { entityId: string; chunks?: unknown; chunkData?: string }[] };
  const entry = exported('scenes/scene-main.json').blocks.find((b) => b.entityId === layer)!;
  expect(entry.chunks).toBeUndefined();
  expect(entry.chunkData).toMatch(/^[0-9a-f]{64}$/);
  expect(exported('scene.json').blocks.find((b) => b.entityId === layer)!.chunkData).toBe(entry.chunkData);
  const blob = readFileSync(join(dir, 'content', 'sha256', entry.chunkData!));
  expect([blob.subarray(0, 4).toString('latin1'), blob[5]]).toEqual(['TLBK', 2]);
  expect(createHash('sha256').update(blob).digest('hex')).toBe(entry.chunkData);
  const site = await serveDir(dir);
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  const logs: string[] = [];
  game.on('console', (m) => logs.push(m.text()));
  try {
    await game.goto(site.url);
    const canvas = game.locator('canvas').first();
    const observe = (): Promise<Observation | null> => game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve?.() ?? null) as Observation | null);
    // The rest is read before the dig, from the simulation: it does not wait for the first drawn frame.
    await expectRestsOnBlocks(observe, 'export', topY);
    await expect.poll(async () => Number((await canvas.getAttribute('data-tl-draws')) ?? 0), { timeout: 60_000 }).toBeGreaterThan(0);
    const roofInExport = await roofBeforeDig(() => canvas.screenshot(), observe);
    await expect.poll(async () => greenPixels(decodePng(await canvas.screenshot())), { timeout: 30_000, message: 'grass-green pixels in the export' }).toBeGreaterThan(500);
    await expect.poll(async () => magentaPixels(decodePng(await canvas.screenshot())), { timeout: 30_000, message: 'the beacons\' posts in the export' }).toBeGreaterThan(30);
    await expect.poll(async () => cyanPixels(decodePng(await canvas.screenshot())), { timeout: 30_000, message: 'the edge wall in the export' }).toBeGreaterThan(80);
    await expect.poll(async () => orangePixels(decodePng(await canvas.screenshot())), { timeout: 30_000, message: 'the live gate in the export' }).toBeGreaterThan(30);
    await expectConnectedWall(() => canvas.screenshot(), 'the export');
    await expectFallsThrough(observe, 'export').catch((e: Error) => {
      throw new Error(`${e.message}\nconsole: ${logs.slice(-20).join(' | ')}`);
    });
    await expectRoofsCut(() => canvas.screenshot(), 'the export', roofInExport);
    await expectBurntBanner(() => canvas.screenshot(), 'the export');
    expect(errors).toEqual([]);
    // The other renderer reads the same chunk data (on a GPU the default above is WebGPU).
    if (gpuAvailable()) {
      expect(await canvas.getAttribute('data-tl-renderer')).toBe('webgpu');
      const gl = await page.context().newPage();
      gl.on('pageerror', (e) => errors.push(`webgl2: ${e.message}`));
      try {
        await gl.goto(`${site.url}?renderer=webgl2`);
        const glCanvas = gl.locator('canvas').first();
        const glObserve = (): Promise<Observation | null> => gl.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve?.() ?? null) as Observation | null);
        await expectRestsOnBlocks(glObserve, 'export (WebGL 2)', topY);
        await expect.poll(async () => glCanvas.getAttribute('data-tl-renderer'), { timeout: 60_000 }).toBe('webgl2');
        const roofOnWebGl = await roofBeforeDig(() => glCanvas.screenshot(), glObserve);
        await expect.poll(async () => greenPixels(decodePng(await glCanvas.screenshot())), { timeout: 30_000, message: 'grass-green pixels in the export on WebGL 2' }).toBeGreaterThan(500);
        await expect.poll(async () => magentaPixels(decodePng(await glCanvas.screenshot())), { timeout: 30_000, message: 'the beacons\' posts in the export on WebGL 2' }).toBeGreaterThan(30);
        await expect.poll(async () => cyanPixels(decodePng(await glCanvas.screenshot())), { timeout: 30_000, message: 'the edge wall in the export on WebGL 2' }).toBeGreaterThan(80);
        await expect.poll(async () => orangePixels(decodePng(await glCanvas.screenshot())), { timeout: 30_000, message: 'the live gate in the export on WebGL 2' }).toBeGreaterThan(30);
        await expectConnectedWall(() => glCanvas.screenshot(), 'the export on WebGL 2');
        await expectFallsThrough(glObserve, 'export (WebGL 2)');
        await expectRoofsCut(() => glCanvas.screenshot(), 'the export on WebGL 2', roofOnWebGl);
        await expectBurntBanner(() => glCanvas.screenshot(), 'the export on WebGL 2');
        expect(errors).toEqual([]);
      } finally {
        await gl.close();
      }
    }
  } finally {
    await game.close();
    await site.close();
  }
});
