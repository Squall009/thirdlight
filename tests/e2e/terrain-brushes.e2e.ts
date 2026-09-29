/**
 * The terrain brushes of the Blocks panel in the real editor against a real
 * backend: a flat block layer (32 × 16 × 32 cells of 1 × 0.5 × 1 m, its top
 * two metres up) is sculpted in the Scene view. A Height drag raises a smooth
 * hill (one editBlocks: the stroke's `sculpt` dabs; sloped top cells, every
 * shared vertex joined), Ctrl + a Height drag lowers, Smooth softens the
 * hill's peak, Flatten levels the ground to the height where its drag
 * starts. Undo and redo step through the strokes one each; a reload of the
 * editor shows the stored terrain (the same cells from the backend, the same
 * mesh in the Scene view). Every result is read back through `queryBlocks`.
 */
import { randomBytes } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-terrain-brushes' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}

/** The layer's min corner: 4 rows of 0.5 m, so the flat top is at y = 0 (world). */
const ORIGIN = [-16, -2, -16] as const;
type V3 = [number, number, number];

const view = (page: Page) => page.locator('.tl-viewport');
const panel = (page: Page) => page.getByLabel('blocks panel');
const tool = (page: Page, name: string) => panel(page).getByRole('toolbar', { name: 'block tools' }).getByRole('button', { name, exact: true });

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

/** A column's corner heights in rows (the top cell's row plus its corners; a flat top: row + 1), from the backend. */
async function heights(layer: string, x: number, z: number): Promise<number[] | null> {
  const r = (await query('queryBlocks', { entityId: layer, box: [x, 0, z, x + 1, 16, z + 1] })) as { box: { cells: number[][]; palette: { block?: string; corners?: number[] }[] } };
  const blocks = r.box.cells.filter((c) => r.box.palette[c[3]!]!.block !== undefined);
  if (blocks.length === 0) return null;
  const top = blocks.reduce((a, c) => (c[1]! > a[1]! ? c : a));
  const corners = r.box.palette[top[3]!]!.corners ?? [1, 1, 1, 1];
  return corners.map((c) => top[1]! + c);
}
/** The layer's stored chunks, as the backend holds them. */
const chunks = async (layer: string): Promise<string> => JSON.stringify(((await query('queryBlocks', { entityId: layer, box: [0, 0, 0, 32, 16, 32] })) as { box: unknown }).box);
const revision = async (): Promise<number> => Number((await query('queryProject')).revision);

/** Drag across world points on the ground (the pointer held), in small steps. */
async function drag(page: Page, points: V3[], modifier?: 'Control'): Promise<void> {
  const s = await Promise.all(points.map((p) => screen(page, p)));
  await page.mouse.move(s[0]!.x - 4, s[0]!.y - 3);
  await page.mouse.move(s[0]!.x, s[0]!.y);
  await expect(view(page)).toHaveAttribute('data-block-brush', /\d/);
  if (modifier !== undefined) await page.keyboard.down(modifier);
  await page.mouse.down();
  for (const p of s.slice(1)) await page.mouse.move(p.x, p.y, { steps: 12 });
  await page.mouse.up();
  if (modifier !== undefined) await page.keyboard.up(modifier);
}

/** The world point on the flat top over layer column (x, z). */
const ground = (x: number, z: number, rows = 4): V3 => [ORIGIN[0] + x, ORIGIN[1] + rows * 0.5, ORIGIN[2] + z];

