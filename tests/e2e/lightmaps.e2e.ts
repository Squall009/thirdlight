/**
 * Phase 9.6: light baking. A static cube on a static ground, the sun set to
 * "baked" and casting no realtime shadow: before a bake Play shows no shadow;
 * after "Bake preview" (in this browser) or "Bake final" (Blender Cycles on
 * the bake host) in the Lighting window the cube's shadow is in the ground's
 * lightmap (the sun is then no longer realtime), and a lit spot keeps about
 * the brightness the realtime sun gave it.
 */
import { spawnSync } from 'node:child_process';

import { expect, test, type Page } from '@playwright/test';
import * as THREE from 'three';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';

let be: E2EBackend;
let seq = 0;
test.afterEach(async () => {
  await be?.stop();
});

/** The final bake runs Blender here (THIRDLIGHT_BLENDER / blender on PATH), or on TL_BAKE_HOST with TL_BAKE_BLENDER. */
const bakeBlender = process.env['TL_BAKE_BLENDER'] ?? process.env['THIRDLIGHT_BLENDER'] ?? 'blender';
const bakeHost = process.env['TL_BAKE_HOST'] ?? 'local';
const haveBlender = bakeHost !== 'local' || spawnSync(bakeBlender, ['--version'], { encoding: 'utf8' }).status === 0;

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: q.revision,
    requestId: `req-${(0xb0a00 + seq).toString(16).padStart(32, '0')}`,
    origin: { kind: 'mcp', clientId: 'e2e-lightmaps' },
    args,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

/** Mean brightness of a small square around a world point, as the Play camera sees it. */
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
  for (let y = cy - 3; y <= cy + 3; y++) {
    for (let x = cx - 3; x <= cx + 3; x++) {
      const [r, g, b] = img.pixel(x, y);
      sum += (r + g + b) / 3;
      n += 1;
    }
  }
  return sum / n;
}

interface Scene {
  ground: string;
  cube: string;
  play: () => Promise<Image>;
}

async function openScene(page: Page): Promise<Scene> {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const ground = String((await cmd('createEntity', { kind: 'box', name: 'ground', box: { size: [12, 0.5, 8], material: { color: '#b0b0b0' } }, transform: { position: [0, -0.25, 0] } })).createdId);
  const cube = String((await cmd('createEntity', { kind: 'box', name: 'cube', box: { size: [1, 2, 1], material: { color: '#b0b0b0' } }, transform: { position: [0, 1, 0] } })).createdId);
  // The camera looks down on the ground at 30° (a side-view game camera sits higher than eye level).
  await cmd('setTransform', { entityId: 'cam-main', transform: { position: [0, 3, 6], rotation: [-0.2588190451, 0, 0, 0.9659258263] } });
  await cmd('updateEntity', { entityId: ground, static: true });
  await cmd('updateEntity', { entityId: cube, static: true });
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffffff', intensity: 1.2, direction: [0.4, -1, -0.3], castShadow: false, mode: 'baked' } });
  await cmd('setComponent', { entityId: 'light-0002', component: 'light', value: { type: 'ambient', color: '#8090a8', intensity: 0.6, mode: 'baked' } });
  const frame = page.locator('iframe.tl-app__preview-frame');
  const play = async (): Promise<Image> => {
    await page.getByTitle('Start an isolated play preview').click();
    await expect(frame).toBeVisible();
    await page.waitForTimeout(2500);
    const img = decodePng(await frame.screenshot());
    await page.getByTitle('Stop the play preview').click();
    return img;
  };
  return { ground, cube, play };
}

const shadowSpot: [number, number, number] = [0.95, 0, -0.75];
const litSpot: [number, number, number] = [-0.95, 0, -0.75];

async function bakeOf(): Promise<{ atlases: string[]; entries: { entityId: string }[]; bakedLights: string[]; source: string; bounces: number }> {
  const config = await be.command({ op: 'queryGameConfig', projectId: be.projectId });
  return Object.values(config['lighting'] as Record<string, { atlases: string[]; entries: { entityId: string }[]; bakedLights: string[]; source: string; bounces: number }>)[0]!;
}

