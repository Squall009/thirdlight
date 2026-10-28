/**
 * "Bake lighting" of block layers: the live lighting run until it settles
 * and saved, drawn on WebGL 2 and the low tier the way WebGPU draws it live.
 *
 * The ground is a static block layer (a 12 × 8 floor of 1 m cells, top at
 * y = 0) with a static cube standing on it; the sun and the ambient light
 * are "baked", and so is a small area light over the floor's front corner.
 * Before a bake, on WebGPU, the area light lights a pool there that its
 * mirror spot across the floor lacks: an area light has no per-pixel light,
 * so the pool is the blocks reading the surface cache live. The floor there
 * is polished (a standard material): the lamp's highlight shows where the
 * camera sees its mirror image, brighter than the spot as far from the lamp
 * on its other side (the cache's diffuse light is the same at both).
 * "Bake lighting" in the Lighting window saves the cache's pages and the
 * probes (the scene's bake: `surface`). The static export, served with the
 * backend stopped, draws the saved light on WebGL 2 and at the low quality
 * level on WebGPU (no live light there): the lamp's pool is on the blocks
 * and the baked sun's light keeps about the brightness the realtime sun
 * gave them. A static glowing box over the floor's back left (its glow's
 * light mode left at the default, baked) lights a pool under it there; a
 * flat terrain behind the floor, with a second glowing box over it, keeps
 * its saved light (its rings) too: in the export the terrain shows that
 * pool and about the sun's brightness it had before. A cell edit makes the
 * bake stale.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from './pw';
import * as THREE from 'three';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { backendOf, editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, PRODUCT_RENDERER_VARIANTS, type RendererVariant } from './renderer-variants';
import { openWindow } from './ui';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-block-lightmaps' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}

/** Mean brightness of a small square around a world point, as the game camera (0, 3, 6) looking down 30° sees it. */
function brightnessAt(img: Image, world: [number, number, number]): number {
  const camera = new THREE.PerspectiveCamera(60, img.width / img.height, 0.1, 100);
  camera.position.set(0, 3, 6);
  camera.quaternion.set(-0.2588190451, 0, 0, 0.9659258263);
  camera.updateMatrixWorld();
  const p = new THREE.Vector3(...world).project(camera);
  const cx = Math.round(((p.x + 1) / 2) * img.width);
  const cy = Math.round(((1 - p.y) / 2) * img.height);
  let sum = 0;
  let n = 0;
  for (let y = cy - 3; y <= cy + 3; y++)
    for (let x = cx - 3; x <= cx + 3; x++) {
      const [r, g, b] = img.pixel(x, y);
      sum += (r + g + b) / 3;
      n += 1;
    }
  return sum / n;
}

const shadowSpot: [number, number, number] = [0.95, 0, -0.75];
const litSpot: [number, number, number] = [-0.95, 0, -0.75];
/** Under the area light (its reach ends well short of the spots above), and the same spot mirrored across the floor. */
const lampSpot: [number, number, number] = [3.5, 0, 2];
const mirrorSpot: [number, number, number] = [-3.5, 0, 2];
/** How much brighter (of 255) the lamp's pool is than its mirror spot when the blocks read the cache. */
const LAMP_POOL = 25;
/**
 * Where the camera sees the lamp's mirror image in the floor (the line from the camera to the lamp's centre
 * mirrored under y = 0 meets the floor there), and the spot as far from the lamp straight across it.
 */
const highlightSpot: [number, number, number] = [3, 0, 2.571];
const acrossSpot: [number, number, number] = [4, 0, 1.429];
/** How much brighter (of 255) the highlight is than the spot across the lamp from it on WebGPU. */
const HIGHLIGHT = 12;
/** Under the glowing box over the floor and its mirror spot; under the one over the terrain and its mirror spot. */
const glowSpot: [number, number, number] = [-3.5, 0, -2];
const glowMirror: [number, number, number] = [3.5, 0, -2];
const groundGlow: [number, number, number] = [-3, 0, -8];
const groundMirror: [number, number, number] = [3, 0, -8];
/** How much brighter (of 255) a glowing box's pool is than its mirror spot where its light is drawn. */
const GLOW_POOL = 12;

function serveDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png' };
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

