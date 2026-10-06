/**
 * The Scene view draws what Play draws: both go through the same scene
 * adapter (lights and the sun's shadow, materials, the environment's sky,
 * fog and post), so the same scene through the same camera matches pixel
 * for pixel within the renderer parity rule (parity.ts `STRICT`).
 *
 * The game's camera is put where the Scene view's is (its pose and lens, read
 * from `data-view-camera`), the view's own overlays are switched off (icons,
 * light gizmos, gameplay helpers, the grid), and nothing is selected. Both
 * renderers (renderer-variants.ts). The scene uses light layers, per-vertex
 * local lights and ambient occlusion as well, so those agree too.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { diff, diffPng, show, STRICT, within } from './parity';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';
import { menu, showView } from './ui';
import { centre, gameCameraAtView, settledShot, viewCamera } from './view-match';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('scene-view-parity-e2e');
});
test.afterEach(async () => {
  await be.stop();
});

let seq = 0;
async function command(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: q['revision'], requestId: `req-${String(seq).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'e2e-scene-view-parity' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}

for (const variant of RENDERER_VARIANTS) test(`the Scene view and Play draw the same scene through the same camera alike (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(300_000);
  // Boxes in a plain and a standard (surface) material, the starter's sun (with its shadow) and ambient
  // light, a point light, and a scene look with a sky colour, fog and post.
  await command('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'floor', transform: { position: [0, -0.1, 0] }, box: { size: [10, 0.2, 10], material: { color: '#b8b8b0' } } });
  const cube = await command('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'cube', transform: { position: [0, 0.5, 0], rotation: [0, 0.3826834, 0, 0.9238795] }, box: { size: [1, 1, 1], material: { color: '#c05030' } } });
  const tall = await command('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'pillar', transform: { position: [-2, 1, -1.5] }, box: { size: [0.6, 2, 0.6], material: { color: '#3060c0' } } });
  await command('setComponent', { entityId: String(tall['createdId']), component: 'surface', value: { color: '#4070d0', roughness: 0.4, metalness: 0.2, emissive: '#000000', emissiveIntensity: 1 } });
  const lamp = await command('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'lamp', transform: { position: [1.5, 1.2, 1.5] } });
  await command('setComponent', { entityId: String(lamp['createdId']), component: 'light', value: { type: 'point', color: '#ffb060', intensity: 6, range: 6, decay: 2 } });
  // The lighting controls the two must agree on too: the cube is in light layer 2 only, so a magenta lamp masked to
  // layer 1 lights the floor round it and not the cube; the pillar takes local lights per vertex; ambient occlusion
  // (the look's) darkens the creases' indirect light.
  await command('setComponent', { entityId: String(cube['createdId']), component: 'box', value: { size: [1, 1, 1], material: { color: '#c05030' }, lightLayers: 2 } });
  await command('setComponent', { entityId: String(tall['createdId']), component: 'box', value: { size: [0.6, 2, 0.6], material: { color: '#3060c0' }, localLights: 'vertex' } });
  const masked = await command('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'masked lamp', transform: { position: [0.9, 0.8, -0.9] } });
  await command('setComponent', { entityId: String(masked['createdId']), component: 'light', value: { type: 'point', color: '#ff40ff', intensity: 5, range: 4, decay: 2, lightMask: 1 } });
  await command('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#506070' }, fog: { mode: 'linear', color: '#506070', near: 8, far: 40 }, post: { exposure: 1.1, ssao: { enabled: true } } } });

  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const view = page.locator('canvas.tl-viewport');
  await expectRendererBackend(view, variant);
  // The view's own overlays off: what is left is what the game draws.
  await menu(page, 'Gizmos', 'Icons: on');
  await menu(page, 'Gizmos', 'Light ranges: on');
  await menu(page, 'Gizmos', 'Gameplay paths and areas: on');
  await menu(page, 'Gizmos', 'Grid: on');
  await expect(view).toHaveAttribute('data-gizmos', '');
  await expect(view).toHaveAttribute('data-grid', 'false');
  // Game lighting (the scene has lights): the scene's lights, look and shadows.
  await expect(page.getByText('light: game')).toBeVisible();

  const cam = await gameCameraAtView(page, command, variant, async (id) => (await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: id } }))['entity'] as never);
  const scene = await settledShot(view, `scene-view-${variant}`);
  expect(await viewCamera(page)).toEqual(cam);

  await page.getByTitle('Start an isolated play preview').click();
  const game = page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first();
  await expectRendererBackend(game, variant);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  const play = await settledShot(game, `play-${variant}`);
  await page.getByTitle('Stop the play preview').click();
  await showView(page, 'Scene');

  console.log(`[scene-view-parity] ${variant}: Scene view ${scene.width}×${scene.height}, Play ${play.width}×${play.height}`);
  // The same scale: Play's picture is the middle of the Scene view's.
  const w = Math.min(scene.width, play.width);
  const h = Math.min(scene.height, play.height);
  const a = centre(scene, w, h);
  const b = centre(play, w, h);
  const d = diff(a, b, STRICT);
  console.log(`[scene-view-parity] ${variant}: ${show(d)}`);
  if (!within(d)) writeFileSync(join(test.info().outputPath(), `diff-${variant}.png`), diffPng(a, b));
  expect(within(d), show(d)).toBe(true);
});
