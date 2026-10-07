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
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from './pw';

import { layeredMaterial } from '../../packages/editor/src/session/material-graph';
import { controls, startBackend, type E2EBackend } from './backend';
import { gpuAvailable } from './browser-env.mjs';
import { ALBEDO_HEIGHT_LAYERS, isBlue, isRed, packNormalAndOrm, packTexture, publishLayerSources, publishTexture, useArrays, type Pred } from './painted-layers';
import { makePng } from './png-make';
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
type Observation = { state: string; stepIndex?: number; player?: { x: number; y: number; z: number } };
type TerrainDiag = { tilesDrawn: number; draws: number; perLevel: number[]; errors: string[]; uploadMsPeak?: number; uploadBytesPeak?: number; tilesUploaded?: number; cpuBytes?: number; decodeMs?: number; packMs?: number };
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
/** The 1,025² tile's terrain: far out of view (its uploads are what is measured). */
const BIG_ORIGIN: V3 = [3000, 0, 3000];

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

async function buildTerrain(): Promise<{ ground: string; big: string }> {
  await cmd('setSettings', { settings: { camera_far_m: 400 } });
  for (const id of ['model-0001', 'spawn-0001', 'box-0001', 'box-0002', 'box-0003', 'box-0004', 'model-0002']) await cmd('deleteEntity', { entityId: id }).catch(() => undefined);
  // The arrays (through the pack route) and the layered template, made as the Materials tab makes it.
  await publishLayerSources(be!);
  await publishTexture(be!, new Uint8Array(makePng(16, 16, () => [230, 200, 40, 255])), 'alb-5', 'Albedo 5');
  await publishTexture(be!, new Uint8Array(makePng(16, 16, () => [230, 230, 230, 255])), 'hgt-5', 'Height 5');
  await packNormalAndOrm(be!);
  const five = [...ALBEDO_HEIGHT_LAYERS, [{ assetId: 'alb-5', channel: 'r' as const }, { assetId: 'alb-5', channel: 'g' as const }, { assetId: 'alb-5', channel: 'b' as const }, { assetId: 'hgt-5', channel: 'r' as const }]];
  await packTexture(be!, five, 'color', 'terrain-albedo');
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
  // A strip the player walks along into the hole: flat (the bumps are steeper than it climbs).
  const strip: [number, number][] = [];
  for (let z = PLAYER[1] + 2; z >= HOLE[1] + 1; z -= 1) strip.push([PLAYER[0], z]);
  await cmd('editTerrain', { entityId: ground, kind: 'flatten', dabs: strip, radius: 2.5, strength: 1, falloff: 'constant', height: STRIP_HEIGHT });
  // A 3D game with a player on the strip (its capsule's 0.9 m half height over the ground).
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  const player = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Player', transform: { position: [PLAYER[0], STRIP_HEIGHT + 0.95, PLAYER[1]] } }))['createdId']);
  await cmd('setComponent', { entityId: player, component: 'controller', value: {} });
  // One 1,025² tile of noise, far out of view.
  const big = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Far', transform: { position: BIG_ORIGIN } }))['createdId']);
  await cmd('setComponent', { entityId: big, component: 'terrain', value: { tileSamples: 1025, spacing: 1, heightRange: [-64, 64], tiles: [{ x: 0, z: 0 }] } });
  await bigNoise(big, 7);
  return { ground, big };
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
  return count(img, isRed) / ((img.width * img.height) / 4) > 0.5 && count(img, isBlue) > 20 && count(img, isYellow) > 20 && sky.n > 40 && sky.away === 0;
}
function expectFrame(img: Image, what: string): void {
  expect(count(img, isRed) / ((img.width * img.height) / 4), `${what}: red ground`).toBeGreaterThan(0.5);
  expect(count(img, isBlue), `${what}: the painted disc`).toBeGreaterThan(20);
  expect(count(img, isYellow), `${what}: the disc of the fifth layer`).toBeGreaterThan(20);
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
  const { ground, big } = await buildTerrain();
  const plain = await surface(ground, ...PLAIN);
  const painted = await surface(ground, ...PAINTED);
  const holeAt: V3 = [HOLE[0], (await surface(ground, ...HOLE))[1], HOLE[1]];
  const fifth = await surface(ground, ...FIFTH);
  let holed = false;

  for (const renderer of BACKENDS) {
    await page.goto(be.editorUrl.replace('#', `&renderer=${renderer}#`));
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

    // The player stands on the terrain, walks forward (−z) into the hole and falls through it.
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
