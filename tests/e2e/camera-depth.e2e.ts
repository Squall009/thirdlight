/**
 * Phase 23.4: view distance — a virtual camera's own far plane and the
 * project's depth precision (`depth_buffer`), in Play against a real backend
 * on both renderer backends (this file runs in the WebGPU project too).
 *
 * A neutral scene: a small red box 8 m in front of a fixed virtual camera and
 * a large green "vista" slab 5 km out. The scene camera's far plane (100 m)
 * would clip the vista; the virtual camera's `far` (20 km) draws it. With the
 * logarithmic depth buffer the renderer reports its depth mode on the canvas
 * (`data-tl-depth`) and both the near box and the far vista are drawn.
 */
import { randomBytes } from 'node:crypto';

import { expect, test, type Locator } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng } from './png';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await be!.command({ op: 'queryProject', projectId: be!.projectId, args: {} })).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-camera-depth' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}

async function create(name: string, position: number[], extra: Record<string, unknown> = {}, kind = 'group'): Promise<string> {
  return String((await cmd('createEntity', { parentId: null, kind, name, transform: { position }, ...extra }))['createdId']);
}

/** Pixels of a colour in the view (sampled every 2 px). */
async function count(frame: Locator, which: 'red' | 'green'): Promise<number> {
  const img = decodePng(await frame.screenshot());
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (which === 'red' ? r > 50 && r > g * 3 && r > b * 3 : g > 40 && g > r * 2 && g > b * 2) n += 1;
    }
  }
  return n;
}

test('a virtual camera\'s far plane draws a vista 5 km out; the logarithmic depth buffer is applied', async ({ page }) => {
  test.setTimeout(180_000);
  be = await startBackend('camera-depth-e2e');
  const near = await create('Near box', [0, 1, 0], { box: { size: [1, 1, 1], material: { color: '#d02020' } } }, 'box');
  await create('Vista', [0, 150, -5000], { box: { size: [3000, 600, 40], material: { color: '#20b030' } } }, 'box');
  const shot = await create('Shot', [0, 2, 8]);
  await cmd('setComponent', { entityId: shot, component: 'virtualCamera', value: { rig: 'fixed', target: near, near: 0.1, far: 20000 } });
  await cmd('setSettings', { settings: { depth_buffer: 2 } });

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame.contentFrame().locator('canvas[data-tl-depth]')).toHaveAttribute('data-tl-depth', 'logarithmic', { timeout: 60_000 });
  await expect.poll(async () => count(frame, 'red'), { timeout: 60_000, message: 'the near box' }).toBeGreaterThan(200);
  await expect.poll(async () => count(frame, 'green'), { timeout: 30_000, message: 'the vista 5 km out (beyond the scene camera\'s 100 m far plane)' }).toBeGreaterThan(200);
  await frame.screenshot({ path: 'test-results/camera-depth.png' });
  await page.getByTitle('Stop the play preview').click();
});