test('terrain brushes: Height raises and lowers, Smooth softens, Flatten levels; one undo step each; the terrain survives a reload', async ({ page }) => {
  test.setTimeout(300_000);
  be = await startBackend('terrain-brushes-e2e');
  await cmd('setBlockType', { block: { blockId: 'soil', name: 'Soil', variants: [{ color: '#7a6040' }], shape: 'full' } });
  const layer = String((await cmd('createEntity', { parentId: null, kind: 'group', name: 'Ground', transform: { position: [...ORIGIN] } }))['createdId']);
  await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [32, 16, 32] } } });
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [0, 0, 0, 32, 4, 32], cell: { block: 'soil' } }] });
  const flat = await chunks(layer);

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expect.poll(async () => JSON.parse((await view(page).getAttribute('data-block-layers')) ?? '{"chunks":0}').chunks as number, { timeout: 30_000 }).toBe(4);
  await page.getByRole('tab', { name: 'Blocks', exact: true }).click();
  await expect(panel(page).getByLabel('block layer')).toHaveValue(layer);
  await expect(view(page)).toHaveAttribute('data-view-proj', /\[/);

  // ---- Height: a drag across the middle raises a hill in one command.
  await tool(page, 'Height').click();
  await expect(view(page)).toHaveAttribute('data-block-tool', 'height');
  await panel(page).getByLabel('brush radius').fill('4');
  await panel(page).getByLabel('brush strength').fill('1');
  const r0 = await revision();
  await drag(page, [ground(14, 16), ground(18, 16)]);
  await expect.poll(async () => (await heights(layer, 16, 16))?.[0] ?? 0, { timeout: 20_000 }).toBeGreaterThan(5);
  expect(await revision()).toBe(r0 + 1);
  const stroke = JSON.parse((await view(page).getAttribute('data-block-stroke'))!) as { tool: string; cells: number };
  expect(stroke.tool).toBe('height');
  // Several dabs along the drag (a quarter radius apart), sent together.
  expect(stroke.cells).toBeGreaterThan(3);
  const hill = await chunks(layer);
  // A smooth hill: sloped tops (corners) around the peak; the rim still flat at 4 rows; neighbours joined.
  expect(hill).toContain('"corners"');
  expect(await heights(layer, 2, 2)).toEqual([4, 4, 4, 4]);
  const a = (await heights(layer, 15, 16))!;
  const b = (await heights(layer, 16, 16))!;
  expect(a[1]).toBe(b[0]);
  expect(a[2]).toBe(b[3]);
  const peak = b[0]!;

  // ---- Height with Ctrl: lowers (a dip elsewhere).
  await drag(page, [ground(6, 12), ground(7, 12)], 'Control');
  await expect.poll(async () => (await heights(layer, 6, 12))?.[0] ?? 99, { timeout: 20_000, message: `lowered: ${await view(page).getAttribute('data-block-stroke')} rev ${await revision()}` }).toBeLessThan(4);
  expect(await revision()).toBe(r0 + 2);

  // ---- Smooth over the hill: the peak comes down.
  await tool(page, 'Smooth').click();
  await drag(page, [ground(15, 16, peak), ground(17, 16, peak)]);
  await expect.poll(async () => (await heights(layer, 16, 16))?.[0] ?? 99, { timeout: 20_000 }).toBeLessThan(peak);
  expect(await revision()).toBe(r0 + 3);

  // ---- Flatten, starting on the flat ground outside the dip: levels the dip back to 4 rows (there and back).
  await tool(page, 'Flatten').click();
  await drag(page, [ground(1, 12), ground(11, 12), ground(1, 12)]);
  await expect.poll(async () => JSON.stringify(await heights(layer, 6, 12)), { timeout: 20_000 }).toBe('[4,4,4,4]');
  expect(await revision()).toBe(r0 + 4);

  // ---- Undo: one step per stroke, back to the hill; then the flat layer; redo the hill.
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
  await expect.poll(() => chunks(layer), { timeout: 20_000 }).toBe(hill);
  await page.keyboard.press('Control+z');
  await expect.poll(() => chunks(layer), { timeout: 20_000 }).toBe(flat);
  await page.keyboard.press('Control+y');
  await expect.poll(() => chunks(layer), { timeout: 20_000 }).toBe(hill);

  // ---- Reload: the stored terrain comes back (the backend's cells, the same mesh in the Scene view).
  const meshBefore = JSON.parse((await view(page).getAttribute('data-block-layers'))!) as { triangles: number };
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expect.poll(async () => (JSON.parse((await view(page).getAttribute('data-block-layers')) ?? '{"triangles":0}') as { triangles: number }).triangles, { timeout: 30_000 }).toBe(meshBefore.triangles);
  expect(await chunks(layer)).toBe(hill);
});
