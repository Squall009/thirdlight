/**
 * Animator override layers with a bone mask, and an
 * animation-only GLB whose clips play on another model's rig.
 *
 * The neutral skinned column (bones `root` and `upper`, clips `idle` and
 * `bend`) and a clips-only file (the same bones, no mesh, clip `wave`: the
 * upper half bent to the right) are imported; the clips file is marked
 * "clips for rig of" the column in the Asset browser. In the Animator tab
 * (the graph editor; layers are tabs inside it) a controller
 * plays `idle` on the base layer; a second layer, masked to the `upper` bone
 * with the bone picker, plays `wave` from the clips file (a state added from
 * the node catalogue, made the entry state in the Inspector). The
 * live preview shows the upper half bent to the right; masking the layer to
 * `root` instead (a bone `wave` does not animate) straightens it again. Play
 * (the runtime's two-layer state machine and the renderer's masked actions,
 * the clips file loaded from the build) shows the same.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { clipsOnlyGlb, skinnedGlb } from './skinned-glb';
import { openWindow, openEditor, editorPane, inspector as inspectorOf, previewCanvas, previewPane } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend();
});
test.afterEach(async () => {
  await be.stop();
});

const orange = (img: Image, x: number, y: number): boolean => {
  const [r, g, b] = img.pixel(x, y);
  return r > 60 && r > 1.25 * g && g > 1.8 * b;
};
/** The rightmost orange column (fraction of the width) over a band of rows, or 0. */
function rightEdge(img: Image, from: number, to: number): number {
  let edge = 0;
  for (let y = Math.floor(img.height * from); y < Math.floor(img.height * to); y += 2) {
    for (let x = img.width - 1; x > 0; x -= 2) {
      if (orange(img, x, y)) {
        edge = Math.max(edge, x / img.width);
        break;
      }
    }
  }
  return edge;
}
/**
 * How far the top of the column reaches right of its base (fraction of the
 * width): about 0 for the straight column, large when the upper half bends
 * to the right. Independent of the preview's framing.
 */
function leanRight(img: Image): number {
  return rightEdge(img, 0.05, 0.45) - rightEdge(img, 0.75, 0.95);
}

async function assets(): Promise<{ assetId: string; displayName: string; clipsFor?: string }[]> {
  return (await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 10, offset: 0 } }))['assets'] as { assetId: string; displayName: string; clipsFor?: string }[];
}

async function importGlb(page: Page, dir: string, name: string, bytes: Buffer, count: number): Promise<void> {
  const file = join(dir, name);
  writeFileSync(file, bytes);
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect.poll(async () => (await assets()).length, { timeout: 15_000 }).toBe(count);
}

