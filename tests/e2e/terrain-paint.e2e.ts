/**
 * Phase 25.21: the Blocks panel's Paint mode ("Paint texture") in the real
 * editor against a real backend. A flat block layer (32 × 16 × 32 cells of
 * 1 × 0.5 × 1 m, its top at y = 0) wears the height-blended layers material
 * (the three texture arrays packed through the pack route; layer 3 blue). A
 * drag paints layer 3 under the round brush — previewed as the dabs land,
 * stored as one `editBlocks` of `paint` dabs (the chunk's paint lattice), the
 * Scene view shows blue; a Ctrl drag erases part of it; undo and redo step
 * through the strokes one each; a reload shows the stored paint again.
 */
import { randomBytes } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { ALBEDO_HEIGHT_LAYERS, count, isBlue, materials, packNormalAndOrm, packTexture, publishLayerSources, useArrays } from './painted-layers';
import { decodePng } from './png';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-terrain-paint' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}

const ORIGIN = [-16, -2, -16] as const;
type V3 = [number, number, number];
const view = (page: Page) => page.locator('.tl-viewport');
const panel = (page: Page) => page.getByLabel('blocks panel');
const tool = (page: Page, name: string) => panel(page).getByRole('toolbar', { name: 'block tools' }).getByRole('button', { name, exact: true });

async function screen(page: Page, p: V3): Promise<{ x: number; y: number }> {
  const m = JSON.parse((await view(page).getAttribute('data-view-proj'))!) as number[];
  const box = (await view(page).boundingBox())!;
  const [x, y, z] = p;
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  const nx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w;
  const ny = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w;
  return { x: box.x + ((nx + 1) / 2) * box.width, y: box.y + ((1 - ny) / 2) * box.height };
}
const ground = (x: number, z: number): V3 => [ORIGIN[0] + x, 0, ORIGIN[2] + z];

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

/** The layer's stored chunks' paint (base64 per chunk key; absent: unpainted). */
async function paint(layer: string): Promise<Record<string, string>> {
  const chunks = ((await query('queryBlocks', { entityId: layer })) as { chunks: { cx: number; cz: number; chunk: { paint?: string } | null }[] }).chunks;
  const out: Record<string, string> = {};
  for (const c of chunks) if (c.chunk?.paint !== undefined) out[`${c.cx},${c.cz}`] = c.chunk.paint;
  return out;
}
/** One lattice vertex's five bytes (layer vertex x, z; chunk 17 × 17 × 5), or the unpainted default. */
function vertex(p: Record<string, string>, x: number, z: number): number[] {
  const cx = Math.floor(x / 16);
  const cz = Math.floor(z / 16);
  const b = p[`${cx},${cz}`];
  if (b === undefined) return [255, 0, 0, 0, 0];
  const bytes = Buffer.from(b, 'base64');
  const o = ((z - cz * 16) * 17 + (x - cx * 16)) * 5;
  return [...bytes.subarray(o, o + 5)];
}
const revision = async (): Promise<number> => Number((await query('queryProject')).revision);
/** Blue pixels around a world point in the Scene view (a 120 px square). */
async function blueNear(page: Page, p: V3): Promise<number> {
  const s = await screen(page, p);
  const box = (await view(page).boundingBox())!;
  const img = decodePng(await page.screenshot({ clip: { x: Math.max(box.x, s.x - 60), y: Math.max(box.y, s.y - 60), width: 120, height: 120 } }));
  return count(img, isBlue);
}

