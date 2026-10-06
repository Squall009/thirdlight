/**
 * Point, spot and hemisphere lights. A red point light next to a
 * box tints it in the Scene view (game lighting) and in Play; the light is
 * edited in the Inspector; the Scene view toggles between the editor rig and
 * the scene's own lights.
 *
 * Runs on the product's own renderer (renderer-variants.ts
 * PRODUCT_RENDERER_VARIANTS): scene-lights covers lights and cookies on both.
 */
import { randomBytes } from 'node:crypto';

import { expect, test } from './pw';

import { publishBytes, startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, PRODUCT_RENDERER_VARIANTS } from './renderer-variants';
import { menu } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend();
});
test.afterEach(async () => {
  await be.stop();
});

function reddish(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
    const [r, g, b] = img.pixel(x, y);
    if (r > 60 && r > 1.8 * g && r > 1.8 * b) n += 1;
  }
  return n;
}

for (const variant of PRODUCT_RENDERER_VARIANTS) test(`a red point light tints a box in the Scene view and in Play; lights are edited in the Inspector (${variant})`, async ({ page }) => {
  onlyInItsProject(variant, PRODUCT_RENDERER_VARIANTS);
  test.setTimeout(120_000);
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expectRendererBackend(page.locator('canvas.tl-viewport'), variant);
  // The new project has a sun and an ambient light: the Scene view uses them.
  await expect(page.getByRole('button', { name: 'light: game' })).toBeVisible();
  await menu(page, 'GameObject', 'Box');
  await menu(page, 'GameObject', 'Light', 'Point light');
  const lightRow = page.locator('.tl-hierarchy__list li.tl-row.is-selected');
  await expect(lightRow).toContainText('Point light');
  const lightId = (await lightRow.getAttribute('data-entity-id'))!;
  // Red, strong, close to the box (the box sits at the view focus; the light 1 m above it).
  await expect(page.locator('[aria-label="light component"]')).toBeVisible();
  const colour = page.getByLabel('light color', { exact: true });
  await colour.focus();
  await colour.evaluate((el: HTMLInputElement) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(el, '#ff0000');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await colour.blur();
  await page.getByRole('slider', { name: 'light intensity' }).focus();
  await page.keyboard.press('End');
  const box = (await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 50, offset: 0 } }))['entities'] as { id: string; components: { box?: object; transform: { position: number[] } } }[];
  const boxPos = box.find((e) => e.components.box !== undefined)!.components.transform.position;
  const q = await be.command({ op: 'queryProject', projectId: be.projectId });
  const moved = await be.command({ op: 'setTransform', projectId: be.projectId, expectedRevision: q['revision'], requestId: `req-${'b'.repeat(31)}1`, args: { entityId: lightId, transform: { position: [boxPos[0]!, boxPos[1]! + 1.2, boxPos[2]! + 1.2] } } });
  expect(moved['ok'], JSON.stringify(moved)).toBe(true);
  const light = (await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: lightId } }))['entity'] as { components: { light: { color: string; intensity: number } } };
  expect(light.components.light).toMatchObject({ color: '#ff0000', intensity: 1000 });

  const viewport = page.locator('canvas.tl-viewport');
  await page.locator('canvas.tl-viewport').click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => reddish(decodePng(await viewport.screenshot())), { timeout: 20_000 }).toBeGreaterThan(300);
  // The editor rig ignores the scene's lights.
  await page.getByRole('button', { name: 'light: game' }).click();
  await expect(page.getByRole('button', { name: 'light: editor' })).toBeVisible();
  await expect.poll(async () => reddish(decodePng(await viewport.screenshot())), { timeout: 20_000 }).toBeLessThan(100);
  await page.getByRole('button', { name: 'light: editor' }).click();

  // Play shows the same light.
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  await expect.poll(async () => reddish(decodePng(await frame.screenshot())), { timeout: 20_000 }).toBeGreaterThan(200);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
});

/** Separate runs of bright pixels along row y (at least `minRun` long: the gizmo lines and icons are shorter). */
function brightRuns(img: Image, y: number, minRun = 12): number {
  let n = 0;
  let len = 0;
  for (let x = 0; x <= img.width; x += 1) {
    const on = x < img.width && (([r, g, b]) => r + g + b > 300)(img.pixel(x, y));
    if (on) len += 1;
    else {
      if (len >= minRun) n += 1;
      len = 0;
    }
  }
  return n;
}
function mostBrightRuns(img: Image): number {
  let best = 0;
  for (let y = 0; y < img.height; y += 1) best = Math.max(best, brightRuns(img, y));
  return best;
}