test('an upper-body layer masked by bone plays clips of an animation-only file in the live preview and in Play', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  const dir = mkdtempSync(join(tmpdir(), 'tl-layers-'));
  await importGlb(page, dir, 'column.glb', skinnedGlb(), 1);
  await importGlb(page, dir, 'moves.glb', clipsOnlyGlb(), 2);
  const list = await assets();
  const column = list.find((a) => a.displayName.includes('column'))!;
  const moves = list.find((a) => a.displayName.includes('moves'))!;
  expect(column, JSON.stringify(list)).toBeDefined();
  expect(moves, JSON.stringify(list)).toBeDefined();

  // Mark the clips-only file as clips for the column's rig; the editor checks the bone names.
  await page.locator(`.tl-assets__list li[data-asset-id="${moves.assetId}"]`).click();
  await page.getByRole('combobox', { name: 'clips for rig of' }).selectOption(column.assetId);
  await expect.poll(async () => (await assets()).find((a) => a.assetId === moves.assetId)?.clipsFor).toBe(column.assetId);
  await expect(page.getByLabel('clips for rig check')).toHaveText('every animated bone is in the rig', { timeout: 15_000 });

  // A controller on the column: idle on the base layer (it opens in the editor window).
  await openWindow(page, 'Animator');
  await page.getByLabel('animator model').selectOption(column.assetId);
  await page.getByRole('button', { name: 'New controller' }).click();
  const doc = editorPane(page, 'Animator', 'New animator');
  const graph = doc.getByLabel('animator graph');
  const inspector = inspectorOf(page);
  await expect(graph.getByRole('group', { name: 'State idle node state-01' })).toBeVisible();

  // The live preview (the editor window's preview pane): the straight column.
  const readout = previewPane(page).getByLabel('animator preview', { exact: true });
  const preview = previewCanvas(page);
  await expect(readout).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });
  await page.waitForTimeout(500);
  const straight = leanRight(decodePng(await preview.screenshot()));

  // A second layer (a tab inside the document): a state playing `wave` from the clips file, made the entry state.
  await doc.getByRole('button', { name: 'Add layer' }).click();
  await expect(doc.getByRole('tab', { name: 'Layer 1' })).toHaveAttribute('aria-selected', 'true');
  await expect(doc.getByLabel('layer settings')).toBeVisible();
  await expect(graph.getByRole('group', { name: /^Empty state Empty node / })).toBeVisible();
  const empty = (await graph.getByRole('group', { name: /^Empty state Empty node / }).boundingBox())!;
  const sb = (await graph.locator('.tl-graph__stage').boundingBox())!;
  await page.mouse.click(Math.min(sb.x + sb.width - 260, empty.x + empty.width + 200), empty.y + empty.height + 80, { button: 'right' });
  const popup = page.getByRole('dialog', { name: 'Add node' });
  // An override layer's catalogue also offers empty states.
  await expect(popup.getByRole('option', { name: 'Empty state', exact: true })).toBeVisible();
  await popup.getByRole('option', { name: 'State', exact: true }).click();
  await expect(inspector.getByLabel('state inspector')).toBeVisible();
  await inspector.getByLabel('state clip').selectOption(`${moves.assetId}/wave`);
  await expect.poll(async () => JSON.stringify(((await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['animators'] as { layers?: unknown[] }[])[0]?.layers)).toContain('"clip":"wave"');
  await inspector.getByLabel('state name').fill('Wave');
  await inspector.getByLabel('state name').press('Enter');
  await expect(graph.getByRole('group', { name: /^State Wave node / })).toBeVisible();
  await inspector.getByRole('button', { name: 'Set as entry state' }).click();
  await expect(inspector.getByText('State (entry)')).toBeVisible();

  // The bone picker lists the column's skeleton; mask the layer to the upper bone.
  await expect(doc.getByLabel('mask bone root')).toBeVisible();
  await doc.getByLabel('mask bone upper').click();
  await expect.poll(async () => JSON.stringify(((await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['animators'] as { layers?: unknown[] }[])[0]?.layers)).toContain('"mask":["upper"]');

  // The live preview shows the upper-body layer: the upper half bends to the right.
  await expect(readout).toHaveAttribute('data-layer-states', 'Wave', { timeout: 20_000 });
  await expect(readout).toHaveAttribute('data-state', 'idle');
  await page.waitForTimeout(500);
  const bent = leanRight(decodePng(await preview.screenshot()));
  console.log(`[animator-layers] top of the column right of its base (width fraction): base only ${straight.toFixed(3)}, with the upper-body layer ${bent.toFixed(3)}`);
  expect(straight).toBeLessThan(0.08);
  expect(bent).toBeGreaterThan(0.15);

  // Masked to `root` instead (a bone the clip does not animate): the column is straight again.
  await doc.getByLabel('mask bone upper').click();
  await expect.poll(async () => JSON.stringify(((await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['animators'] as { layers?: unknown[] }[])[0]?.layers)).toContain('"mask":[]');
  await doc.getByLabel('mask bone root').click();
  await expect.poll(async () => JSON.stringify(((await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['animators'] as { layers?: unknown[] }[])[0]?.layers)).toContain('"mask":["root"]');
  await expect(readout).toHaveAttribute('data-layer-states', 'Wave', { timeout: 20_000 });
  await page.waitForTimeout(800);
  const masked = leanRight(decodePng(await preview.screenshot()));
  console.log(`[animator-layers] masked to root: ${masked.toFixed(3)}`);
  expect(masked).toBeLessThan(0.08);

  // What was stored: one override layer over the base layer.
  const stored = ((await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['animators'] as { states: { name: string }[]; layers: { name: string; mask: string[]; weight: number; entry: string; states: { id: string; name: string; motion: { kind: string; clip?: { assetId: string; clip: string } } }[] }[] }[])[0]!;
  expect(stored.states.map((s) => s.name)).toEqual(['idle']);
  expect(stored.layers).toHaveLength(1);
  const layer = stored.layers[0]!;
  expect(layer).toMatchObject({ name: 'Layer 1', mask: ['root'], weight: 1 });
  expect(layer.states.map((s) => [s.name, s.motion.kind])).toEqual([
    ['Empty', 'empty'],
    ['Wave', 'clip'],
  ]);
  expect(layer.states[1]!.motion.clip).toMatchObject({ assetId: moves.assetId, clip: 'wave' });
  expect(layer.entry).toBe(layer.states[1]!.id);

  // Play: the runtime steps both layers and the renderer plays the clips file's
  // `wave` on the column's bones — only when the layer's mask holds `upper`.
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  const created = await be.command({ op: 'createEntity', projectId: be.projectId, expectedRevision: q.revision, requestId: 'req-00000000000000000000000000146a01', origin: { kind: 'mcp', clientId: 'e2e-layers' }, args: { kind: 'model', name: 'column', model: { asset: { assetId: column.assetId } }, transform: { position: [0, 0, 0] } } });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  const q2 = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  const put = await be.command({ op: 'setComponent', projectId: be.projectId, expectedRevision: q2.revision, requestId: 'req-00000000000000000000000000146a02', origin: { kind: 'mcp', clientId: 'e2e-layers' }, args: { entityId: created['createdId'], component: 'animator', value: { controller: (stored as unknown as { controllerId: string }).controllerId } } });
  expect(put.ok, JSON.stringify(put)).toBe(true);
  const rootOnly = await play(page, 'baseline');
  await openEditor(page, 'Animator', 'New animator');
  await doc.getByRole('tab', { name: 'Layer 1' }).click();
  await doc.getByLabel('mask bone root').click();
  await expect.poll(async () => JSON.stringify(((await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['animators'] as { layers?: unknown[] }[])[0]?.layers)).toContain('"mask":[]');
  await doc.getByLabel('mask bone upper').click();
  await expect.poll(async () => JSON.stringify(((await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['animators'] as { layers?: unknown[] }[])[0]?.layers)).toContain('"mask":["upper"]');
  const upper = await play(page, rootOnly + 40);
  console.log(`[animator-layers] Play: orange pixels right of the column, mask root ${rootOnly}, mask upper ${upper}`);
  expect(upper).toBeGreaterThan(rootOnly + 40);
});

/** Orange pixels right of the column's top in Play (the game camera frames the same place every run). */
function playRightPixels(img: Image): number {
  let n = 0;
  for (let y = Math.floor(img.height * 0.05); y < Math.floor(img.height * 0.5); y += 2) {
    for (let x = Math.floor(img.width * 0.53); x < Math.floor(img.width * 0.75); x += 2) if (orange(img, x, y)) n += 1;
  }
  return n;
}

/**
 * Play, measure the orange pixels right of the column's top, stop. Polls the
 * preview instead of a fixed wait (a loaded host takes seconds to show the
 * first frame and to advance the clip):
 * - 'baseline': once the column shows, the most seen over 3 s (a clip that
 *   wrongly bends the column has time to show, so the baseline is not low by luck);
 * - a number: until more than that many show (30 s), else the last count
 *   (the caller's expect then fails with it).
 */
async function play(page: Page, want: 'baseline' | number): Promise<number> {
  const frame = page.locator('iframe.tl-app__preview-frame');
  await page.getByTitle('Start an isolated play preview').click();
  await expect(frame).toBeVisible();
  // The column is on screen (the game camera frames it every run).
  await expect.poll(async () => orangePixels(decodePng(await frame.screenshot())), { timeout: 30_000 }).toBeGreaterThan(40);
  let n = 0;
  if (want === 'baseline') {
    const until = Date.now() + 3000;
    while (Date.now() < until) n = Math.max(n, playRightPixels(decodePng(await frame.screenshot())));
  } else {
    await expect
      .poll(async () => (n = playRightPixels(decodePng(await frame.screenshot()))), { timeout: 30_000 })
      .toBeGreaterThan(want)
      .catch(() => undefined);
  }
  await page.getByTitle('Stop the play preview').click();
  // Stop is a backend round trip plus the preview's teardown: seconds on a loaded CPU-rendered host.
  await expect(page.getByTitle('Start an isolated play preview')).toBeVisible({ timeout: 30_000 });
  return n;
}

/** Orange pixels anywhere in the frame (the column is shown). */
function orangePixels(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) if (orange(img, x, y)) n += 1;
  return n;
}
