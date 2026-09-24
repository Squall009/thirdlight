/**
 * Phase 9.7: the Animator window. A skinned test model (two joints, clips
 * `idle` and `bend`) gets a controller built in the window: an entry state
 * playing `idle`, a second state playing `bend`, a transition on a bool
 * parameter. Play shows the straight column while the parameter is false and
 * the bent one once it is true.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { skinnedGlb } from './skinned-glb';

let be: E2EBackend;
let seq = 0;
test.beforeEach(async () => {
  be = await startBackend();
});
test.afterEach(async () => {
  await be.stop();
});

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: q.revision, requestId: `req-${(0xa11a00 + seq).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'e2e-animator' }, args });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

/** Orange pixels in the part of the frame left of the column's top (where the bent half goes). */
function bentPixels(img: Image): number {
  let n = 0;
  for (let y = Math.floor(img.height * 0.05); y < Math.floor(img.height * 0.5); y += 2) {
    for (let x = Math.floor(img.width * 0.25); x < Math.floor(img.width * 0.47); x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (r > 60 && r > 1.25 * g && g > 1.8 * b) n += 1;
    }
  }
  return n;
}

async function play(page: Page): Promise<Image> {
  const frame = page.locator('iframe.tl-app__preview-frame');
  await page.getByTitle('Start an isolated play preview').click();
  await expect(frame).toBeVisible();
  await page.waitForTimeout(2500);
  const img = decodePng(await frame.screenshot());
  await page.getByTitle('Stop the play preview').click();
  return img;
}

test('a controller built in the Animator window poses a skinned model in Play by its parameter', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // Import the skinned model and place it.
  const dir = mkdtempSync(join(tmpdir(), 'tl-skin-'));
  const file = join(dir, 'column.glb');
  writeFileSync(file, skinnedGlb());
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect.poll(async () => ((await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 10, offset: 0 } }))['assets'] as unknown[]).length).toBe(1);
  const assetId = ((await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 10, offset: 0 } }))['assets'] as { assetId: string }[])[0]!.assetId;
  const column = String((await cmd('createEntity', { kind: 'model', name: 'column', model: { asset: { assetId } }, transform: { position: [0, 0, 0] } })).createdId);

  // Build the controller in the Animator window.
  await page.getByRole('tab', { name: 'Animator' }).click();
  await expect(page.getByLabel('animator model')).toHaveValue(assetId);
  await page.getByRole('button', { name: 'New controller' }).click();
  const graph = page.getByLabel('animator graph');
  await expect(graph.getByRole('button', { name: 'state idle' })).toBeVisible();
  await page.getByLabel('new parameter name').fill('bent');
  await page.getByLabel('new parameter type').selectOption('bool');
  await page.getByRole('button', { name: 'Add parameter' }).click();
  await expect(page.getByLabel('parameter bent default')).toBeVisible();

  const box = (await graph.boundingBox())!;
  await graph.click({ button: 'right', position: { x: box.width * 0.6, y: 200 } });
  await page.getByRole('menuitem', { name: 'Add state' }).click();
  await expect(page.getByLabel('state inspector')).toBeVisible();
  await page.getByLabel('state clip').selectOption('bend');
  await page.getByLabel('state name').fill('Bent');
  await page.getByLabel('state name').blur();
  await expect(graph.getByRole('button', { name: 'state Bent' })).toBeVisible();

  await graph.getByRole('button', { name: 'state idle' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Make transition' }).click();
  await graph.getByRole('button', { name: 'state Bent' }).click();
  await expect(page.getByLabel('transition inspector')).toBeVisible();
  await page.getByRole('button', { name: 'Add condition' }).click();
  await page.getByLabel('condition 1 parameter').selectOption('bent');
  await expect(page.getByLabel('condition 1 test')).toHaveValue('true');
  await page.getByLabel('transition has exit time').uncheck();
  await page.getByLabel('transition duration').fill('0');

  const controllers = (await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['animators'] as { controllerId: string; states: { name: string }[]; transitions: { conditions: unknown[]; exitTime?: number; duration: number }[] }[];
  expect(controllers).toHaveLength(1);
  expect(controllers[0]!.states.map((s) => s.name)).toEqual(['idle', 'Bent']);
  expect(controllers[0]!.transitions).toEqual([{ from: 'state-01', to: 'state-02', conditions: [{ parameter: 'bent', op: 'true' }], duration: 0 }]);

  // The live preview: the controller runs on its model; flipping `bent` in the preview moves to Bent and changes the pose.
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = page.getByLabel('animator preview', { exact: true });
  await expect(preview).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });
  await page.waitForTimeout(500);
  const before = decodePng(await preview.screenshot());
  await page.getByLabel('preview bent').check();
  await expect(preview).toHaveAttribute('data-state', 'Bent');
  await page.waitForTimeout(500);
  const after = decodePng(await preview.screenshot());
  let changed = 0;
  for (let y = 0; y < Math.min(before.height, after.height); y += 2) {
    for (let x = 0; x < Math.min(before.width, after.width); x += 2) {
      const a = before.pixel(x, y);
      const b = after.pixel(x, y);
      if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 60) changed += 1;
    }
  }
  console.log(`[animator] preview pixels changed by the pose: ${changed}`);
  expect(changed).toBeGreaterThan(20);
  await page.getByRole('button', { name: 'Stop preview' }).click();
  await expect(preview).toHaveCount(0);
  // Nothing was saved by the preview.
  expect(JSON.stringify((await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['animators'])).not.toContain('"default":true');

  // Put the controller on the model (Inspector).
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${column}"]`).click();
  // Phase 15.1: "+ Add component" → Animator, then pick its controller.
  await page.locator('.tl-inspector').getByLabel('add component', { exact: true }).selectOption({ label: 'Animator' });
  await page.locator('.tl-inspector').getByLabel('animator controller', { exact: true }).selectOption({ label: 'New animator' });
  await page.locator('.tl-inspector').getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(async () => ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: column } }))['entity'] as { components: { animator?: unknown } }).components.animator).toEqual({ controller: controllers[0]!.controllerId });

  // Play: bent = false → straight; bent = true → the upper half leans over.
  const straight = bentPixels(await play(page));
  await page.getByRole('tab', { name: 'Animator' }).click();
  await page.getByLabel('parameter bent default').check();
  await expect.poll(async () => JSON.stringify((await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['animators'])).toContain('"default":true');
  const bent = bentPixels(await play(page));
  console.log(`[animator] orange pixels left of the column: straight ${straight}, bent ${bent}`);
  expect(bent).toBeGreaterThan(straight + 40);
});