/**
 * A spot light's cookie (three's SpotLight.map) is set in the
 * Inspector (a texture field on spot lights only) and shows in the Scene
 * view: the spot's patch on a dark floor is one bright disc before and
 * striped after. Play draws it too (scene-lights.e2e.ts checks its pixels).
 */
for (const variant of PRODUCT_RENDERER_VARIANTS) test(`a spot light's cookie is set in the Inspector and shows in the Scene view (${variant})`, async ({ page }) => {
  onlyInItsProject(variant, PRODUCT_RENDERER_VARIANTS);
  test.setTimeout(120_000);
  await publishBytes(be, makePng(64, 64, (x) => (Math.floor(x / 8) % 2 === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255])), 'texture', 'tex-stripes');
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expectRendererBackend(page.locator('canvas.tl-viewport'), variant);
  await menu(page, 'GameObject', 'Box');
  await menu(page, 'GameObject', 'Light', 'Spot light');
  const lightRow = page.locator('.tl-hierarchy__list li.tl-row.is-selected');
  await expect(lightRow).toContainText('Spot light');
  const lightId = (await lightRow.getAttribute('data-entity-id'))!;
  // Directional lights have no cookie field; spot lights do.
  const cookie = page.locator('.tl-inspector').getByLabel('light cookie', { exact: true });
  await expect(cookie).toBeVisible();

  // A dark floor under the spot, the spot 4 m above it pointing down (the default direction).
  const entities = (await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 50, offset: 0 } }))['entities'] as { id: string; components: { box?: object; transform: { position: number[] } } }[];
  const box = entities.find((e) => e.components.box !== undefined)!;
  const at = box.components.transform.position;
  const send = async (op: string, args: Record<string, unknown>): Promise<void> => {
    const q = await be.command({ op: 'queryProject', projectId: be.projectId });
    const r = await be.command({ op, projectId: be.projectId, expectedRevision: q['revision'], requestId: `req-${randomBytes(16).toString('hex')}`, args });
    expect(r['ok'], JSON.stringify(r)).toBe(true);
  };
  await send('setComponent', { entityId: box.id, component: 'box', value: { size: [12, 0.2, 12], material: { color: '#202020' } } });
  await send('setTransform', { entityId: lightId, transform: { position: [at[0]!, at[1]! + 4, at[2]!] } });
  await send('setComponent', { entityId: lightId, component: 'light', value: { type: 'spot', color: '#ffffff', intensity: 1000, range: 0, decay: 2, angle: 30, penumbra: 0, direction: [0, -1, 0] } });

  const viewport = page.locator('canvas.tl-viewport');
  // Only the lit floor is measured: no light icons or cone outlines over it.
  await menu(page, 'Gizmos', 'Icons: on');
  await menu(page, 'Gizmos', 'Light ranges: on');
  await viewport.click({ position: { x: 5, y: 5 } }); // nothing selected: no transform gizmo either
  await expect.poll(async () => mostBrightRuns(decodePng(await viewport.screenshot())), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  const plain = mostBrightRuns(decodePng(await viewport.screenshot()));
  expect(plain).toBe(1); // one disc

  // The cookie, picked in the Inspector.
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${lightId}"]`).click();
  await cookie.selectOption({ label: 'tex-stripes' });
  const stored = async (): Promise<unknown> => ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: lightId } }))['entity'] as { components: { light: { cookie?: string } } }).components.light.cookie;
  await expect.poll(stored).toBe('tex-stripes');
  await viewport.click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => mostBrightRuns(decodePng(await viewport.screenshot())), { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
  console.log(`scene view bright runs (${variant}): plain ${plain}, cookie ${mostBrightRuns(decodePng(await viewport.screenshot()))}`);

  // Cleared again in the Inspector: one disc.
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${lightId}"]`).click();
  await cookie.selectOption({ label: 'none' });
  await expect.poll(stored).toBeUndefined();
  await viewport.click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => mostBrightRuns(decodePng(await viewport.screenshot())), { timeout: 20_000 }).toBe(plain);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
});
