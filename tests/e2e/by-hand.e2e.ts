/**
 * A material, an effect and a timeline built the way a person builds them:
 * through the editor's own controls only — the project window's Create menu,
 * the graph's node catalogue, wires dragged between ports, Inspector fields,
 * the timeline's toolbar and key inspector. No command, query or MCP call is
 * made after the project exists; what was built is read back from the page
 * after a reload. Screenshots of each step go to TL_BY_HAND_DIR for the owner.
 *
 * Not part of the gates: it runs only when TL_BY_HAND_DIR names the folder.
 * It stands in for a person's hands, not for the owner's own try.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { createItem, editorPane, editorTab, editorWindow, inspector, openEditor, previewPane } from './ui';

const OUT = process.env['TL_BY_HAND_DIR'];

let be: E2EBackend | undefined;
test.afterEach(async () => {
  await be?.stop();
});

let shots = 0;
async function shot(page: Page, name: string): Promise<void> {
  // Let the preview draw (a picture for the owner, not a measurement).
  await page.waitForTimeout(800);
  shots += 1;
  await page.screenshot({ path: join(OUT!, `${String(shots).padStart(2, '0')}-${name}.png`) });
}

const node = (page: Page, id: string): Locator => page.locator(`[data-node-id="${id}"]`);
const port = (page: Page, id: string, side: 'in' | 'out', name: string): Locator => page.locator(`[data-node="${id}"][data-side="${side}"][data-port="${name}"]`);
async function centre(l: Locator): Promise<{ x: number; y: number }> {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function wire(page: Page, from: Locator, to: Locator): Promise<void> {
  const a = await centre(from);
  const b = await centre(to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}
/** Right-click an empty spot of the graph and pick a node from the catalogue; the new node's id. */
async function addNode(page: Page, at: { x: number; y: number }, query: string, pick: string, type: string): Promise<string> {
  const before = await page.locator(`.tl-graph [data-node-type="${type}"]`).count();
  await page.mouse.click(at.x, at.y, { button: 'right' });
  const popup = page.getByRole('dialog', { name: 'Add node' });
  await expect(popup).toBeVisible();
  await popup.getByLabel('Search nodes').fill(query);
  await popup.getByRole('option', { name: pick, exact: true }).click();
  await expect(popup).toHaveCount(0);
  const added = page.locator(`.tl-graph [data-node-type="${type}"]`);
  await expect(added).toHaveCount(before + 1);
  return (await added.nth(before).getAttribute('data-node-id'))!;
}
/** A spot of the graph stage `dx`, `dy` from its top left. */
async function stageAt(page: Page, dx: number, dy: number): Promise<{ x: number; y: number }> {
  const b = (await page.locator('.tl-graph__stage').first().boundingBox())!;
  return { x: b.x + dx, y: b.y + dy };
}
async function saved(page: Page): Promise<void> {
  await expect(page.locator('.tl-statusbar')).toContainText('saved');
}

