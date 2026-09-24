/**
 * Phase 14.6: animator override layers with a bone mask, and an
 * animation-only GLB whose clips play on another model's rig.
 *
 * The neutral skinned column (bones `root` and `upper`, clips `idle` and
 * `bend`) and a clips-only file (the same bones, no mesh, clip `wave`: the
 * upper half bent to the right) are imported; the clips file is marked
 * "clips for rig of" the column in the Asset browser. In the Animator window
 * a controller plays `idle` on the base layer; a second layer, masked to the
 * `upper` bone with the bone picker, plays `wave` from the clips file. The
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

  // A controller on the column: idle on the base layer.
  await page.getByRole('tab', { name: 'Animator' }).click();
  await page.getByLabel('animator model').selectOption(column.assetId);
  await page.getByRole('button', { name: 'New controller' }).click();
  const graph = page.getByLabel('animator graph');
  await expect(graph.getByRole('button', { name: 'state idle' })).toBeVisible();

  // The live preview: the straight column.
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = page.getByLabel('animator preview', { exact: true });
  await expect(preview).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });
  await page.waitForTimeout(500);
  const straight = leanRight(decodePng(await preview.screenshot()));

  // A second layer: a state playing `wave` from the clips file, made the entry state.
  await page.getByRole('button', { name: 'Add layer' }).click();
  await expect(page.getByRole('tab', { name: 'Layer 1' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('layer settings')).toBeVisible();
  await expect(graph.getByRole('button', { name: 'state Empty' })).toBeVisible();
  const box = (await graph.boundingBox())!;
  await graph.click({ button: 'right', position: { x: box.width * 0.6, y: 180 } });
  await page.getByRole('menuitem', { name: 'Add state' }).click();
  await expect(page.getByLabel('state inspector')).toBeVisible();
  await page.getByLabel('state clip').selectOption(`${moves.assetId}/wave`);
  await page.getByLabel('state name').fill('Wave');
  await page.getByLabel('state name').blur();
  await expect(graph.getByRole('button', { name: 'state Wave' })).toBeVisible();
  await graph.getByRole('button', { name: 'state Wave' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Set as entry state' }).click();

  // The bone picker lists the column's skeleton; mask the layer to the upper bone.
  await expect(page.getByLabel('mask bone root')).toBeVisible();
  await page.getByLabel('mask bone upper').check();
  await expect.poll(async () => JSON.stringify(((await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['animators'] as { layers?: unknown[] }[])[0]?.layers)).toContain('"mask":["upper"]');

  // The live preview shows the upper-body layer: the upper half bends to the right.
  await expect(preview).toHaveAttribute('data-layer-states', 'Wave', { timeout: 20_000 });
  await expect(preview).toHaveAttribute('data-state', 'idle');
  await page.waitForTimeout(500);
  const bent = leanRight(decodePng(await preview.screenshot()));
  console.log(`[animator-layers] top of the column right of its base (width fraction): base only ${straight.toFixed(3)}, with the upper-body layer ${bent.toFixed(3)}`);
  expect(straight).toBeLessThan(0.08);
  expect(bent).toBeGreaterThan(0.15);

  // Masked to `root` instead (a bone the clip does not animate): the column is straight again.
  await page.getByLabel('mask bone upper').uncheck();
  await page.getByLabel('mask bone root').check();
  await expect.poll(async () => JSON.stringify(((await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['animators'] as { layers?: unknown[] }[])[0]?.layers)).toContain('"mask":["root"]');
  await expect(preview).toHaveAttribute('data-layer-states', 'Wave', { timeout: 20_000 });
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
  await page.getByRole('button', { name: 'Stop preview' }).click();
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  const created = await be.command({ op: 'createEntity', projectId: be.projectId, expectedRevision: q.revision, requestId: 'req-00000000000000000000000000146a01', origin: { kind: 'mcp', clientId: 'e2e-layers' }, args: { kind: 'model', name: 'column', model: { asset: { assetId: column.assetId } }, transform: { position: [0, 0, 0] } } });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  const q2 = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  const put = await be.command({ op: 'setComponent', projectId: be.projectId, expectedRevision: q2.revision, requestId: 'req-00000000000000000000000000146a02', origin: { kind: 'mcp', clientId: 'e2e-layers' }, args: { entityId: created['createdId'], component: 'animator', value: { controller: (stored as unknown as { controllerId: string }).controllerId } } });
  expect(put.ok, JSON.stringify(put)).toBe(true);
  const rootOnly = playRightPixels(await play(page));
  await page.getByRole('tab', { name: 'Animator' }).click();
  await page.getByRole('tab', { name: 'Layer 1' }).click();
  await page.getByLabel('mask bone root').uncheck();
  await page.getByLabel('mask bone upper').check();
  await expect.poll(async () => JSON.stringify(((await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['animators'] as { layers?: unknown[] }[])[0]?.layers)).toContain('"mask":["upper"]');
  const upper = playRightPixels(await play(page));
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

async function play(page: Page): Promise<Image> {
  const frame = page.locator('iframe.tl-app__preview-frame');
  await page.getByTitle('Start an isolated play preview').click();
  await expect(frame).toBeVisible();
  await page.waitForTimeout(2500);
  const img = decodePng(await frame.screenshot());
  await page.getByTitle('Stop the play preview').click();
  return img;
}
