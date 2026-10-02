/**
 * Sloped block-layer terrain against a real backend, per renderer variant
 * (renderer-variants.ts: auto; WebGL 2 with TL_E2E_ALL_VARIANTS=1 on a GPU;
 * WebGPU in `webgpu`).
 *
 * A 3D project gets a block layer built with the bulk commands (the ones
 * MCP's tl_command sends): a lane rising along +x — a flat floor, a gentle
 * slope (0.375 cells per 1 m column, 20.6°), a flat shelf, a steep slope
 * (0.84375, 40.2°) — of sloped cells (`corners`), the layer's maxSlope 30°.
 * The cells read back with their corners; the Scene view meshes them (grass
 * pixels).
 *
 * In Play (the simulation worker) the character lands on the gentle slope at
 * the slope's height (its collider follows the sloped surface), walks +x
 * (relayed input) up the gentle slope onto the shelf and stops at the foot of
 * the steep slope (steeper than maxSlope, gentler than its own 45° limit).
 * Grass pixels in the Play screenshot. The static export, served with the
 * backend stopped, lands and walks the same with the keyboard.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { controls, startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';

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
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-terrain' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}

async function relay(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/play/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

/** The layer's min corner (world); layer column x is world x − 2. */
const ORIGIN = [-2, 0, -4] as const;
const GENTLE = 0.375;
const STEEP = 0.84375;
/** The lane's surface height (cells = metres) at layer column coordinate x. */
function laneHeight(x: number): number {
  if (x < 4) return 1;
  if (x < 8) return 1 + (x - 4) * GENTLE;
  if (x < 12) return 1 + 4 * GENTLE;
  if (x < 16) return 1 + 4 * GENTLE + (x - 12) * STEEP;
  return 1 + 4 * GENTLE + 4 * STEEP;
}

/** The lane as `fill` edits: under each column, full cells up to the row of its lowest corner, then one sloped (or flat) top cell. */
function laneEdits(z0: number, z1: number): unknown[] {
  const edits: unknown[] = [];
  for (let x = 0; x < 20; x++) {
    const h0 = laneHeight(x);
    const h1 = laneHeight(x + 1);
    const top = h0 === h1 && Number.isInteger(h0) ? h0 - 1 : Math.floor(Math.min(h0, h1));
    if (top > 0) edits.push({ kind: 'fill', box: [x, 0, z0, x + 1, top, z1], cell: { block: 'grass' } });
    const c = [h0 - top, h1 - top, h1 - top, h0 - top];
    edits.push({ kind: 'fill', box: [x, top, z0, x + 1, top + 1, z1], cell: { block: 'grass', ...(c.every((v) => v === 1) ? {} : { corners: c }) } });
  }
  return edits;
}

/** Grass-green pixels: green well above red and blue. */
function greenPixels(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
    const [r, g, b] = img.pixel(x, y);
    if (g > r + 35 && g > b + 35 && g > 60) n += 1;
  }
  return n;
}

async function buildTerrain(): Promise<{ layer: string; player: string }> {
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  await cmd('setBlockType', { block: { blockId: 'grass', name: 'Grass', variants: [{ color: '#3fa34d' }], shape: 'full' } });
  const cam = ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities.find((e) => e.components['virtualCamera'] !== undefined)!.id;
  // South of the lane, above it, looking down its length a little.
  const pitch = (-30 * Math.PI) / 180;
  await cmd('setTransform', { entityId: cam, transform: { position: [8, 10, 14], rotation: [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)] } });
  const layer = String((await cmd('createEntity', { parentId: null, kind: 'group', name: 'Terrain', transform: { position: [...ORIGIN] } }))['createdId']);
  // Over the gentle slope's middle (layer column 6.5, world x 4.5), a few metres up.
  const player = String((await cmd('createEntity', { parentId: null, kind: 'group', name: 'Player', transform: { position: [4.5, 4, 0] } }))['createdId']);
  await cmd('setComponent', { entityId: player, component: 'controller', value: {} });
  await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [24, 12, 8] }, maxSlope: 30 } });
  const res = await cmd('editBlocks', { entityId: layer, edits: laneEdits(1, 7) });
  expect((res.change as { chunks: number[][] }).chunks).toEqual([[0, 0], [1, 0]]);
  return { layer, player };
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

/** The capsule's origin over a slope: 0.9 m above the surface under it plus the skin, a little more on a slope (its round bottom touches uphill). */
const standY = (layerX: number): number => laneHeight(layerX) + 0.91;