test('Bake preview puts the static cube\'s shadow into the ground\'s lightmap; Play shows it', async ({ page }) => {
  test.setTimeout(240_000);
  be = await startBackend();
  const { ground, cube, play } = await openScene(page);

  // Play before the bake: baked lights are realtime until a bake holds them — no shadow.
  const before = await play();
  const beforeShadow = brightnessAt(before, shadowSpot);
  const beforeLit = brightnessAt(before, litSpot);
  expect(Math.abs(beforeShadow - beforeLit)).toBeLessThan(15);

  // Bake in the Lighting window.
  await page.getByRole('tab', { name: 'Lighting' }).click();
  await expect(page.locator('[aria-label="bake status"]')).toContainText('No bake for this scene');
  await page.getByRole('button', { name: 'Bake preview (browser)' }).click();
  await expect(page.locator('[aria-label="bake status"]')).toContainText('Preview (browser) bake', { timeout: 120_000 });
  await expect(page.getByRole('status')).toContainText('Baked 2 objects');
  const bake = await bakeOf();
  expect(bake.source).toBe('browser');
  expect(bake.entries.map((e) => e.entityId).sort()).toEqual([cube, ground].sort());
  expect(bake.bakedLights.sort()).toEqual(['light-0001', 'light-0002']);
  expect(bake.atlases).toHaveLength(1);

  // Play after the bake: the shadow is in the lightmap; the lit ground stays about as bright.
  const after = await play();
  const afterShadow = brightnessAt(after, shadowSpot);
  const afterLit = brightnessAt(after, litSpot);
  console.log(`[lightmaps] preview: before lit ${beforeLit.toFixed(1)} shadow ${beforeShadow.toFixed(1)}; after lit ${afterLit.toFixed(1)} shadow ${afterShadow.toFixed(1)}`);
  expect(afterShadow).toBeLessThan(afterLit * 0.75);
  expect(afterLit / beforeLit).toBeGreaterThan(0.6);
  expect(afterLit / beforeLit).toBeLessThan(1.5);

  // Moving a static object makes the bake stale (it is still used).
  await cmd('setTransform', { entityId: cube, transform: { position: [1, 1, 0] } });
  await expect(page.locator('[aria-label="bake status"]')).toContainText('stale');

  // Clear removes the bake (one undo step).
  await page.getByRole('button', { name: 'Clear bake' }).click();
  await expect(page.locator('[aria-label="bake status"]')).toContainText('No bake for this scene');
});

test('Bake final runs Blender Cycles on the bake host; its lightmap shows the shadow in Play', async ({ page }) => {
  test.skip(!haveBlender, 'no Blender for the final bake on this machine');
  test.setTimeout(900_000);
  be = await startBackend('e2e-0001', undefined, { THIRDLIGHT_BAKE_HOST: bakeHost, THIRDLIGHT_BAKE_BLENDER: bakeBlender, THIRDLIGHT_BAKE_TIMEOUT_MINUTES: '12' });
  const { ground, cube, play } = await openScene(page);
  const before = await play();
  const beforeLit = brightnessAt(before, litSpot);

  await page.getByRole('tab', { name: 'Lighting' }).click();
  await expect(page.getByRole('button', { name: 'Bake final (Blender)' })).toBeEnabled();
  await page.getByRole('button', { name: /settings/ }).click();
  // A small, quick bake (the real samples are the owner's choice).
  await page.getByRole('spinbutton', { name: 'bake finalSamples' }).fill(bakeHost === 'local' ? '32' : '256');
  await page.getByRole('spinbutton', { name: 'bake texelsPerMeter' }).fill('8');
  const started = Date.now();
  await page.getByRole('button', { name: 'Bake final (Blender)' }).click();
  await expect(page.locator('[aria-label="bake status"]')).toContainText('Final (Blender) bake', { timeout: 840_000 });
  console.log(`[lightmaps] final bake on ${bakeHost}: ${((Date.now() - started) / 1000).toFixed(1)} s (${await page.getByRole('status').textContent()})`);
  const bake = await bakeOf();
  expect(bake.source).toBe('blender');
  expect(bake.bounces).toBe(3);
  expect(bake.entries.map((e) => e.entityId).sort()).toEqual([cube, ground].sort());

  const after = await play();
  const afterShadow = brightnessAt(after, shadowSpot);
  const afterLit = brightnessAt(after, litSpot);
  console.log(`[lightmaps] final: before lit ${beforeLit.toFixed(1)}; after lit ${afterLit.toFixed(1)} shadow ${afterShadow.toFixed(1)}`);
  expect(afterShadow).toBeLessThan(afterLit * 0.8);
  // Bounce light adds a little on top of what the realtime sun + ambient gave.
  expect(afterLit / beforeLit).toBeGreaterThan(0.7);
  expect(afterLit / beforeLit).toBeLessThan(1.7);
});
