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
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from './pw';

import { startBackend, type E2EBackend } from './backend';
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

/** The map: stone under grass, raised by a heightmap, a lower floor 5 m below, a player above the middle. */
async function buildMap(): Promise<{ layer: string; player: string }> {
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  await cmd('setCellFields', { fields: [{ key: 'walkable', type: 'bool', color: '#20c020' }, { key: 'cost', type: 'int', default: 1, min: 0, max: 9 }] });
  await cmd('setBlockType', { block: { blockId: 'stone', name: 'Stone', variants: [{ color: '#6b7280' }], shape: 'full' } });
  await cmd('setBlockType', { block: { blockId: 'grass', name: 'Grass', variants: [{ color: '#3fa34d' }], shape: 'full', metadata: { walkable: true } } });
  // The camera looks down at the map from its south side.
  const cam = ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities.find((e) => e.components['virtualCamera'] !== undefined)!.id;
  const pitch = (-35 * Math.PI) / 180;
  await cmd('setTransform', { entityId: cam, transform: { position: [8, 11, 26], rotation: [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)] } });
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Ground', transform: { position: [0, 0, 0] } });
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name: 'Lower floor', transform: { position: [8, -5.5, 8] }, box: { size: [40, 1, 40], material: { color: '#404650' } }, components: { collider: { shape: { type: 'box', hx: 20, hy: 0.5, hz: 20 } } } });
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Player', transform: { position: [8.5, 6, 8.5] } });
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Digger', transform: { position: [0, 0, 0] } });
  const ents = ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; name?: string }[] }).entities;
  const id = (name: string): string => ents.find((e) => e.name === name)!.id;
  await cmd('setComponent', { entityId: id('Player'), component: 'controller', value: {} });
  await cmd('setComponent', { entityId: id('Ground'), component: 'blockLayer', value: { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [24, 16, 24] } } });
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
    ],
  });
  expect((res.change as { chunks: number[][] }).chunks).toEqual([[0, 0]]);
  await script('digger', DIGGER, id('Digger'));
  return { layer: id('Ground'), player: id('Player') };
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
  expect(list.layers).toEqual([expect.objectContaining({ entityId: layer, chunks: [[0, 0]], regions: ['spawn.area'] })]);
  const cells16 = list.layers[0]!.cells;
  expect(cells16).toBeGreaterThan(16 * 16 * 2);
  const box = (await query('queryBlocks', { entityId: layer, box: [0, 0, 0, 1, 16, 1] })) as { box: { cells: number[][]; palette: { block?: string }[]; meta: { walkable: boolean; cost: number }[] } };
  const column = box.box.cells.map((c) => [c[1], box.box.palette[c[3]!]!.block, box.box.meta[c[3]!]!.cost]);
  expect(column.slice(0, 3)).toEqual([[0, 'stone', 1], [1, 'stone', 2], [2, 'grass', 1]]);
  const region = (await query('queryBlocks', { entityId: layer, region: 'spawn.area' })) as { region: { cells: number[][] } };
  expect(region.region.cells.length).toBe(4 * 16 * 4);
  // One file per chunk, listed by the scene file.
  const sceneDir = join(be.projectDir, 'scenes');
  const blocksDir = readdirSync(sceneDir).find((n) => n.endsWith('.blocks'))!;
  expect(readdirSync(join(sceneDir, blocksDir))).toEqual([`${layer}.0.0.json`]);
  const chunkFile = readFileSync(join(sceneDir, blocksDir, `${layer}.0.0.json`), 'utf8');
  expect(chunkFile).toContain('"type": "block-chunk"');
  expect(chunkFile.split('\n').filter((l) => l.startsWith('    [')).length).toBe(256);

  // The Scene view meshes the layer (merged chunk meshes: a few per chunk).
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const viewport = page.locator('.tl-viewport');
  await expect.poll(async () => JSON.parse((await viewport.getAttribute('data-block-layers')) ?? '{"meshes":0}').meshes as number, { timeout: 30_000 }).toBeGreaterThan(0);
  const stats = JSON.parse((await viewport.getAttribute('data-block-layers'))!) as { layers: number; chunks: number; meshes: number; triangles: number };
  expect(stats).toEqual(expect.objectContaining({ layers: 1, chunks: 1 }));
  expect(stats.meshes).toBeLessThanOrEqual(4);
  // Hidden faces left out: far fewer triangles than 12 per cell.
  expect(stats.triangles).toBeLessThan(cells16 * 12 * 0.25);

  // Play (the simulation worker): lands on the grass top under x = 8 (height 2 + round((48 + 64) / 255 × 6) = 5 cells → 2.5 m).
  const topY = 0.5 * (2 + Math.round(((48 + 8 * 8) / 255) * 6));
  const psid = await startPlay(page);
  const read = async (): Promise<Observation | null> => {
    const r = await relay(`${psid}/observe`, {});
    return r.status === 200 ? (r.json as unknown as Observation) : null;
  };
  await expectRestsOnBlocks(read, 'Play', topY);
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

  // The static export with the backend stopped.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const dir = join(be.exportRoot, String(res.json.outputDir));
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
    await expect.poll(async () => greenPixels(decodePng(await canvas.screenshot())), { timeout: 30_000, message: 'grass-green pixels in the export' }).toBeGreaterThan(500);
    await expectFallsThrough(observe, 'export').catch((e: Error) => {
      throw new Error(`${e.message}\nconsole: ${logs.slice(-20).join(' | ')}`);
    });
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
});