/** The character comes to rest on the gentle slope at its height there. */
async function expectLanded(read: () => Promise<Observation | null>, what: string): Promise<void> {
  const want = standY(6.5);
  await expect
    .poll(async () => {
      const o = await read();
      return o?.player !== undefined && Math.abs(o.player.x - 4.5) < 0.05 && o.player.y > want - 0.01 && o.player.y < want + 0.05;
    }, { timeout: 60_000, intervals: [200], message: `${what}: the character rests on the gentle slope at ${want.toFixed(3)} m` })
    .toBe(true);
}

/** After walking +x: up the gentle slope, over the shelf, stopped at the steep slope's foot (layer 12, world x 10). */
async function expectStoppedAtSteepFoot(read: () => Promise<Observation | null>, what: string): Promise<void> {
  let last: Observation | null = null;
  await expect
    .poll(async () => {
      const o = await read();
      last = o;
      const p = o?.player;
      return p !== undefined && p.x > 9.4 && p.x < 10.05 && p.y > standY(10) - 0.01 && p.y < standY(10) + 0.2;
    }, { timeout: 60_000, intervals: [250], message: `${what}: up the gentle slope, stopped at the foot of the steep one` })
    .toBe(true)
    .catch((e: Error) => {
      throw new Error(`${e.message}\nlast: ${JSON.stringify(last)}`);
    });
}

async function startPlay(page: Page): Promise<string> {
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect.poll(async () => (await relay(`${psid}/observe`, {})).status, { timeout: 30_000 }).toBe(200);
  return psid;
}

for (const variant of RENDERER_VARIANTS) test(`sloped terrain: corner cells by command, the Scene view, Play (lands on and walks up a slope, stops at one steeper than maxSlope) and the export (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(420_000);
  be = await startBackend('terrain-e2e');
  const { layer } = await buildTerrain();

  // Read back: the sloped cells keep their corners.
  const box = (await query('queryBlocks', { entityId: layer, box: [5, 0, 3, 6, 12, 4] })) as { box: { cells: number[][]; palette: { block?: string; corners?: number[] }[] } };
  const top = box.box.cells.map((c) => box.box.palette[c[3]!]!).find((c) => c.corners !== undefined);
  expect(top?.corners).toEqual([0.375, 0.75, 0.75, 0.375]);

  // The Scene view meshes the layer; the grass shows.
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const viewport = page.locator('canvas.tl-viewport');
  await expectRendererBackend(viewport, variant);
  await expect.poll(async () => JSON.parse((await viewport.getAttribute('data-block-layers')) ?? '{"meshes":0}').chunks as number, { timeout: 30_000 }).toBe(2);
  await expect.poll(async () => greenPixels(decodePng(await viewport.screenshot())), { timeout: 30_000, message: 'grass pixels in the Scene view' }).toBeGreaterThan(400);

  // Play (the simulation worker): lands on the slope, then walks +x for 5 s (relayed input).
  const psid = await startPlay(page);
  const read = async (): Promise<Observation | null> => {
    const r = await relay(`${psid}/observe`, {});
    return r.status === 200 ? (r.json as unknown as Observation) : null;
  };
  await expectLanded(read, 'Play');
  await expect
    .poll(async () => {
      const shot = await relay(`${psid}/screenshot`, { maxWidth: 480 });
      if (shot.status !== 200) return 0;
      return greenPixels(decodePng(Buffer.from(String(shot.json.dataUrl ?? '').split(',')[1] ?? '', 'base64')));
    }, { timeout: 60_000, message: 'grass pixels in the Play screenshot' })
    .toBeGreaterThan(300);
  const walked = await relay(`${psid}/input`, { mode: 'exclusive-test', frames: [{ stepOffset: 0, steps: 600, ...controls(1) }] });
  expect(walked.status, JSON.stringify(walked.json)).toBe(200);
  await expectStoppedAtSteepFoot(read, 'Play');

  // The static export with the backend stopped: the keyboard walks it.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const site = await serveDir(join(be.exportRoot, String(res.json.outputDir)));
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.goto(`${site.url}${exportQueryFor(variant)}`);
    const canvas = game.locator('canvas').first();
    await expectRendererBackend(canvas, variant);
    await expect.poll(async () => Number((await canvas.getAttribute('data-tl-draws')) ?? 0), { timeout: 60_000 }).toBeGreaterThan(0);
    const observe = (): Promise<Observation | null> => game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve?.() ?? null) as Observation | null);
    await expectLanded(observe, 'export');
    await expect.poll(async () => greenPixels(decodePng(await canvas.screenshot())), { timeout: 30_000, message: 'grass pixels in the export' }).toBeGreaterThan(300);
    await canvas.click({ position: { x: 5, y: 5 } });
    await game.keyboard.down('KeyD');
    try {
      await expectStoppedAtSteepFoot(observe, 'export');
    } finally {
      await game.keyboard.up('KeyD');
    }
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
});
