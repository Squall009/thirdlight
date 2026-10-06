/**
 * Block-layer editing in the real editor against a real
 * backend.
 *
 * A 64 × 64 × 16 layer (the interactive-editing target size) starts with its
 * lower half filled (32,768 cells). The Blocks panel and the Scene view then
 * paint with the single-cell brush, rectangle and box, flood fill, pick with
 * the eyedropper, replace all of a type, raise a column, erase, undo and redo
 * (one step per stroke), paint metadata and show it as an overlay (red pixels
 * in the Scene view), select, copy, paste and mirror a selection, save it as a
 * stamp and place the stamp, lock and hide the layer. The Edit menu's snapping
 * settings change the gizmo's step, and with cell-top snapping on a prop
 * dragged over the layer lands on the cells and its block footprint writes
 * its metadata beneath it, in the same undo step as the move (undo and redo
 * take both); deleting the prop clears the cells and undo restores them; a prop
 * under a moved group snaps and writes its footprint where it stands in the
 * world. The Inspector edits the layer's cell size with x and z as one value
 * (cells are square from above); a command with x ≠ z is refused. Every result is read back from the backend
 * (`queryBlocks`, `queryEntity`); the stroke latency is measured.
 */
import { randomBytes } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { menuItem, openWindow, projectWindow } from './ui';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-block-editor' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}

/** The layer: its min corner at (-8, -7.5, -8), so the top of the filled half (row 7) is at y = 0.5 (clear of the editor's ground grid). */
const ORIGIN = [-8, -7.5, -8] as const;
type V3 = [number, number, number];

/** A cell's top-face centre in world space. */
const top = (x: number, y: number, z: number): V3 => [ORIGIN[0] + x + 0.5, ORIGIN[1] + y + 1, ORIGIN[2] + z + 0.5];
/** A point at the middle of row `y` over the cell (x, z) (a rectangle stroke's plane). */
const mid = (x: number, y: number, z: number): V3 => [ORIGIN[0] + x + 0.5, ORIGIN[1] + y + 0.5, ORIGIN[2] + z + 0.5];

const view = (page: Page) => page.locator('.tl-viewport');

/** World → client pixels through the Scene view's published view-projection matrix. */
async function screen(page: Page, p: V3): Promise<{ x: number; y: number }> {
  const m = JSON.parse((await view(page).getAttribute('data-view-proj'))!) as number[];
  const box = (await view(page).boundingBox())!;
  const [x, y, z] = p;
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  const nx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w;
  const ny = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w;
  return { x: box.x + ((nx + 1) / 2) * box.width, y: box.y + ((1 - ny) / 2) * box.height };
}

/** Hover a world point and wait until the Scene view aims at the expected cell. */
async function aim(page: Page, p: V3, cell: V3): Promise<{ x: number; y: number }> {
  const s = await screen(page, p);
  await page.mouse.move(s.x - 3, s.y - 2);
  await page.mouse.move(s.x, s.y);
  await expect(view(page)).toHaveAttribute('data-block-hover', cell.join(','));
  return s;
}

/** Press on one point, drag through the others, release. */
async function stroke(page: Page, points: { x: number; y: number }[]): Promise<void> {
  await page.mouse.move(points[0]!.x, points[0]!.y);
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(p.x, p.y, { steps: 6 });
  await page.mouse.up();
}

async function cells(layer: string, box: number[]): Promise<Map<string, { block?: string; rot?: number; meta: Record<string, unknown> }>> {
  const r = (await query('queryBlocks', { entityId: layer, box })) as { box: { cells: number[][]; palette: { block?: string; rot?: number }[]; meta: Record<string, unknown>[] } };
  const out = new Map<string, { block?: string; rot?: number; meta: Record<string, unknown> }>();
  for (const c of r.box.cells) out.set(`${c[0]},${c[1]},${c[2]}`, { ...r.box.palette[c[3]!]!, meta: r.box.meta[c[3]!]! });
  return out;
}
const blockAt = async (layer: string, x: number, y: number, z: number): Promise<string | null> => (await cells(layer, [x, y, z, x + 1, y + 1, z + 1])).get(`${x},${y},${z}`)?.block ?? null;
const cellCount = async (layer: string): Promise<number> => ((await query('queryBlocks')) as { layers: { entityId: string; cells: number }[] }).layers.find((l) => l.entityId === layer)?.cells ?? 0;

