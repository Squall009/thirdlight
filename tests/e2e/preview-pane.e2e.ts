/**
 * The editor window's one preview pane against the real backend, on each
 * renderer.
 *
 * - A timeline shows on its scene: the Scene view's own canvas moves into
 *   the pane (the window covers the Scene view, so a scene-bound preview
 *   needs that canvas in front), and scrubbing moves the
 *   crate in the pane's pixels.
 * - A material shows on the pane's own canvas; the Scene view's canvas is
 *   back home meanwhile.
 * - A UI document shows at the editor's resolution over its scene: its
 *   magenta panel and the green crate in one picture; a new resolution
 *   reaches the pane.
 * - One renderer while the window shows: switching between its open items
 *   makes no new one; closing the window releases it and gives the Scene
 *   view its canvas back.
 *
 * The animator, effect and dialogue previews are checked in pixels in their
 * own specs (animator, effect-editor, dialogue).
 */
import { createHash } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { backendOf, editorUrlFor, expectRendererBackend, onlyInItsProject, PRODUCT_RENDERER_VARIANTS, type RendererVariant } from './renderer-variants';
import { closeEditor, editorTab, editorWindow, openEditor, previewCanvas, previewPane } from './ui';

let be: E2EBackend;
test.afterEach(async () => {
  await be?.stop();
});

