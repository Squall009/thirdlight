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
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from './pw';

import { layeredMaterial } from '../../packages/editor/src/session/material-graph';
import { startBackend, type E2EBackend } from './backend';
import { gpuAvailable } from './browser-env.mjs';
import { ALBEDO_HEIGHT_LAYERS, isBlue, isRed, packNormalAndOrm, packTexture, publishLayerSources, useArrays, type Pred } from './painted-layers';
import { decodePng, type Image } from './png';
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

async function buildTerrain(): Promise<string> {
  await cmd('setSettings', { settings: { camera_far_m: 400 } });
  for (const id of ['model-0001', 'spawn-0001', 'box-0001', 'box-0002', 'box-0003', 'box-0004', 'model-0002']) await cmd('deleteEntity', { entityId: id }).catch(() => undefined);
  // The arrays (through the pack route) and the layered template, made as the Materials tab makes it.
  await publishLayerSources(be!);
  await packNormalAndOrm(be!);
  await packTexture(be!, ALBEDO_HEIGHT_LAYERS, 'color', 'terrain-albedo');
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
  return ground;
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
  return count(img, isRed) / ((img.width * img.height) / 4) > 0.5 && count(img, isBlue) > 20 && sky.n > 40 && sky.away === 0;
}
function expectFrame(img: Image, what: string): void {
  expect(count(img, isRed) / ((img.width * img.height) / 4), `${what}: red ground`).toBeGreaterThan(0.5);
  expect(count(img, isBlue), `${what}: the painted disc`).toBeGreaterThan(20);
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

/** WebGPU and WebGL 2 on a GPU host; WebGL 2 alone where there is no WebGPU adapter. */
const BACKENDS: readonly ('webgpu' | 'webgl2')[] = gpuAvailable() ? ['webgpu', 'webgl2'] : ['webgl2'];

test('terrain: CDLOD heights, layered material, paint and a hole in the Scene view, Play and the export, without cracks (WebGPU and WebGL 2)', async ({ page }) => {
  test.skip(test.info().project.name === 'webgpu', 'one pass covers both renderers');
  test.setTimeout(420_000);
  be = await startBackend('terrain-cdlod');
  const ground = await buildTerrain();
  const plain = await surface(ground, ...PLAIN);
  const painted = await surface(ground, ...PAINTED);
  const holeAt: V3 = [HOLE[0], (await surface(ground, ...HOLE))[1], HOLE[1]];
  let holed = false;

  for (const renderer of BACKENDS) {
    await page.goto(be.editorUrl.replace('#', `&renderer=${renderer}#`));
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    const canvas = page.locator('canvas.tl-viewport');
    await expect.poll(() => canvas.evaluate((c) => `${c.getAttribute('data-tl-renderer')}/${c.getAttribute('data-tl-renderer-state')}`), { timeout: 30_000 }).toBe(`${renderer}/ready`);
    await expect(viewport(page)).toHaveAttribute('data-view-proj', /\[/);
    // Every tile read and uploaded, one draw for the page of tiles, nothing failed to read.
    const terrain = async (): Promise<{ tilesDrawn: number; draws: number; perLevel: number[]; errors: string[] }> => JSON.parse((await viewport(page).getAttribute('data-terrain')) ?? '{"tilesDrawn":0,"draws":0,"perLevel":[],"errors":[]}');
    await expect.poll(async () => (await terrain()).tilesDrawn, { timeout: 30_000 }).toBe(TILES * TILES);
    const t = await terrain();
    expect(t.draws).toBe(1);
    expect(t.errors).toEqual([]);
    // The quadtree's three levels (8, 16, 32 m nodes) are all drawn.
    expect(t.perLevel.length).toBe(3);
    expect(t.perLevel.every((n) => n > 0)).toBe(true);
    // The Scene view: the layered material's layer 1 where unpainted, layer 3 on the painted disc.
    await expect.poll(() => shareNear(page, plain, isRed), { timeout: 60_000, message: `${renderer} Scene view: red ground` }).toBeGreaterThan(0.8);
    await expect.poll(() => shareNear(page, painted, isBlue), { timeout: 30_000, message: `${renderer} Scene view: the painted disc` }).toBeGreaterThan(0.8);
    if (!holed) {
      expect(await shareNear(page, holeAt, (r, g, b) => isRed(r, g, b) || isBlue(r, g, b))).toBeGreaterThan(0.8);
      // A holes stroke with the page open: its tile's layers are uploaded again and the ground there is cut away.
      await cmd('editTerrain', { entityId: ground, kind: 'holes', dabs: [HOLE], radius: 3 });
      holed = true;
    }
    await expect.poll(() => shareNear(page, holeAt, (r, g, b) => !isRed(r, g, b) && !isBlue(r, g, b)), { timeout: 30_000, message: `${renderer} Scene view: the hole` }).toBeGreaterThan(0.6);

    // Play: the scene camera's frame.
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
    let last: Image | null = null;
    await expect
      .poll(async () => {
        // Full size: a crack is a pixel wide.
        const shot = await relay(`${psid}/screenshot`, { maxWidth: 2048 });
        if (shot.status !== 200) return false;
        last = decodePng(Buffer.from(String(shot.json['dataUrl'] ?? '').split(',')[1] ?? '', 'base64'));
        return frameOk(last);
      }, { timeout: 90_000, message: `${renderer} Play: the terrain with its layers and hole` })
      .toBe(true)
      .catch((e: Error) => {
        if (last !== null) expectFrame(last, `${renderer} Play`);
        throw e;
      });
    expectFrame(last!, `${renderer} Play`);
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
        expect(errors).toEqual([]);
      } finally {
        await game.close();
      }
    }
  } finally {
    await site.close();
  }
});