/** The cube's face toward the camera: the sun grazes it, so it is darker than the lit blocks once the scene is drawn. */
const cubeFront: [number, number, number] = [0, 0.5, 0.5];

/**
 * Before a bake: the scene drawn (the blocks lit, the cube's face darker than
 * them) and the same as the frame before (loaded and staying put). Whether
 * the shadow is absent is asserted on that frame, not waited for.
 */
function steadyLit(pool = false): (img: Image) => boolean {
  let last = -1;
  return (img) => {
    const lit = brightnessAt(img, litSpot);
    const steady = Math.abs(lit - last) < 1;
    last = lit;
    return lit > 60 && lit - brightnessAt(img, cubeFront) > 10 && steady && (!pool || (brightnessAt(img, lampSpot) - brightnessAt(img, mirrorSpot) > LAMP_POOL && brightnessAt(img, highlightSpot) - brightnessAt(img, acrossSpot) > HIGHLIGHT));
  };
}

/** Play, the picture taken once it shows what the step waits for. */
async function play(page: Page, variant: RendererVariant, shows: (img: Image) => boolean): Promise<Image> {
  const frame = page.locator('iframe.tl-app__preview-frame');
  await page.getByTitle('Start an isolated play preview').click();
  await expect(frame).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  const shot: { img?: Image } = {};
  await expect
    .poll(async () => {
      shot.img = decodePng(await frame.screenshot());
      return shows(shot.img);
    }, { timeout: 30_000, message: 'the Play frame the step waits for' })
    .toBe(true);
  await page.getByTitle('Stop the play preview').click();
  return shot.img!;
}

/** The scene: a static block-layer floor (polished at its front right), a static cube on it, the sun and ambient "baked"; the editor open on it. */
async function openScene(page: Page, variant: RendererVariant, env: Record<string, string> = {}): Promise<{ layer: string; cube: string }> {
  be = await startBackend('block-lightmaps-e2e', undefined, env);
  await cmd('setBlockType', { block: { blockId: 'stone', name: 'Stone', variants: [{ color: '#b0b0b0' }], shape: 'full' } });
  await cmd('setMaterial', { material: { materialId: 'mat-polished', name: 'Polished', shader: 'standard', params: { color: '#b0b0b0', roughness: 0.25, metalness: 0 }, textures: {} } });
  await cmd('setBlockType', { block: { blockId: 'polished', name: 'Polished', variants: [{ color: '#b0b0b0' }], shape: 'full', materials: { '*': 'mat-polished' } } });
  const layer = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Floor', transform: { position: [-6, -1, -4] } }))['createdId']);
  await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [12, 4, 8] } } });
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [0, 0, 0, 12, 1, 8], cell: { block: 'stone' } }, { kind: 'fill', box: [8, 0, 4, 12, 1, 8], cell: { block: 'polished' } }] });
  const cube = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'cube', box: { size: [1, 2, 1], material: { color: '#b0b0b0' } }, transform: { position: [0, 1, 0] } })).createdId);
  await cmd('setTransform', { entityId: 'cam-main', transform: { position: [0, 3, 6], rotation: [-0.2588190451, 0, 0, 0.9659258263] } });
  await cmd('updateEntity', { entityId: layer, static: true });
  await cmd('updateEntity', { entityId: cube, static: true });
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffffff', intensity: 1.2, direction: [0.4, -1, -0.3], castShadow: false, mode: 'baked' } });
  await cmd('setComponent', { entityId: 'light-0002', component: 'light', value: { type: 'ambient', color: '#8090a8', intensity: 0.6, mode: 'baked' } });
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expectRendererBackend(page.locator('canvas.tl-viewport'), variant);
  await expect.poll(async () => JSON.parse((await page.locator('.tl-viewport').getAttribute('data-block-layers')) ?? '{"chunks":0}').chunks as number, { timeout: 30_000 }).toBe(1);
  return { layer, cube };
}

type BakeRecord = { source: string; atlases: string[]; bakedLights: string[]; surface?: { files: string[]; tiles: number; rings?: number } };
async function bakeRecord(): Promise<BakeRecord> {
  const config = await be!.command({ op: 'queryGameConfig', projectId: be!.projectId });
  return Object.values(config['lighting'] as Record<string, BakeRecord>)[0]!;
}