test('Paint mode: a drag paints a layer (one undo step), Ctrl erases, undo/redo, the paint survives a reload', async ({ page }) => {
  test.setTimeout(300_000);
  be = await startBackend('terrain-paint-e2e');
  // The arrays (through the pack route) and the layered material (the template, as the Materials tab makes it).
  await publishLayerSources(be);
  await packNormalAndOrm(be);
  await packTexture(be, ALBEDO_HEIGHT_LAYERS, 'color', 'terrain-albedo');
  await cmd('setEnvironment', { environment: { sky: { mode: 'color', color: '#303030' } } });

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Materials' }).click();
  await page.getByRole('combobox', { name: 'graph material template' }).selectOption('layers');
  await page.getByRole('button', { name: '+ new graph material' }).click();
  await expect.poll(async () => (await materials(be!)).filter((m) => JSON.stringify(m.graph ?? {}).includes('heightBlend')).length, { timeout: 15_000 }).toBe(1);
  const mat = (await materials(be)).find((m) => JSON.stringify(m.graph ?? {}).includes('heightBlend'))!.materialId;
  await useArrays(be, mat, { albedoHeight: 'terrain-albedo', normals: 'terrain-normals', orm: 'terrain-orm' });
  await cmd('setBlockType', { block: { blockId: 'soil', name: 'Soil', variants: [{ color: '#7a6040' }], shape: 'full', materials: { '*': mat } } });
  const layer = String((await cmd('createEntity', { parentId: null, kind: 'group', name: 'Ground', transform: { position: [...ORIGIN] } }))['createdId']);
  await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [32, 16, 32] } } });
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [0, 0, 0, 32, 4, 32], cell: { block: 'soil' } }] });
  for (const e of ((await query('queryEntities', { limit: 200, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities) {
    if (e.components['box'] !== undefined) await cmd('setTransform', { entityId: e.id, transform: { position: [0, -80, 0] } });
  }
  expect(await paint(layer)).toEqual({});

  await page.getByRole('tab', { name: 'Scene', exact: true }).click();
  await expect.poll(async () => JSON.parse((await view(page).getAttribute('data-block-layers')) ?? '{"chunks":0}').chunks as number, { timeout: 30_000 }).toBe(4);
  await page.getByRole('tab', { name: 'Blocks', exact: true }).click();
  await expect(panel(page).getByLabel('block layer')).toHaveValue(layer);
  await expect(view(page)).toHaveAttribute('data-view-proj', /\[/);
  // Nothing blue before painting (the layer is all layer 1: red).
  await expect.poll(() => blueNear(page, ground(16, 16)), { timeout: 30_000 }).toBe(0);

  // ---- Paint layer 3 across the middle: one command of paint dabs.
  await tool(page, 'Paint texture').click();
  await expect(view(page)).toHaveAttribute('data-block-tool', 'paint');
  await panel(page).getByLabel('paint channel').selectOption('2');
  await panel(page).getByLabel('paint radius').fill('3');
  await panel(page).getByLabel('paint strength').fill('1');
  await panel(page).getByLabel('paint falloff').selectOption('constant');
  const r0 = await revision();
  await drag(page, [ground(14, 16), ground(18, 16)]);
  await expect.poll(async () => vertex(await paint(layer), 16, 16), { timeout: 20_000 }).toEqual([0, 0, 255, 0, 0]);
  expect(await revision()).toBe(r0 + 1);
  const stroke = JSON.parse((await view(page).getAttribute('data-block-stroke'))!) as { tool: string; cells: number };
  expect(stroke.tool).toBe('paint');
  expect(stroke.cells).toBeGreaterThan(3);
  const painted = await paint(layer);
  // The four chunks meet at (16, 16): the shared vertex is painted alike in each.
  expect(Object.keys(painted).sort()).toEqual(['0,0', '0,1', '1,0', '1,1']);
  expect(vertex(painted, 10, 16)).toEqual([255, 0, 0, 0, 0]);
  await expect.poll(() => blueNear(page, ground(16, 16)), { timeout: 30_000 }).toBeGreaterThan(40);

  // ---- Ctrl: erase layer 3 on the left end (its weight goes back to layer 1).
  await drag(page, [ground(13, 16), ground(14, 16)], 'Control');
  await expect.poll(async () => vertex(await paint(layer), 13, 16)[2], { timeout: 20_000 }).toBe(0);
  expect(vertex(await paint(layer), 13, 16)).toEqual([255, 0, 0, 0, 0]);
  expect(vertex(await paint(layer), 18, 16)).toEqual([0, 0, 255, 0, 0]);
  expect(await revision()).toBe(r0 + 2);
  const erased = await paint(layer);

  // ---- Undo: one step per stroke; back to unpainted; redo the paint.
  await page.keyboard.press('Control+z');
  await expect.poll(() => paint(layer), { timeout: 20_000 }).toEqual(painted);
  await page.keyboard.press('Control+z');
  await expect.poll(() => paint(layer), { timeout: 20_000 }).toEqual({});
  await expect.poll(() => blueNear(page, ground(16, 16)), { timeout: 30_000 }).toBe(0);
  await page.keyboard.press('Control+y');
  await page.keyboard.press('Control+y');
  await expect.poll(() => paint(layer), { timeout: 20_000 }).toEqual(erased);

  // ---- Reload: the stored paint comes back into the Scene view.
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expect.poll(async () => JSON.parse((await view(page).getAttribute('data-block-layers')) ?? '{"chunks":0}').chunks as number, { timeout: 30_000 }).toBe(4);
  await page.getByRole('tab', { name: 'Blocks', exact: true }).click();
  await expect(view(page)).toHaveAttribute('data-view-proj', /\[/);
  await expect.poll(() => blueNear(page, ground(17, 16)), { timeout: 30_000 }).toBeGreaterThan(20);
  expect(await paint(layer)).toEqual(erased);
});
