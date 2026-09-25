/**
 * Phase 17.4: realtime shadows of boxes (and, by the same rule, models and
 * instance sets). A box above a floor box casts the sun's shadow onto it in
 * Play; with the box's `castShadow` off (the Inspector's "Casts shadows"
 * checkbox, a component field) the shadow is gone. The difference between the
 * two Play frames is the shadow: a patch of the floor clearly darker, and only
 * a patch (shadow acne or a self-shadowed floor would darken far more).
 *
 * Runs once per renderer variant (renderer-variants.ts): auto (the default)
 * and forced WebGL 2 in the default project, WebGPU in the webgpu project.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('shadows-e2e');
});
test.afterEach(async () => {
  await be.stop();
});

let seq = 0;
async function command(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: q['revision'],
    requestId: `req-${String(seq).padStart(32, '0')}`,
    origin: { kind: 'mcp', clientId: 'e2e-shadows' },
    args,
  });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}

/** Pixels where `a` is darker than `b` by more than `delta` (luminance, 0–255). */
function darkerPixels(a: Image, b: Image, delta = 40): number {
  const lum = (p: readonly number[]): number => 0.2126 * p[0]! + 0.7152 * p[1]! + 0.0722 * p[2]!;
  let n = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) if (lum(b.pixel(x, y)) - lum(a.pixel(x, y)) > delta) n += 1;
  return n;
}

async function playFrame(page: Page, variant: (typeof RENDERER_VARIANTS)[number], label: string): Promise<Image> {
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  // Two equal frames in a row: the scene has settled (shaders compiled, shadow map drawn).
  let last = '';
  let img: Image | null = null;
  await expect
    .poll(
      async () => {
        const png = await frame.screenshot();
        img = decodePng(png);
        const same = png.toString('base64') === last;
        last = png.toString('base64');
        return same;
      },
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe(true);
  const out = test.info().outputPath();
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${label}.png`), Buffer.from(last, 'base64'));
  await page.getByTitle('Stop the play preview').click();
  await expect(page.getByTitle('Start an isolated play preview')).toBeVisible();
  return img!;
}

for (const variant of RENDERER_VARIANTS) test(`a box casts the sun's shadow on a floor box in Play; "Casts shadows" off removes it (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(240_000);
  // The new project's camera stands at (0, 0.5, 4) looking along −Z; its sun casts shadows.
  // The floor ends 2 m in front of the camera (a floor edge through the camera's own
  // plane breaks depth testing on SwiftShader, both backends).
  await command('createEntity', { kind: 'box', name: 'floor', transform: { position: [0, -1, -1] }, box: { size: [8, 0.2, 6], material: { color: '#c8c8c8' } } });
  const cube = await command('createEntity', { kind: 'box', name: 'cube', transform: { position: [0, -0.3, 0] }, box: { size: [1, 1, 1], material: { color: '#c05030' } } });
  const cubeId = String(cube['createdId']);
  // The sun from behind-left-above: the shadow falls right and towards the camera (in view).
  await command('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffffff', intensity: 1.2, direction: [0.5, -1, 0.6], castShadow: true } });

  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expectRendererBackend(page.locator('canvas.tl-viewport'), variant);
  // The Inspector shows the box's shadow fields (checked by default).
  await page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'cube' }).click();
  const casts = page.getByLabel('box castShadow', { exact: true });
  await expect(casts).toBeChecked();

  const withShadow = await playFrame(page, variant, 'with-shadow');
  // Off in the Inspector (a controlled checkbox: click, then poll the stored value).
  await casts.click();
  await expect
    .poll(async () => ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: cubeId } }))['entity'] as { components: { box: { castShadow?: boolean } } }).components.box.castShadow)
    .toBe(false);
  const without = await playFrame(page, variant, 'without-shadow');

  expect(withShadow.width).toBe(without.width);
  const shadow = darkerPixels(withShadow, without);
  const total = withShadow.width * withShadow.height;
  console.log(`[shadows] ${variant}: ${shadow} of ${total} pixels darker by > 40 with the cube's shadow`);
  // A visible patch (the cube's 1 m shadow is thousands of pixels here)…
  expect(shadow).toBeGreaterThan(1500);
  // …and only a patch: no acne or self-shadowing over the whole floor.
  expect(shadow).toBeLessThan(total * 0.15);
  // Nothing got brighter (the shadow only takes light away).
  expect(darkerPixels(without, withShadow)).toBeLessThan(200);
});