type EntityView = { active?: boolean; locked?: boolean; components: { transform: { position: number[] }; blockLayer?: { cellSize: number[] } } };
async function entity(id: string): Promise<EntityView> {
  return ((await query('queryEntity', { entityId: id })) as { entity: EntityView }).entity;
}

function countPixels(img: Image, test: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
    const [r, g, b] = img.pixel(x, y);
    if (test(r, g, b)) n += 1;
  }
  return n;
}
const red = (r: number, g: number, b: number): boolean => r > 170 && g < 90 && b < 90;
const green = (r: number, g: number, b: number): boolean => g > r + 35 && g > b + 35 && g > 60;

const panel = (page: Page) => page.getByLabel('blocks panel');
const tool = (page: Page, name: string) => panel(page).getByRole('toolbar', { name: 'block tools' }).getByRole('button', { name, exact: true });
const blockButton = (page: Page, id: string) => panel(page).getByRole('button', { name: `block ${id}`, exact: true });

test('the Blocks panel paints, fills, picks, replaces, selects, stamps and paints metadata; props snap to cell tops', async ({ page }) => {
  test.setTimeout(420_000);
  be = await startBackend('block-editor-e2e');
  await cmd('setCellFields', { fields: [{ key: 'hazard', type: 'bool', color: '#ff0000' }] });
  for (const [blockId, color] of [['stone', '#6b7280'], ['grass', '#3fa34d'], ['sand', '#d8c27a']] as const) await cmd('setBlockType', { block: { blockId, name: blockId[0]!.toUpperCase() + blockId.slice(1), variants: [{ color }], shape: 'full' } });
  const layer = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Ground', transform: { position: [...ORIGIN] } }))['createdId']);
  await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [64, 16, 64] } } });
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [0, 0, 0, 64, 8, 64], cell: { block: 'stone' } }] });
  expect(await cellCount(layer)).toBe(32_768);

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expect.poll(async () => JSON.parse((await view(page).getAttribute('data-block-layers')) ?? '{"chunks":0}').chunks as number, { timeout: 30_000 }).toBe(16);
  await openWindow(page, 'Blocks');
  await expect(panel(page).getByLabel('block layer')).toHaveValue(layer);
  await expect(view(page)).toHaveAttribute('data-block-tool', 'single');
  await expect(view(page)).toHaveAttribute('data-view-proj', /\[/);

  // ---- single-cell brush: a drag over three tops paints three cells in one command.
  await blockButton(page, 'grass').click();
  const a = await aim(page, top(8, 7, 8), [8, 8, 8]);
  const b = await screen(page, top(10, 7, 8));
  const revBefore = Number((await query('queryProject')).revision);
  await stroke(page, [a, b]);
  await expect.poll(() => blockAt(layer, 10, 8, 8)).toBe('grass');
  expect(await blockAt(layer, 8, 8, 8)).toBe('grass');
  expect(await blockAt(layer, 9, 8, 8)).toBe('grass');
  expect(Number((await query('queryProject')).revision)).toBe(revBefore + 1);
  // The view writes the stroke's record once its command came back (the backend's data can be read first).
  await expect(view(page)).toHaveAttribute('data-block-stroke', /"tool":"single"/);
  const timing = JSON.parse((await view(page).getAttribute('data-block-stroke'))!) as { tool: string; cells: number; previewMs: number; commitMs: number };
  expect(timing.tool).toBe('single');
  expect(timing.cells).toBe(3);
  test.info().annotations.push({ type: 'block stroke latency (64×64×16)', description: `preview ${timing.previewMs} ms (worst pointer move), commit ${timing.commitMs} ms (release → stored)` });
  console.log(`block stroke latency at 64×64×16: preview ${timing.previewMs} ms, commit ${timing.commitMs} ms`);
  // Interactive: a pointer move's preview well inside a frame budget on a loaded host; the commit one round trip.
  expect(timing.previewMs).toBeLessThan(200);
  expect(timing.commitMs).toBeLessThan(5_000);

  // ---- undo / redo: one step for the whole stroke.
  await page.keyboard.press('Control+z');
  await expect.poll(() => cellCount(layer)).toBe(32_768);
  await page.keyboard.press('Control+y');
  await expect.poll(() => cellCount(layer)).toBe(32_771);

  // ---- rectangle: a 3 × 3 one-cell-thick fill on the row above the tops.
  await tool(page, 'Rectangle').click();
  await stroke(page, [await aim(page, top(4, 7, 4), [4, 8, 4]), await screen(page, mid(6, 8, 6))]);
  await expect.poll(() => cellCount(layer)).toBe(32_771 + 9);
  expect(await blockAt(layer, 6, 8, 6)).toBe('grass');
  expect(await blockAt(layer, 6, 9, 6)).toBeNull();

  // ---- box: the rectangle raised to the box height (2).
  await tool(page, 'Box').click();
  await expect(panel(page).getByLabel('box height')).toHaveValue('2');
  await stroke(page, [await aim(page, top(12, 7, 4), [12, 8, 4]), await screen(page, mid(13, 8, 5))]);
  await expect.poll(() => cellCount(layer)).toBe(32_780 + 8);
  expect(await blockAt(layer, 13, 9, 5)).toBe('grass');

  // ---- flood: the connected stone of the top row becomes sand.
  await blockButton(page, 'sand').click();
  await tool(page, 'Flood').click();
  const fl = await aim(page, top(2, 7, 10), [2, 7, 10]);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => blockAt(layer, 63, 7, 63)).toBe('sand');
  void fl;
  expect(await blockAt(layer, 63, 6, 63)).toBe('stone');

  // ---- eyedropper: the grass cell becomes the brush.
  await tool(page, 'Pick').click();
  await aim(page, top(8, 8, 8), [8, 8, 8]);
  await page.mouse.down();
  await page.mouse.up();
  await expect(blockButton(page, 'grass')).toHaveAttribute('aria-pressed', 'true');

  // ---- replace all of a type: every sand cell becomes stone.
  await blockButton(page, 'stone').click();
  await tool(page, 'Replace all').click();
  await aim(page, top(2, 7, 10), [2, 7, 10]);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => blockAt(layer, 63, 7, 63)).toBe('stone');
  expect(await blockAt(layer, 0, 7, 0)).toBe('stone');

  // ---- raise a column (the brush block on top), undo and redo it.
  await tool(page, 'Raise / lower').click();
  await aim(page, top(1, 7, 6), [1, 7, 6]);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => blockAt(layer, 1, 8, 6)).toBe('stone');
  await page.keyboard.press('Control+z');
  await expect.poll(() => blockAt(layer, 1, 8, 6)).toBeNull();
  await page.keyboard.press('Control+y');
  await expect.poll(() => blockAt(layer, 1, 8, 6)).toBe('stone');

  // ---- erase one of the painted cells (the row becomes asymmetric for the mirror below).
  await tool(page, 'Erase').click();
  await aim(page, top(10, 8, 8), [10, 8, 8]);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => blockAt(layer, 10, 8, 8)).toBeNull();

  // ---- select, copy, paste, mirror.
  await tool(page, 'Select').click();
  await stroke(page, [await aim(page, top(8, 8, 8), [8, 8, 8]), await screen(page, mid(10, 8, 8))]);
  await expect(view(page)).toHaveAttribute('data-block-selection', '8,8,8,11,9,9');
  await expect(panel(page).getByLabel('selection box')).toContainText('3 cells');
  await page.keyboard.press('Control+c');
  await expect(tool(page, 'Paste')).toHaveAttribute('aria-pressed', 'true');
  await aim(page, top(8, 7, 12), [8, 8, 12]);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => blockAt(layer, 9, 8, 12)).toBe('grass');
  expect(await blockAt(layer, 8, 8, 12)).toBe('grass');
  expect(await blockAt(layer, 10, 8, 12)).toBeNull();
  await panel(page).getByRole('button', { name: 'Mirror X', exact: true }).click();
  await expect.poll(() => blockAt(layer, 8, 8, 8)).toBeNull();
  expect(await blockAt(layer, 9, 8, 8)).toBe('grass');
  expect(await blockAt(layer, 10, 8, 8)).toBe('grass');

  // ---- save the selection as a stamp, place it elsewhere.
  await panel(page).getByLabel('stamp name').fill('Row piece');
  await panel(page).getByRole('button', { name: 'Save as stamp', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: 'place stamp row-piece' })).toBeVisible();
  await panel(page).getByRole('button', { name: 'place stamp row-piece' }).click();
  await expect(tool(page, 'Stamp')).toHaveAttribute('aria-pressed', 'true');
  await aim(page, top(4, 7, 12), [4, 8, 12]);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => blockAt(layer, 6, 8, 12)).toBe('grass');
  expect(await blockAt(layer, 5, 8, 12)).toBe('grass');
  expect(await blockAt(layer, 4, 8, 12)).toBeNull();

  // ---- metadata paint (a rectangle of hazard = true) and its overlay.
  await panel(page).getByLabel('metadata field').selectOption('hazard');
  await panel(page).getByLabel('metadata shape').selectOption('rect');
  await tool(page, 'Metadata').click();
  await stroke(page, [await aim(page, top(0, 7, 0), [0, 7, 0]), await screen(page, mid(3, 7, 5))]);
  await expect.poll(async () => [...(await cells(layer, [0, 7, 0, 4, 8, 6])).values()].filter((c) => c.meta['hazard'] === true).length).toBe(24);
  expect((await cells(layer, [4, 7, 0, 5, 8, 1])).get('4,7,0')?.meta['hazard']).toBe(false);
  const redOff = countPixels(decodePng(await view(page).screenshot()), red);
  await panel(page).getByLabel('overlay hazard').check();
  await expect.poll(async () => Number((await view(page).getAttribute('data-block-overlay')) ?? 0)).toBe(24);
  await expect(panel(page).getByLabel('overlay legend')).toContainText('hazard');
  await expect.poll(async () => countPixels(decodePng(await view(page).screenshot()), red), { timeout: 20_000, message: 'red overlay pixels in the Scene view' }).toBeGreaterThan(redOff + 150);
  await panel(page).getByLabel('overlay hazard').uncheck();
  await expect(view(page)).toHaveAttribute('data-block-overlay', '0');

  // ---- lock: the tools refuse and nothing changes; unlock.
  const before = await cellCount(layer);
  await panel(page).getByRole('button', { name: 'lock layer' }).click();
  await expect.poll(async () => (await entity(layer)).locked).toBe(true);
  await expect(panel(page).getByRole('button', { name: 'lock layer' })).toHaveAttribute('aria-pressed', 'true');
  await tool(page, 'Paint').click();
  await blockButton(page, 'grass').click();
  const lockedAt = await aim(page, top(3, 7, 9), [3, 8, 9]);
  await page.mouse.click(lockedAt.x, lockedAt.y);
  await expect(page.getByText(/layer is locked/)).toBeVisible();
  expect(await cellCount(layer)).toBe(before);
  await panel(page).getByRole('button', { name: 'lock layer' }).click();
  await expect.poll(async () => (await entity(layer)).locked ?? false).toBe(false);

  // ---- hide: the layer's blocks leave the Scene view; show again.
  await expect.poll(async () => countPixels(decodePng(await view(page).screenshot()), green), { timeout: 20_000 }).toBeGreaterThan(200);
  await panel(page).getByRole('button', { name: 'hide layer' }).click();
  await expect.poll(async () => (await entity(layer)).active).toBe(false);
  await expect.poll(async () => countPixels(decodePng(await view(page).screenshot()), green), { timeout: 20_000, message: 'no grass pixels while the layer is hidden' }).toBeLessThan(20);
  await panel(page).getByRole('button', { name: 'hide layer' }).click();
  await expect.poll(async () => (await entity(layer)).active ?? true).toBe(true);

  // ---- snapping settings: a 1 m move step moves an object in whole metres.
  await projectWindow(page);
  await expect(view(page)).toHaveAttribute('data-block-tool', '');
  await (await menuItem(page, 'Edit', 'Snapping settings…')).click();
  const dialog = page.getByRole('dialog', { name: 'Snapping settings' });
  await dialog.getByLabel('Move step (m)').fill('1');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const mover = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name: 'Mover', transform: { position: [0.3, 0.5, -3] }, box: { size: [1, 1, 1], material: { color: '#dd44dd' } } }))['createdId']);
  await dragGizmoX(page, mover);
  await expect.poll(async () => (await entity(mover)).components.transform.position[0]).not.toBe(0.3);
  const moved = (await entity(mover)).components.transform.position;
  expect(Number.isInteger(moved[0])).toBe(true);
  await expect(view(page)).toHaveAttribute('data-snap-step', '1');

  // ---- cell-top snapping and a prop's block footprint.
  await (await menuItem(page, 'Edit', 'Snapping settings…')).click();
  await dialog.getByLabel('snap to cell tops').check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  // A field of its own for the footprint (cells read back with the fields' defaults filled in).
  await cmd('setCellFields', { fields: [{ key: 'hazard', type: 'bool', color: '#ff0000' }, { key: 'lot', type: 'int', default: 0, min: 0, max: 99 }] });
  const hut = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name: 'Hut', transform: { position: [-4.5, 3, -5.5] }, box: { size: [1, 1, 1], material: { color: '#dd8844' } } }))['createdId']);
  await cmd('setComponent', { entityId: hut, component: 'blockFootprint', value: { layer, set: { lot: 7 } } });
  await dragGizmoX(page, hut);
  await expect.poll(async () => (await entity(hut)).components.transform.position[1]).toBe(0.5);
  const p = (await entity(hut)).components.transform.position;
  // On the top of the column under it: a cell centre on x and z, on the row-7 tops (y = 0.5).
  expect(p[2]).toBe(-5.5);
  expect((((p[0]! - ORIGIN[0] - 0.5) % 1) + 1) % 1).toBe(0);
  const cx = p[0]! - ORIGIN[0] - 0.5;
  await expect.poll(async () => (await cells(layer, [cx, 7, 2, cx + 1, 8, 3])).get(`${cx},7,2`)?.meta['lot']).toBe(7);
  // The footprint is written with the move, so one undo takes both back: the hut returns to y = 3 and
  // the footprint to the row-9 cell it wrote when the component was set there.
  const lotAt = async (x: number, y: number, z: number): Promise<unknown> => (await cells(layer, [x, y, z, x + 1, y + 1, z + 1])).get(`${x},${y},${z}`)?.meta['lot'];
  expect(await lotAt(3, 9, 2)).not.toBe(7);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await entity(hut)).components.transform.position).toEqual([-4.5, 3, -5.5]);
  expect(await lotAt(cx, 7, 2)).toBe(0);
  expect(await lotAt(3, 9, 2)).toBe(7);
  await page.keyboard.press('Control+y');
  await expect.poll(() => lotAt(cx, 7, 2)).toBe(7);
  expect(await lotAt(3, 9, 2)).not.toBe(7);
  // Deleting the prop (as MCP sends it) clears its cells; the editor's undo brings them back with it.
  await cmd('deleteEntity', { entityId: hut });
  expect(await lotAt(cx, 7, 2)).toBe(0);
  await page.keyboard.press('Control+z');
  await expect.poll(() => lotAt(cx, 7, 2)).toBe(7);
  await expect(page.locator(`.tl-hierarchy__list li[data-entity-id="${hut}"]`)).toHaveCount(1);

  // A prop under a moved group: the Inspector's snap and "Write to cells" pick the cells under its world place,
  // the ones the backend's moves write and clear. Column (40, 40) is untouched: its top is row 7.
  expect(await blockAt(layer, 40, 7, 40)).toBe('stone');
  expect(await blockAt(layer, 40, 8, 40)).toBeNull();
  const yard = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Yard', transform: { position: [0.25, 1, 3] } }))['createdId']);
  // World (32.6, 4, 32.5): over cell (40, 40).
  const shed = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: yard, kind: 'box', name: 'Shed', transform: { position: [32.35, 3, 29.5] }, box: { size: [1, 1, 1], material: { color: '#88dd44' } } }))['createdId']);
  await cmd('setComponent', { entityId: shed, component: 'blockFootprint', value: { layer, set: { lot: 9 } } });
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${shed}"]`).click();
  await page.locator('.tl-inspector').getByRole('button', { name: 'Snap to cell top' }).click();
  // On the row-7 top at the cell's centre in the world (x 32.5, y 0.5, z 32.5), stored local to the group.
  await expect.poll(async () => (await entity(shed)).components.transform.position).toEqual([32.25, -0.5, 29.5]);
  await expect.poll(() => lotAt(40, 7, 40)).toBe(9);
  // Cleared by hand, "Write to cells" writes it again on the same cell.
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'meta', set: { lot: null }, at: [40, 7, 40] }] });
  expect(await lotAt(40, 7, 40)).toBe(0);
  await page.locator('.tl-inspector').getByRole('button', { name: 'Write to cells' }).click();
  await expect.poll(() => lotAt(40, 7, 40)).toBe(9);

  // ---- the Inspector's cell size: cells are square from above, so x and z are edited as one value.
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${layer}"]`).click();
  const inspector = page.locator('.tl-inspector');
  const cellSize = async (): Promise<number[] | undefined> => (await entity(layer)).components.blockLayer?.cellSize;
  const cellField = (axis: string) => inspector.getByLabel(`blockLayer cellSize ${axis}`, { exact: true });
  await cellField('x').fill('2');
  await cellField('x').press('Enter');
  await expect.poll(cellSize).toEqual([2, 1, 2]);
  await expect(cellField('z')).toHaveValue('2');
  await cellField('z').fill('0.5');
  await cellField('z').press('Enter');
  await expect.poll(cellSize).toEqual([0.5, 1, 0.5]);
  await expect(cellField('x')).toHaveValue('0.5');
  await cellField('y').fill('0.25');
  await cellField('y').press('Enter');
  await expect.poll(cellSize).toEqual([0.5, 0.25, 0.5]);
  // A command (as MCP sends it) with x ≠ z is refused, naming both values and the rule.
  const refused = await be!.command({ op: 'setComponent', projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-block-editor' }, args: { entityId: layer, component: 'blockLayer', value: { cellSize: [2, 1, 1], bounds: { min: [0, 0, 0], max: [64, 16, 64] } } } });
  expect(refused['ok']).toBe(false);
  expect(JSON.stringify(refused)).toContain('field_value');
  expect(JSON.stringify(refused)).toMatch(/x \(2\) and z \(1\).*square from above/);
  expect(await cellSize()).toEqual([0.5, 0.25, 0.5]);
});

/** Select an object in the Hierarchy and drag its gizmo's X arrow (one setTransform on release). */
async function dragGizmoX(page: Page, id: string): Promise<void> {
  const previous = (await view(page).getAttribute('data-gizmo-grab')) ?? 'null';
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
  await expect(page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`)).toHaveClass(/is-selected|selected/);
  // The grip of this object (not the one selected before), settled over two reads.
  let last = '';
  await expect
    .poll(async () => {
      const now = (await view(page).getAttribute('data-gizmo-grab')) ?? 'null';
      const settled = now !== 'null' && now !== previous && now === last;
      last = now;
      return settled;
    }, { timeout: 15_000, intervals: [150] })
    .toBe(true);
  const g = JSON.parse(last) as { x: number; y: number; ax: number; ay: number };
  await page.mouse.move(g.ax, g.ay);
  await page.waitForTimeout(100);
  await page.mouse.down();
  await page.mouse.move(g.ax + (g.ax - g.x) * 2.5, g.ay + (g.ay - g.y) * 2.5, { steps: 10 });
  await page.mouse.up();
}
