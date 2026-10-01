/**
 * Each scene its own look, against a real backend, in the editor. Two
 * scenes of a blank project get different solid skies (set by MCP-style
 * commands with `sceneId`); the editor opens both:
 *
 * - the Scene view shows the active scene's sky (Unity's rule), and switches
 *   when another scene is made active;
 * - the Environment window names the scene it edits and stores its edits in
 *   that scene only (one command, one undo);
 * - "+ Scene" starts from the engine defaults, or copies the look of the
 *   scene chosen beside it.
 *
 * Runs per renderer: WebGL 2 in `default`, WebGPU in `webgpu`.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';
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
  const revision = Number((await query('queryProject')).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-scene-environment' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}
/** Each scene's stored look, by scene id. */
async function looks(): Promise<Record<string, unknown>> {
  const rows = (await query('queryProject', { environments: true }))['scenes'] as { sceneId: string; environment?: unknown }[];
  return Object.fromEntries(rows.map((r) => [r.sceneId, r.environment ?? null]));
}

function avg(img: Image, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = Math.floor(img.height * y0); y < Math.floor(img.height * y1); y += 3) {
    for (let x = Math.floor(img.width * x0); x < Math.floor(img.width * x1); x += 3) {
      const p = img.pixel(x, y);
      r += p[0];
      g += p[1];
      b += p[2];
      n += 1;
    }
  }
  return [r / n, g / n, b / n];
}
/** The sky at the top of a view: [r, g, b]. */
const skyOf = async (t: Locator | Page): Promise<[number, number, number]> => avg(decodePng(await t.screenshot()), 0.05, 0.02, 0.95, 0.12);
const header = (page: Page, name: string): Locator => page.locator('.tl-scene-header').filter({ has: page.locator('.tl-scene-header__name', { hasText: new RegExp(`^${name}$`) }) });

const RED_SKY = { sky: { mode: 'color', color: '#d02020' } };
const BLUE_SKY = { sky: { mode: 'color', color: '#2040d0' } };

for (const variant of RENDERER_VARIANTS) test(`each scene's look in the Scene view; the Environment window edits the active scene's (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(180_000);
  be = await startBackend('scene-environment-e2e');
  await cmd('createScene', { sceneId: 'scene-two', name: 'Two' });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: RED_SKY });
  await cmd('setEnvironment', { sceneId: 'scene-two', environment: BLUE_SKY });

  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const viewport = page.locator('canvas.tl-viewport');
  await expectRendererBackend(viewport, variant);
  const red = async (): Promise<boolean> => { const [r, , b] = await skyOf(viewport); return r > b + 80; };
  const blue = async (): Promise<boolean> => { const [r, , b] = await skyOf(viewport); return b > r + 80; };

  // Main is the active scene: its red sky.
  await expect(header(page, 'Main')).toHaveClass(/is-active/);
  await expect.poll(red, { timeout: 20_000, message: "the active scene's (Main) red sky" }).toBe(true);
  // Opening Two keeps Main active (and its sky); making Two active shows Two's blue sky.
  await page.getByLabel('open scene').selectOption({ label: 'Two' });
  await expect(header(page, 'Two')).toHaveCount(1);
  await expect.poll(red, { timeout: 10_000 }).toBe(true);
  await header(page, 'Two').click();
  await expect(header(page, 'Two')).toHaveClass(/is-active/);
  await expect.poll(blue, { timeout: 20_000, message: "the active scene's (Two) blue sky" }).toBe(true);

  // The Environment window names the scene it edits; an edit goes to that scene only.
  await openWindow(page, 'Environment');
  const named = page.locator('.tl-environment__scene');
  await expect(named).toHaveAttribute('data-scene-id', 'scene-two');
  await expect(named).toContainText('Two');
  await page.getByRole('combobox', { name: 'sky mode' }).selectOption('gradient');
  await expect.poll(async () => (await looks())['scene-two']).toMatchObject({ sky: { mode: 'gradient' } });
  expect((await looks())['scene-main']).toEqual({ sky: { color: '#d02020', mode: 'color' } });
  // The file of the edited scene holds it.
  expect((JSON.parse(readFileSync(join(be.projectDir, 'scenes', 'scene-two.json'), 'utf8')) as { scene: { environment?: unknown } }).scene.environment).toMatchObject({ sky: { mode: 'gradient' } });
  // The default gradient's pale horizon replaces the solid blue (#2040d0 has almost no red).
  await expect.poll(async () => (await skyOf(viewport))[0], { timeout: 20_000, message: 'the gradient sky' }).toBeGreaterThan(100);
  // One undo puts Two's colour sky back.
  await viewport.click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await looks())['scene-two']).toEqual({ sky: { color: '#2040d0', mode: 'color' } });

  // Back to Main: the window follows the active scene.
  await header(page, 'Main').click();
  await expect(named).toHaveAttribute('data-scene-id', 'scene-main');
  await expect(page.getByRole('combobox', { name: 'sky mode' })).toHaveValue('color');
  await expect.poll(red, { timeout: 20_000 }).toBe(true);

  // "+ Scene": the engine defaults, or the look of the scene chosen beside it.
  await page.getByRole('button', { name: '+ Scene' }).click();
  await expect(header(page, 'Scene 3')).toHaveClass(/is-active/);
  await page.getByLabel('new scene look').selectOption({ label: 'look of Two' });
  await page.getByRole('button', { name: '+ Scene' }).click();
  await expect(header(page, 'Scene 4')).toHaveClass(/is-active/);
  const rows = (await query('queryProject', { environments: true }))['scenes'] as { name: string; environment?: unknown }[];
  expect(rows.find((r) => r.name === 'Scene 3')!.environment).toBeUndefined();
  expect(rows.find((r) => r.name === 'Scene 4')!.environment).toEqual({ sky: { color: '#2040d0', mode: 'color' } });
  await expect.poll(blue, { timeout: 20_000, message: "the copied look (Two's blue) on the new active scene" }).toBe(true);
});