test('a material, an effect and a timeline built through the editor only', async ({ page }) => {
  test.skip(OUT === undefined, 'set TL_BY_HAND_DIR to drive the build and keep its screenshots');
  test.setTimeout(420_000);
  mkdirSync(OUT!, { recursive: true });
  await page.setViewportSize({ width: 1600, height: 960 });
  be = await startBackend('by-hand-0001', 'starter');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await shot(page, 'default-view');

  // ---- A graph material: an empty PBR output, a Colour node wired to its base colour, the colour picked.
  await createItem(page, ['Graph material', 'Empty (PBR output)'], 'Ember');
  await expect(editorTab(page, 'Material', 'Ember')).toHaveAttribute('aria-selected', 'true');
  await expect(previewPane(page)).toHaveAttribute('data-kind', 'material');
  await shot(page, 'material-new');
  const colour = await addNode(page, await stageAt(page, 120, 120), 'colour', 'Colour', 'color');
  await wire(page, port(page, colour, 'out', 'rgb'), port(page, 'output', 'in', 'baseColor'));
  await expect(editorWindow(page).locator('[data-edge-id]')).toHaveCount(1);
  await node(page, colour).click({ position: { x: 90, y: 8 } });
  await inspector(page).getByLabel('Colour', { exact: true }).fill('#ff6a00');
  await saved(page);
  await shot(page, 'material-built');

  // ---- An effect: a system from the empty state, a burst of 50, a lifetime and a billboard wired to their contexts, a longer duration.
  await createItem(page, 'Effect', 'Sparks');
  const fx = editorPane(page, 'Effect', 'Sparks');
  await expect(fx.getByRole('region', { name: 'empty: No particle systems yet' })).toBeVisible();
  await shot(page, 'effect-new');
  await fx.getByRole('region', { name: 'empty: No particle systems yet' }).getByRole('button', { name: 'Add a system' }).click();
  await expect(node(page, 'spawn')).toBeVisible();
  const burst = await addNode(page, await stageAt(page, 60, 320), 'burst', 'Burst', 'spawn.burst');
  await wire(page, port(page, 'spawn', 'out', 'then'), port(page, burst, 'in', 'in'));
  await expect(editorWindow(page).locator('[data-edge-id]')).toHaveCount(1);
  // A lifetime for the particles and a billboard to draw them, chained to their contexts.
  const life = await addNode(page, await stageAt(page, 60, 470), 'lifetime', 'Lifetime', 'init.lifetime');
  await wire(page, port(page, 'initialize', 'out', 'then'), port(page, life, 'in', 'in'));
  const board = await addNode(page, await stageAt(page, 60, 620), 'billboard', 'Billboard', 'output.billboard');
  await wire(page, port(page, 'output', 'out', 'then'), port(page, board, 'in', 'in'));
  await expect(editorWindow(page).locator('[data-edge-id]')).toHaveCount(3);
  await node(page, burst).click({ position: { x: 90, y: 8 } });
  await inspector(page).getByLabel('Count', { exact: true }).fill('50');
  await inspector(page).getByLabel('Count', { exact: true }).press('Enter');
  await fx.getByLabel('effect duration', { exact: true }).fill('3');
  await fx.getByLabel('effect duration', { exact: true }).press('Enter');
  await saved(page);
  // The preview held just after the burst, so the picture shows the particles.
  await previewPane(page).getByRole('button', { name: 'pause preview' }).click();
  await previewPane(page).getByRole('slider', { name: 'preview time' }).fill('0.4');
  await shot(page, 'effect-built');

  // ---- A timeline: a fade track from the empty state, a key at 1 s, its value set.
  await createItem(page, 'Timeline', 'Opening');
  const tl = editorPane(page, 'Timeline', 'Opening');
  const empty = tl.getByRole('region', { name: 'empty: No tracks yet' });
  await expect(empty).toBeVisible();
  await shot(page, 'timeline-new');
  await tl.getByRole('combobox', { name: 'New track type' }).selectOption({ label: 'Fade' });
  await empty.getByRole('button', { name: /^Add a fade track$/i }).click();
  const lane = tl.locator('.tl-timeline__lane[data-lane="track-1"]');
  await expect(lane).toBeVisible();
  const ruler = (await tl.getByLabel('Timeline ruler').boundingBox())!;
  await page.mouse.click(ruler.x + 80, ruler.y + ruler.height / 2);
  await lane.click();
  await tl.getByRole('button', { name: 'Add key at playhead', exact: true }).click();
  const key = tl.locator('.tl-timeline__key[data-track-id="track-1"][data-key-index="0"]');
  await expect(key).toHaveCount(1);
  await page.getByLabel('Key value', { exact: true }).fill('0.5');
  await page.getByLabel('Key value', { exact: true }).press('Enter');
  await saved(page);
  await shot(page, 'timeline-built');

  // ---- After a reload each is as built (read from the page, not the API).
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await openEditor(page, 'Material', 'Ember');
  await expect(editorWindow(page).locator('.tl-graph [data-node-type="color"]')).toHaveCount(1);
  await expect(editorWindow(page).locator('[data-edge-id]')).toHaveCount(1);
  await node(page, colour).click({ position: { x: 90, y: 8 } });
  await expect(inspector(page).getByLabel('Colour', { exact: true })).toHaveValue('#ff6a00');
  await shot(page, 'material-reloaded');
  await openEditor(page, 'Effect', 'Sparks');
  await expect(editorWindow(page).locator('.tl-graph [data-node-type="spawn.burst"]')).toHaveCount(1);
  await expect(editorWindow(page).locator('[data-edge-id]')).toHaveCount(3);
  await node(page, burst).click({ position: { x: 90, y: 8 } });
  await expect(inspector(page).getByLabel('Count', { exact: true })).toHaveValue('50');
  await expect(editorPane(page, 'Effect', 'Sparks').getByLabel('effect duration', { exact: true })).toHaveValue('3');
  await shot(page, 'effect-reloaded');
  await openEditor(page, 'Timeline', 'Opening');
  const keyAgain = editorPane(page, 'Timeline', 'Opening').locator('.tl-timeline__key[data-track-id="track-1"][data-key-index="0"]');
  await expect(keyAgain).toHaveAttribute('data-time', '1');
  await keyAgain.click();
  await expect(page.getByLabel('Key value', { exact: true })).toHaveValue('0.5');
  await shot(page, 'timeline-reloaded');
  expect(errors).toEqual([]);
});