const query = (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => be.command({ op, projectId: be.projectId, args });
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await query('queryProject');
  const r = await be.command({ op, projectId: be.projectId, expectedRevision: q['revision'], requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`, origin: { kind: 'mcp', clientId: 'e2e-preview-pane' }, args });
  expect(r['ok'], JSON.stringify(r).slice(0, 600)).toBe(true);
  return r;
}

const shot = async (l: Locator): Promise<Image> => decodePng(await l.screenshot());
type Test = (r: number, g: number, b: number) => boolean;
const green: Test = (r, g, b) => g > 90 && g > 1.6 * r && g > 1.6 * b;
const magenta: Test = (r, g, b) => r > 150 && b > 150 && g < 0.5 * Math.min(r, b);
const orange: Test = (r, g, b) => r > 180 && g > 60 && g < 0.75 * r && b < 0.4 * r;
/** How many pixels (every 2nd) pass `test`, and their mean x as a share of the width. */
function census(img: Image, t: Test): { n: number; x: number } {
  let n = 0;
  let sx = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (t(r, g, b)) {
        n += 1;
        sx += x;
      }
    }
  }
  return { n, x: n === 0 ? -1 : sx / n / img.width };
}
const ledger = async (page: Page): Promise<{ open: number; opened: number; closed: number }> => JSON.parse((await page.locator('html').getAttribute('data-tl-previews')) ?? '{"open":0,"opened":0,"closed":0}');

const VARIANTS: readonly RendererVariant[] = PRODUCT_RENDERER_VARIANTS;

for (const variant of VARIANTS) test(`one preview pane: a timeline and a UI document on their scene, a material on its own canvas, one renderer (${variant})`, async ({ page }) => {
  onlyInItsProject(variant, VARIANTS);
  test.setTimeout(240_000);
  be = await startBackend('preview-pane-e2e');
  // A green crate at the origin, a timeline that slides it 4 m along x in 2 s.
  const crate = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Crate', transform: { position: [0, 0.5, 0] }, box: { size: [1, 1, 1], material: { color: '#20e020' } } }))['createdId']);
  await cmd('setTimeline', {
    timeline: {
      timelineId: 'slide',
      name: 'Slide',
      duration: 4,
      slots: [{ name: 'crate', entity: crate }],
      tracks: [{ trackId: 'move', type: 'transform', target: 'crate', keys: [{ time: 0, position: [0, 0.5, 0] }, { time: 2, position: [4, 0.5, 0] }] }],
    },
  });
  // A UI document with a magenta panel in its top-left corner.
  await cmd('setUiDocument', { document: { uiDocumentId: 'hud', name: 'HUD', root: { type: 'panel', stretch: 'both', children: [{ id: 'box', type: 'panel', anchor: [0, 0], offset: [0, 0], size: [640, 360], css: { background: '#ff00ff' } }] } } });
  // An orange graph material (emissive: its colour does not depend on the light).
  await cmd('setMaterial', {
    material: {
      materialId: 'mat-glow',
      name: 'Glow',
      shader: 'standard',
      params: {},
      textures: {},
      graph: {
        nodes: [
          { id: 'output', type: 'pbr', position: [400, 0] },
          { id: 'black', type: 'color', position: [0, 0], data: { color: '#000000' } },
          { id: 'glow', type: 'color', position: [0, 150], data: { color: '#ff8000' } },
        ],
        edges: [
          { id: 'w1', from: { node: 'black', port: 'rgb' }, to: { node: 'output', port: 'baseColor' } },
          { id: 'w2', from: { node: 'glow', port: 'rgb' }, to: { node: 'output', port: 'emissive' } },
        ],
      },
    },
  });
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const home = page.locator('.tl-viewport-host canvas.tl-viewport');
  await expect(home).toHaveCount(1);
  await expectRendererBackend(home, variant);

  // The timeline: the Scene view's canvas in the pane, the window opaque over the default view.
  await openEditor(page, 'Timeline', 'Slide');
  const pane = previewPane(page);
  await expect(pane).toHaveAttribute('data-kind', 'timeline');
  const lent = pane.locator('canvas.tl-viewport');
  await expect(lent).toHaveCount(1);
  await expect(home).toHaveCount(0);
  await expect(previewCanvas(page)).toBeHidden();
  expect(await editorWindow(page).evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  const scene = pane.getByLabel('preview scene');
  let at0 = { n: 0, x: -1 };
  await expect.poll(async () => (at0 = census(await shot(scene), green)).n, { timeout: 30_000 }).toBeGreaterThan(20);
  // Scrub to 1 s (80 px per second at the default zoom): the crate is at x 2, to the right in the pane.
  const ruler = page.getByLabel('Timeline ruler');
  const r = (await ruler.boundingBox())!;
  await page.mouse.click(r.x + 80, r.y + r.height / 2);
  await expect.poll(async () => JSON.parse((await lent.getAttribute('data-timeline-preview')) || 'null')?.time ?? -1).toBeCloseTo(1, 1);
  let at1 = { n: 0, x: -1 };
  await expect.poll(async () => (at1 = census(await shot(scene), green)).x - at0.x, { timeout: 30_000 }).toBeGreaterThan(0.05);
  console.log(`[preview-pane] ${variant}: crate at 0 s ${JSON.stringify(at0)}, at 1 s ${JSON.stringify(at1)}`);

  // A material: the pane's own canvas, the Scene view's canvas home again.
  await openEditor(page, 'Material', 'Glow');
  await expect(pane).toHaveAttribute('data-kind', 'material');
  await expect(home).toHaveCount(1);
  const canvas = previewCanvas(page);
  await expectRendererBackend(canvas, variant);
  await expect.poll(async () => census(await shot(canvas), orange).n, { timeout: 30_000 }).toBeGreaterThan(200);

  // A UI document at the editor's resolution over its scene: the magenta panel and the crate in one picture.
  await openEditor(page, 'UI', 'HUD');
  await expect(pane).toHaveAttribute('data-kind', 'ui');
  await expect(lent).toHaveCount(1);
  await expect(pane.getByLabel('UI document preview').locator('[data-widget="box"]')).toHaveCount(1, { timeout: 30_000 });
  await expect.poll(async () => census(await shot(scene), magenta).n, { timeout: 30_000 }).toBeGreaterThan(50);
  const ui = await shot(scene);
  const m = census(ui, magenta);
  console.log(`[preview-pane] ${variant}: UI over the scene: magenta ${JSON.stringify(m)}, green ${JSON.stringify(census(ui, green))}`);
  // The panel is the top-left third of the screen; the crate shows beside it.
  expect(m.x).toBeLessThan(0.3);
  expect(census(ui, green).n).toBeGreaterThan(10);
  const size = pane.locator('[data-preview-size]');
  const before = await size.getAttribute('data-preview-size');
  const res = editorWindow(page).getByLabel('preview resolution');
  const options = await res.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  await res.selectOption(options[1]!);
  await expect(size).not.toHaveAttribute('data-preview-size', before!);

  // Switching between the open items makes no new renderer (the pane keeps its one while the window shows).
  const made = (await ledger(page)).opened;
  for (const [kind, name, shown] of [['Timeline', 'Slide', 'timeline'], ['Material', 'Glow', 'material'], ['UI', 'HUD', 'ui']] as const) {
    await editorTab(page, kind, name).click();
    await expect(pane).toHaveAttribute('data-kind', shown);
    await expect(lent).toHaveCount(shown === 'material' ? 0 : 1);
  }
  expect((await ledger(page)).opened).toBe(made);
  expect((await ledger(page)).open).toBe(1);
  // The window closing releases it and the Scene view has its canvas back.
  const frames = Number((await lent.getAttribute('data-frames')) ?? 0);
  await closeEditor(page);
  await expect(home).toHaveCount(1);
  expect((await ledger(page)).open).toBe(0);
  // Back at its own size, the Scene view draws again.
  await expect.poll(async () => Number((await home.getAttribute('data-frames')) ?? 0), { timeout: 10_000 }).toBeGreaterThan(frames);
  expect(backendOf(variant)).toBe(await home.getAttribute('data-tl-renderer'));
});