for (const variant of PRODUCT_RENDERER_VARIANTS) test(`Bake lighting saves a static block layer's live light; the export draws it on WebGL 2 and the low tier (${variant})`, async ({ page }) => {
  onlyInItsProject(variant, PRODUCT_RENDERER_VARIANTS);
  test.setTimeout(300_000);
  const { layer } = await openScene(page, variant);

  // Before the bake: the sun is per pixel without a shadow. A small area light, baked, 0.5 m over the front corner.
  const live = backendOf(variant) === 'webgpu';
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Lamp', transform: { position: [lampSpot[0], 0.5, lampSpot[2]] }, components: { light: { type: 'area', shape: 'rect', width: 0.6, height: 0.6, color: '#ffffff', intensity: 4, range: 1.5, castShadow: false, mode: 'baked' } } });
  // A flat terrain behind the floor (x −8…8, z −12…−4, its top at y = 0), and a static glowing box 0.45 m over the
  // floor and one over the terrain (their surfaces name no glow mode: baked).
  const ground = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Ground', transform: { position: [-8, 0, -12] } }))['createdId']);
  await cmd('setComponent', { entityId: ground, component: 'terrain', value: { tileSamples: 17, spacing: 0.5, heightRange: [-1, 1], tiles: [{ x: 0, z: 0 }, { x: 1, z: 0 }] } });
  await cmd('updateEntity', { entityId: ground, static: true });
  for (const at of [glowSpot, groundGlow]) {
    const glow = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'glow', box: { size: [1.2, 0.1, 1.2], material: { color: '#303030' } }, transform: { position: [at[0], 0.5, at[2]] } })).createdId);
    await cmd('setComponent', { entityId: glow, component: 'surface', value: { color: '#303030', emissive: '#ffc080', emissiveIntensity: 4 } });
    await cmd('updateEntity', { entityId: glow, static: true });
  }
  const before = await play(page, variant, steadyLit(live));
  const beforeLit = brightnessAt(before, litSpot);
  const beforeGround = brightnessAt(before, groundMirror);
  const glows = (img: Image): { floor: number; ground: number } => ({ floor: brightnessAt(img, glowSpot) - brightnessAt(img, glowMirror), ground: brightnessAt(img, groundGlow) - brightnessAt(img, groundMirror) });
  const glowBefore = glows(before);
  console.log(`[block-lightmaps] ${variant}: glowing boxes' pools ${glowBefore.floor.toFixed(1)} on the floor, ${glowBefore.ground.toFixed(1)} on the terrain over their mirror spots; terrain ${beforeGround.toFixed(1)}`);
  // Live their light is in the cache; WebGL 2 draws none before a bake (a glowing box has no per-pixel light).
  if (live) {
    expect(glowBefore.floor).toBeGreaterThan(GLOW_POOL);
    expect(glowBefore.ground).toBeGreaterThan(GLOW_POOL);
  } else {
    expect(Math.abs(glowBefore.floor)).toBeLessThan(GLOW_POOL);
    expect(Math.abs(glowBefore.ground)).toBeLessThan(GLOW_POOL);
  }
  expect(Math.abs(brightnessAt(before, shadowSpot) - beforeLit)).toBeLessThan(15);
  const pool = brightnessAt(before, lampSpot) - brightnessAt(before, mirrorSpot);
  const highlight = brightnessAt(before, highlightSpot) - brightnessAt(before, acrossSpot);
  console.log(`[block-lightmaps] ${variant}: area light pool ${pool.toFixed(1)} over its mirror spot, highlight ${highlight.toFixed(1)} over the spot across the lamp (${live ? 'read from the surface cache' : 'no live cache'})`);
  // Where the cache is lit live the blocks draw its light and the lamp's highlight; WebGL 2 draws no area light before a bake.
  if (live) {
    expect(pool).toBeGreaterThan(LAMP_POOL);
    expect(highlight).toBeGreaterThan(HIGHLIGHT);
  } else {
    expect(Math.abs(pool)).toBeLessThan(LAMP_POOL);
    expect(Math.abs(highlight)).toBeLessThan(HIGHLIGHT);
  }

  // Bake lighting in the Lighting window (WebGPU: the Scene view's live light; WebGL 2 says it cannot).
  await openWindow(page, 'Lighting');
  await expect(page.locator('[aria-label="lighting status"]')).toContainText('No saved lighting for this scene');
  if (!live) {
    await expect(page.getByRole('button', { name: 'Bake lighting' })).toBeDisabled();
    await expect(page.locator('[aria-label="lighting bake unavailable"]')).toContainText('needs WebGPU');
    return;
  }
  const started = Date.now();
  await page.getByRole('button', { name: 'Bake lighting' }).click();
  await expect(page.locator('[aria-label="lighting status"]')).toContainText('Saved lighting from', { timeout: 120_000 });
  console.log(`[block-lightmaps] ${variant}: ${((Date.now() - started) / 1000).toFixed(1)} s — ${await page.getByRole('status').textContent()}`);
  const bake = await bakeRecord();
  expect(bake.source).toBe('cache');
  expect(bake.atlases).toEqual([]);
  expect(bake.surface!.files.length).toBeGreaterThan(0);
  expect(bake.surface!.tiles).toBeGreaterThan(0);
  expect(bake.bakedLights.sort()).toEqual(expect.arrayContaining(['light-0001']));
  expect(bake.surface!.rings, 'the terrain\'s rings saved').toBeGreaterThan(0);

  // A cell edit makes the bake stale (it is still drawn), and back.
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'cells', at: [11, 1, 7], cell: { block: 'stone' } }] });
  await expect(page.locator('[aria-label="lighting status"]')).toContainText('stale');
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'cells', at: [11, 1, 7], cell: null }] });
  await expect(page.locator('[aria-label="lighting status"]')).not.toContainText('stale');

  // The static export with the backend stopped draws the saved light: on WebGL 2, and at the low level on WebGPU.
  const res = await be!.admin(`projects/${be!.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be!.halt();
  const site = await serveDir(join(be!.exportRoot, String(res.json.outputDir)));
  try {
    for (const [renderer, query] of [['webgl2', exportQueryFor('webgl2')], ['webgpu', '?quality=low']] as const) {
      const game = await page.context().newPage();
      const errors: string[] = [];
      game.on('pageerror', (e) => errors.push(e.message));
      try {
        await game.setViewportSize({ width: 960, height: 540 });
        await game.goto(`${site.url}${query}`);
        const canvas = game.locator('canvas').first();
        await expectRendererBackend(canvas, renderer === 'webgl2' ? 'webgl2' : variant);
        let seen = { pool: 0, lit: 0, glow: { floor: 0, ground: 0 }, ground: 0 };
        const shown = await expect
          .poll(async () => {
            const img = decodePng(await canvas.screenshot());
            seen = { pool: brightnessAt(img, lampSpot) - brightnessAt(img, mirrorSpot), lit: brightnessAt(img, litSpot), glow: glows(img), ground: brightnessAt(img, groundMirror) };
            return seen.pool > LAMP_POOL && seen.lit / beforeLit > 0.6 && seen.lit / beforeLit < 1.5 && seen.glow.floor > GLOW_POOL && seen.glow.ground > GLOW_POOL && seen.ground / beforeGround > 0.6 && seen.ground / beforeGround < 1.5;
          }, { timeout: 60_000, message: `the saved light on the blocks and the terrain in the export (${renderer})` })
          .toBe(true)
          .then(() => null, (e: unknown) => e);
        if (shown !== null) {
          console.log(`[block-lightmaps] export ${renderer}${query}: last seen ${JSON.stringify(seen)}`);
          throw shown;
        }
        console.log(`[block-lightmaps] export ${renderer}${query}: saved pool ${seen.pool.toFixed(1)} over its mirror spot, lit ${seen.lit.toFixed(1)} (before the bake ${beforeLit.toFixed(1)}); glowing boxes' pools ${seen.glow.floor.toFixed(1)} floor, ${seen.glow.ground.toFixed(1)} terrain; terrain ${seen.ground.toFixed(1)} (before ${beforeGround.toFixed(1)})`);
        expect(errors).toEqual([]);
      } finally {
        await game.close();
      }
    }
  } finally {
    await site.close();
  }
});
